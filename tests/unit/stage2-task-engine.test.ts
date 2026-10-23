import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CourseObservation, TaskSnapshot } from '../../packages/contracts/src/index';
import type { SiteObservation } from '../../packages/contracts/src/monitor';
import type { SnapshotInput, SnapshotStore } from '../../packages/persistence/src/index';
import { TaskEngine, type GuardedOperation } from '../../packages/task-engine/src/index';

function course(patch: Partial<CourseObservation> = {}): CourseObservation {
  return {
    courseId: 'fixture-course',
    title: '仅模拟课程',
    observedAt: new Date().toISOString(),
    confidence: 'verified',
    source: 'fixture',
    authenticated: true,
    pageKind: 'course',
    platformCompleted: null,
    evidence: ['fixture-only'],
    ...patch,
  };
}
function observation(): SiteObservation {
  const observedAt = new Date().toISOString();
  return {
    course: course(),
    currentChapterId: 'chapter-1',
    player: {
      chapterId: 'chapter-1',
      currentTime: 81,
      duration: 100,
      playbackRate: 1.5,
      paused: false,
      buffering: false,
      ended: false,
      observedAt,
      confidence: 'verified',
    },
    chapters: [
      {
        chapterId: 'chapter-1',
        title: '模拟章节一',
        platformCompleted: false,
        observedAt,
        confidence: 'verified',
      },
      {
        chapterId: 'chapter-2',
        title: '模拟章节二',
        platformCompleted: null,
        observedAt,
        confidence: 'verified',
      },
    ],
    popup: 'none',
    safeToRefresh: true,
    supportedRates: [1, 1.25, 1.5],
  };
}
function memory(previous: TaskSnapshot | null = null) {
  let snapshot = previous;
  const writes: SnapshotInput[] = [];
  const store: SnapshotStore = {
    load: async () => structuredClone(snapshot),
    write: async (input) => {
      writes.push(structuredClone(input));
      snapshot = { ...structuredClone(input), integrityDigest: '0'.repeat(64) };
      return structuredClone(snapshot);
    },
  };
  return { store, writes, snapshot: () => snapshot };
}
async function setup() {
  const storage = memory();
  let current = course();
  const backup = vi.fn(async () => true);
  const engine = new TaskEngine({
    store: storage.store,
    stage2Capabilities: { enabled: true, inspect: async () => current, backup },
  });
  await engine.browserConnected();
  await engine.confirmCourse(current, 'fixture-course');
  expect((await engine.start()).ok).toBe(true);
  return {
    engine,
    storage,
    backup,
    setCourse: (value: CourseObservation) => {
      current = value;
    },
  };
}
function operation(
  operationId: string,
  kind: GuardedOperation['kind'] = 'chapter-navigation',
): GuardedOperation {
  return {
    operationId,
    kind,
    issue: vi.fn(async () => undefined),
    verify: async () => 'confirmed',
  };
}
afterEach(() => vi.useRealTimers());

