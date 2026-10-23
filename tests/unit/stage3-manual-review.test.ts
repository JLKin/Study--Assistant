import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationRecord } from '../../packages/contracts/src/index';
import { DEFAULT_CONFIG } from '../../packages/contracts/src/config';
import type { SiteObservation } from '../../packages/contracts/src/monitor';
import {
  StateStore,
  type SnapshotInput,
  type SnapshotStore,
} from '../../packages/persistence/src/index';
import {
  ManualPracticeReviewStore,
  type PracticeReviewChapterEvidence,
} from '../../packages/persistence/src/manual-practice-review';
import { ManualPracticeReviewAuthorization } from '../../packages/task-engine/src/manual-practice-review';
import { TaskEngine } from '../../packages/task-engine/src/index';
import { PracticeSession } from '../../packages/practice/src/index';
import { PracticeFaultAdapter, fixedRandom } from '../helpers/stage3';
import { review } from '../../scripts/stage3-manual-review-tool';
import { recordedPracticeChapter } from '../../scripts/stage3-recorded-chapter';

const DECISION = 'abandon-old-attempt-allow-one-fresh-task' as const;
const roots: string[] = [];
const oldOperation: OperationRecord = {
  operationId: 'old-submit',
  taskId: 'old-task',
  kind: 'practice-submit',
  status: 'awaiting-confirmation',
  savedAt: '2026-10-20T09:00:00.000Z',
};
function input(): SnapshotInput {
  return {
    schemaVersion: 1,
    taskId: 'old-task',
    courseId: 'course',
    chapterId: 'old-chapter',
    savedAt: new Date().toISOString(),
    state: 'PAUSED',
    pendingOperations: [{ ...oldOperation }],
    confirmedPlatformStatuses: [],
  };
}
function observation(): SiteObservation {
  const now = new Date().toISOString();
  return {
    course: {
      courseId: 'course',
      title: 'fixture',
      source: 'fixture',
      authenticated: true,
      pageKind: 'course',
      confidence: 'verified',
      platformCompleted: null,
      evidence: ['fixture-only'],
      observedAt: now,
    },
    player: {
      chapterId: 'new-chapter',
      currentTime: 5,
      duration: 120,
      playbackRate: 1,
      paused: false,
      buffering: false,
      ended: false,
      confidence: 'verified',
      observedAt: now,
    },
    chapters: [
      {
        chapterId: 'new-chapter',
        title: 'fixture',
        platformCompleted: false,
        confidence: 'verified',
        observedAt: now,
      },
    ],
    currentChapterId: 'new-chapter',
    supportedRates: [1],
    popup: 'none',
    safeToRefresh: false,
  };
}
async function fixture(source = input()) {
  const directory = await mkdtemp(join(tmpdir(), 'stage3-review-'));
  roots.push(directory);
  await mkdir(join(directory, 'config'));
  // Deliberately preserve formatting, not just parsed equality.
  await writeFile(
    join(directory, 'config', 'settings.json'),
    JSON.stringify(DEFAULT_CONFIG, null, 3) + '\r\n',
  );
  const state = new StateStore(directory);
  await state.write(source);
  const store = new ManualPracticeReviewStore(directory);
  return { directory, state, store };
}
async function receiptFixture() {
  const f = await fixture();
  const receipt = await f.store.record((await f.store.preview()).snapshotDigest, DECISION);
  const directory = join(f.directory, 'state', 'manual-practice-review', receipt.id);
  return { ...f, receipt, receiptDirectory: directory };
}
async function engineFixture(
  options: { backup?: () => Promise<boolean>; store?: SnapshotStore } = {},
) {
  const f = await receiptFixture();
  let sample = observation();
  const observe = vi.fn(async () => structuredClone(sample));
  const authorization = await ManualPracticeReviewAuthorization.create(
    f.store,
    f.receipt.id,
    observe,
    new AbortController().signal,
  );
  const backup = vi.fn(options.backup ?? (async () => true));
  const engine = new TaskEngine({
    store: options.store ?? f.state,
    stage2Capabilities: { enabled: true, inspect: async () => sample.course, backup },
    stage3FixturePractice: true,
  });
  await engine.browserConnected();
  await engine.confirmCourse(sample.course, 'course');
  return {
    ...f,
    engine,
    authorization,
    backup,
    observe,
    set: (value: SiteObservation) => {
      sample = value;
    },
  };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('stage3 narrow manual practice review storage', () => {
  it('预览只读，不建新目录，不改原schema1及字节', async () => {
    const f = await fixture();
    const before = await readFile(f.state.snapshotPath);
    expect(await f.store.preview()).toMatchObject({
      operation: oldOperation,
      chapterId: 'old-chapter',
    });
    expect(await readFile(f.state.snapshotPath)).toEqual(before);
    expect(await readdir(join(f.directory, 'state'))).toEqual(['snapshot.json']);
  });
  it('备份逐字节一致、收据保留unknown，旧读取器仍能加载', async () => {
    const f = await receiptFixture();
    expect(await readFile(join(f.receiptDirectory, 'state', 'snapshot.json'))).toEqual(
      await readFile(f.state.snapshotPath),
    );
    expect(await readFile(join(f.receiptDirectory, 'settings.json'))).toEqual(
      await readFile(join(f.directory, 'config', 'settings.json')),
    );
    expect((await f.store.load(f.receipt.id)).outcome).toBe('unknown');
    expect((await new StateStore(f.directory).load())!.pendingOperations).toEqual([oldOperation]);
  });
  it.each([
    [
      '没有未知项',
      (s: SnapshotInput) => {
        s.pendingOperations = [];
      },
    ],
    [
      '不同任务',
      (s: SnapshotInput) => {
        s.pendingOperations[0].taskId = 'other';
      },
    ],
    [
      '其他动作',
      (s: SnapshotInput) => {
        s.pendingOperations[0].kind = 'chapter-navigation';
      },
    ],
    [
      '执行中',
      (s: SnapshotInput) => {
        s.pendingOperations[0].status = 'executing';
      },
    ],
    [
      'pending',
      (s: SnapshotInput) => {
        s.pendingOperations[0].status = 'pending';
      },
    ],
    [
      '运行中',
      (s: SnapshotInput) => {
        s.state = 'MONITORING';
      },
    ],
    [
      '两条未知',
      (s: SnapshotInput) => {
        s.pendingOperations.push({ ...oldOperation, operationId: 'other' });
      },
    ],
  ])('%s不可批准', async (_name, change) => {
    const source = input();
    change(source);
    const f = await fixture(source);
    await expect(f.store.preview()).rejects.toThrow('MANUAL_REVIEW_NOT_ELIGIBLE');
  });
  it('旧快照没有章节且没有封存证据时拒绝，不猜测或改写', async () => {
    const source = input();
    source.chapterId = null;
    const f = await fixture(source);
    await expect(f.store.preview()).rejects.toThrow('MANUAL_REVIEW_CHAPTER_EVIDENCE_REQUIRED');
    expect((await f.state.load())!.chapterId).toBeNull();
  });
  it('合成证据仅绑定对应尝试，空章节与原操作保持，其他操作拒绝', async () => {
    const source = input();
    source.chapterId = null;
    const f = await fixture(source);
    const original = await readFile(f.state.snapshotPath);
    const evidenceFile = join(f.directory, 'synthetic-chapter-evidence.json');
    await writeFile(
      evidenceFile,
      JSON.stringify({
        taskId: source.taskId,
        courseId: source.courseId,
        operation: oldOperation,
        chapterId: `zhs_v1_${'a'.repeat(64)}`,
      }),
    );
    // Exercise the store's evidence contract without depending on private historical archives.
    // The real sealed-file resolver's missing/tampered-file checks remain covered below.
    const evidence: PracticeReviewChapterEvidence = {
      resolve: async (snapshot) => {
        const recorded = JSON.parse(await readFile(evidenceFile, 'utf8'));
        if (
          snapshot.chapterId !== null ||
          snapshot.taskId !== recorded.taskId ||
          snapshot.courseId !== recorded.courseId ||
          JSON.stringify(snapshot.pendingOperations) !== JSON.stringify([recorded.operation])
        )
          throw new Error('RECORDED_CHAPTER_NOT_BOUND_TO_SNAPSHOT');
        return { chapterId: recorded.chapterId, source: 'synthetic-recorded-chapter-v1' };
      },
    };
    const store = new ManualPracticeReviewStore(f.directory, evidence);
    const p = await store.preview();
    expect(p.chapterSource).toBe('synthetic-recorded-chapter-v1');
    expect(p.chapterId).toMatch(/^zhs_v1_[a-f0-9]{64}$/);
    const receipt = await store.record(p.snapshotDigest, DECISION);
    expect((await store.load(receipt.id)).chapterId).toBe(p.chapterId);
    expect((await f.state.load())!.chapterId).toBeNull();
    expect((await f.state.load())!.pendingOperations).toEqual([oldOperation]);
    expect(await readFile(f.state.snapshotPath)).toEqual(original);
    source.pendingOperations[0].operationId = 'wrong-submit';
    await f.state.write(source);
    await expect(store.preview()).rejects.toThrow('RECORDED_CHAPTER_NOT_BOUND_TO_SNAPSHOT');
  });
  it('封存文件缺失或哈希变化拒绝，不以名称或序号代替证据', async () => {
    const source = input();
    source.chapterId = null;
    const f = await fixture(source);
    const witness = recordedPracticeChapter(f.directory);
    const store = new ManualPracticeReviewStore(f.directory, witness);
    await expect(store.preview()).rejects.toThrow();
    const archived = join(
      f.directory,
      'docs/evidence/stage3-random/2026-10-20T09-36-18Z/attempt-02',
    );
    await mkdir(archived, { recursive: true });
    await writeFile(join(archived, 'armed.json'), JSON.stringify({ original: { ordinal: '8.2' } }));
    await expect(store.preview()).rejects.toThrow('RECORDED_CHAPTER_EVIDENCE_CHANGED');
  });
  it('陈旧预览拒绝且不创建决定', async () => {
    const f = await fixture();
    const p = await f.store.preview();
    await f.state.write({ ...input(), savedAt: '2026-10-20T10:01:02.003Z' });
    await expect(f.store.record(p.snapshotDigest, DECISION)).rejects.toThrow(
      'REVIEW_PREVIEW_CHANGED',
    );
    expect(await readdir(join(f.directory, 'state'))).toEqual(['snapshot.json']);
  });
  it('未明确决定拒绝，包含额外键的配置不复制', async () => {
    const f = await fixture();
    const p = await f.store.preview();
    await expect(f.store.record(p.snapshotDigest, 'completed' as typeof DECISION)).rejects.toThrow(
      'MANUAL_DECISION_REQUIRED',
    );
    await writeFile(
      join(f.directory, 'config', 'settings.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, secret: 'must-not-backup' }),
    );
    await expect(f.store.record(p.snapshotDigest, DECISION)).rejects.toThrow(
      'REVIEW_SETTINGS_INVALID',
    );
  });
  it('已取消和目录不可写均不改原快照', async () => {
    const f = await fixture();
    const p = await f.store.preview();
    const original = await readFile(f.state.snapshotPath);
    const controller = new AbortController();
    controller.abort();
    await expect(f.store.record(p.snapshotDigest, DECISION, controller.signal)).rejects.toThrow();
    await writeFile(join(f.directory, 'state', 'manual-practice-review'), 'blocked');
    await expect(f.store.record(p.snapshotDigest, DECISION)).rejects.toThrow();
    expect(await readFile(f.state.snapshotPath)).toEqual(original);
  });
  it.each(['receipt.json', 'state/snapshot.json', 'settings.json'])(
    '%s损坏不能生成有效许可',
    async (name) => {
      const f = await receiptFixture();
      await writeFile(join(f.receiptDirectory, name), '{}');
      await expect(f.store.load(f.receipt.id)).rejects.toThrow();
    },
  );
  it('同一决定只允许一个独占claim，取消不消费', async () => {
    const f = await receiptFixture();
    const signal = new AbortController();
    signal.abort();
    await expect(
      f.store.claim(f.receipt.id, 'fresh-task', 'new-chapter', signal.signal),
    ).rejects.toThrow();
    const active = new AbortController().signal;
    await expect(
      f.store.claim(f.receipt.id, 'fresh-task', 'new-chapter', active),
    ).resolves.toBeUndefined();
    await expect(
      new ManualPracticeReviewStore(f.directory).claim(
        f.receipt.id,
        'another-task',
        'another-chapter',
        active,
      ),
    ).rejects.toThrow();
  });
  it('同一旧尝试重复建收据也只能独占一个新任务', async () => {
    const f = await receiptFixture();
    const another = await f.store.record((await f.store.preview()).snapshotDigest, DECISION);
    const outcomes = await Promise.allSettled([
      f.store.claim(f.receipt.id, 'fresh-task-1', 'new-chapter', new AbortController().signal),
      f.store.claim(another.id, 'fresh-task-2', 'new-chapter', new AbortController().signal),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await f.state.load())!.pendingOperations).toEqual([oldOperation]);
  });
  it.each([
    ['old-task', 'new-chapter'],
    ['fresh-task', 'old-chapter'],
  ])('拒绝旧任务或旧章 %s/%s', async (task, chapter) => {
    const f = await receiptFixture();
    await expect(
      f.store.claim(f.receipt.id, task, chapter, new AbortController().signal),
    ).rejects.toThrow('REVIEW_OLD_ATTEMPT_FORBIDDEN');
  });
  it('路径穿越ID不读取外部文件', async () => {
    const f = await fixture();
    await expect(f.store.load('../outside')).rejects.toThrow('REVIEW_INVALID_ID');
  });
});

describe('stage3 manual review explicit TaskEngine admission', () => {
  it('新题随机一次、错误反馈、关闭和恢复后，原未知仍完整保留', async () => {
    const f = await engineFixture();
    expect((await f.engine.startAfterManualPracticeReview(f.authorization)).ok).toBe(true);
    const adapter = new PracticeFaultAdapter();
    adapter.current.courseId = 'course';
    adapter.reply = 'incorrect';
    const session = new PracticeSession(f.engine, adapter, undefined, fixedRandom());
    expect((await session.run()).ok).toBe(true);
    expect(adapter.actions.map((action) => action.type)).toEqual([
      'pause',
      'submit',
      'close',
      'restore',
    ]);
    expect(adapter.submissions()).toHaveLength(1);
    expect(adapter.currentVideo.paused).toBe(false);
    const ledger = (await f.state.load())!.pendingOperations;
    expect(ledger[0]).toEqual(oldOperation);
    expect(ledger.slice(1)).toHaveLength(4);
    expect(
      ledger.slice(1).every((op) => op.status === 'completed' && op.taskId !== 'old-task'),
    ).toBe(true);
    await f.engine.pause();
  });
  it('普通start/resume仍锁止，显式新任务保留原未知、旧ID仍去重', async () => {
    const f = await engineFixture();
    expect((await f.engine.start()).code).toBe('UNCONFIRMED_OPERATION');
    expect((await f.engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
    expect((await f.engine.startAfterManualPracticeReview(f.authorization)).ok).toBe(true);
    expect(f.engine.view().taskId).not.toBe('old-task');
    expect((await f.state.load())!.chapterId).toBe('new-chapter');
    expect(f.backup).toHaveBeenCalledOnce();
    expect((await f.state.load())!.pendingOperations).toEqual([oldOperation]);
    expect(
      (
        await f.engine.execute({
          operationId: 'old-submit',
          kind: 'recovery',
          issue: async () => {
            throw new Error('must not issue');
          },
          verify: async () => 'confirmed',
        })
      ).code,
    ).toBe('DUPLICATE_OPERATION');
    await f.engine.pause();
    expect((await f.engine.start()).code).toBe('UNCONFIRMED_OPERATION');
    expect((await f.engine.resume()).ok).toBe(true);
    await f.engine.pause();
  });
  it('备份失败不消费收据，不发动作', async () => {
    const f = await engineFixture({ backup: async () => false });
    expect((await f.engine.startAfterManualPracticeReview(f.authorization)).code).toBe(
      'BACKUP_FAILED',
    );
    expect(await readdir(f.receiptDirectory)).not.toContain('claim.json');
    expect(f.engine.view().taskId).toBe('old-task');
  });
  it('备份等待可立即暂停，不消费许可', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await engineFixture({
      backup: async () => {
        await gate;
        return true;
      },
    });
    const start = f.engine.startAfterManualPracticeReview(f.authorization);
    await vi.waitFor(() => expect(f.backup).toHaveBeenCalledOnce());
    await f.engine.pause();
    release();
    expect((await start).code).toBe('CANCELLED');
    expect(await readdir(f.receiptDirectory)).not.toContain('claim.json');
  });
  it.each([
    [
      '旧章',
      (s: SiteObservation) => {
        s.currentChapterId = 'old-chapter';
        s.player!.chapterId = 'old-chapter';
      },
    ],
    [
      '不同课程',
      (s: SiteObservation) => {
        s.course.courseId = 'other';
      },
    ],
    [
      '计分页',
      (s: SiteObservation) => {
        s.course.pageKind = 'graded';
      },
    ],
    [
      '弹窗已出现',
      (s: SiteObservation) => {
        s.popup = 'present';
      },
    ],
    [
      '暂停',
      (s: SiteObservation) => {
        s.player!.paused = true;
      },
    ],
    [
      '过期观察',
      (s: SiteObservation) => {
        s.course.observedAt = '2000-01-01T00:00:00Z';
      },
    ],
  ])('%s不能创建新题许可', async (_name, change) => {
    const f = await receiptFixture();
    const observed = observation();
    change(observed);
    await expect(
      ManualPracticeReviewAuthorization.create(
        f.store,
        f.receipt.id,
        async () => observed,
        new AbortController().signal,
      ),
    ).rejects.toThrow('REVIEW_FRESH_CHAPTER_REQUIRED');
  });
  it('启动前变回旧章拒绝，不消费claim', async () => {
    const f = await engineFixture();
    const observed = observation();
    observed.currentChapterId = 'old-chapter';
    f.set(observed);
    expect((await f.engine.startAfterManualPracticeReview(f.authorization)).code).toBe(
      'MANUAL_REVIEW_REJECTED',
    );
    expect(await readdir(f.receiptDirectory)).not.toContain('claim.json');
  });
  it('准备完成后变章，发出动作前再次核验并阻止', async () => {
    const f = await engineFixture();
    await f.engine.startAfterManualPracticeReview(f.authorization);
    const issue = vi.fn(async () => undefined);
    const result = await f.engine.execute({
      operationId: 'new-recovery',
      kind: 'recovery',
      prepare: async () => {
        const sample = observation();
        sample.currentChapterId = 'old-chapter';
        f.set(sample);
      },
      issue,
      verify: async () => 'confirmed',
    });
    expect(result.ok).toBe(false);
    expect(issue).not.toHaveBeenCalled();
    expect(f.engine.view().state).toBe('PAUSED');
    expect((await f.state.load())!.pendingOperations).toEqual([oldOperation]);
  });
  it('执行意图落盘后变章，发动作前仍阻止并保留保守未知', async () => {
    const f = await engineFixture();
    await f.engine.startAfterManualPracticeReview(f.authorization);
    const originalWrite = f.state.write.bind(f.state);
    vi.spyOn(f.state, 'write').mockImplementation(async (source) => {
      if (source.pendingOperations.at(-1)?.status === 'executing') {
        const changed = observation();
        changed.currentChapterId = 'old-chapter';
        f.set(changed);
      }
      return originalWrite(source);
    });
    const issue = vi.fn(async () => undefined);
    expect(
      (
        await f.engine.execute({
          operationId: 'new-recovery',
          kind: 'recovery',
          issue,
          verify: async () => 'confirmed',
        })
      ).ok,
    ).toBe(false);
    expect(issue).not.toHaveBeenCalled();
    const operations = (await f.state.load())!.pendingOperations;
    expect(operations[0]).toEqual(oldOperation);
    expect(operations[1].status).toBe('awaiting-confirmation');
    expect((await f.engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
  });
  it('观察等待中用户暂停立即取消新任务入场', async () => {
    const f = await engineFixture();
    let release!: (value: SiteObservation) => void;
    f.observe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const start = f.engine.startAfterManualPracticeReview(f.authorization);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.engine.pause();
    release(observation());
    expect((await start).code).toBe('CANCELLED');
    expect(await readdir(f.receiptDirectory)).not.toContain('claim.json');
  });
  it('新动作结果未知再次锁止，旧记录不改', async () => {
    const f = await engineFixture();
    await f.engine.startAfterManualPracticeReview(f.authorization);
    const issue = vi.fn(async () => undefined);
    expect(
      (
        await f.engine.execute({
          operationId: 'new-recovery',
          kind: 'recovery',
          issue,
          verify: async () => 'unknown',
        })
      ).code,
    ).toBe('OPERATION_UNCONFIRMED');
    expect((await f.engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
    expect(issue).toHaveBeenCalledOnce();
    expect((await f.state.load())!.pendingOperations[0]).toEqual(oldOperation);
  });
  it('重启不加载许可，重复收据不能给另一引擎新任务', async () => {
    const f = await engineFixture();
    await f.engine.startAfterManualPracticeReview(f.authorization);
    await f.engine.pause();
    const again = new TaskEngine({
      store: f.state,
      stage2Capabilities: {
        enabled: true,
        inspect: async () => observation().course,
        backup: async () => true,
      },
    });
    await again.browserConnected();
    await again.confirmCourse(observation().course, 'course');
    expect((await again.resume()).code).toBe('UNCONFIRMED_OPERATION');
    const auth = await ManualPracticeReviewAuthorization.create(
      f.store,
      f.receipt.id,
      async () => observation(),
      new AbortController().signal,
    );
    expect((await again.startAfterManualPracticeReview(auth)).code).toBe('MANUAL_REVIEW_REJECTED');
    expect((await f.state.load())!.pendingOperations[0]).toEqual(oldOperation);
  });
  it('许可到期立即禁止下一动作，暂停不受等待影响', async () => {
    const f = await engineFixture();
    await f.engine.startAfterManualPracticeReview(f.authorization);
    vi.useFakeTimers();
    vi.setSystemTime(f.authorization.expiresAt + 1);
    const issue = vi.fn(async () => undefined);
    expect(
      (
        await f.engine.execute({
          operationId: 'expired',
          kind: 'recovery',
          issue,
          verify: async () => 'confirmed',
        })
      ).ok,
    ).toBe(false);
    expect(issue).not.toHaveBeenCalled();
    expect(f.engine.view().state).toBe('PAUSED');
    await f.engine.pause();
  });
  it('伪造结构不能提供豁免', async () => {
    const f = await engineFixture();
    const forged = {
      valid: () => true,
      permits: () => true,
    } as unknown as ManualPracticeReviewAuthorization;
    expect((await f.engine.startAfterManualPracticeReview(forged)).code).toBe(
      'UNCONFIRMED_OPERATION',
    );
  });
  it('关键状态写失败不开始新任务，网页效果为0', async () => {
    const f = await engineFixture();
    const write = vi.spyOn(f.state, 'write').mockRejectedValue(new Error('disk failure'));
    expect((await f.engine.startAfterManualPracticeReview(f.authorization)).code).toBe(
      'STATE_WRITE_FAILED',
    );
    expect(f.engine.view().persistenceHealthy).toBe(false);
    expect((await f.engine.resume()).code).toBe('STATE_WRITE_FAILED');
    write.mockRestore();
    expect((await f.state.load())!.pendingOperations).toEqual([oldOperation]);
    const authorization = await ManualPracticeReviewAuthorization.create(
      f.store,
      f.receipt.id,
      async () => observation(),
      new AbortController().signal,
    );
    await expect(
      authorization.claim('another-task', new AbortController().signal),
    ).rejects.toThrow();
  });
});

describe('stage3 manual review CLI', () => {
  it('默认预览不启动或写决定，明确摘要才保存收据', async () => {
    const f = await fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await review(['--data-dir', f.directory]);
    expect(JSON.parse(log.mock.calls[0][0] as string).mode).toBe('preview-only');
    expect(await readdir(join(f.directory, 'state'))).toEqual(['snapshot.json']);
    await review([
      '--data-dir',
      f.directory,
      '--acknowledge-digest',
      (await f.store.preview()).snapshotDigest,
    ]);
    expect(JSON.parse(log.mock.calls[1][0] as string)).toMatchObject({
      taskStarted: false,
      browserActions: 0,
      outcome: 'unknown',
    });
  });
  it.each([
    { args: [] },
    { args: ['--data-dir'] },
    { args: ['--unknown', 'x'] },
    { args: ['--data-dir', 'x', '--data-dir', 'y'] },
  ])('不完整或未知参数拒绝 %j', async ({ args }) => {
    await expect(review(args)).rejects.toThrow();
  });
});
