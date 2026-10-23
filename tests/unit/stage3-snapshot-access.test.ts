import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateStore, type SnapshotInput } from '../../packages/persistence/src/index';
import { TaskEngine } from '../../packages/task-engine/src/index';
import { course } from '../helpers/stage3';

type Gate = { entered(): void; waiting: Promise<void> };
const access = vi.hoisted(() => ({
  target: '',
  readGate: null as Gate | null,
  renameGate: null as Gate | null,
  readers: 0,
  collisions: 0,
  renames: 0,
  rejectRename: false,
}));

/** Model the Windows sharing violation without relying on a lucky scheduler or a real user file. */
vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  const path = await import('node:path');
  const key = (value: unknown) => {
    const name = path.resolve(String(value));
    return process.platform === 'win32' ? name.toLowerCase() : name;
  };
  return {
    ...native,
    readFile: async (...args: Parameters<typeof native.readFile>) => {
      const gate = key(args[0]) === access.target ? access.readGate : null;
      if (!gate) return native.readFile(...args);
      access.readGate = null;
      access.readers++;
      try {
        const raw = await native.readFile(...args);
        gate.entered();
        await gate.waiting;
        return raw;
      } finally {
        access.readers--;
      }
    },
    rename: async (...args: Parameters<typeof native.rename>) => {
      if (key(args[1]) === access.target) {
        access.renames++;
        if (access.readers || access.rejectRename) {
          if (access.readers) access.collisions++;
          throw Object.assign(new Error('EPERM'), { code: 'EPERM', syscall: 'rename' });
        }
        const gate = access.renameGate;
        access.renameGate = null;
        if (gate) {
          gate.entered();
          await gate.waiting;
        }
      }
      return native.rename(...args);
    },
  };
});

