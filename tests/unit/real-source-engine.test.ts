import { describe, expect, it, vi } from 'vitest';
import type { CourseObservation, TaskSnapshot } from '../../packages/contracts/src/index';
import type { SiteObservation } from '../../packages/contracts/src/monitor';
import type { SnapshotInput, SnapshotStore } from '../../packages/persistence/src/index';
import { TaskEngine, type GuardedOperation } from '../../packages/task-engine/src/index';

function course(patch: Partial<CourseObservation> = {}): CourseObservation {
  return {
    courseId: 'zhs_course_123',
    title: '真实 DOM 派生测试课程',
    observedAt: new Date().toISOString(),
    confidence: 'verified',
    source: 'zhihuishu-dom',
    authenticated: true,
    pageKind: 'course',
    platformCompleted: null,
    evidence: ['sanitized-dom-fixture'],
    ...patch,
  };
}

function memory() {
  let snapshot: TaskSnapshot | null = null;
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
  return { engine, storage, backup, setCourse: (value: CourseObservation) => (current = value) };
}

function operation(kind: GuardedOperation['kind'] = 'recovery'): GuardedOperation {
  return {
    operationId: 'real-operation-1',
    kind,
    issue: vi.fn(async () => undefined),
    verify: async () => 'confirmed',
  };
}