describe('stage 2 capabilities preserve the task safety boundary', () => {
  it('rejects removed playback-rate before preparation, effects or ledger writes', async () => {
    const { engine, storage } = await setup();
    const before = structuredClone(storage.snapshot());
    const rate = {
      ...operation('removed-rate', 'playback-rate'),
      prepare: vi.fn(async () => undefined),
    };
    expect((await engine.execute(rate)).code).toBe('AUTOMATIC_RATE_DISABLED');
    expect(rate.prepare).not.toHaveBeenCalled();
    expect(rate.issue).not.toHaveBeenCalled();
    expect(storage.snapshot()).toEqual(before);
    expect(engine.view().state).toBe('MONITORING');
  });

  it('preserves legacy unknown playback-rate records and does not silently unlock resume', async () => {
    const savedAt = new Date().toISOString();
    const previous: TaskSnapshot = {
      schemaVersion: 1,
      taskId: 'legacy-task',
      courseId: 'fixture-course',
      chapterId: 'chapter-1',
      state: 'PAUSED',
      savedAt,
      confirmedPlatformStatuses: [],
      integrityDigest: '0'.repeat(64),
      pendingOperations: [
        {
          operationId: 'old-rate',
          taskId: 'legacy-task',
          kind: 'playback-rate',
          status: 'awaiting-confirmation',
          savedAt,
        },
      ],
    };
    const storage = memory(previous);
    const engine = new TaskEngine({
      store: storage.store,
      stage2Capabilities: {
        enabled: true,
        inspect: async () => course(),
        backup: async () => true,
      },
    });
    await engine.init();
    await engine.browserConnected();
    await engine.confirmCourse(course(), 'fixture-course');
    expect((await engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
    expect(storage.snapshot()?.pendingOperations).toEqual(previous.pendingOperations);
    expect(engine.view().state).toBe('PAUSED');
  });

  it('refresh uses the recovery cooldown and its one-use budget survives restart and resume', async () => {
    vi.useFakeTimers();
    const { engine, storage } = await setup();
    expect((await engine.execute(operation('recover-once', 'recovery'))).ok).toBe(true);
    const refresh = operation('refresh-once', 'page-refresh');
    expect((await engine.execute(refresh)).code).toBe('RECOVERY_COOLDOWN');
    expect(engine.refreshAttempts).toBe(0);
    vi.advanceTimersByTime(5000);
    expect((await engine.execute(refresh)).ok).toBe(true);
    expect(engine.refreshAttempts).toBe(1);
    const restored = new TaskEngine({
      store: storage.store,
      stage2Capabilities: {
        enabled: true,
        inspect: async () => course(),
        backup: async () => true,
      },
    });
    await restored.init();
    expect(restored.refreshAttempts).toBe(1);
    await restored.browserConnected();
    await restored.confirmCourse(course(), 'fixture-course');
    expect((await restored.resume()).ok).toBe(true);
    const repeat = operation('refresh-again', 'page-refresh');
    expect((await restored.execute(repeat)).code).toBe('REFRESH_LIMIT');
    expect(repeat.issue).not.toHaveBeenCalled();
  });
  it('requires fresh course confirmation and a successful pre-task backup', async () => {
    const storage = memory();
    const backup = vi.fn(async () => false);
    const engine = new TaskEngine({
      store: storage.store,
      stage2Capabilities: { enabled: true, inspect: async () => course(), backup },
    });
    await engine.browserConnected();
    expect((await engine.start()).code).toBe('COURSE_NOT_CONFIRMED');
    expect(backup).not.toHaveBeenCalled();
    await engine.confirmCourse(course(), 'fixture-course');
    expect((await engine.start()).code).toBe('BACKUP_FAILED');
    expect(engine.view()).toMatchObject({ state: 'PAUSED', cancelled: true });
  });

  it('production stage 2 cannot activate a real-unverified adapter or generic fixture mutation', async () => {
    const { engine, setCourse } = await setup();
    const mutation = operation('fixture-only', 'fixture-mutation');
    expect((await engine.execute(mutation)).code).toBe('INVALID_OPERATION');
    expect(mutation.issue).not.toHaveBeenCalled();
    setCourse(course({ source: 'real-unverified', confidence: 'uncertain' }));
    const navigation = operation('real-unverified');
    expect((await engine.execute(navigation)).ok).toBe(false);
    expect(navigation.issue).not.toHaveBeenCalled();
    expect(engine.confirmedCourse).toBeNull();
  });

  it('persists navigation intent and confirmed feedback, with a fixed five-second cooldown', async () => {
    vi.useFakeTimers();
    const { engine, storage } = await setup();
    const first = operation('navigation-1');
    expect((await engine.execute(first)).ok).toBe(true);
    expect(
      storage.writes
        .filter((write) => write.pendingOperations.length)
        .map((write) => write.pendingOperations[0].status),
    ).toEqual(['pending', 'executing', 'awaiting-confirmation', 'completed']);
    const second = operation('navigation-2');
    await vi.advanceTimersByTimeAsync(4999);
    expect((await engine.execute(second)).code).toBe('RECOVERY_COOLDOWN');
    expect(second.issue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await engine.execute(second)).ok).toBe(true);
  });

  it('unknown navigation is not repeated or resumed even after reconnect and manual confirmation', async () => {
    const { engine, storage } = await setup();
    const navigation = {
      ...operation('navigation-unknown'),
      verify: async () => 'unknown' as const,
    };
    expect((await engine.execute(navigation)).code).toBe('OPERATION_UNCONFIRMED');
    expect(storage.snapshot()?.pendingOperations[0].status).toBe('awaiting-confirmation');
    await engine.browserDisconnected();
    await engine.browserConnected();
    await engine.confirmCourse(course(), 'fixture-course');
    expect((await engine.start()).code).toBe('UNCONFIRMED_OPERATION');
    expect(navigation.issue).toHaveBeenCalledTimes(1);
  });

  it('suspend cancels immediately while a non-cooperating prepare is still pending', async () => {
    const { engine } = await setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const navigation = {
      ...operation('cancel-navigation'),
      prepare: async () => {
        started();
        await waiting;
      },
    };
    const execution = engine.execute(navigation);
    await ready;
    const signal = engine.signal;
    const suspended = engine.suspend('用户手动切章，已暂停。', true);
    expect(signal.aborted).toBe(true);
    expect(engine.view()).toMatchObject({ state: 'PAUSED', cancelled: true });
    expect(engine.confirmedCourse).toBeNull();
    expect((await execution).code).toBe('CANCELLED');
    await suspended;
    release();
    await Promise.resolve();
    expect(navigation.issue).not.toHaveBeenCalled();
  });

  it('records explicit chapter markers without equating 81% progress or player ending with completion', async () => {
    const { engine, storage } = await setup();
    const current = observation();
    current.player!.ended = true;
    expect((await engine.recordObservation(current)).ok).toBe(true);
    expect(storage.snapshot()).toMatchObject({
      schemaVersion: 1,
      chapterId: 'chapter-1',
      confirmedPlatformStatuses: [{ chapterId: 'chapter-1', completed: false }],
    });
    expect(Object.keys(storage.snapshot()!)).not.toContain('player');
    expect(JSON.stringify(storage.snapshot())).not.toContain('模拟章节');
    current.chapters[0].platformCompleted = true;
    expect((await engine.recordObservation(current)).ok).toBe(true);
    expect(storage.snapshot()?.confirmedPlatformStatuses[0].completed).toBe(true);
  });

  it('rejects wrong-course and uncertain chapter observations before modifying reliable IDs', async () => {
    const { engine, storage } = await setup();
    const current = observation();
    current.course.courseId = 'another-course';
    expect((await engine.recordObservation(current)).code).toBe('COURSE_UNVERIFIED');
    expect(storage.snapshot()?.courseId).toBe('fixture-course');
    expect(storage.snapshot()?.chapterId).toBeNull();
    expect(engine.confirmedCourse).toBeNull();
  });

  it('missing or duplicate chapter IDs pause without persisting inferred platform markers', async () => {
    for (const invalid of ['missing', 'duplicate'] as const) {
      const { engine, storage } = await setup();
      const current = observation();
      if (invalid === 'missing') current.currentChapterId = 'guessed-chapter';
      else current.chapters.push({ ...current.chapters[0] });
      expect((await engine.recordObservation(current)).code).toBe('CHAPTER_UNVERIFIED');
      expect(storage.snapshot()?.confirmedPlatformStatuses).toEqual([]);
      expect(engine.view().state).toBe('PAUSED');
    }
  });

  it('retains a legacy schema-1 chapter and platform markers during safe startup', async () => {
    const observedAt = new Date().toISOString();
    const storage = memory({
      schemaVersion: 1,
      taskId: 'legacy-task',
      courseId: 'fixture-course',
      chapterId: 'legacy-chapter',
      state: 'MONITORING',
      savedAt: observedAt,
      pendingOperations: [],
      confirmedPlatformStatuses: [{ chapterId: 'legacy-chapter', completed: true, observedAt }],
      integrityDigest: '0'.repeat(64),
    });
    const engine = new TaskEngine({ store: storage.store });
    await engine.init();
    expect(engine.view()).toMatchObject({ state: 'PAUSED', cancelled: true });
    expect(storage.snapshot()).toMatchObject({
      chapterId: 'legacy-chapter',
      confirmedPlatformStatuses: [{ chapterId: 'legacy-chapter', completed: true }],
    });
    expect(engine.confirmedCourse).toBeNull();
  });

  it('observation persistence failure blocks the next navigation', async () => {
    const { engine, storage } = await setup();
    storage.store.write = async () => {
      throw new Error('injected-storage-fault');
    };
    expect((await engine.recordObservation(observation())).code).toBe('STATE_WRITE_FAILED');
    expect(engine.signal.aborted).toBe(true);
    const navigation = operation('blocked-after-observation');
    expect((await engine.execute(navigation)).code).toBe('STATE_WRITE_FAILED');
    expect(navigation.issue).not.toHaveBeenCalled();
  });
});