const input = (state: SnapshotInput['state']): SnapshotInput => ({
  schemaVersion: 1,
  taskId: 'snapshot-task',
  courseId: 'stage3-course',
  chapterId: 'chapter-1',
  state,
  savedAt: new Date().toISOString(),
  pendingOperations: [],
  confirmedPlatformStatuses: [],
});
const gates: Array<() => void> = [];
function gate() {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((done) => (entered = done));
  const waiting = new Promise<void>((done) => (release = done));
  gates.push(release);
  return { trap: { entered, waiting }, ready, release };
}
async function settledWithin<T>(promise: Promise<T>, ms = 100) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((done) => {
        timer = setTimeout(() => done(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let directory: string;
let writer: StateStore;
beforeEach(async () => {
  Object.assign(access, {
    target: '',
    readGate: null,
    renameGate: null,
    readers: 0,
    collisions: 0,
    renames: 0,
    rejectRename: false,
  });
  directory = await mkdtemp(join(tmpdir(), 'stage3-snapshot-access-'));
  writer = new StateStore(directory);
  await writer.write(input('MONITORING'));
  const path = resolve(writer.snapshotPath);
  access.target = process.platform === 'win32' ? path.toLowerCase() : path;
});
afterEach(async () => {
  gates.splice(0).forEach((release) => release());
  access.target = '';
  // Allow outstanding test-only filesystem completions to drain before removing this owned path.
  await writer.load().catch(() => undefined);
  const path = resolve(directory);
  if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('stage3-snapshot-access-'))
    throw new Error('REFUSE_OUTSIDE_TEMP');
  await rm(path, { recursive: true, force: true });
});

describe('阶段3快照读写互斥：不依赖重试消除自身文件占用', () => {
  it.each(['same-instance', 'path-alias', 'windows-case-alias'] as const)(
    '%s 的读取未关闭前不替换快照，写入只尝试一次',
    async (mode) => {
      const reader =
        mode === 'same-instance'
          ? writer
          : new StateStore(
              mode === 'windows-case-alias' && process.platform === 'win32'
                ? directory.toUpperCase()
                : join(directory, '.'),
            );
      const held = gate();
      access.readGate = held.trap;
      const reading = reader.load();
      await held.ready;
      const writing = writer.write(input('PAUSED'));
      const outcome = writing.then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      );
      const early = await settledWithin(outcome);
      held.release();
      await reading;
      expect(await outcome).toEqual({ ok: true });
      expect(early).toBe(false);
      expect(access.collisions).toBe(0);
      expect(access.renames).toBe(1);
      expect((await writer.load())?.state).toBe('PAUSED');
    },
  );
  it('替换正在等待时，另一实例读取必须等提交完成，不能提前读到旧状态', async () => {
    const held = gate();
    access.renameGate = held.trap;
    const writing = writer.write(input('PAUSED'));
    await held.ready;
    const reading = new StateStore(directory).load();
    const early = await settledWithin(reading);
    held.release();
    await writing;
    expect((await reading)?.state).toBe('PAUSED');
    expect(early).toBe(false);
  });
  it('同路径不同实例的两次写入按请求顺序完成，不被早发晚到覆盖', async () => {
    const held = gate();
    access.renameGate = held.trap;
    const first = writer.write(input('WAIT_LOGIN'));
    await held.ready;
    const second = new StateStore(directory).write(input('PAUSED'));
    const early = await settledWithin(second);
    held.release();
    await Promise.all([first, second]);
    expect((await writer.load())?.state).toBe('PAUSED');
    expect(early).toBe(false);
  });
  it('不同快照路径互不阻塞', async () => {
    const held = gate();
    access.renameGate = held.trap;
    const first = writer.write(input('PAUSED'));
    await held.ready;
    const other = new StateStore(join(directory, 'independent'));
    const independent = other.write(input('WAIT_LOGIN'));
    const completed = await settledWithin(independent, 1000);
    held.release();
    await first;
    await independent;
    expect(completed).toBe(true);
    expect((await other.load())?.state).toBe('WAIT_LOGIN');
  });
  it('外部/权限EPERM不重试，不删旧快照，也不污染后续队列', async () => {
    const before = await readFile(writer.snapshotPath, 'utf8');
    access.rejectRename = true;
    await expect(writer.write(input('PAUSED'))).rejects.toMatchObject({
      code: 'STATE_WRITE_FAILED',
    });
    expect(access.renames).toBe(1);
    expect(await readFile(writer.snapshotPath, 'utf8')).toBe(before);
    expect(await readdir(join(directory, 'state'))).toEqual(['snapshot.json']);
    access.rejectRename = false;
    expect((await new StateStore(directory).load())?.state).toBe('MONITORING');
  });
  it('锁等待期间P0立即取消，释放读取后也不能发出迟到动作', async () => {
    const engine = new TaskEngine({
      store: writer,
      testCapabilities: { enabled: true, inspect: async () => course(), backup: async () => true },
    });
    await engine.browserConnected();
    await engine.confirmCourse(course(), 'stage3-course');
    expect((await engine.resume()).ok).toBe(true);
    const held = gate();
    access.readGate = held.trap;
    const reading = new StateStore(directory).load();
    await held.ready;
    const issue = vi.fn(async () => undefined);
    const execution = engine.execute({
      operationId: 'blocked-by-paused-io',
      kind: 'fixture-mutation',
      issue,
      verify: async () => 'confirmed',
    });
    const paused = engine.pause();
    expect(engine.signal.aborted).toBe(true);
    expect(engine.view().state).toBe('PAUSED');
    held.release();
    await reading;
    await paused;
    expect((await execution).ok).toBe(false);
    expect(issue).not.toHaveBeenCalled();
  });
  it('实际替换失败依然阻止新网页动作', async () => {
    const engine = new TaskEngine({
      store: writer,
      testCapabilities: { enabled: true, inspect: async () => course(), backup: async () => true },
    });
    await engine.browserConnected();
    await engine.confirmCourse(course(), 'stage3-course');
    expect((await engine.resume()).ok).toBe(true);
    access.rejectRename = true;
    const issue = vi.fn(async () => undefined);
    expect(
      (
        await engine.execute({
          operationId: 'external-lock',
          kind: 'fixture-mutation',
          issue,
          verify: async () => 'confirmed',
        })
      ).code,
    ).toBe('STATE_WRITE_FAILED');
    expect(issue).not.toHaveBeenCalled();
    expect(engine.view()).toMatchObject({ state: 'PAUSED', persistenceHealthy: false });
    expect(access.renames).toBeGreaterThan(0);
  });
});
