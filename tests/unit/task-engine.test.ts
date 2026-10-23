import { describe, expect, it, vi } from 'vitest';
import type { CourseObservation, TaskSnapshot } from '../../packages/contracts/src/index';
import { TaskEngine, type GuardedOperation } from '../../packages/task-engine/src/index';
import type { SnapshotInput, SnapshotStore } from '../../packages/persistence/src/index';

function observation(patch: Partial<CourseObservation> = {}): CourseObservation {
  return {
    courseId: 'fixture-course',
    title: '模拟课程',
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
function memoryStore(previous: TaskSnapshot | null = null) {
  let snapshot = previous;
  const writes: SnapshotInput[] = [];
  const store: SnapshotStore = {
    load: async () => snapshot,
    write: async (input) => {
      writes.push(structuredClone(input));
      snapshot = { ...structuredClone(input), integrityDigest: '0'.repeat(64) };
      return snapshot;
    },
  };
  return { store, writes, snapshot: () => snapshot };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function running() {
  const storage = memoryStore();
  let current = observation();
  const backup = vi.fn(async () => true);
  const engine = new TaskEngine({
    store: storage.store,
    testCapabilities: {
      enabled: true,
      inspect: async () => ({ ...current, observedAt: new Date().toISOString() }),
      backup,
    },
  });
  await engine.init();
  await engine.browserConnected();
  await engine.confirmCourse(current, current.courseId!);
  expect((await engine.start()).ok).toBe(true);
  return {
    engine,
    storage,
    backup,
    setObservation: (next: CourseObservation) => {
      current = next;
    },
  };
}
function operation(id = 'operation-1', patch: Partial<GuardedOperation> = {}): GuardedOperation {
  return {
    operationId: id,
    kind: 'fixture-mutation',
    issue: vi.fn(async () => undefined),
    verify: async () => 'confirmed',
    ...patch,
  };
}

describe('stage 1 task safety substrate', () => {
  it('production start/resume/execute are unavailable and never enter MONITORING', async () => {
    const { store } = memoryStore();
    const engine = new TaskEngine({ store });
    await engine.init();
    expect((await engine.start()).code).toBe('STAGE_UNAVAILABLE');
    expect((await engine.resume()).code).toBe('STAGE_UNAVAILABLE');
    const action = operation();
    expect((await engine.execute(action)).code).toBe('STAGE_UNAVAILABLE');
    expect(action.issue).not.toHaveBeenCalled();
    expect(engine.view().state).not.toBe('MONITORING');
  });

  it('cannot start a test task without manual course confirmation', async () => {
    const { store } = memoryStore();
    const backup = vi.fn(async () => true);
    const engine = new TaskEngine({
      store,
      testCapabilities: { enabled: true, inspect: async () => observation(), backup },
    });
    await engine.browserConnected();
    expect((await engine.start()).code).toBe('COURSE_NOT_CONFIRMED');
    expect(backup).not.toHaveBeenCalled();
    expect((await engine.execute(operation())).ok).toBe(false);
  });

  it.each(['graded', 'unknown'] as const)(
    'a %s page has zero automatic effects and pauses',
    async (pageKind) => {
      const { engine, setObservation } = await running();
      setObservation(observation({ pageKind }));
      const action = operation();
      expect((await engine.execute(action)).ok).toBe(false);
      expect(action.issue).not.toHaveBeenCalled();
      expect(engine.view().state).toBe('PAUSED');
    },
  );

  it.each([
    { authenticated: false },
    { confidence: 'uncertain' as const },
    { source: 'real-unverified' as const },
    { courseId: 'another-course' },
  ])('rejects unsafe course observation %j with zero effects', async (patch) => {
    const { engine, setObservation } = await running();
    setObservation(observation(patch));
    const action = operation();
    await engine.execute(action);
    expect(action.issue).not.toHaveBeenCalled();
    expect(engine.view().state).toBe('PAUSED');
  });

  it('rejects stale manual confirmation and does not persist page text', async () => {
    const { store, writes } = memoryStore();
    const engine = new TaskEngine({ store });
    await engine.browserConnected();
    expect(
      (
        await engine.confirmCourse(
          observation({ observedAt: '2020-01-01T00:00:00.000Z' }),
          'fixture-course',
        )
      ).code,
    ).toBe('COURSE_UNVERIFIED');
    expect(JSON.stringify(writes)).not.toContain('模拟课程');
  });

  it('a failed task-before backup prevents starting', async () => {
    const { store } = memoryStore();
    const engine = new TaskEngine({
      store,
      testCapabilities: {
        enabled: true,
        inspect: async () => observation(),
        backup: async () => false,
      },
    });
    await engine.browserConnected();
    await engine.confirmCourse(observation(), 'fixture-course');
    expect((await engine.start()).code).toBe('BACKUP_FAILED');
    expect(engine.view().state).toBe('PAUSED');
  });

  it('writes intent/executing/awaiting/verified in order and never infers platform completion', async () => {
    const { engine, storage } = await running();
    const action = operation();
    const result = await engine.execute(action);
    expect(result.code).toBe('OPERATION_COMPLETED');
    expect(action.issue).toHaveBeenCalledTimes(1);
    expect(
      storage.writes
        .filter((entry) => entry.pendingOperations.length)
        .map((entry) => entry.pendingOperations[0].status),
    ).toEqual(['pending', 'executing', 'awaiting-confirmation', 'completed']);
    expect(storage.snapshot()?.confirmedPlatformStatuses).toEqual([]);
    expect((await engine.execute(action)).code).toBe('DUPLICATE_OPERATION');
    expect(action.issue).toHaveBeenCalledTimes(1);
  });

  it('a critical intent write failure locks all new effects while pause/stop remain responsive', async () => {
    const { engine, storage } = await running();
    const originalWrite = storage.store.write;
    storage.store.write = async (input) => {
      if (input.pendingOperations.length)
        throw new Error('synthetic-sensitive-message-never-logged');
      return originalWrite(input);
    };
    const action = operation();
    expect((await engine.execute(action)).code).toBe('STATE_WRITE_FAILED');
    expect(action.issue).not.toHaveBeenCalled();
    expect(engine.view()).toMatchObject({ state: 'PAUSED', persistenceHealthy: false });
    expect((await engine.execute(operation('operation-2'))).code).toBe('STATE_WRITE_FAILED');
    const pausing = engine.pause();
    expect(engine.view().cancelled).toBe(true);
    await pausing;
    const stopping = engine.stop();
    expect(engine.view().state).toBe('IDLE');
    await stopping;
  });

  it('pause cancels a non-cooperating pending prepare and a late callback cannot issue', async () => {
    const { engine } = await running();
    const waiting = deferred<void>();
    const started = deferred<void>();
    const action = operation('late-prepare', {
      prepare: async () => {
        started.resolve();
        await waiting.promise;
      },
    });
    const execution = engine.execute(action);
    await started.promise;
    const paused = engine.pause();
    expect(engine.view()).toMatchObject({ state: 'PAUSED', cancelled: true });
    expect((await execution).code).toBe('CANCELLED');
    await paused;
    waiting.resolve();
    await Promise.resolve();
    expect(action.issue).not.toHaveBeenCalled();
  });

  it('stop cancels pending work and a second operation cannot overlap it', async () => {
    const { engine } = await running();
    const waiting = deferred<void>();
    const started = deferred<void>();
    const first = operation('first', {
      prepare: async () => {
        started.resolve();
        await waiting.promise;
      },
    });
    const execution = engine.execute(first);
    await started.promise;
    expect((await engine.execute(operation('overlap'))).code).toBe('OPERATION_BUSY');
    const stopped = engine.stop();
    expect(engine.view().state).toBe('IDLE');
    expect((await execution).code).toBe('CANCELLED');
    await stopped;
    waiting.resolve();
    expect(first.issue).not.toHaveBeenCalled();
  });

  it('rechecks page classification after preparation, before issuing any effect', async () => {
    const { engine, setObservation } = await running();
    const action = operation('classification-changed', {
      prepare: async () => {
        setObservation(observation({ pageKind: 'graded' }));
      },
    });
    expect((await engine.execute(action)).ok).toBe(false);
    expect(action.issue).not.toHaveBeenCalled();
    expect(engine.view().state).toBe('PAUSED');
  });

  it('pause during an intent write prevents the click when the write completes late', async () => {
    const { engine, storage } = await running();
    const intentStarted = deferred<void>();
    const releaseIntent = deferred<void>();
    const originalWrite = storage.store.write;
    let firstIntent = true;
    storage.store.write = async (input) => {
      if (firstIntent && input.pendingOperations[0]?.status === 'pending') {
        firstIntent = false;
        intentStarted.resolve();
        await releaseIntent.promise;
      }
      return originalWrite(input);
    };
    const action = operation('late-intent-write');
    const execution = engine.execute(action);
    await intentStarted.promise;
    const paused = engine.pause();
    expect(engine.view().cancelled).toBe(true);
    releaseIntent.resolve();
    expect((await execution).code).toBe('CANCELLED');
    await paused;
    expect(action.issue).not.toHaveBeenCalled();
  });

  it('an issued action with an unknown result is never repeated, including after restart', async () => {
    const { engine, storage } = await running();
    const action = operation('uncertain-result', { verify: async () => 'unknown' });
    expect((await engine.execute(action)).code).toBe('OPERATION_UNCONFIRMED');
    expect(action.issue).toHaveBeenCalledTimes(1);
    expect(storage.snapshot()?.pendingOperations[0].status).toBe('awaiting-confirmation');
    expect((await engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
    const restarted = new TaskEngine({ store: storage.store });
    await restarted.init();
    expect(restarted.view()).toMatchObject({ state: 'PAUSED', cancelled: true });
    expect((await restarted.execute(action)).ok).toBe(false);
    expect(action.issue).toHaveBeenCalledTimes(1);
  });

  it('pause after issue preserves awaiting confirmation and does not wait for issued promise', async () => {
    const { engine, storage } = await running();
    const issued = deferred<void>();
    const finish = deferred<void>();
    const action = operation('pending-issued', {
      issue: async () => {
        issued.resolve();
        await finish.promise;
      },
    });
    const execution = engine.execute(action);
    await issued.promise;
    await engine.pause();
    expect((await execution).code).toBe('CANCELLED');
    expect(storage.snapshot()?.pendingOperations[0].status).toBe('awaiting-confirmation');
    finish.resolve();
  });

  it('enforces the fixed same-kind recovery cooldown without delaying pause', async () => {
    const { engine } = await running();
    expect((await engine.execute(operation('recovery-1', { kind: 'recovery' }))).ok).toBe(true);
    const second = operation('recovery-2', { kind: 'recovery' });
    expect((await engine.execute(second)).code).toBe('RECOVERY_COOLDOWN');
    expect(second.issue).not.toHaveBeenCalled();
    const pausing = engine.pause();
    expect(engine.view().state).toBe('PAUSED');
    await pausing;
  });

  it('disconnect cancels work and reconnect does not automatically resume', async () => {
    const { engine } = await running();
    await engine.browserDisconnected();
    expect(engine.view()).toMatchObject({ state: 'PAUSED', cancelled: true });
    await engine.browserConnected();
    expect(engine.view().state).toBe('PAUSED');
    expect((await engine.resume()).code).toBe('COURSE_NOT_CONFIRMED');
  });

  it('startup never auto-resumes a stored MONITORING task or executing operation', async () => {
    const snapshot: TaskSnapshot = {
      schemaVersion: 1,
      taskId: 'previous-task',
      courseId: 'fixture-course',
      chapterId: null,
      savedAt: new Date().toISOString(),
      state: 'MONITORING',
      integrityDigest: '0'.repeat(64),
      confirmedPlatformStatuses: [],
      pendingOperations: [
        {
          operationId: 'issued-id',
          taskId: 'previous-task',
          kind: 'fixture-mutation',
          status: 'executing',
          savedAt: new Date().toISOString(),
        },
      ],
    };
    const storage = memoryStore(snapshot);
    const engine = new TaskEngine({ store: storage.store });
    await engine.init();
    expect(engine.view()).toMatchObject({ state: 'PAUSED', cancelled: true });
    expect(storage.snapshot()?.pendingOperations[0].status).toBe('awaiting-confirmation');
  });
});
