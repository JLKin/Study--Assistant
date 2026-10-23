import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore, type SnapshotInput } from '../../packages/persistence/src/index';

const input = (state: SnapshotInput['state'] = 'IDLE'): SnapshotInput => ({
  schemaVersion: 1,
  taskId: null,
  courseId: null,
  chapterId: null,
  savedAt: new Date().toISOString(),
  state,
  pendingOperations: [],
  confirmedPlatformStatuses: [],
});
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'zhihuishu-stage1-state-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('stage 1 critical snapshots', () => {
  it('writes a complete versioned integrity-checked snapshot and reloads it', async () => {
    const store = new StateStore(directory);
    expect(await store.load()).toBeNull();
    const snapshot = await store.write(input());
    expect(snapshot.integrityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await new StateStore(directory).load()).toEqual(snapshot);
    expect(await readdir(join(directory, 'state'))).toEqual(['snapshot.json']);
  });

  it('serializes concurrent updates and captures queued input at invocation', async () => {
    const store = new StateStore(directory);
    const first = input('WAIT_LOGIN');
    const firstWrite = store.write(first);
    first.state = 'ERROR';
    const secondWrite = store.write(input('PAUSED'));
    expect((await firstWrite).state).toBe('WAIT_LOGIN');
    await secondWrite;
    expect((await store.load())?.state).toBe('PAUSED');
  });

  it('does not overwrite unknown schema versions even when write is called before load', async () => {
    await mkdir(join(directory, 'state'));
    const raw = JSON.stringify({ schemaVersion: 9, opaque: 'preserve-existing-format' });
    await writeFile(join(directory, 'state', 'snapshot.json'), raw);
    const store = new StateStore(directory);
    await expect(store.write(input())).rejects.toMatchObject({ code: 'STATE_VERSION_UNSUPPORTED' });
    expect(await readFile(store.snapshotPath, 'utf8')).toBe(raw);
  });

  it('detects tampering, preserves the original and locks subsequent writes', async () => {
    const store = new StateStore(directory);
    await store.write(input());
    const raw = (await readFile(store.snapshotPath, 'utf8')).replace(
      '"state":"IDLE"',
      '"state":"MONITORING"',
    );
    await writeFile(store.snapshotPath, raw);
    await expect(store.load()).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
    await expect(store.write(input())).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
    expect(await readFile(store.snapshotPath, 'utf8')).toBe(raw);
  });

  it('rejects unknown payload fields and duplicate operation IDs', async () => {
    const store = new StateStore(directory);
    await expect(
      store.write({ ...input(), arbitraryPageText: 'not-allowed' } as SnapshotInput),
    ).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
    const record = {
      operationId: 'id-1',
      taskId: 'task-1',
      kind: 'fixture-mutation',
      status: 'pending' as const,
      savedAt: new Date().toISOString(),
    };
    await expect(
      store.write({ ...input(), pendingOperations: [record, record] }),
    ).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  });

  it('reports real filesystem write failure without exposing filesystem error details', async () => {
    await writeFile(join(directory, 'state'), 'a file cannot be a directory');
    const store = new StateStore(directory);
    await expect(store.write(input())).rejects.toMatchObject({
      code: expect.stringMatching(/^STATE_(READ|WRITE)_FAILED$/),
      message: expect.stringMatching(/^STATE_(READ|WRITE)_FAILED$/),
    });
  });
});
