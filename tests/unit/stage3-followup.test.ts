import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../packages/persistence/src/index';
import { ManualPracticeReviewStore } from '../../packages/persistence/src/manual-practice-review';
import { PracticeRevalidationStore } from '../../packages/persistence/src/practice-revalidation';
import { DEFAULT_CONFIG } from '../../packages/contracts/src/config';
import type { SiteObservation } from '../../packages/contracts/src/monitor';
import { ManualPracticeReviewAuthorization } from '../../packages/task-engine/src/manual-practice-review';
import { TaskEngine } from '../../packages/task-engine/src/index';
import { PracticeSession } from '../../packages/practice/src/index';
import { PracticeFaultAdapter, fixedRandom } from '../helpers/stage3';
import { prepareRevalidation } from '../../scripts/stage3-revalidation-tool';

const roots: string[] = [];
const decision = 'allow-one-new-practice-after-zero-actions' as const;
const signal = () => new AbortController().signal;
const old = {
  operationId: 'original-submit',
  taskId: 'original-task',
  kind: 'practice-submit',
  status: 'awaiting-confirmation' as const,
  savedAt: '2026-10-20T01:00:00.000Z',
};
async function fixture() {
  const data = await mkdtemp(join(tmpdir(), 'stage3-followup-'));
  roots.push(data);
  await mkdir(join(data, 'config'));
  await writeFile(
    join(data, 'config/settings.json'),
    JSON.stringify(DEFAULT_CONFIG, null, 2) + '\r\n',
  );
  const state = new StateStore(data);
  await state.write({
    schemaVersion: 1,
    taskId: old.taskId,
    chapterId: 'original-chapter',
    courseId: 'course',
    state: 'PAUSED',
    savedAt: new Date().toISOString(),
    pendingOperations: [old],
    confirmedPlatformStatuses: [],
  });
  const original = new ManualPracticeReviewStore(data);
  const review = await original.record(
    (await original.preview()).snapshotDigest,
    'abandon-old-attempt-allow-one-fresh-task',
  );
  await original.claim(review.id, 'parent-task', 'parent-chapter', signal());
  await state.write({
    ...(await state.load())!,
    taskId: 'parent-task',
    chapterId: 'parent-chapter',
  });
  const store = new PracticeRevalidationStore(data, original);
  const first = await store.record(
    review.id,
    (await store.preview(review.id)).snapshotDigest,
    decision,
  );
  await store.claim(first.id, 'first-task', 'first-chapter', signal());
  await state.write({ ...(await state.load())!, taskId: 'first-task', chapterId: 'first-chapter' });
  return {
    data,
    state,
    original,
    review,
    store,
    first,
    folder: join(data, 'state/practice-revalidation'),
  };
}
async function prepared() {
  const f = await fixture();
  const preview = await f.store.preview(f.review.id, f.first.id);
  const receipt = await f.store.record(
    f.review.id,
    preview.snapshotDigest,
    decision,
    undefined,
    f.first.id,
  );
  return { ...f, receipt };
}
function observation(): SiteObservation {
  const time = new Date().toISOString();
  return {
    course: {
      courseId: 'course',
      title: 'synthetic',
      observedAt: time,
      confidence: 'verified',
      source: 'fixture',
      authenticated: true,
      pageKind: 'course',
      platformCompleted: null,
      evidence: [],
    },
    player: {
      chapterId: 'fresh-chapter',
      currentTime: 3,
      duration: 120,
      playbackRate: 1,
      paused: false,
      ended: false,
      buffering: false,
      observedAt: time,
      confidence: 'verified',
    },
    chapters: [
      {
        chapterId: 'fresh-chapter',
        title: 'synthetic',
        platformCompleted: false,
        observedAt: time,
        confidence: 'verified',
      },
    ],
    currentChapterId: 'fresh-chapter',
    supportedRates: [1],
    popup: 'none',
    safeToRefresh: false,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) {
    const target = resolve(path);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('stage3-followup-'))
      throw new Error('REFUSE_OUTSIDE_TEST_TEMP');
    await rm(target, { recursive: true, force: true });
  }
});

