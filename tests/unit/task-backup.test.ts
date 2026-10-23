import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../packages/contracts/src/config';
import { StateStore } from '../../packages/persistence/src/index';
import { TaskBackup } from '../../packages/persistence/src/task-backup';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stage2-task-backup-'));
  await mkdir(join(directory, 'config'));
  await writeFile(join(directory, 'config', 'settings.json'), JSON.stringify(DEFAULT_CONFIG));
  await new StateStore(directory).write({
    schemaVersion: 1,
    taskId: null,
    courseId: 'fixture-course',
    chapterId: 'fixture-chapter',
    savedAt: new Date().toISOString(),
    state: 'COURSE_CONFIRM',
    pendingOperations: [],
    confirmedPlatformStatuses: [],
  });
});
afterEach(async () => {
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('stage2-task-backup-'))
    throw new Error('拒绝清理测试目录以外的路径');
  await rm(target, { recursive: true, force: true });
});

describe('minimal stage 2 task-before backup barrier', () => {
  it('writes unique complete verified config and snapshot copies, excluding browser profile', async () => {
    await mkdir(join(directory, 'browser-profile'));
    await writeFile(
      join(directory, 'browser-profile', 'private-sentinel'),
      'do-not-export-profile-credentials',
    );
    const backup = new TaskBackup(directory);
    expect(await backup.create()).toBe(true);
    expect(await backup.create()).toBe(true);
    const parent = join(directory, 'backups', 'task-before');
    const entries = await readdir(parent);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      const backupDir = join(parent, entry);
      expect((await readdir(backupDir)).sort()).toEqual([
        'manifest.json',
        'settings.json',
        'snapshot.json',
      ]);
      const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ schemaVersion: 1, kind: 'stage2-task-before' });
      for (const name of ['settings.json', 'snapshot.json']) {
        const raw = await readFile(join(backupDir, name), 'utf8');
        expect(createHash('sha256').update(raw).digest('hex')).toBe(manifest.files[name]);
        expect(raw).not.toContain('do-not-export-profile');
      }
      expect(JSON.parse(await readFile(join(backupDir, 'settings.json'), 'utf8'))).toEqual(
        DEFAULT_CONFIG,
      );
      expect(JSON.parse(await readFile(join(backupDir, 'snapshot.json'), 'utf8'))).toEqual(
        await new StateStore(directory).load(),
      );
    }
    expect(await readFile(join(directory, 'browser-profile', 'private-sentinel'), 'utf8')).toBe(
      'do-not-export-profile-credentials',
    );
  });

  it('rejects tampered snapshots and preserves their original bytes', async () => {
    const path = join(directory, 'state', 'snapshot.json');
    const raw = (await readFile(path, 'utf8')).replace('COURSE_CONFIRM', 'MONITORING');
    await writeFile(path, raw);
    expect(await new TaskBackup(directory).create()).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(raw);
    expect(await readdir(directory)).not.toContain('backups');
  });

  it.each([
    { ...DEFAULT_CONFIG, schemaVersion: 9 },
    { ...DEFAULT_CONFIG, token: 'must-not-export' },
    { ...DEFAULT_CONFIG, targetPlaybackRate: 3 },
    { ...DEFAULT_CONFIG, pollIntervalMs: 10000, stallTimeoutMs: 5000 },
  ])(
    'does not silently repair or copy invalid/future/extra-field settings %j',
    async (settings) => {
      const raw = JSON.stringify(settings);
      const path = join(directory, 'config', 'settings.json');
      await writeFile(path, raw);
      expect(await new TaskBackup(directory).create()).toBe(false);
      expect(await readFile(path, 'utf8')).toBe(raw);
      expect(await readdir(directory)).not.toContain('backups');
    },
  );

  it('unacknowledged critical config repairs prevent the backup barrier', async () => {
    await writeFile(
      join(directory, 'config', 'repair-pending.json'),
      JSON.stringify({ schemaVersion: 1, requiresConfirmation: true }),
    );
    expect(await new TaskBackup(directory).create()).toBe(false);
    expect(await readdir(directory)).not.toContain('backups');
  });

  it('filesystem failure and prior cancellation never report success', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await new TaskBackup(directory).create(controller.signal)).toBe(false);
    expect(await readdir(directory)).not.toContain('backups');
    await writeFile(join(directory, 'backups'), 'fault-fixture');
    expect(await new TaskBackup(directory).create()).toBe(false);
    expect(await readFile(join(directory, 'backups'), 'utf8')).toBe('fault-fixture');
  });
});
