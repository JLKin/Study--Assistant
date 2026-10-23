import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_VALIDATORS, DEFAULT_CONFIG, isRecord } from '../../contracts/src/config';
import type { AppConfig } from '../../contracts/src/index';
import { StateStore } from './index';

/**
 * Minimal stage-2 pre-task write barrier. This is not the stage-4 rolling backup,
 * restoration, quarantine or retention service. Incomplete directories are preserved.
 */
export class TaskBackup {
  constructor(private readonly dataDir: string) {}

  async create(signal?: AbortSignal): Promise<boolean> {
    try {
      signal?.throwIfAborted();
      const settingsPath = join(this.dataDir, 'config', 'settings.json');
      const snapshotPath = join(this.dataDir, 'state', 'snapshot.json');
      for (const source of [settingsPath, snapshotPath]) {
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink()) return false;
        signal?.throwIfAborted();
      }
      // An unacknowledged config repair must never become a successful task barrier.
      try {
        await lstat(join(this.dataDir, 'config', 'repair-pending.json'));
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
      const candidate: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
      if (!validConfig(candidate)) return false;
      const snapshot = await new StateStore(this.dataDir).load();
      if (!snapshot) return false;
      signal?.throwIfAborted();

      const parent = join(this.dataDir, 'backups', 'task-before');
      await mkdir(parent, { recursive: true });
      signal?.throwIfAborted();
      const directory = join(parent, `${Date.now()}-${randomUUID()}`);
      await mkdir(directory);
      const documents = {
        'settings.json': `${JSON.stringify(candidate)}\n`,
        'snapshot.json': `${JSON.stringify(snapshot)}\n`,
      };
      const checksums: Record<string, string> = {};
      for (const [name, body] of Object.entries(documents)) {
        signal?.throwIfAborted();
        const path = join(directory, name);
        await exclusiveWrite(path, body);
        signal?.throwIfAborted();
        const stored = await readFile(path, 'utf8');
        if (stored !== body) return false;
        checksums[name] = checksum(stored);
      }
      signal?.throwIfAborted();
      const manifest = `${JSON.stringify({
        schemaVersion: 1,
        kind: 'stage2-task-before',
        savedAt: new Date().toISOString(),
        files: checksums,
      })}\n`;
      // The final manifest marks a complete barrier; a partial write never reports success.
      const manifestPath = join(directory, 'manifest.json');
      await exclusiveWrite(manifestPath, manifest);
      signal?.throwIfAborted();
      return (await readFile(manifestPath, 'utf8')) === manifest;
    } catch {
      return false;
    }
  }
}

function validConfig(value: unknown): value is AppConfig {
  if (!isRecord(value)) return false;
  const keys = Object.keys(DEFAULT_CONFIG) as Array<keyof AppConfig>;
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key) && CONFIG_VALIDATORS[key](value[key])) &&
    (value.bufferTimeoutMs as number) >= (value.pollIntervalMs as number) &&
    (value.stallTimeoutMs as number) >= (value.pollIntervalMs as number)
  );
}

async function exclusiveWrite(path: string, text: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
