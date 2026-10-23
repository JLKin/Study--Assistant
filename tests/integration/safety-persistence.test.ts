import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CourseObservation } from '../../packages/contracts/src/index';
import { StateStore } from '../../packages/persistence/src/index';
import { TaskEngine } from '../../packages/task-engine/src/index';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function current(): CourseObservation {
  return {
    courseId: 'fixture-course',
    title: '独立模拟课程',
    observedAt: new Date().toISOString(),
    confidence: 'verified',
    source: 'fixture',
    authenticated: true,
    pageKind: 'course',
    platformCompleted: null,
    evidence: ['fixture-only'],
  };
}

describe('critical storage and task engine integration', () => {
  it('actual critical-directory failure blocks an effect and restart stays paused', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhihuishu-stage1-safety-'));
    directories.push(directory);
    const store = new StateStore(directory);
    const engine = new TaskEngine({
      store,
      testCapabilities: { enabled: true, inspect: async () => current(), backup: async () => true },
    });
    await engine.browserConnected();
    await engine.confirmCourse(current(), 'fixture-course');
    expect((await engine.start()).ok).toBe(true);
    // The only removed path is this test's freshly-created state directory.
    await rm(join(directory, 'state'), { recursive: true });
    await writeFile(join(directory, 'state'), 'filesystem-fault-fixture');
    const issue = vi.fn(async () => undefined);
    expect(
      (
        await engine.execute({
          operationId: 'must-not-issue',
          kind: 'fixture-mutation',
          issue,
          verify: async () => 'confirmed',
        })
      ).code,
    ).toBe('STATE_WRITE_FAILED');
    expect(issue).not.toHaveBeenCalled();
    expect(engine.view()).toMatchObject({ state: 'PAUSED', persistenceHealthy: false });
    const restarted = new TaskEngine({ store: new StateStore(directory) });
    expect((await restarted.init()).ok).toBe(false);
    expect(restarted.view()).toMatchObject({ state: 'PAUSED', persistenceHealthy: false });
  });

  it('persists unknown operations across a real-store restart without issuing again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhihuishu-stage1-safety-'));
    directories.push(directory);
    const store = new StateStore(directory);
    const engine = new TaskEngine({
      store,
      testCapabilities: { enabled: true, inspect: async () => current(), backup: async () => true },
    });
    await engine.browserConnected();
    await engine.confirmCourse(current(), 'fixture-course');
    await engine.start();
    const issue = vi.fn(async () => undefined);
    const action = {
      operationId: 'unknown-result',
      kind: 'fixture-mutation' as const,
      issue,
      verify: async () => 'unknown' as const,
    };
    expect((await engine.execute(action)).code).toBe('OPERATION_UNCONFIRMED');
    const restarted = new TaskEngine({
      store: new StateStore(directory),
      testCapabilities: { enabled: true, inspect: async () => current(), backup: async () => true },
    });
    await restarted.init();
    expect(restarted.view().state).toBe('PAUSED');
    await restarted.browserConnected();
    await restarted.confirmCourse(current(), 'fixture-course');
    expect((await restarted.start()).code).toBe('UNCONFIRMED_OPERATION');
    expect((await restarted.execute(action)).ok).toBe(false);
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
