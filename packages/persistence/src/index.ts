import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { TASK_STATES, type OperationRecord, type TaskSnapshot } from '../../contracts/src/index';

export type SnapshotInput = Omit<TaskSnapshot, 'integrityDigest'>;
export interface SnapshotStore {
  load(): Promise<TaskSnapshot | null>;
  write(snapshot: SnapshotInput): Promise<TaskSnapshot>;
}

export class StateStoreError extends Error {
  constructor(
    readonly code:
      'STATE_CORRUPT' | 'STATE_VERSION_UNSUPPORTED' | 'STATE_READ_FAILED' | 'STATE_WRITE_FAILED',
  ) {
    super(code);
    this.name = 'StateStoreError';
  }
}

const SNAPSHOT_KEYS = [
  'schemaVersion',
  'taskId',
  'courseId',
  'chapterId',
  'savedAt',
  'state',
  'pendingOperations',
  'confirmedPlatformStatuses',
  'integrityDigest',
];
const OPERATION_KEYS = ['operationId', 'taskId', 'kind', 'status', 'savedAt'];
const STATUS_KEYS = ['chapterId', 'completed', 'observedAt'];
const OPERATION_STATES = ['pending', 'executing', 'awaiting-confirmation', 'completed', 'failed'];
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keysMatch(value: Record<string, unknown>, keys: string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}
function id(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}
function nullableId(value: unknown): boolean {
  return value === null || id(value);
}
function time(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Deliberately rejects unknown keys: snapshots cannot become a container for page text or credentials. */
export function validateSnapshot(value: unknown): asserts value is TaskSnapshot {
  if (!object(value)) throw new StateStoreError('STATE_CORRUPT');
  if (typeof value.schemaVersion === 'number' && value.schemaVersion !== 1) {
    throw new StateStoreError('STATE_VERSION_UNSUPPORTED');
  }
  if (
    !keysMatch(value, SNAPSHOT_KEYS) ||
    value.schemaVersion !== 1 ||
    !nullableId(value.taskId) ||
    !nullableId(value.courseId) ||
    !nullableId(value.chapterId) ||
    !time(value.savedAt) ||
    !TASK_STATES.includes(value.state as TaskSnapshot['state']) ||
    !Array.isArray(value.pendingOperations) ||
    value.pendingOperations.length > 1000 ||
    !Array.isArray(value.confirmedPlatformStatuses) ||
    value.confirmedPlatformStatuses.length > 10000 ||
    typeof value.integrityDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.integrityDigest)
  ) {
    throw new StateStoreError('STATE_CORRUPT');
  }
  const operationIds = new Set<string>();
  for (const operation of value.pendingOperations) {
    if (
      !object(operation) ||
      !keysMatch(operation, OPERATION_KEYS) ||
      !id(operation.operationId) ||
      !id(operation.taskId) ||
      !id(operation.kind) ||
      !time(operation.savedAt) ||
      !OPERATION_STATES.includes(operation.status as string) ||
      operationIds.has(operation.operationId)
    ) {
      throw new StateStoreError('STATE_CORRUPT');
    }
    operationIds.add(operation.operationId);
  }
  for (const status of value.confirmedPlatformStatuses) {
    if (
      !object(status) ||
      !keysMatch(status, STATUS_KEYS) ||
      !id(status.chapterId) ||
      typeof status.completed !== 'boolean' ||
      !time(status.observedAt)
    ) {
      throw new StateStoreError('STATE_CORRUPT');
    }
  }
}

function normalized(input: SnapshotInput): SnapshotInput {
  return {
    schemaVersion: input.schemaVersion,
    taskId: input.taskId,
    courseId: input.courseId,
    chapterId: input.chapterId,
    savedAt: input.savedAt,
    state: input.state,
    pendingOperations: input.pendingOperations.map((entry: OperationRecord) => ({
      operationId: entry.operationId,
      taskId: entry.taskId,
      kind: entry.kind,
      status: entry.status,
      savedAt: entry.savedAt,
    })),
    confirmedPlatformStatuses: input.confirmedPlatformStatuses.map((entry) => ({
      chapterId: entry.chapterId,
      completed: entry.completed,
      observedAt: entry.observedAt,
    })),
  };
}
function digest(input: SnapshotInput): string {
  return createHash('sha256')
    .update(JSON.stringify(normalized(input)))
    .digest('hex');
}

// Backups create their own StateStore. Coordinate every instance accessing the
// same file so an in-process reader cannot overlap Windows' atomic replacement.
// External locks still fail closed; this queue does not retry filesystem errors.
const snapshotAccess = new Map<string, Promise<void>>();
function withSnapshotAccess<T>(snapshotPath: string, action: () => Promise<T>): Promise<T> {
  const absolute = resolve(snapshotPath);
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const previous = snapshotAccess.get(key) ?? Promise.resolve();
  const work = previous.then(action);
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  snapshotAccess.set(key, settled);
  void settled.then(() => {
    if (snapshotAccess.get(key) === settled) snapshotAccess.delete(key);
  });
  return work;
}

/** Stage 1 atomic snapshot only. Recovery replay, previous snapshots and quarantine belong to stage 4. */
export class StateStore implements SnapshotStore {
  readonly snapshotPath: string;
  private inspection: Promise<TaskSnapshot | null> | null = null;
  private blocked: StateStoreError | null = null;

  constructor(dataDir: string) {
    this.snapshotPath = join(dataDir, 'state', 'snapshot.json');
  }

  async load(): Promise<TaskSnapshot | null> {
    return withSnapshotAccess(this.snapshotPath, async () => {
      await this.inspectOnce();
      return this.readSnapshot();
    });
  }

  write(input: SnapshotInput): Promise<TaskSnapshot> {
    // Capture at invocation so callers cannot mutate a queued intent afterwards.
    let captured: SnapshotInput;
    try {
      const candidate = structuredClone({ ...input, integrityDigest: '0'.repeat(64) });
      validateSnapshot(candidate);
      captured = normalized(candidate);
    } catch {
      return Promise.reject(new StateStoreError('STATE_CORRUPT'));
    }
    return withSnapshotAccess(this.snapshotPath, async () => {
      await this.inspectOnce();
      if (this.blocked) throw this.blocked;
      await this.readSnapshot();
      const snapshot = { ...captured, integrityDigest: digest(captured) };
      const temporary = `${this.snapshotPath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.snapshotPath), { recursive: true });
        const file = await open(temporary, 'wx');
        try {
          await file.writeFile(`${JSON.stringify(snapshot)}\n`, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.snapshotPath);
        return structuredClone(snapshot);
      } catch {
        await unlink(temporary).catch(() => undefined);
        throw new StateStoreError('STATE_WRITE_FAILED');
      }
    });
  }

  private inspectOnce(): Promise<TaskSnapshot | null> {
    if (this.blocked) return Promise.reject(this.blocked);
    this.inspection ??= this.readSnapshot();
    return this.inspection;
  }

  private async readSnapshot(): Promise<TaskSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.snapshotPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.blocked = new StateStoreError('STATE_READ_FAILED');
      throw this.blocked;
    }
    try {
      const snapshot: unknown = JSON.parse(raw);
      validateSnapshot(snapshot);
      const expected = Buffer.from(digest(snapshot), 'hex');
      if (!timingSafeEqual(expected, Buffer.from(snapshot.integrityDigest, 'hex'))) {
        throw new StateStoreError('STATE_CORRUPT');
      }
      return snapshot;
    } catch (error) {
      this.blocked =
        error instanceof StateStoreError ? error : new StateStoreError('STATE_CORRUPT');
      throw this.blocked;
    }
  }
}