describe('verified real source is limited to the production stage 2 capability', () => {
  it('requires explicit confirmation, then starts with real DOM wording and guarded intent', async () => {
    const { engine, storage, backup } = await setup();
    expect((await engine.start()).code).toBe('COURSE_NOT_CONFIRMED');
    expect(backup).not.toHaveBeenCalled();
    expect((await engine.confirmCourse(course(), 'zhs_course_123')).ok).toBe(true);
    expect(engine.view().reason).toContain('真实 DOM');
    const started = await engine.start();
    expect(started).toMatchObject({ ok: true, code: 'TASK_STARTED' });
    expect(started.message).toContain('待真实环境人工验收');
    expect(engine.view().reason).not.toContain('模拟');
    expect(backup).toHaveBeenCalledOnce();
    const action = operation();
    expect((await engine.execute(action)).ok).toBe(true);
    expect(action.issue).toHaveBeenCalledOnce();
    expect(
      storage.writes
        .filter((snapshot) => snapshot.pendingOperations.length)
        .map((snapshot) => snapshot.pendingOperations[0].status),
    ).toEqual(['pending', 'executing', 'awaiting-confirmation', 'completed']);
  });

  it.each(['none', 'test', 'both'] as const)(
    '%s capability configuration cannot confirm or activate a real observation',
    async (capability) => {
      const inspect = async () => course();
      const backup = vi.fn(async () => true);
      const capabilities = { enabled: true as const, inspect, backup };
      const engine = new TaskEngine({
        store: memory().store,
        ...(capability === 'test' || capability === 'both'
          ? { testCapabilities: capabilities }
          : {}),
        ...(capability === 'both' ? { stage2Capabilities: capabilities } : {}),
      });
      await engine.browserConnected();
      expect((await engine.confirmCourse(course(), 'zhs_course_123')).code).toBe(
        'COURSE_UNVERIFIED',
      );
      expect((await engine.start()).ok).toBe(false);
      expect(backup).not.toHaveBeenCalled();
      const action = operation('fixture-mutation');
      expect((await engine.execute(action)).ok).toBe(false);
      expect(action.issue).not.toHaveBeenCalled();
    },
  );

  it.each([
    { source: 'real-unverified' as const },
    { confidence: 'uncertain' as const },
    { authenticated: 'unknown' as const },
    { authenticated: false },
    { pageKind: 'graded' as const },
    { pageKind: 'unknown' as const },
    { observedAt: new Date(Date.now() - 60000).toISOString() },
    { observedAt: new Date(Date.now() + 60000).toISOString() },
    { observedAt: 'invalid' },
    { courseId: 'other-course' },
  ])('does not loosen existing course gates for %j', async (patch) => {
    const { engine, backup } = await setup();
    expect((await engine.confirmCourse(course(patch), 'zhs_course_123')).code).toBe(
      'COURSE_UNVERIFIED',
    );
    expect(engine.confirmedCourse).toBeNull();
    expect((await engine.start()).ok).toBe(false);
    expect(backup).not.toHaveBeenCalled();
  });

  it('rejects unknown or changed source at the action gate even with the same course ID', async () => {
    for (const source of ['real-unverified', 'fixture'] as const) {
      const { engine, setCourse } = await setup();
      await engine.confirmCourse(course(), 'zhs_course_123');
      expect((await engine.start()).ok).toBe(true);
      setCourse(course({ source }));
      const action = operation();
      expect((await engine.execute(action)).ok).toBe(false);
      expect(action.issue).not.toHaveBeenCalled();
      expect(engine.view()).toMatchObject({ state: 'PAUSED', cancelled: true });
      expect(engine.confirmedCourse).toBeNull();
    }
  });

  it('cannot use a generic fixture mutation for a verified real source', async () => {
    const { engine } = await setup();
    await engine.confirmCourse(course(), 'zhs_course_123');
    await engine.start();
    const action = operation('fixture-mutation');
    expect((await engine.execute(action)).code).toBe('INVALID_OPERATION');
    expect(action.issue).not.toHaveBeenCalled();
  });

  it('one-shot read-only preview cannot confirm a course or authorize an existing task', async () => {
    const { engine, setCourse, backup } = await setup();
    const preview = course({ evidence: ['READ_ONLY_PREVIEW：单次只读采样，不授权网页动作。'] });
    expect((await engine.confirmCourse(preview, 'zhs_course_123')).code).toBe('COURSE_UNVERIFIED');
    expect((await engine.start()).ok).toBe(false);
    expect(backup).not.toHaveBeenCalled();
    expect((await engine.confirmCourse(course(), 'zhs_course_123')).ok).toBe(true);
    expect((await engine.start()).ok).toBe(true);
    setCourse(preview);
    const action = operation('playback-start');
    expect((await engine.execute(action)).ok).toBe(false);
    expect(action.issue).not.toHaveBeenCalled();
    expect(engine.confirmedCourse).toBeNull();
  });

  it('explicit playback-start has an independent schema 1 intent and confirmed feedback', async () => {
    const { engine, storage } = await setup();
    await engine.confirmCourse(course(), 'zhs_course_123');
    await engine.start();
    const action = operation('playback-start');
    expect((await engine.execute(action)).code).toBe('OPERATION_COMPLETED');
    expect(action.issue).toHaveBeenCalledOnce();
    expect(storage.snapshot()).toMatchObject({
      schemaVersion: 1,
      pendingOperations: [{ kind: 'playback-start', status: 'completed' }],
    });
    expect(
      storage.writes
        .filter((snapshot) => snapshot.pendingOperations.length)
        .map((snapshot) => snapshot.pendingOperations[0].status),
    ).toEqual(['pending', 'executing', 'awaiting-confirmation', 'completed']);
  });

  it('explicit playback-start preparation rejection creates no intent or play', async () => {
    const { engine, storage } = await setup();
    await engine.confirmCourse(course(), 'zhs_course_123');
    await engine.start();
    const action = {
      ...operation('playback-start'),
      prepare: vi.fn(async () => {
        throw new Error('current chapter is not paused');
      }),
    };
    expect((await engine.execute(action)).ok).toBe(false);
    expect(action.issue).not.toHaveBeenCalled();
    expect(storage.snapshot()?.pendingOperations).toEqual([]);
  });

  it('playback-start issue failure preserves unknown result and blocks retries and task resume', async () => {
    const { engine, storage } = await setup();
    await engine.confirmCourse(course(), 'zhs_course_123');
    await engine.start();
    const action = {
      ...operation('playback-start'),
      issue: vi.fn(async () => {
        throw new Error('play rejected after issuance');
      }),
    };
    expect((await engine.execute(action)).code).toBe('UNSAFE_PAGE_OR_RESULT');
    expect(action.issue).toHaveBeenCalledOnce();
    expect(storage.snapshot()?.pendingOperations).toMatchObject([
      { kind: 'playback-start', status: 'awaiting-confirmation' },
    ]);
    await engine.confirmCourse(course(), 'zhs_course_123');
    expect((await engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
    expect((await engine.execute(action)).ok).toBe(false);
    expect(action.issue).toHaveBeenCalledOnce();
    expect(storage.snapshot()?.pendingOperations).toMatchObject([
      { kind: 'playback-start', status: 'awaiting-confirmation' },
    ]);
  });

  it('records only schema 1 IDs and explicit platform status without persisting real DOM text', async () => {
    const { engine, storage } = await setup();
    await engine.confirmCourse(course(), 'zhs_course_123');
    await engine.start();
    const observedAt = new Date().toISOString();
    const observation: SiteObservation = {
      course: course(),
      player: null,
      currentChapterId: 'zhs_v1_chapter_1',
      chapters: [
        {
          chapterId: 'zhs_v1_chapter_1',
          title: '本轮未核实完成图标语义的真实章节',
          platformCompleted: null,
          observedAt,
          confidence: 'verified',
        },
      ],
      popup: 'none',
      safeToRefresh: false,
      supportedRates: [1, 1.25, 1.5],
      capabilities: {
        playbackRate: true,
        recoverPlay: false,
        refresh: false,
        navigation: false,
        completionMarkers: false,
      },
    };
    expect((await engine.recordObservation(observation)).ok).toBe(true);
    expect(storage.snapshot()).toMatchObject({
      schemaVersion: 1,
      courseId: 'zhs_course_123',
      chapterId: 'zhs_v1_chapter_1',
      confirmedPlatformStatuses: [],
    });
    expect(Object.keys(storage.snapshot()!).sort()).toEqual(
      [
        'schemaVersion',
        'taskId',
        'courseId',
        'chapterId',
        'savedAt',
        'state',
        'pendingOperations',
        'confirmedPlatformStatuses',
        'integrityDigest',
      ].sort(),
    );
    const serialized = JSON.stringify(storage.snapshot());
    expect(serialized).not.toContain('真实 DOM 派生测试课程');
    expect(serialized).not.toContain('未核实完成图标');
    expect(serialized).not.toContain('capabilities');
    const restored = new TaskEngine({
      store: storage.store,
      stage2Capabilities: {
        enabled: true,
        inspect: async () => course(),
        backup: async () => true,
      },
    });
    await restored.init();
    await restored.browserConnected();
    expect((await restored.resume()).code).toBe('COURSE_NOT_CONFIRMED');
  });
});