describe('阶段3显式后继：旧数据兼容、逐层零动作且只消费一次', () => {
  it('只读预览保留旧格式和已消费claim，默认不自动挑选上次复验', async () => {
    const f = await fixture();
    const snapshot = await readFile(join(f.data, 'state/snapshot.json'));
    const claim = await readFile(join(f.folder, f.first.id, 'claim.json'));
    await expect(f.store.preview(f.review.id)).rejects.toThrow('REQUIRES_ZERO_ACTION');
    const preview = await f.store.preview(f.review.id, f.first.id);
    expect(preview).toMatchObject({
      predecessorRevalidationId: f.first.id,
      predecessorRevalidationDigest: f.first.integrityDigest,
      predecessorTaskId: 'first-task',
      operation: old,
      excludedChapterIds: ['original-chapter', 'parent-chapter', 'first-chapter'],
      excludedTaskIds: ['original-task', 'parent-task', 'first-task'],
    });
    expect(await f.store.load(f.first.id)).toEqual(f.first);
    expect(await readFile(join(f.data, 'state/snapshot.json'))).toEqual(snapshot);
    expect(await readFile(join(f.folder, f.first.id, 'claim.json'))).toEqual(claim);
  });
  it('新收据逐字节备份，原schema与未知不变，旧收据不增加新字段', async () => {
    const f = await prepared();
    expect(await readFile(join(f.folder, f.receipt.id, 'state/snapshot.json'))).toEqual(
      await readFile(join(f.data, 'state/snapshot.json')),
    );
    expect(await readFile(join(f.folder, f.receipt.id, 'settings.json'))).toEqual(
      await readFile(join(f.data, 'config/settings.json')),
    );
    expect((await f.state.load())!.pendingOperations).toEqual([old]);
    expect(await f.store.load(f.first.id)).not.toHaveProperty('predecessorRevalidationId');
    expect(await f.store.load(f.receipt.id)).toEqual(f.receipt);
  });
  it.each(['pending', 'executing', 'awaiting-confirmation', 'completed', 'failed'] as const)(
    '新增%s操作阻止后继准备',
    async (status) => {
      const f = await fixture();
      const snapshot = (await f.state.load())!;
      await f.state.write({
        ...snapshot,
        pendingOperations: [
          ...snapshot.pendingOperations,
          { ...old, operationId: 'new-effect', taskId: 'first-task', status },
        ],
      });
      await expect(f.store.preview(f.review.id, f.first.id)).rejects.toThrow(
        'REQUIRES_ZERO_ACTION',
      );
    },
  );
  it.each(['removed', 'modified', 'wrong-task', 'wrong-chapter', 'active'] as const)(
    '%s不等于零动作暂停快照',
    async (fault) => {
      const f = await fixture(),
        snapshot = (await f.state.load())!;
      if (fault === 'removed') snapshot.pendingOperations = [];
      if (fault === 'modified') snapshot.pendingOperations[0].status = 'completed';
      if (fault === 'wrong-task') snapshot.taskId = 'other';
      if (fault === 'wrong-chapter') snapshot.chapterId = 'other';
      if (fault === 'active') snapshot.state = 'MONITORING';
      await f.state.write(snapshot);
      await expect(f.store.preview(f.review.id, f.first.id)).rejects.toThrow(
        'REQUIRES_ZERO_ACTION',
      );
    },
  );
  it('父收据必须属于指定原人工记录', async () => {
    const f = await fixture();
    await expect(
      f.store.preview('11111111-1111-4111-8111-111111111111', f.first.id),
    ).rejects.toThrow('PARENT_MISMATCH');
  });
  it('前次两份claim不一致拒绝，不能用单文件伪造下一任务', async () => {
    const f = await fixture();
    const path = join(f.folder, f.first.id, 'claim.json');
    const claim = JSON.parse(await readFile(path, 'utf8'));
    claim.taskId = 'forged';
    await writeFile(path, JSON.stringify(claim));
    await expect(f.store.preview(f.review.id, f.first.id)).rejects.toThrow('PARENT_CLAIM_INVALID');
  });
  it('未消费的父收据没有后继资格', async () => {
    const f = await prepared();
    await expect(f.store.preview(f.review.id, f.receipt.id)).rejects.toThrow();
  });
  it('祖先备份损坏拒绝整个后继', async () => {
    const f = await prepared();
    await writeFile(join(f.folder, f.first.id, 'state/snapshot.json'), '{}');
    await expect(f.store.load(f.receipt.id)).rejects.toThrow('BACKUP_CORRUPT');
  });
  it('同一前任务的两个新收据并发消费只有一个成功', async () => {
    const f = await prepared(),
      preview = await f.store.preview(f.review.id, f.first.id);
    const second = await f.store.record(
      f.review.id,
      preview.snapshotDigest,
      decision,
      undefined,
      f.first.id,
    );
    const results = await Promise.allSettled([
      f.store.claim(f.receipt.id, 'next-one', 'fresh-one', signal()),
      f.store.claim(second.id, 'next-two', 'fresh-two', signal()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.state.load())!.pendingOperations).toEqual([old]);
  });
  it.each(['original-task', 'parent-task', 'first-task'])('不能复用祖先任务%s', async (task) => {
    const f = await prepared();
    await expect(f.store.claim(f.receipt.id, task, 'fresh-chapter', signal())).rejects.toThrow(
      'OLD_CONTEXT_FORBIDDEN',
    );
  });
  it.each(['original-chapter', 'parent-chapter', 'first-chapter'])(
    '不能复用祖先章节%s',
    async (chapter) => {
      const f = await prepared();
      await expect(f.store.claim(f.receipt.id, 'fresh-task', chapter, signal())).rejects.toThrow(
        'OLD_CONTEXT_FORBIDDEN',
      );
    },
  );
  it('预览后时间戳变化需要重新确认摘要，消费时允许初始化时间戳', async () => {
    const f = await fixture(),
      preview = await f.store.preview(f.review.id, f.first.id);
    await f.state.write({ ...(await f.state.load())!, savedAt: '2026-10-21T00:00:00.000Z' });
    await expect(
      f.store.record(f.review.id, preview.snapshotDigest, decision, undefined, f.first.id),
    ).rejects.toThrow('PREVIEW_CHANGED');
    const receipt = await f.store.record(
      f.review.id,
      (await f.store.preview(f.review.id, f.first.id)).snapshotDigest,
      decision,
      undefined,
      f.first.id,
    );
    await f.state.write({ ...(await f.state.load())!, savedAt: '2026-10-21T00:00:01.000Z' });
    await expect(
      f.store.claim(receipt.id, 'next-task', 'fresh-chapter', signal()),
    ).resolves.toBeUndefined();
  });
  it('消费前业务状态改变拒绝，不写后继claim', async () => {
    const f = await prepared();
    await f.state.write({
      ...(await f.state.load())!,
      confirmedPlatformStatuses: [
        { chapterId: 'first-chapter', completed: true, observedAt: new Date().toISOString() },
      ],
    });
    await expect(
      f.store.claim(f.receipt.id, 'next-task', 'fresh-chapter', signal()),
    ).rejects.toThrow('SOURCE_CHANGED');
    expect(await readdir(f.folder)).not.toContain('predecessor-first-task.claim.json');
  });
  it('取消和不明确的决定不会准备新收据', async () => {
    const f = await fixture(),
      preview = await f.store.preview(f.review.id, f.first.id),
      before = await readdir(f.folder),
      controller = new AbortController();
    controller.abort();
    await expect(
      f.store.record(f.review.id, preview.snapshotDigest, decision, controller.signal, f.first.id),
    ).rejects.toThrow();
    await expect(
      f.store.record(
        f.review.id,
        preview.snapshotDigest,
        'yes' as typeof decision,
        undefined,
        f.first.id,
      ),
    ).rejects.toThrow('EXPLICIT_DECISION_REQUIRED');
    expect(await readdir(f.folder)).toEqual(before);
  });
  it('路径越界和带正确摘要的自循环都拒绝', async () => {
    const f = await prepared();
    await expect(f.store.preview(f.review.id, '../outside')).rejects.toThrow('INVALID_ID');
    const path = join(f.folder, f.receipt.id, 'receipt.json'),
      { integrityDigest: _oldDigest, ...body } = JSON.parse(await readFile(path, 'utf8'));
    body.predecessorRevalidationId = f.receipt.id;
    await writeFile(
      path,
      JSON.stringify({
        ...body,
        integrityDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      }),
    );
    await expect(f.store.load(f.receipt.id)).rejects.toThrow('ANCESTRY_INVALID');
  });
  it('16层可读，第17层预览即拒绝，不留下无法加载的新收据', async () => {
    const f = await fixture();
    let parent = f.first;
    for (let level = 2; level <= 16; level++) {
      const preview = await f.store.preview(f.review.id, parent.id);
      parent = await f.store.record(
        f.review.id,
        preview.snapshotDigest,
        decision,
        undefined,
        parent.id,
      );
      await f.store.claim(parent.id, 'task-' + level, 'chapter-' + level, signal());
      await f.state.write({
        ...(await f.state.load())!,
        taskId: 'task-' + level,
        chapterId: 'chapter-' + level,
      });
    }
    expect((await f.store.load(parent.id)).excludedChapterIds).toHaveLength(17);
    const before = await readdir(f.folder);
    await expect(f.store.preview(f.review.id, parent.id)).rejects.toThrow('ANCESTRY_INVALID');
    expect(await readdir(f.folder)).toEqual(before);
  }, 30000);
  it.each(['correct', 'incorrect'] as const)(
    '显式后继%s只作答一次并关闭恢复，新动作阻止再准备',
    async (reply) => {
      const f = await prepared(),
        observe = async () => observation();
      const authorization = await ManualPracticeReviewAuthorization.create(
        f.store,
        f.receipt.id,
        observe,
        signal(),
      );
      const engine = new TaskEngine({
        store: f.state,
        stage3FixturePractice: true,
        stage2Capabilities: {
          enabled: true,
          inspect: async () => observation().course,
          backup: async () => true,
        },
      });
      await engine.browserConnected();
      await engine.confirmCourse(observation().course, 'course');
      expect((await engine.start()).code).toBe('UNCONFIRMED_OPERATION');
      expect((await engine.startAfterManualPracticeReview(authorization)).ok).toBe(true);
      const adapter = new PracticeFaultAdapter();
      adapter.current.courseId = 'course';
      adapter.reply = reply;
      expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
        true,
      );
      expect(adapter.actions.map((a) => a.type)).toEqual(['pause', 'submit', 'close', 'restore']);
      await engine.pause();
      expect((await f.state.load())!.pendingOperations[0]).toEqual(old);
      await expect(f.store.preview(f.review.id, f.receipt.id)).rejects.toThrow(
        'REQUIRES_ZERO_ACTION',
      );
    },
  );
  it('CLI显式父收据默认预览，确认摘要才准备，缺省不能自动接续', async () => {
    const f = await fixture(),
      log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const args = ['--data-dir', f.data, '--review-id', f.review.id, '--predecessor-id', f.first.id];
    await prepareRevalidation(args);
    const preview = JSON.parse(log.mock.calls[0][0] as string);
    expect(preview).toMatchObject({
      mode: 'preview-only',
      predecessorRevalidationId: f.first.id,
      taskStarted: false,
      browserActions: 0,
    });
    await prepareRevalidation([...args, '--acknowledge-digest', preview.snapshotDigest]);
    expect(JSON.parse(log.mock.calls[1][0] as string)).toMatchObject({
      mode: 'revalidation-prepared',
      taskStarted: false,
      browserActions: 0,
    });
    await expect(
      prepareRevalidation(['--data-dir', f.data, '--review-id', f.review.id]),
    ).rejects.toThrow('REQUIRES_ZERO_ACTION');
  });
});
