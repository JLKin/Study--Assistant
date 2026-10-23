import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OperationRecord, TaskSnapshot } from '../../contracts/src/index';
import { CONFIG_VALIDATORS, DEFAULT_CONFIG, isRecord } from '../../contracts/src/config';
import { StateStore } from './index';

const DECISION = 'abandon-old-attempt-allow-one-fresh-task' as const;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
export interface PracticeReviewPreview {
  snapshotDigest: string;
  taskId: string;
  courseId: string;
  chapterId: string;
  chapterSource: string;
  operation: OperationRecord;
}
export interface PracticeReviewChapterEvidence {
  resolve(snapshot: TaskSnapshot): Promise<{ chapterId: string; source: string }>;
}
export interface PracticeReviewReceipt extends PracticeReviewPreview {
  schemaVersion: 1;
  kind: 'stage3-manual-practice-review';
  id: string;
  savedAt: string;
  decision: typeof DECISION;
  outcome: 'unknown';
  files: { 'snapshot.json': string; 'settings.json': string };
  integrityDigest: string;
}

async function preview(
  snapshot: TaskSnapshot | null,
  evidence?: PracticeReviewChapterEvidence,
): Promise<PracticeReviewPreview> {
  const unknown = snapshot?.pendingOperations.filter((op) =>
    ['pending', 'executing', 'awaiting-confirmation'].includes(op.status),
  );
  if (
    !snapshot ||
    snapshot.state !== 'PAUSED' ||
    !snapshot.taskId ||
    !snapshot.courseId ||
    unknown?.length !== 1 ||
    unknown[0].kind !== 'practice-submit' ||
    unknown[0].status !== 'awaiting-confirmation' ||
    unknown[0].taskId !== snapshot.taskId
  )
    throw new Error('MANUAL_REVIEW_NOT_ELIGIBLE');
  const chapter = snapshot.chapterId
    ? { chapterId: snapshot.chapterId, source: 'schema1-snapshot' }
    : await evidence?.resolve(snapshot);
  if (!chapter || !ID.test(chapter.chapterId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(chapter.source))
    throw new Error('MANUAL_REVIEW_CHAPTER_EVIDENCE_REQUIRED');
  return {
    snapshotDigest: snapshot.integrityDigest,
    taskId: snapshot.taskId,
    courseId: snapshot.courseId,
    chapterId: chapter.chapterId,
    chapterSource: chapter.source,
    operation: { ...unknown[0] },
  };
}

async function regularRead(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('REVIEW_UNSAFE_FILE');
  return readFile(path, 'utf8');
}
async function exclusiveWrite(path: string, body: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(body, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  signal?.throwIfAborted();
  if ((await regularRead(path)) !== body) throw new Error('REVIEW_WRITE_NOT_VERIFIED');
}
function sameKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function receiptBody(receipt: Omit<PracticeReviewReceipt, 'integrityDigest'>) {
  return JSON.stringify(receipt);
}
function validateSettings(text: string) {
  const value: unknown = JSON.parse(text);
  const keys = Object.keys(DEFAULT_CONFIG) as Array<keyof typeof DEFAULT_CONFIG>;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key) && CONFIG_VALIDATORS[key](value[key])) ||
    (value.bufferTimeoutMs as number) < (value.pollIntervalMs as number) ||
    (value.stallTimeoutMs as number) < (value.pollIntervalMs as number)
  )
    throw new Error('REVIEW_SETTINGS_INVALID');
}

/** Narrow stage-3 acceptance prerequisite. Never edits a snapshot or resolves a platform outcome. */
export class ManualPracticeReviewStore {
  constructor(
    private readonly dataDir: string,
    private readonly chapterEvidence?: PracticeReviewChapterEvidence,
  ) {}

  async preview(): Promise<PracticeReviewPreview> {
    await regularRead(join(this.dataDir, 'state', 'snapshot.json'));
    return preview(await new StateStore(this.dataDir).load(), this.chapterEvidence);
  }

