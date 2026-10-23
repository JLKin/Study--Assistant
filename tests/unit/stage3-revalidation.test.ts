import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationRecord } from '../../packages/contracts/src/index';
import { DEFAULT_CONFIG } from '../../packages/contracts/src/config';
import type { SiteObservation } from '../../packages/contracts/src/monitor';
import { StateStore } from '../../packages/persistence/src/index';
import { ManualPracticeReviewStore } from '../../packages/persistence/src/manual-practice-review';
import { PracticeRevalidationStore } from '../../packages/persistence/src/practice-revalidation';
import { ManualPracticeReviewAuthorization } from '../../packages/task-engine/src/manual-practice-review';
import { TaskEngine } from '../../packages/task-engine/src/index';
import { PracticeSession } from '../../packages/practice/src/index';
import { PracticeFaultAdapter, fixedRandom } from '../helpers/stage3';
import { prepareRevalidation } from '../../scripts/stage3-revalidation-tool';
const roots: string[] = [];
const old: OperationRecord = {
  operationId: 'old-submit',
  taskId: 'old-task',
  kind: 'practice-submit',
  status: 'awaiting-confirmation',
  savedAt: '2026-10-20T00:00:00.000Z',
};
const DECISION = 'allow-one-new-practice-after-zero-actions' as const;
function observation(): SiteObservation {
  const time = new Date().toISOString();
  return {
    course: {
      courseId: 'course',
      title: 'fixture',
      source: 'fixture',
      authenticated: true,
      pageKind: 'course',
      confidence: 'verified',
      platformCompleted: null,
      observedAt: time,
      evidence: ['fixture'],
    },
    player: {
      chapterId: 'fresh-chapter',
      currentTime: 3,
      duration: 120,
      playbackRate: 1,
      paused: false,
      ended: false,
      buffering: false,
      confidence: 'verified',
      observedAt: time,
    },
    chapters: [
      {
        chapterId: 'fresh-chapter',
        title: 'fixture',
        platformCompleted: false,
        confidence: 'verified',
        observedAt: time,
      },
    ],
    currentChapterId: 'fresh-chapter',
    supportedRates: [1],
    popup: 'none',
    safeToRefresh: false,
  };
}
async function fixture() {
  const data = await mkdtemp(join(tmpdir(), 'stage3-revalidation-'));
  roots.push(data);
  await mkdir(join(data, 'config'));
  await writeFile(
    join(data, 'config/settings.json'),
    JSON.stringify(DEFAULT_CONFIG, null, 2) + '\r\n',
  );
  const state = new StateStore(data);
  await state.write({
    schemaVersion: 1,
    taskId: 'old-task',
    courseId: 'course',
    chapterId: 'old-chapter',
    savedAt: new Date().toISOString(),
    state: 'PAUSED',
    pendingOperations: [{ ...old }],
    confirmedPlatformStatuses: [],
  });
  const original = new ManualPracticeReviewStore(data);
  const receipt = await original.record(
    (await original.preview()).snapshotDigest,
    'abandon-old-attempt-allow-one-fresh-task',
  );
  await original.claim(
    receipt.id,
    'previous-task',
    'previous-chapter',
    new AbortController().signal,
  );
  const snapshot = (await state.load())!;
  await state.write({
    ...snapshot,
    taskId: 'previous-task',
    chapterId: 'previous-chapter',
    savedAt: new Date().toISOString(),
  });
  const store = new PracticeRevalidationStore(data, original);
  const preview = await store.preview(receipt.id);
  return { data, state, original, receipt, store, preview };
}
async function prepared() {
  const f = await fixture();
  const ticket = await f.store.record(f.receipt.id, f.preview.snapshotDigest, DECISION);
  return { ...f, ticket, directory: join(f.data, 'state/practice-revalidation', ticket.id) };
}
async function admitted() {
  const f = await prepared();
  let sample = observation();
  const auth = await ManualPracticeReviewAuthorization.create(
    f.store,
    f.ticket.id,
    async () => structuredClone(sample),
    new AbortController().signal,
  );
  const backup = vi.fn(async () => true);
  const engine = new TaskEngine({
    store: f.state,
    stage3FixturePractice: true,
    stage2Capabilities: { enabled: true, inspect: async () => sample.course, backup },
  });
  await engine.browserConnected();
  await engine.confirmCourse(sample.course, 'course');
  return {
    ...f,
    auth,
    engine,
    backup,
    set: (next: SiteObservation) => {
      sample = next;
    },
  };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) {
    const target = resolve(path);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('stage3-revalidation-')
    )
      throw new Error('UNSAFE_TEST_CLEANUP');
    await rm(target, { recursive: true, force: true });
  }
});
describe('stage3 revalidation after proven zero-action stop', () => {
  it('任务前备份失败时不消费新收据，普通入口仍锁止', async () => {
    const f = await admitted();
    f.backup.mockResolvedValue(false);
    expect((await f.engine.startAfterManualPracticeReview(f.auth)).code).toBe('BACKUP_FAILED');
    expect(await readdir(join(f.data, 'state/practice-revalidation'))).not.toContain(
      'predecessor-previous-task.claim.json',
    );
    expect((await f.engine.start()).code).toBe('UNCONFIRMED_OPERATION');
  });
  it('备份等待中暂停立即取消，未发动作且未消费', async () => {
    const f = await admitted();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.backup.mockImplementation(async () => {
      await gate;
      return true;
    });
    const start = f.engine.startAfterManualPracticeReview(f.auth);
    await vi.waitFor(() => expect(f.backup).toHaveBeenCalledOnce());
    await f.engine.pause();
    release();
    expect((await start).code).toBe('CANCELLED');
    expect(await readdir(join(f.data, 'state/practice-revalidation'))).not.toContain(
      'predecessor-previous-task.claim.json',
    );
    expect((await f.state.load())!.pendingOperations).toEqual([old]);
  });
  it('claim读取期间取消，不留下前任务消费标记', async () => {
    const f = await prepared(),
      controller = new AbortController();
    const originalLoad = f.store.load.bind(f.store);
    const load = vi.spyOn(f.store, 'load').mockImplementation(async (id) => {
      const result = await originalLoad(id);
      controller.abort();
      return result;
    });
    await expect(
      f.store.claim(f.ticket.id, 'next-task', 'fresh-chapter', controller.signal),
    ).rejects.toThrow();
    load.mockRestore();
    expect(await readdir(join(f.data, 'state/practice-revalidation'))).not.toContain(
      'predecessor-previous-task.claim.json',
    );
  });
  it('默认预览不创建收据、不改旧快照或claim', async () => {
    const f = await fixture();
    const before = await readFile(f.state.snapshotPath);
    const entries = await readdir(join(f.data, 'state'));
    expect(f.preview.predecessorTaskId).toBe('previous-task');
    expect(f.preview.excludedChapterIds).toEqual(['old-chapter', 'previous-chapter']);
    expect(await readdir(join(f.data, 'state'))).toEqual(entries);
    expect(await readFile(f.state.snapshotPath)).toEqual(before);
  });
  it('新收据逐字节备份，旧收据与两个旧claim原字节保留', async () => {
    const f = await fixture();
    const names = await readdir(join(f.data, 'state/manual-practice-review'));
    const claimName = names.find((name) => name.endsWith('.claim.json'))!;
    const oldReceipt = await readFile(
      join(f.data, 'state/manual-practice-review', f.receipt.id, 'receipt.json'),
    );
    const oldClaim = await readFile(join(f.data, 'state/manual-practice-review', claimName));
    const ticket = await f.store.record(f.receipt.id, f.preview.snapshotDigest, DECISION);
    const directory = join(f.data, 'state/practice-revalidation', ticket.id);
    expect(await readFile(join(directory, 'state/snapshot.json'))).toEqual(
      await readFile(f.state.snapshotPath),
    );
    expect(await readFile(join(directory, 'settings.json'))).toEqual(
      await readFile(join(f.data, 'config/settings.json')),
    );
    expect(
      await readFile(join(f.data, 'state/manual-practice-review', f.receipt.id, 'receipt.json')),
    ).toEqual(oldReceipt);
    expect(await readFile(join(f.data, 'state/manual-practice-review', claimName))).toEqual(
      oldClaim,
    );
    expect(ticket.outcome).toBe('unknown');
    expect((await f.state.load())!.pendingOperations).toEqual([old]);
  });
  it.each(['completed', 'failed', 'pending', 'executing', 'awaiting-confirmation'] as const)(
    '新增动作即使%s也禁止本入口',
    async (status) => {
      const f = await fixture();
      const source = (await f.state.load())!;
      await f.state.write({
        ...source,
        pendingOperations: [
          ...source.pendingOperations,
          {
            ...old,
            operationId: 'another',
            taskId: 'previous-task',
            kind: 'practice-pause',
            status,
          },
        ],
      });
      await expect(f.store.preview(f.receipt.id)).rejects.toThrow(
        'REVALIDATION_REQUIRES_ZERO_ACTION_PAUSED_TASK',
      );
    },
  );
  it.each(['task', 'chapter', 'course', 'running', 'old-status'])(
    '%s变化拒绝，不把新未知当旧未知',
    async (field) => {
      const f = await fixture();
      const source = (await f.state.load())!;
      if (field === 'task') source.taskId = 'other-task';
      if (field === 'chapter') source.chapterId = 'other-chapter';
      if (field === 'course') source.courseId = 'other-course';
      if (field === 'running') source.state = 'MONITORING';
      if (field === 'old-status') source.pendingOperations[0].status = 'completed';
      await f.state.write(source);
      await expect(f.store.preview(f.receipt.id)).rejects.toThrow();
    },
  );
  it.each(['receipt', 'claim', 'attempt'])('原%s损坏拒绝', async (what) => {
    const f = await fixture();
    const parent = join(f.data, 'state/manual-practice-review');
    const path =
      what === 'attempt'
        ? join(
            parent,
            (await readdir(parent)).find((name) => name.endsWith('.claim.json'))!,
          )
        : join(parent, f.receipt.id, what + '.json');
    await writeFile(path, '{}');
    await expect(f.store.preview(f.receipt.id)).rejects.toThrow();
  });
  it('陈旧预览、未明确决定和取消都不建有效收据', async () => {
    const f = await fixture();
    const source = (await f.state.load())!;
    await f.state.write({ ...source, savedAt: '2026-10-20T01:02:03.456Z' });
    await expect(f.store.record(f.receipt.id, f.preview.snapshotDigest, DECISION)).rejects.toThrow(
      'REVALIDATION_PREVIEW_CHANGED',
    );
    await expect(
      f.store.record(f.receipt.id, f.preview.snapshotDigest, 'completed' as typeof DECISION),
    ).rejects.toThrow('REVALIDATION_EXPLICIT_DECISION_REQUIRED');
    const abort = new AbortController();
    abort.abort();
    await expect(
      f.store.record(f.receipt.id, f.preview.snapshotDigest, DECISION, abort.signal),
    ).rejects.toThrow();
    expect(await readdir(join(f.data, 'state'))).not.toContain('practice-revalidation');
  });
  it.each(['receipt.json', 'state/snapshot.json', 'settings.json'])(
    '新备份%s损坏不可消费',
    async (name) => {
      const f = await prepared();
      await writeFile(join(f.directory, name), '{}');
      await expect(f.store.load(f.ticket.id)).rejects.toThrow();
    },
  );
  it('非法配置及不可写目录保护原快照', async () => {
    const f = await fixture();
    const original = await readFile(f.state.snapshotPath);
    await writeFile(
      join(f.data, 'config/settings.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, secret: 'excluded' }),
    );
    await expect(f.store.record(f.receipt.id, f.preview.snapshotDigest, DECISION)).rejects.toThrow(
      'REVALIDATION_SETTINGS_INVALID',
    );
    await writeFile(join(f.data, 'config/settings.json'), JSON.stringify(DEFAULT_CONFIG));
    await writeFile(join(f.data, 'state/practice-revalidation'), 'blocked');
    await expect(
      f.store.record(f.receipt.id, f.preview.snapshotDigest, DECISION),
    ).rejects.toThrow();
    expect(await readFile(f.state.snapshotPath)).toEqual(original);
  });
  it('两个新收据也只能消费一个前任务后继', async () => {
    const f = await prepared();
    const other = await f.store.record(f.receipt.id, f.preview.snapshotDigest, DECISION);
    const outcomes = await Promise.allSettled([
      f.store.claim(f.ticket.id, 'next-task-1', 'fresh-chapter', new AbortController().signal),
      f.store.claim(other.id, 'next-task-2', 'fresh-chapter', new AbortController().signal),
    ]);
    expect(outcomes.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((v) => v.status === 'rejected')).toHaveLength(1);
  });
  it.each([
    ['old-task', 'fresh-chapter'],
    ['previous-task', 'fresh-chapter'],
    ['next-task', 'old-chapter'],
    ['next-task', 'previous-chapter'],
  ])('拒绝旧上下文%s/%s', async (task, chapter) => {
    const f = await prepared();
    await expect(
      f.store.claim(f.ticket.id, task, chapter, new AbortController().signal),
    ).rejects.toThrow('REVALIDATION_OLD_CONTEXT_FORBIDDEN');
  });
  it('引擎仅刷新savedAt可接受，业务变化仍拒绝', async () => {
    const f = await prepared();
    const source = (await f.state.load())!;
    await f.state.write({ ...source, savedAt: '2026-10-20T02:03:04.567Z' });
    await expect(
      f.store.claim(f.ticket.id, 'next-task', 'fresh-chapter', new AbortController().signal),
    ).resolves.toBeUndefined();
  });
  it('消费前新增动作拒绝，不创建前任务claim', async () => {
    const f = await prepared();
    const source = (await f.state.load())!;
    await f.state.write({
      ...source,
      pendingOperations: [
        ...source.pendingOperations,
        { ...old, operationId: 'new', taskId: 'previous-task', status: 'failed' },
      ],
    });
    await expect(
      f.store.claim(f.ticket.id, 'next-task', 'fresh-chapter', new AbortController().signal),
    ).rejects.toThrow();
    expect(await readdir(join(f.data, 'state/practice-revalidation'))).not.toContain(
      'predecessor-previous-task.claim.json',
    );
  });
  it.each(['correct', 'incorrect'] as const)(
    '显式新任务%s反馈后一次关闭恢复，旧未知保留',
    async (reply) => {
      const f = await admitted();
      expect((await f.engine.start()).code).toBe('UNCONFIRMED_OPERATION');
      expect((await f.engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
      expect((await f.engine.startAfterManualPracticeReview(f.auth)).ok).toBe(true);
      expect(f.backup).toHaveBeenCalledOnce();
      const adapter = new PracticeFaultAdapter();
      adapter.current.courseId = 'course';
      adapter.reply = reply;
      expect(
        (await new PracticeSession(f.engine, adapter, undefined, fixedRandom()).run()).ok,
      ).toBe(true);
      expect(adapter.actions.map((v) => v.type)).toEqual(['pause', 'submit', 'close', 'restore']);
      expect(adapter.submissions()).toHaveLength(1);
      expect((await f.state.load())!.pendingOperations[0]).toEqual(old);
      await f.engine.pause();
    },
  );
  it('新未知再次锁止，不产生第二次选择', async () => {
    const f = await admitted();
    await f.engine.startAfterManualPracticeReview(f.auth);
    const adapter = new PracticeFaultAdapter();
    adapter.current.courseId = 'course';
    adapter.reply = 'unknown';
    expect((await new PracticeSession(f.engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
      false,
    );
    expect((await f.engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
    expect(adapter.submissions()).toHaveLength(1);
    expect((await f.state.load())!.pendingOperations[0]).toEqual(old);
  });
  it('新许可禁止前一零动作章节', async () => {
    const f = await prepared();
    const observed = observation();
    observed.currentChapterId = 'previous-chapter';
    observed.player!.chapterId = 'previous-chapter';
    await expect(
      ManualPracticeReviewAuthorization.create(
        f.store,
        f.ticket.id,
        async () => observed,
        new AbortController().signal,
      ),
    ).rejects.toThrow('REVIEW_FRESH_CHAPTER_REQUIRED');
  });
  it('到期及重启不自动恢复新许可', async () => {
    const f = await admitted();
    await f.engine.startAfterManualPracticeReview(f.auth);
    await f.engine.pause();
    const rebuilt = new TaskEngine({
      store: f.state,
      stage2Capabilities: {
        enabled: true,
        inspect: async () => observation().course,
        backup: async () => true,
      },
    });
    await rebuilt.browserConnected();
    await rebuilt.confirmCourse(observation().course, 'course');
    expect((await rebuilt.resume()).code).toBe('UNCONFIRMED_OPERATION');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(f.auth.expiresAt + 1);
    expect((await f.engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
  });
  it('写失败消费许可也不启动动作，不能重用', async () => {
    const f = await admitted();
    const write = vi.spyOn(f.state, 'write').mockRejectedValue(new Error('disk failure'));
    expect((await f.engine.startAfterManualPracticeReview(f.auth)).code).toBe('STATE_WRITE_FAILED');
    write.mockRestore();
    expect((await f.state.load())!.pendingOperations).toEqual([old]);
    await expect(
      f.store.claim(f.ticket.id, 'another-task', 'fresh-chapter', new AbortController().signal),
    ).rejects.toThrow();
  });
  it('CLI默认只读，确认摘要才保存，均不启动任务', async () => {
    const f = await fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const args = ['--data-dir', f.data, '--review-id', f.receipt.id];
    await prepareRevalidation(args);
    expect(JSON.parse(log.mock.calls[0][0] as string).mode).toBe('preview-only');
    await prepareRevalidation([...args, '--acknowledge-digest', f.preview.snapshotDigest]);
    expect(JSON.parse(log.mock.calls[1][0] as string)).toMatchObject({
      mode: 'revalidation-prepared',
      taskStarted: false,
      browserActions: 0,
    });
    await expect(prepareRevalidation(['--bad', 'x'])).rejects.toThrow();
    await expect(f.store.load('../outside')).rejects.toThrow('REVALIDATION_INVALID_ID');
  });
});
