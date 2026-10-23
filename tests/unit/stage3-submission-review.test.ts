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
import type { OperationRecord } from '../../packages/contracts/src/index';

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
async function fixture(seedOperations: OperationRecord[] = []) {
  const data = await mkdtemp(join(tmpdir(), 'stage3-submission-review-'));
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
    pendingOperations: [old, ...seedOperations],
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
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('stage3-submission-review-')
    )
      throw new Error('REFUSE_OUTSIDE_TEST_TEMP');
    await rm(target, { recursive: true, force: true });
  }
});

describe('显式复验历史零操作章节', () => {
  async function candidate(seed: OperationRecord[] = []) {
    const f = await fixture(seed);
    const parent = await f.store.record(
      f.review.id,
      (await f.store.preview(f.review.id, f.first.id)).snapshotDigest,
      decision,
      undefined,
      f.first.id,
    );
    await f.store.claim(parent.id, 'current-task', 'current-chapter', signal());
    const pending = { ...submitted, taskId: 'current-task' };
    await f.state.write({
      ...(await f.state.load())!,
      taskId: 'current-task',
      chapterId: 'current-chapter',
      pendingOperations: [old, ...seed, pending],
    });
    return { ...f, parent, pending };
  }
  async function prepared() {
    const f = await candidate();
    const preview = await f.store.preview(f.review.id, f.parent.id, true, true);
    const receipt = await f.store.record(
      f.review.id,
      preview.snapshotDigest,
      reviewedDecision,
      undefined,
      f.parent.id,
      true,
    );
    return { ...f, receipt };
  }
  async function rewrite(
    f: Awaited<ReturnType<typeof prepared>>,
    change: (body: Record<string, any>) => void,
  ) {
    const path = join(f.folder, f.receipt.id, 'receipt.json');
    const { integrityDigest: _digest, ...body } = JSON.parse(await readFile(path, 'utf8'));
    change(body);
    await writeFile(
      path,
      JSON.stringify({
        ...body,
        integrityDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      }),
    );
  }
  it('默认仍排除所有历史章，旧收据形状与加载保持', async () => {
    const f = await candidate();
    const preview = await f.store.preview(f.review.id, f.parent.id, true);
    expect(preview.excludedChapterIds).toContain('first-chapter');
    expect(preview).not.toHaveProperty('reusedZeroActionChapterId');
    const receipt = await f.store.record(
      f.review.id,
      preview.snapshotDigest,
      reviewedDecision,
      undefined,
      f.parent.id,
    );
    expect(await f.store.load(receipt.id)).toEqual(receipt);
    await expect(f.store.claim(receipt.id, 'new-task', 'first-chapter', signal())).rejects.toThrow(
      'OLD_CONTEXT_FORBIDDEN',
    );
  });
  it('显式收据仅移除已证明的章，旧收据与账本逐字节保持', async () => {
    const f = await candidate(),
      path = join(f.folder, f.parent.id, 'receipt.json');
    const before = await readFile(path, 'utf8'),
      snapshot = await readFile(join(f.data, 'state/snapshot.json'), 'utf8');
    const preview = await f.store.preview(f.review.id, f.parent.id, true, true);
    expect(preview).toMatchObject({
      reusedZeroActionChapterId: 'first-chapter',
      reviewedOperations: [old, f.pending],
    });
    expect(preview.excludedChapterIds).toEqual([
      'original-chapter',
      'parent-chapter',
      'current-chapter',
    ]);
    const receipt = await f.store.record(
      f.review.id,
      preview.snapshotDigest,
      reviewedDecision,
      undefined,
      f.parent.id,
      true,
    );
    expect(await f.store.load(receipt.id)).toEqual(receipt);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readFile(join(f.data, 'state/snapshot.json'), 'utf8')).toBe(snapshot);
    await f.store.claim(receipt.id, 'new-task', 'first-chapter', signal());
  });
  it('没有零动作后继证明不得复用', async () => {
    const f = await fixture();
    await expect(f.store.preview(f.review.id, undefined, false, true)).rejects.toThrow();
    await expect(f.store.preview(f.review.id, f.first.id, false, true)).rejects.toThrow(
      'ZERO_ACTION_PROOF_REQUIRED',
    );
  });
  it('提交待确认的前置章节拒绝，不能把提交后人工审阅当零动作证明', async () => {
    const f = await reviewedFixture();
    await f.store.claim(f.receipt.id, 'current-task', 'current-chapter', signal());
    await f.state.write({
      ...(await f.state.load())!,
      taskId: 'current-task',
      chapterId: 'current-chapter',
    });
    await expect(f.store.preview(f.review.id, f.receipt.id, false, true)).rejects.toThrow(
      'ZERO_ACTION_PROOF_REQUIRED',
    );
  });
  it.each(['completed', 'failed', 'pending', 'executing', 'awaiting-confirmation'] as const)(
    '目标章历史任务存在%s操作均拒绝',
    async (status) => {
      const seeded = { ...pause, operationId: 'seed', taskId: 'first-task', status };
      const f = await candidate(['completed', 'failed'].includes(status) ? [seeded] : []);
      if (!['completed', 'failed'].includes(status))
        await f.state.write({
          ...(await f.state.load())!,
          pendingOperations: [old, f.pending, seeded],
        });
      await expect(f.store.preview(f.review.id, f.parent.id, true, true)).rejects.toThrow();
    },
  );
  it.each(['original-chapter', 'current-chapter', 'fake-chapter'])(
    '重算摘要篡改允许章为%s仍拒绝',
    async (chapter) => {
      const f = await prepared();
      await rewrite(f, (body) => {
        body.reusedZeroActionChapterId = chapter;
        body.excludedChapterIds = body.excludedChapterIds.filter((v: string) => v !== chapter);
      });
      await expect(f.store.load(f.receipt.id)).rejects.toThrow('CORRUPT');
    },
  );
  it('删除新字段但保留被缩减的排除表仍拒绝', async () => {
    const f = await prepared();
    await rewrite(f, (body) => {
      delete body.reusedZeroActionChapterId;
    });
    await expect(f.store.load(f.receipt.id)).rejects.toThrow('CORRUPT');
  });
  it('祖先备份损坏拒绝', async () => {
    const f = await prepared();
    await writeFile(join(f.folder, f.first.id, 'state/snapshot.json'), '{}');
    await expect(f.store.load(f.receipt.id)).rejects.toThrow();
  });
  it('祖先双claim不一致拒绝', async () => {
    const f = await prepared();
    await writeFile(join(f.folder, f.first.id, 'claim.json'), '{}');
    await expect(f.store.load(f.receipt.id)).rejects.toThrow();
  });
  it('预览后业务改变拒绝准备', async () => {
    const f = await candidate(),
      preview = await f.store.preview(f.review.id, f.parent.id, true, true);
    await f.state.write({ ...(await f.state.load())!, state: 'IDLE' });
    await expect(
      f.store.record(
        f.review.id,
        preview.snapshotDigest,
        reviewedDecision,
        undefined,
        f.parent.id,
        true,
      ),
    ).rejects.toThrow();
  });
  it('消费前修改账本拒绝', async () => {
    const f = await prepared();
    await f.state.write({ ...(await f.state.load())!, pendingOperations: [old] });
    await expect(
      f.store.claim(f.receipt.id, 'new-task', 'first-chapter', signal()),
    ).rejects.toThrow();
  });
  it('仅savedAt变更仍允许消费，消费不能重复', async () => {
    const f = await prepared();
    await f.state.write({
      ...(await f.state.load())!,
      savedAt: new Date(Date.now() + 1).toISOString(),
    });
    await f.store.claim(f.receipt.id, 'new-task', 'first-chapter', signal());
    await expect(
      f.store.claim(f.receipt.id, 'other-task', 'first-chapter', signal()),
    ).rejects.toThrow();
  });
  it('同一前置任务的两个显式收据只能消费一个', async () => {
    const f = await prepared(),
      preview = await f.store.preview(f.review.id, f.parent.id, true, true);
    const second = await f.store.record(
      f.review.id,
      preview.snapshotDigest,
      reviewedDecision,
      undefined,
      f.parent.id,
      true,
    );
    const results = await Promise.allSettled([
      f.store.claim(f.receipt.id, 'one', 'first-chapter', signal()),
      f.store.claim(second.id, 'two', 'first-chapter', signal()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('复验后下一收据重新排除目标章，历史链仍可加载', async () => {
    const f = await prepared();
    await f.store.claim(f.receipt.id, 'new-task', 'first-chapter', signal());
    await f.state.write({
      ...(await f.state.load())!,
      taskId: 'new-task',
      chapterId: 'first-chapter',
    });
    const next = await f.store.preview(f.review.id, f.receipt.id);
    expect(next.excludedChapterIds).toContain('first-chapter');
    const receipt = await f.store.record(
      f.review.id,
      next.snapshotDigest,
      decision,
      undefined,
      f.receipt.id,
    );
    expect(await f.store.load(receipt.id)).toEqual(receipt);
    await expect(f.store.preview(f.review.id, f.receipt.id, false, true)).rejects.toThrow(
      'ZERO_ACTION_PROOF_REQUIRED',
    );
  });
  it('取消准备不写新收据', async () => {
    const f = await candidate(),
      preview = await f.store.preview(f.review.id, f.parent.id, true, true),
      before = await readdir(f.folder),
      control = new AbortController();
    control.abort();
    await expect(
      f.store.record(
        f.review.id,
        preview.snapshotDigest,
        reviewedDecision,
        control.signal,
        f.parent.id,
        true,
      ),
    ).rejects.toThrow();
    expect(await readdir(f.folder)).toEqual(before);
  });
  it('授权只接受合法上下文，保留全部未知且固定当前章', async () => {
    const f = await prepared();
    const observe = async () => {
      const o = observation();
      o.currentChapterId = 'first-chapter';
      o.player!.chapterId = 'first-chapter';
      o.chapters[0].chapterId = 'first-chapter';
      return o;
    };
    const auth = await ManualPracticeReviewAuthorization.create(
      f.store,
      f.receipt.id,
      observe,
      signal(),
    );
    expect(auth.permits([old, f.pending], 'course')).toBe(true);
    expect(auth.permits([old], 'course')).toBe(false);
    await auth.claim('new-task', signal());
    await auth.verify(signal());
    expect((await f.state.load())!.pendingOperations).toEqual([old, f.pending]);
    await expect(
      ManualPracticeReviewAuthorization.create(
        f.store,
        f.receipt.id,
        async () => {
          const o = await observe();
          o.course.courseId = 'other';
          return o;
        },
        signal(),
      ),
    ).rejects.toThrow('FRESH_CHAPTER');
  });
  it.each([
    ['correct', false],
    ['incorrect', false],
    ['correct', true],
    ['incorrect', true],
  ] as const)(
    '三条历史未知保持，零操作章复验%s，已有反馈=%s，仅执行对应动作',
    async (reply, existing) => {
      const f = await prepared();
      await f.store.claim(f.receipt.id, 'middle-task', 'middle-chapter', signal());
      await f.state.write({
        ...(await f.state.load())!,
        taskId: 'middle-task',
        chapterId: 'middle-chapter',
      });
      const parent = await f.store.record(
        f.review.id,
        (await f.store.preview(f.review.id, f.receipt.id)).snapshotDigest,
        decision,
        undefined,
        f.receipt.id,
      );
      await f.store.claim(parent.id, 'last-task', 'last-chapter', signal());
      const third = { ...submitted, operationId: 'third-submit', taskId: 'last-task' };
      const retained = [old, f.pending, third];
      await f.state.write({
        ...(await f.state.load())!,
        taskId: 'last-task',
        chapterId: 'last-chapter',
        pendingOperations: retained,
      });
      const receipt = await f.store.record(
        f.review.id,
        (await f.store.preview(f.review.id, parent.id, true, true)).snapshotDigest,
        reviewedDecision,
        undefined,
        parent.id,
        true,
      );
      expect(receipt.reusedZeroActionChapterId).toBe('middle-chapter');
      const observe = async () => {
        const o = observation();
        o.currentChapterId = 'middle-chapter';
        o.player!.chapterId = 'middle-chapter';
        o.chapters[0].chapterId = 'middle-chapter';
        return o;
      };
      const auth = await ManualPracticeReviewAuthorization.create(
        f.store,
        receipt.id,
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
      expect((await engine.startAfterManualPracticeReview(auth)).ok).toBe(true);
      const adapter = new PracticeFaultAdapter();
      adapter.current.courseId = 'course';
      adapter.reply = reply;
      if (existing) adapter.current.existingFeedback = reply;
      expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
        true,
      );
      await engine.pause();
      expect(adapter.actions.map((a) => a.type)).toEqual(
        existing ? ['close', 'restore'] : ['pause', 'submit', 'close', 'restore'],
      );
      expect((await f.state.load())!.pendingOperations.slice(0, 3)).toEqual(retained);
    },
  );
  it('CLI显式标志默认只预览，false拒绝；准备后收据保留新字段', async () => {
    const f = await candidate(),
      log = vi.spyOn(console, 'log').mockImplementation(() => undefined),
      before = await readdir(f.folder);
    const args = [
      '--data-dir',
      f.data,
      '--review-id',
      f.review.id,
      '--predecessor-id',
      f.parent.id,
      '--review-submission',
      'true',
    ];
    await expect(
      prepareRevalidation([...args, '--reuse-zero-action-chapter', 'false']),
    ).rejects.toThrow('INVALID_ARGUMENTS');
    await prepareRevalidation([...args, '--reuse-zero-action-chapter', 'true']);
    const preview = JSON.parse(log.mock.calls[0][0] as string);
    expect(preview.reusedZeroActionChapterId).toBe('first-chapter');
    expect(await readdir(f.folder)).toEqual(before);
    await prepareRevalidation([
      ...args,
      '--reuse-zero-action-chapter',
      'true',
      '--acknowledge-digest',
      preview.snapshotDigest,
    ]);
    expect(
      (await f.store.load(JSON.parse(log.mock.calls[1][0] as string).receiptId))
        .reusedZeroActionChapterId,
    ).toBe('first-chapter');
  });
});

const reviewedDecision = 'abandon-reviewed-submission-allow-one-fresh-task' as const;
const closeDecision = 'abandon-reviewed-close-allow-one-fresh-task' as const;

describe('显式关闭待确认后单次复验', () => {
  it('三条旧提交未知加新关闭未知全部保留，授权精确匹配四条', async () => {
    const f = await reviewedFixture();
    await f.store.claim(f.receipt.id, 'second-task', 'second-chapter', signal());
    const third: OperationRecord = {
      ...submitted,
      operationId: 'third-submit',
      taskId: 'second-task',
    };
    await f.state.write({
      ...(await f.state.load())!,
      taskId: 'second-task',
      chapterId: 'second-chapter',
      pendingOperations: [old, pause, submitted, third],
    });
    const second = await f.store.record(
      f.review.id,
      (await f.store.preview(f.review.id, f.receipt.id, true)).snapshotDigest,
      reviewedDecision,
      undefined,
      f.receipt.id,
    );
    await f.store.claim(second.id, 'close-task', 'close-chapter', signal());
    const last: OperationRecord = { ...close, taskId: 'close-task' };
    const operations = [old, pause, submitted, third, last];
    await f.state.write({
      ...(await f.state.load())!,
      taskId: 'close-task',
      chapterId: 'close-chapter',
      pendingOperations: operations,
    });
    const p = await f.store.preview(f.review.id, second.id, false, false, true);
    expect(p.reviewedOperations).toEqual([old, submitted, third, last]);
    const r = await f.store.record(
      f.review.id,
      p.snapshotDigest,
      closeDecision,
      undefined,
      second.id,
    );
    const auth = await ManualPracticeReviewAuthorization.create(
      f.store,
      r.id,
      async () => observation(),
      signal(),
    );
    expect(auth.permits(operations, 'course')).toBe(true);
    expect(auth.permits(operations.slice(0, -1), 'course')).toBe(false);
    expect((await f.state.load())!.pendingOperations).toEqual(operations);
    expect((await f.store.load(r.id)).reviewedOperations).toEqual(p.reviewedOperations);
  });
  const close: OperationRecord = {
    operationId: 'new-close',
    taskId: 'first-task',
    kind: 'practice-close',
    status: 'awaiting-confirmation',
    savedAt: '2026-10-22T01:00:00.000Z',
  };
  async function closed(prefix = 2) {
    const f = await fixture();
    const operations: OperationRecord[] = [
      old,
      ...(prefix === 2 ? [pause] : []),
      ...(prefix ? [{ ...submitted, status: 'completed' as const }] : []),
      close,
    ];
    await f.state.write({ ...(await f.state.load())!, pendingOperations: operations });
    return { ...f, operations };
  }
  const preview = (f: Awaited<ReturnType<typeof closed>>) =>
    f.store.preview(f.review.id, f.first.id, false, false, true);
  async function prepare(f: Awaited<ReturnType<typeof closed>>) {
    return f.store.record(
      f.review.id,
      (await preview(f)).snapshotDigest,
      closeDecision,
      undefined,
      f.first.id,
    );
  }
  it.each([0, 1, 2])('允许已完成前缀长度%s，逐字节备份且保持未知', async (prefix) => {
    const f = await closed(prefix),
      before = await readFile(join(f.data, 'state/snapshot.json'), 'utf8');
    const p = await preview(f);
    expect(p.reviewedOperations).toEqual([old, close]);
    expect(p.excludedChapterIds).toContain('first-chapter');
    const receipt = await prepare(f);
    expect(receipt.decision).toBe(closeDecision);
    expect(await f.store.load(receipt.id)).toEqual(receipt);
    expect(await readFile(join(f.data, 'state/snapshot.json'), 'utf8')).toBe(before);
    expect(await readFile(join(f.folder, receipt.id, 'state/snapshot.json'), 'utf8')).toBe(before);
  });
  it('默认与提交复核仍拒绝，缺少父任务及混合标志拒绝', async () => {
    const f = await closed();
    await expect(f.store.preview(f.review.id, f.first.id)).rejects.toThrow('REQUIRES_ZERO_ACTION');
    await expect(f.store.preview(f.review.id, f.first.id, true)).rejects.toThrow(
      'REVIEW_SUBMISSION_REQUIRED',
    );
    await expect(f.store.preview(f.review.id, undefined, false, false, true)).rejects.toThrow(
      'REVIEW_PARENT_REQUIRED',
    );
    await expect(f.store.preview(f.review.id, f.first.id, true, false, true)).rejects.toThrow(
      'FLAGS_CONFLICT',
    );
    await expect(f.store.preview(f.review.id, f.first.id, false, true, true)).rejects.toThrow(
      'FLAGS_CONFLICT',
    );
  });
  it.each([
    'old-mutated',
    'old-removed',
    'submit-unknown',
    'close-completed',
    'close-executing',
    'wrong-task',
    'restore-added',
    'extra-submit',
    'pause-only',
    'reverse',
    'no-close',
  ])('拒绝无效账本%s', async (kind) => {
    const f = await closed();
    const ops = structuredClone(f.operations);
    if (kind === 'old-mutated') ops[0].savedAt = '2026-10-22T02:00:00.000Z';
    if (kind === 'old-removed') ops.shift();
    if (kind === 'submit-unknown') ops[2].status = 'awaiting-confirmation';
    if (kind === 'close-completed') ops[3].status = 'completed';
    if (kind === 'close-executing') ops[3].status = 'executing';
    if (kind === 'wrong-task') ops[3].taskId = 'other';
    if (kind === 'restore-added')
      ops.push({ ...close, operationId: 'restore', kind: 'practice-restore' });
    if (kind === 'extra-submit') ops.splice(3, 0, { ...ops[2], operationId: 'duplicate-submit' });
    if (kind === 'pause-only') ops.splice(2, 1);
    if (kind === 'reverse') [ops[1], ops[2]] = [ops[2], ops[1]];
    if (kind === 'no-close') ops.pop();
    await f.state.write({ ...(await f.state.load())!, pendingOperations: ops });
    await expect(preview(f)).rejects.toThrow('REVIEW_CLOSE_REQUIRED');
  });
  it('一次claim且禁止旧章旧任务；零操作后继仍保留关闭未知', async () => {
    const f = await closed(),
      r = await prepare(f);
    await expect(f.store.claim(r.id, 'fresh-task', 'first-chapter', signal())).rejects.toThrow(
      'OLD_CONTEXT',
    );
    await expect(f.store.claim(r.id, 'first-task', 'fresh-chapter', signal())).rejects.toThrow(
      'OLD_CONTEXT',
    );
    await f.store.claim(r.id, 'fresh-task', 'fresh-chapter', signal());
    await expect(
      f.store.claim(r.id, 'another-task', 'another-chapter', signal()),
    ).rejects.toThrow();
    await f.state.write({
      ...(await f.state.load())!,
      taskId: 'fresh-task',
      chapterId: 'fresh-chapter',
    });
    const p = await f.store.preview(f.review.id, r.id);
    expect(p.reviewedOperations).toEqual([old, close]);
    const next = await f.store.record(f.review.id, p.snapshotDigest, decision, undefined, r.id);
    expect((await f.store.load(next.id)).reviewedOperations).toEqual([old, close]);
  });
  it('快照变化拒绝消费；未知记录不可少报', async () => {
    const f = await closed(),
      r = await prepare(f);
    const auth = await ManualPracticeReviewAuthorization.create(
      f.store,
      r.id,
      async () => observation(),
      signal(),
    );
    expect(auth.permits(f.operations, 'course')).toBe(true);
    expect(
      auth.permits(
        f.operations.filter((o) => o !== close),
        'course',
      ),
    ).toBe(false);
    await f.state.write({
      ...(await f.state.load())!,
      pendingOperations: [...f.operations, { ...close, operationId: 'extra' }],
    });
    await expect(f.store.claim(r.id, 'fresh-task', 'fresh-chapter', signal())).rejects.toThrow();
  });
  it('收据即使重算摘要，删改关闭复核信息仍拒绝加载', async () => {
    const f = await closed(),
      r = await prepare(f),
      path = join(f.folder, r.id, 'receipt.json');
    const { integrityDigest: _, ...body } = JSON.parse(await readFile(path, 'utf8'));
    body.decision = decision;
    await writeFile(
      path,
      JSON.stringify({
        ...body,
        integrityDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      }),
    );
    await expect(f.store.load(r.id)).rejects.toThrow();
  });
  it('CLI显式关闭复核默认只读，冲突值拒绝，ack后可加载', async () => {
    const f = await closed(),
      log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const args = ['--data-dir', f.data, '--review-id', f.review.id, '--predecessor-id', f.first.id];
    const before = await readdir(f.folder);
    await expect(prepareRevalidation([...args, '--review-close', 'false'])).rejects.toThrow(
      'INVALID_ARGUMENTS',
    );
    await expect(
      prepareRevalidation([...args, '--review-close', 'true', '--review-submission', 'true']),
    ).rejects.toThrow('FLAGS_CONFLICT');
    await prepareRevalidation([...args, '--review-close', 'true']);
    const p = JSON.parse(log.mock.calls[0][0] as string);
    expect(p).toMatchObject({
      mode: 'preview-only',
      decision: closeDecision,
      taskStarted: false,
      browserActions: 0,
    });
    expect(await readdir(f.folder)).toEqual(before);
    await prepareRevalidation([
      ...args,
      '--review-close',
      'true',
      '--acknowledge-digest',
      p.snapshotDigest,
    ]);
    expect(
      (await f.store.load(JSON.parse(log.mock.calls[1][0] as string).receiptId)).reviewedOperations,
    ).toEqual([old, close]);
  });
  it('引擎显式新任务保留旧关闭未知，普通启动仍阻止', async () => {
    const f = await closed(),
      r = await prepare(f);
    const auth = await ManualPracticeReviewAuthorization.create(
      f.store,
      r.id,
      async () => observation(),
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
    expect((await engine.startAfterManualPracticeReview(auth)).ok).toBe(true);
    const adapter = new PracticeFaultAdapter();
    adapter.current.courseId = 'course';
    expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
      true,
    );
    await engine.pause();
    expect((await f.state.load())!.pendingOperations.slice(0, f.operations.length)).toEqual(
      f.operations,
    );
  });
});
const pause = {
  operationId: 'new-pause',
  taskId: 'first-task',
  kind: 'practice-pause',
  status: 'completed' as const,
  savedAt: '2026-10-21T01:00:00.000Z',
};
const submitted = {
  operationId: 'new-submit',
  taskId: 'first-task',
  kind: 'practice-submit',
  status: 'awaiting-confirmation' as const,
  savedAt: '2026-10-21T01:00:01.000Z',
};
async function submittedFixture(withPause = true) {
  const f = await fixture();
  await f.state.write({
    ...(await f.state.load())!,
    pendingOperations: [old, ...(withPause ? [pause] : []), submitted],
  });
  return f;
}
async function reviewedFixture() {
  const f = await submittedFixture();
  const preview = await f.store.preview(f.review.id, f.first.id, true);
  const receipt = await f.store.record(
    f.review.id,
    preview.snapshotDigest,
    reviewedDecision,
    undefined,
    f.first.id,
  );
  return { ...f, receipt };
}

describe('阶段3多条待确认：显式人工处理后新任务', () => {
  it.each([false, true])(
    '精确一次提交、此前pause=%s：原账本逐字节备份，所有未知保持',
    async (withPause) => {
      const f = await submittedFixture(withPause),
        before = await readFile(join(f.data, 'state/snapshot.json'), 'utf8');
      const preview = await f.store.preview(f.review.id, f.first.id, true);
      expect(preview.reviewedOperations).toEqual([old, submitted]);
      expect(preview.excludedChapterIds).toEqual([
        'original-chapter',
        'parent-chapter',
        'first-chapter',
      ]);
      const receipt = await f.store.record(
        f.review.id,
        preview.snapshotDigest,
        reviewedDecision,
        undefined,
        f.first.id,
      );
      expect(await f.store.load(receipt.id)).toEqual(receipt);
      expect(await readFile(join(f.folder, receipt.id, 'state/snapshot.json'), 'utf8')).toBe(
        before,
      );
      expect(await readFile(join(f.data, 'state/snapshot.json'), 'utf8')).toBe(before);
    },
  );
  it('默认零动作模式和原人工入口继续拒绝两条未知，不能自动改为人工处理模式', async () => {
    const f = await submittedFixture();
    await expect(f.store.preview(f.review.id, f.first.id)).rejects.toThrow('REQUIRES_ZERO_ACTION');
    await expect(f.original.preview()).rejects.toThrow('NOT_ELIGIBLE');
    await expect(f.store.preview(f.review.id, undefined, true)).rejects.toThrow(
      'REVIEW_PARENT_REQUIRED',
    );
    await expect(
      f.store.record(
        f.review.id,
        (await f.state.load())!.integrityDigest,
        decision,
        undefined,
        f.first.id,
      ),
    ).rejects.toThrow('REQUIRES_ZERO_ACTION');
  });
  it.each([
    'old-change',
    'old-remove',
    'old-reorder',
    'extra',
    'pause-pending',
    'pause-failed',
    'submit-pending',
    'submit-executing',
    'submit-completed',
    'submit-failed',
    'wrong-task',
    'wrong-kind',
    'missing-submit',
    'active',
    'wrong-chapter',
  ])('非法状态%s不能准备新收据', async (kind) => {
    const f = await submittedFixture(),
      snapshot = (await f.state.load())!;
    if (kind === 'old-change') snapshot.pendingOperations[0].savedAt = '2026-10-21T00:00:00.000Z';
    if (kind === 'old-remove') snapshot.pendingOperations.shift();
    if (kind === 'old-reorder') snapshot.pendingOperations.reverse();
    if (kind === 'extra')
      snapshot.pendingOperations.push({ ...pause, operationId: 'extra', kind: 'practice-close' });
    if (kind === 'pause-pending') snapshot.pendingOperations[1].status = 'pending';
    if (kind === 'pause-failed') snapshot.pendingOperations[1].status = 'failed';
    if (kind.startsWith('submit-'))
      snapshot.pendingOperations[2].status = kind.slice(7) as typeof submitted.status;
    if (kind === 'wrong-task') snapshot.pendingOperations[2].taskId = 'unrelated';
    if (kind === 'wrong-kind') snapshot.pendingOperations[2].kind = 'practice-close';
    if (kind === 'missing-submit') snapshot.pendingOperations.pop();
    if (kind === 'active') snapshot.state = 'MONITORING';
    if (kind === 'wrong-chapter') snapshot.chapterId = 'unrelated';
    await f.state.write(snapshot);
    await expect(f.store.preview(f.review.id, f.first.id, true)).rejects.toThrow();
  });
  it('未发生新提交不能使用新的人工处理决定', async () => {
    const f = await fixture();
    await expect(f.store.preview(f.review.id, f.first.id, true)).rejects.toThrow(
      'REVIEW_SUBMISSION_REQUIRED',
    );
  });
  it.each(['parent-claim', 'parent-backup', 'own-backup', 'list'])(
    '加载时检测%s改变',
    async (kind) => {
      const f = await reviewedFixture();
      if (kind === 'parent-claim') await writeFile(join(f.folder, f.first.id, 'claim.json'), '{}');
      if (kind === 'parent-backup')
        await writeFile(join(f.folder, f.first.id, 'settings.json'), '{}');
      if (kind === 'own-backup')
        await writeFile(join(f.folder, f.receipt.id, 'settings.json'), '{}');
      if (kind === 'list') {
        const path = join(f.folder, f.receipt.id, 'receipt.json');
        const { integrityDigest: _, ...body } = JSON.parse(await readFile(path, 'utf8'));
        body.reviewedOperations.pop();
        await writeFile(
          path,
          JSON.stringify({
            ...body,
            integrityDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
          }),
        );
      }
      await expect(f.store.load(f.receipt.id)).rejects.toThrow();
    },
  );
  it('旧收据形状不增加字段，新的未知清单不可由授权持有方修改', async () => {
    const f = await reviewedFixture();
    expect(await f.store.load(f.first.id)).not.toHaveProperty('reviewedOperations');
    const auth = await ManualPracticeReviewAuthorization.create(
      f.store,
      f.receipt.id,
      async () => observation(),
      signal(),
    );
    expect(Object.isFrozen(auth.receipt.reviewedOperations)).toBe(true);
    expect(Object.isFrozen(auth.receipt.reviewedOperations![0])).toBe(true);
    expect(Object.isFrozen(auth.receipt.operation)).toBe(true);
  });
  it.each(['missing', 'added', 'changed', 'reordered', 'course'])(
    '授权不容许未知清单%s',
    async (kind) => {
      const f = await reviewedFixture();
      const auth = await ManualPracticeReviewAuthorization.create(
        f.store,
        f.receipt.id,
        async () => observation(),
        signal(),
      );
      const operations = [{ ...old }, { ...submitted }];
      expect(auth.permits(operations, 'course')).toBe(true);
      if (kind === 'missing') operations.pop();
      if (kind === 'added') operations.push({ ...submitted, operationId: 'another' });
      if (kind === 'changed') operations[1].savedAt = '2026-10-21T02:00:00.000Z';
      if (kind === 'reordered') operations.reverse();
      expect(auth.permits(operations, kind === 'course' ? 'another' : 'course')).toBe(false);
    },
  );
  it('取消和陈旧预览均不准备收据', async () => {
    const f = await submittedFixture(),
      before = await readdir(f.folder);
    const abort = new AbortController();
    abort.abort();
    await expect(
      f.store.record(
        f.review.id,
        (await f.state.load())!.integrityDigest,
        reviewedDecision,
        abort.signal,
        f.first.id,
      ),
    ).rejects.toThrow();
    await expect(
      f.store.record(f.review.id, '0'.repeat(64), reviewedDecision, undefined, f.first.id),
    ).rejects.toThrow('PREVIEW_CHANGED');
    expect(await readdir(f.folder)).toEqual(before);
  });
  it('消费前业务变化仍拒绝；仅更新时间戳可通过', async () => {
    const f = await reviewedFixture();
    const original = (await f.state.load())!;
    await f.state.write({
      ...original,
      confirmedPlatformStatuses: [
        { chapterId: 'first-chapter', completed: true, observedAt: new Date().toISOString() },
      ],
    });
    await expect(f.store.claim(f.receipt.id, 'next', 'next-chapter', signal())).rejects.toThrow(
      'SOURCE_CHANGED',
    );
    await f.state.write({ ...original, savedAt: new Date().toISOString() });
    await expect(
      f.store.claim(f.receipt.id, 'next', 'next-chapter', signal()),
    ).resolves.toBeUndefined();
  });
  it('重复收据并发只允许消费一个后继任务，所有历史章节拒绝', async () => {
    const f = await reviewedFixture();
    for (const chapter of f.receipt.excludedChapterIds)
      await expect(f.store.claim(f.receipt.id, 'new', chapter, signal())).rejects.toThrow(
        'OLD_CONTEXT',
      );
    const other = await f.store.record(
      f.review.id,
      f.receipt.snapshotDigest,
      reviewedDecision,
      undefined,
      f.first.id,
    );
    const results = await Promise.allSettled([
      f.store.claim(f.receipt.id, 'next1', 'next-chapter', signal()),
      f.store.claim(other.id, 'next2', 'next-chapter', signal()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('明确零动作后继继承全部未知清单，不允许退回只匹配一个', async () => {
    const f = await reviewedFixture();
    await f.store.claim(f.receipt.id, 'next', 'next-chapter', signal());
    await f.state.write({ ...(await f.state.load())!, taskId: 'next', chapterId: 'next-chapter' });
    const preview = await f.store.preview(f.review.id, f.receipt.id);
    const next = await f.store.record(
      f.review.id,
      preview.snapshotDigest,
      decision,
      undefined,
      f.receipt.id,
    );
    expect((await f.store.load(next.id)).reviewedOperations).toEqual([old, submitted]);
  });
  it.each(['correct', 'incorrect'] as const)(
    '两条旧未知保持：%s单次作答关闭并续播',
    async (reply) => {
      const f = await reviewedFixture();
      const auth = await ManualPracticeReviewAuthorization.create(
        f.store,
        f.receipt.id,
        async () => observation(),
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
      expect((await engine.startAfterManualPracticeReview(auth)).ok).toBe(true);
      const adapter = new PracticeFaultAdapter();
      adapter.current.courseId = 'course';
      adapter.reply = reply;
      expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
        true,
      );
      await engine.pause();
      expect(adapter.actions.map((a) => a.type)).toEqual(['pause', 'submit', 'close', 'restore']);
      expect((await f.state.load())!.pendingOperations.slice(0, 3)).toEqual([
        old,
        pause,
        submitted,
      ]);
      await expect(f.store.preview(f.review.id, f.receipt.id, true)).rejects.toThrow(
        'REVIEW_SUBMISSION_REQUIRED',
      );
    },
  );
  it('CLI必须显式选择提交后处理，默认只读，错误值及缺失父ID拒绝', async () => {
    const f = await submittedFixture(),
      log = vi.spyOn(console, 'log').mockImplementation(() => undefined),
      before = await readdir(f.folder);
    const args = ['--data-dir', f.data, '--review-id', f.review.id, '--predecessor-id', f.first.id];
    await expect(prepareRevalidation(args)).rejects.toThrow('REQUIRES_ZERO_ACTION');
    await expect(prepareRevalidation([...args, '--review-submission', 'false'])).rejects.toThrow(
      'INVALID_ARGUMENTS',
    );
    await prepareRevalidation([...args, '--review-submission', 'true']);
    const preview = JSON.parse(log.mock.calls[0][0] as string);
    expect(preview).toMatchObject({
      mode: 'preview-only',
      decision: reviewedDecision,
      taskStarted: false,
      browserActions: 0,
      reviewedOperations: [old, submitted],
    });
    expect(await readdir(f.folder)).toEqual(before);
    await prepareRevalidation([
      ...args,
      '--review-submission',
      'true',
      '--acknowledge-digest',
      preview.snapshotDigest,
    ]);
    const result = JSON.parse(log.mock.calls[1][0] as string);
    expect(result.taskStarted).toBe(false);
    expect((await f.store.load(result.receiptId)).reviewedOperations).toEqual([old, submitted]);
  });
});