  async record(
    expectedDigest: string,
    decision: typeof DECISION,
    signal?: AbortSignal,
  ): Promise<PracticeReviewReceipt> {
    signal?.throwIfAborted();
    if (decision !== DECISION || !HASH.test(expectedDigest))
      throw new Error('MANUAL_DECISION_REQUIRED');
    const current = await this.preview();
    if (current.snapshotDigest !== expectedDigest) throw new Error('REVIEW_PREVIEW_CHANGED');
    const snapshotText = await regularRead(join(this.dataDir, 'state', 'snapshot.json'));
    const settingsText = await regularRead(join(this.dataDir, 'config', 'settings.json'));
    validateSettings(settingsText);
    const id = randomUUID();
    const directory = this.directory(id);
    const parent = join(this.dataDir, 'state', 'manual-practice-review');
    for (const path of [join(this.dataDir, 'state'), parent]) {
      await mkdir(path, { recursive: true });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('REVIEW_UNSAFE_FILE');
    }
    await mkdir(directory);
    await mkdir(join(directory, 'state'));
    const receipt = {
      schemaVersion: 1 as const,
      kind: 'stage3-manual-practice-review' as const,
      id,
      savedAt: new Date().toISOString(),
      ...current,
      decision,
      outcome: 'unknown' as const,
      files: { 'snapshot.json': checksum(snapshotText), 'settings.json': checksum(settingsText) },
    };
    await exclusiveWrite(join(directory, 'state', 'snapshot.json'), snapshotText, signal);
    await exclusiveWrite(join(directory, 'settings.json'), settingsText, signal);
    // Validate the byte-exact copy through the existing schema-1 reader too.
    const backup = await this.backupSnapshot(directory);
    if (JSON.stringify(await preview(backup, this.chapterEvidence)) !== JSON.stringify(current))
      throw new Error('REVIEW_PREVIEW_CHANGED');
    if (
      (await regularRead(join(this.dataDir, 'state', 'snapshot.json'))) !== snapshotText ||
      (await regularRead(join(this.dataDir, 'config', 'settings.json'))) !== settingsText
    )
      throw new Error('REVIEW_SOURCE_CHANGED');
    const complete: PracticeReviewReceipt = {
      ...receipt,
      integrityDigest: checksum(receiptBody(receipt)),
    };
    // Only this final, verified document makes the independent review complete.
    await exclusiveWrite(join(directory, 'receipt.json'), JSON.stringify(complete) + '\n', signal);
    signal?.throwIfAborted();
    return this.load(id);
  }

  async load(id: string): Promise<PracticeReviewReceipt> {
    const directory = this.directory(id);
    for (const path of [
      join(this.dataDir, 'state'),
      join(this.dataDir, 'state', 'manual-practice-review'),
      directory,
      join(directory, 'state'),
    ]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('REVIEW_UNSAFE_FILE');
    }
    const value: unknown = JSON.parse(await regularRead(join(directory, 'receipt.json')));
    if (
      !sameKeys(value, [
        'schemaVersion',
        'kind',
        'id',
        'savedAt',
        'snapshotDigest',
        'taskId',
        'courseId',
        'chapterId',
        'chapterSource',
        'operation',
        'decision',
        'outcome',
        'files',
        'integrityDigest',
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'stage3-manual-practice-review' ||
      value.id !== id ||
      value.decision !== DECISION ||
      value.outcome !== 'unknown' ||
      typeof value.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.savedAt)) ||
      !sameKeys(value.files, ['snapshot.json', 'settings.json']) ||
      !Object.values(value.files).every((hash) => typeof hash === 'string' && HASH.test(hash))
    )
      throw new Error('REVIEW_CORRUPT');
    const receipt = value as unknown as PracticeReviewReceipt;
    const { integrityDigest, ...body } = receipt;
    if (checksum(receiptBody(body)) !== integrityDigest) throw new Error('REVIEW_CORRUPT');
    for (const name of ['snapshot.json', 'settings.json'] as const) {
      const path =
        name === 'snapshot.json' ? join(directory, 'state', name) : join(directory, name);
      if (checksum(await regularRead(path)) !== receipt.files[name])
        throw new Error('REVIEW_BACKUP_CORRUPT');
    }
    validateSettings(await regularRead(join(directory, 'settings.json')));
    const original = await preview(await this.backupSnapshot(directory), this.chapterEvidence);
    for (const key of Object.keys(original) as Array<keyof PracticeReviewPreview>) {
      if (JSON.stringify(original[key]) !== JSON.stringify(receipt[key]))
        throw new Error('REVIEW_CORRUPT');
    }
    return receipt;
  }

  async claim(id: string, taskId: string, chapterId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!ID.test(taskId) || !ID.test(chapterId)) throw new Error('REVIEW_INVALID_TARGET');
    const receipt = await this.load(id);
    if (taskId === receipt.taskId || chapterId === receipt.chapterId)
      throw new Error('REVIEW_OLD_ATTEMPT_FORBIDDEN');
    const body =
      JSON.stringify({
        schemaVersion: 1,
        reviewId: id,
        taskId,
        courseId: receipt.courseId,
        chapterId,
        savedAt: new Date().toISOString(),
      }) + '\n';
    // Duplicate receipts for the same old attempt must not mint multiple fresh tasks.
    const attempt = checksum(
      JSON.stringify([receipt.courseId, receipt.chapterId, receipt.operation]),
    );
    await exclusiveWrite(
      join(this.dataDir, 'state', 'manual-practice-review', `attempt-${attempt}.claim.json`),
      body,
      signal,
    );
    await exclusiveWrite(join(this.directory(id), 'claim.json'), body, signal);
  }

  private directory(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('REVIEW_INVALID_ID');
    return join(this.dataDir, 'state', 'manual-practice-review', id);
  }

  private async backupSnapshot(directory: string): Promise<TaskSnapshot> {
    const reader = new StateStore(directory);
    const snapshot = await reader.load();
    if (!snapshot) throw new Error('REVIEW_BACKUP_CORRUPT');
    return snapshot;
  }
}
