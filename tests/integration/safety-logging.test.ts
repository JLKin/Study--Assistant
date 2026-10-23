import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../../packages/logging/src/index';
import { StateStore } from '../../packages/persistence/src/index';
import { TaskEngine } from '../../packages/task-engine/src/index';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('logger failure callbacks and task cancellation', () => {
  it.each(['write-failure', 'buffer-overflow'] as const)(
    '%s safely pauses the task without recursively logging',
    async (fault) => {
      const directory = await mkdtemp(join(tmpdir(), 'zhihuishu-stage1-log-safety-'));
      directories.push(directory);
      let engine!: TaskEngine;
      let notifications = 0;
      const pendingPauses: Promise<unknown>[] = [];
      const logger = new Logger(directory, {
        onFailure: () => {
          notifications++;
          pendingPauses.push(engine.pause());
        },
      });
      engine = new TaskEngine({ store: new StateStore(directory), logger });
      await engine.init();
      if (fault === 'write-failure')
        await writeFile(join(directory, 'logs'), 'filesystem-fault-fixture');
      const count = fault === 'write-failure' ? 1 : 600;
      for (let index = 0; index < count; index++) logger.log('INFO', 'app', 'APP_STARTED');
      expect(await logger.flush()).toBe(false);
      await Promise.all(pendingPauses);
      expect(notifications).toBe(1);
      expect(engine.view()).toMatchObject({ state: 'PAUSED', cancelled: true });
      expect(logger.readEntries().length).toBeLessThanOrEqual(500);
      logger.log('ERROR', 'app', 'APP_FAILED');
      await logger.flush();
      await Promise.all(pendingPauses);
      expect(notifications).toBe(1);
    },
  );

  it('allows one new failure notification after writes have recovered', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhihuishu-stage1-log-safety-'));
    directories.push(directory);
    await writeFile(join(directory, 'logs'), 'filesystem-fault-fixture');
    let notifications = 0;
    const logger = new Logger(directory, {
      onFailure: () => {
        notifications++;
      },
    });
    logger.log('INFO', 'app', 'APP_STARTED');
    expect(await logger.flush()).toBe(false);
    expect(notifications).toBe(1);
    await rm(join(directory, 'logs'));
    logger.log('INFO', 'app', 'APP_STARTED');
    expect(await logger.flush()).toBe(true);
    await rm(join(directory, 'logs'), { recursive: true });
    await writeFile(join(directory, 'logs'), 'filesystem-fault-fixture');
    logger.log('ERROR', 'app', 'APP_FAILED');
    expect(await logger.flush()).toBe(false);
    expect(notifications).toBe(2);
  });
});
