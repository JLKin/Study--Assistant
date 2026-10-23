import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OperationRecord, TaskSnapshot } from '../../contracts/src/index';
import { CONFIG_VALIDATORS, DEFAULT_CONFIG, isRecord } from '../../contracts/src/config';
import { StateStore } from './index';
import { ManualPracticeReviewStore } from './manual-practice-review';

const DECISION = 'allow-one-new-practice-after-zero-actions' as const;
const REVIEW_SUBMISSION = 'abandon-reviewed-submission-allow-one-fresh-task' as const;
const REVIEW_CLOSE = 'abandon-reviewed-close-allow-one-fresh-task' as const;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
function businessDigest(snapshot: TaskSnapshot) {
  const { savedAt: _savedAt, integrityDigest: _integrityDigest, ...business } = snapshot;
  return checksum(JSON.stringify(business));
}
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((k) => expected.includes(k))
  );
}
async function regular(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('REVALIDATION_UNSAFE_FILE');
  return readFile(path, 'utf8');
}
async function writeExclusive(path: string, body: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(body, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  signal?.throwIfAborted();
  if ((await regular(path)) !== body) throw new Error('REVALIDATION_WRITE_NOT_VERIFIED');
}
function settings(text: string) {
  const value: unknown = JSON.parse(text);
  const names = Object.keys(DEFAULT_CONFIG) as Array<keyof typeof DEFAULT_CONFIG>;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== names.length ||
    !names.every((k) => Object.hasOwn(value, k) && CONFIG_VALIDATORS[k](value[k])) ||
    (value.bufferTimeoutMs as number) < (value.pollIntervalMs as number) ||
    (value.stallTimeoutMs as number) < (value.pollIntervalMs as number)
  )
    throw new Error('REVALIDATION_SETTINGS_INVALID');
}
export interface RevalidationPreview {
  originalReviewId: string;
  originalReviewDigest: string;
  /** Present only when explicitly preparing a successor to another zero-action revalidation. */
  predecessorRevalidationId?: string;
  predecessorRevalidationDigest?: string;
  excludedTaskIds?: string[];
  snapshotDigest: string;
  businessDigest: string;
  predecessorTaskId: string;
  predecessorChapterId: string;
  courseId: string;
  /** Original unknown operation's task and chapter stay distinct from the zero-action predecessor. */
  taskId: string;
  chapterId: string;
  operation: OperationRecord;
  /** Exact retained unknowns, only after an explicit review of a submitted predecessor. */
  reviewedOperations?: OperationRecord[];
  /** Explicitly selected chapter whose previous task is proved to have zero operations. */
  reusedZeroActionChapterId?: string;
  excludedChapterIds: string[];
}
export interface PracticeRevalidationReceipt extends RevalidationPreview {
  schemaVersion: 1;
  kind: 'stage3-zero-action-revalidation';
  id: string;
  savedAt: string;
  decision: typeof DECISION | typeof REVIEW_SUBMISSION | typeof REVIEW_CLOSE;
  outcome: 'unknown';
  files: { 'snapshot.json': string; 'settings.json': string };
  integrityDigest: string;
}

/** Explicit successors require unchanged ledgers; loading ancestry never creates a new permit. */
export class PracticeRevalidationStore {
  constructor(
    private readonly dataDir: string,
    private readonly original: ManualPracticeReviewStore,
  ) {}

  async preview(
    originalReviewId: string,
    predecessorRevalidationId?: string,
    reviewSubmission = false,
    reuseZeroActionChapter = false,
    reviewClose = false,
  ): Promise<RevalidationPreview> {
    await regular(join(this.dataDir, 'state', 'snapshot.json'));
    return this.inspect(
      originalReviewId,
      await new StateStore(this.dataDir).load(),
      predecessorRevalidationId,
      [],
      reviewSubmission,
      reuseZeroActionChapter,
      reviewClose,
    );
  }

  async record(
    originalReviewId: string,
    expectedDigest: string,
    decision: typeof DECISION | typeof REVIEW_SUBMISSION | typeof REVIEW_CLOSE,
    signal?: AbortSignal,
    predecessorRevalidationId?: string,
    reuseZeroActionChapter = false,
  ): Promise<PracticeRevalidationReceipt> {
    signal?.throwIfAborted();
    if (
      ![DECISION, REVIEW_SUBMISSION, REVIEW_CLOSE].includes(decision) ||
      !HASH.test(expectedDigest)
    )
      throw new Error('REVALIDATION_EXPLICIT_DECISION_REQUIRED');
    const reviewSubmission = decision === REVIEW_SUBMISSION;
    const reviewClose = decision === REVIEW_CLOSE;
    const preview = await this.preview(
      originalReviewId,
      predecessorRevalidationId,
      reviewSubmission,
      reuseZeroActionChapter,
      reviewClose,
    );
    if (preview.snapshotDigest !== expectedDigest) throw new Error('REVALIDATION_PREVIEW_CHANGED');
    const snapshot = await regular(join(this.dataDir, 'state', 'snapshot.json'));
    const config = await regular(join(this.dataDir, 'config', 'settings.json'));
    settings(config);
    const id = randomUUID(),
      directory = this.directory(id),
      parent = join(this.dataDir, 'state', 'practice-revalidation');
    await mkdir(parent, { recursive: true });
    for (const path of [join(this.dataDir, 'state'), parent]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('REVALIDATION_UNSAFE_FILE');
    }
    await mkdir(directory);
    await mkdir(join(directory, 'state'));
    await writeExclusive(join(directory, 'state/snapshot.json'), snapshot, signal);
    await writeExclusive(join(directory, 'settings.json'), config, signal);
    const copied = await this.inspect(
      originalReviewId,
      await new StateStore(directory).load(),
      predecessorRevalidationId,
      [],
      reviewSubmission,
      reuseZeroActionChapter,
      reviewClose,
    );
    if (
      JSON.stringify(copied) !== JSON.stringify(preview) ||
      (await regular(join(this.dataDir, 'state/snapshot.json'))) !== snapshot ||
      (await regular(join(this.dataDir, 'config/settings.json'))) !== config
    )
      throw new Error('REVALIDATION_SOURCE_CHANGED');
    const body = {
      schemaVersion: 1 as const,
      kind: 'stage3-zero-action-revalidation' as const,
      id,
      savedAt: new Date().toISOString(),
      ...preview,
      decision,
      outcome: 'unknown' as const,
      files: { 'snapshot.json': checksum(snapshot), 'settings.json': checksum(config) },
    };
    await writeExclusive(
      join(directory, 'receipt.json'),
      JSON.stringify({ ...body, integrityDigest: checksum(JSON.stringify(body)) }) + '\n',
      signal,
    );
    signal?.throwIfAborted();
    return this.load(id);
  }

  async load(id: string): Promise<PracticeRevalidationReceipt> {
    return this.loadChecked(id, []);
  }

  private async loadChecked(
    id: string,
    ancestors: readonly string[],
  ): Promise<PracticeRevalidationReceipt> {
    if (ancestors.includes(id) || ancestors.length >= 16)
      throw new Error('REVALIDATION_ANCESTRY_INVALID');
    const directory = this.directory(id);
    for (const path of [
      join(this.dataDir, 'state'),
      join(this.dataDir, 'state/practice-revalidation'),
      directory,
      join(directory, 'state'),
    ]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('REVALIDATION_UNSAFE_FILE');
    }
    const value: unknown = JSON.parse(await regular(join(directory, 'receipt.json')));
    const successor = isRecord(value) && Object.hasOwn(value, 'predecessorRevalidationId');
    const reviewed = isRecord(value) && Object.hasOwn(value, 'reviewedOperations');
    const reused = isRecord(value) && Object.hasOwn(value, 'reusedZeroActionChapterId');
    if (
      !keys(value, [
        'schemaVersion',
        'kind',
        'id',
        'savedAt',
        'originalReviewId',
        'originalReviewDigest',
        ...(successor
          ? ['predecessorRevalidationId', 'predecessorRevalidationDigest', 'excludedTaskIds']
          : []),
        'snapshotDigest',
        'businessDigest',
        'predecessorTaskId',
        'predecessorChapterId',
        'courseId',
        'taskId',
        'chapterId',
        'operation',
        ...(reviewed ? ['reviewedOperations'] : []),
        ...(reused ? ['reusedZeroActionChapterId'] : []),
        'excludedChapterIds',
        'decision',
        'outcome',
        'files',
        'integrityDigest',
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'stage3-zero-action-revalidation' ||
      value.id !== id ||
      ![DECISION, REVIEW_SUBMISSION, REVIEW_CLOSE].includes(value.decision as typeof DECISION) ||
      value.outcome !== 'unknown' ||
      typeof value.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.savedAt)) ||
      !keys(value.files, ['snapshot.json', 'settings.json']) ||
      !Object.values(value.files).every((v) => typeof v === 'string' && HASH.test(v))
    )
      throw new Error('REVALIDATION_CORRUPT');
    const receipt = value as unknown as PracticeRevalidationReceipt;
    if (
      (reviewed &&
        (!Array.isArray(receipt.reviewedOperations) || receipt.reviewedOperations.length < 2)) ||
      ([REVIEW_SUBMISSION, REVIEW_CLOSE].includes(receipt.decision as typeof REVIEW_SUBMISSION) &&
        (!successor || !reviewed)) ||
      (reused &&
        (!successor ||
          typeof receipt.reusedZeroActionChapterId !== 'string' ||
          !ID.test(receipt.reusedZeroActionChapterId)))
    )
      throw new Error('REVALIDATION_CORRUPT');
    if (
      successor &&
      (typeof receipt.predecessorRevalidationId !== 'string' ||
        !UUID.test(receipt.predecessorRevalidationId) ||
        typeof receipt.predecessorRevalidationDigest !== 'string' ||
        !HASH.test(receipt.predecessorRevalidationDigest) ||
        !Array.isArray(receipt.excludedTaskIds) ||
        !receipt.excludedTaskIds.every((id) => typeof id === 'string' && ID.test(id)))
    )
      throw new Error('REVALIDATION_CORRUPT');
    const { integrityDigest, ...body } = receipt;
    if (checksum(JSON.stringify(body)) !== integrityDigest) throw new Error('REVALIDATION_CORRUPT');
    const snapshotText = await regular(join(directory, 'state/snapshot.json'));
    const configText = await regular(join(directory, 'settings.json'));
    if (
      checksum(snapshotText) !== receipt.files['snapshot.json'] ||
      checksum(configText) !== receipt.files['settings.json']
    )
      throw new Error('REVALIDATION_BACKUP_CORRUPT');
    settings(configText);
    const checked = await this.inspect(
      receipt.originalReviewId,
      await new StateStore(directory).load(),
      receipt.predecessorRevalidationId,
      [...ancestors, id],
      receipt.decision === REVIEW_SUBMISSION,
      reused,
      receipt.decision === REVIEW_CLOSE,
    );
    if (Object.hasOwn(checked, 'reviewedOperations') !== reviewed)
      throw new Error('REVALIDATION_CORRUPT');
    for (const field of Object.keys(checked) as Array<keyof RevalidationPreview>) {
      if (JSON.stringify(checked[field]) !== JSON.stringify(receipt[field]))
        throw new Error('REVALIDATION_CORRUPT');
    }
    return receipt;
  }

  async claim(id: string, taskId: string, chapterId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const receipt = await this.load(id);
    if (
      !ID.test(taskId) ||
      !ID.test(chapterId) ||
      [receipt.taskId, receipt.predecessorTaskId].includes(taskId) ||
      receipt.excludedTaskIds?.includes(taskId) ||
      receipt.excludedChapterIds.includes(chapterId)
    )
      throw new Error('REVALIDATION_OLD_CONTEXT_FORBIDDEN');
    const active = await this.preview(
      receipt.originalReviewId,
      receipt.predecessorRevalidationId,
      receipt.decision === REVIEW_SUBMISSION,
      receipt.reusedZeroActionChapterId !== undefined,
      receipt.decision === REVIEW_CLOSE,
    );
    // Initialization may update savedAt only; no business or ledger change is accepted.
    if (active.businessDigest !== receipt.businessDigest)
      throw new Error('REVALIDATION_SOURCE_CHANGED');
    const body =
      JSON.stringify({
        schemaVersion: 1,
        receiptId: id,
        predecessorTaskId: receipt.predecessorTaskId,
        taskId,
        courseId: receipt.courseId,
        chapterId,
        savedAt: new Date().toISOString(),
      }) + '\n';
    await writeExclusive(
      join(
        this.dataDir,
        'state/practice-revalidation',
        `predecessor-${receipt.predecessorTaskId}.claim.json`,
      ),
      body,
      signal,
    );
    await writeExclusive(join(this.directory(id), 'claim.json'), body, signal);
  }

  private directory(id: string) {
    if (!UUID.test(id)) throw new Error('REVALIDATION_INVALID_ID');
    return join(this.dataDir, 'state/practice-revalidation', id);
  }

  private async inspect(
    originalReviewId: string,
    snapshot: TaskSnapshot | null,
    predecessorRevalidationId?: string,
    ancestors: readonly string[] = [],
    reviewSubmission = false,
    reuseZeroActionChapter = false,
    reviewClose = false,
  ): Promise<RevalidationPreview> {
    if (reviewClose && (reviewSubmission || reuseZeroActionChapter))
      throw new Error('REVALIDATION_REVIEW_FLAGS_CONFLICT');
    if (predecessorRevalidationId !== undefined)
      return this.inspectSuccessor(
        originalReviewId,
        snapshot,
        predecessorRevalidationId,
        ancestors,
        reviewSubmission,
        reuseZeroActionChapter,
        reviewClose,
      );
    if (reviewSubmission || reviewClose) throw new Error('REVALIDATION_REVIEW_PARENT_REQUIRED');
    if (reuseZeroActionChapter) throw new Error('REVALIDATION_ZERO_ACTION_PROOF_REQUIRED');
    const original = await this.original.load(originalReviewId);
    const parentDirectory = join(this.dataDir, 'state/manual-practice-review', originalReviewId);
    const claimText = await regular(join(parentDirectory, 'claim.json'));
    const claim: unknown = JSON.parse(claimText);
    if (
      !keys(claim, ['schemaVersion', 'reviewId', 'taskId', 'courseId', 'chapterId', 'savedAt']) ||
      claim.schemaVersion !== 1 ||
      claim.reviewId !== originalReviewId ||
      typeof claim.taskId !== 'string' ||
      !ID.test(claim.taskId) ||
      typeof claim.chapterId !== 'string' ||
      !ID.test(claim.chapterId) ||
      claim.courseId !== original.courseId ||
      claim.taskId === original.taskId ||
      claim.chapterId === original.chapterId ||
      typeof claim.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(claim.savedAt))
    )
      throw new Error('REVALIDATION_PARENT_CLAIM_INVALID');
    const attempt = checksum(
      JSON.stringify([original.courseId, original.chapterId, original.operation]),
    );
    if (
      (await regular(
        join(this.dataDir, 'state/manual-practice-review', `attempt-${attempt}.claim.json`),
      )) !== claimText
    )
      throw new Error('REVALIDATION_PARENT_CLAIM_INVALID');
    const before = await new StateStore(parentDirectory).load();
    if (
      !snapshot ||
      !before ||
      snapshot.state !== 'PAUSED' ||
      snapshot.taskId !== claim.taskId ||
      snapshot.courseId !== original.courseId ||
      snapshot.chapterId !== claim.chapterId ||
      JSON.stringify(snapshot.pendingOperations) !== JSON.stringify(before.pendingOperations)
    )
      throw new Error('REVALIDATION_REQUIRES_ZERO_ACTION_PAUSED_TASK');
    return {
      originalReviewId,
      originalReviewDigest: original.integrityDigest,
      snapshotDigest: snapshot.integrityDigest,
      businessDigest: businessDigest(snapshot),
      predecessorTaskId: claim.taskId,
      predecessorChapterId: claim.chapterId,
      courseId: original.courseId,
      taskId: original.taskId,
      chapterId: original.chapterId,
      operation: { ...original.operation },
      excludedChapterIds: [original.chapterId, claim.chapterId],
    };
  }

  private async inspectSuccessor(
    originalReviewId: string,
    snapshot: TaskSnapshot | null,
    predecessorId: string,
    ancestors: readonly string[],
    reviewSubmission: boolean,
    reuseZeroActionChapter: boolean,
    reviewClose: boolean,
  ): Promise<RevalidationPreview> {
    // Preview reserves one slot for the proposed receipt, so it cannot prepare an unloadable chain.
    const parent = await this.loadChecked(
      predecessorId,
      ancestors.length ? ancestors : ['preview-successor'],
    );
    if (parent.originalReviewId !== originalReviewId)
      throw new Error('REVALIDATION_PARENT_MISMATCH');
    const directory = this.directory(predecessorId);
    const claimText = await regular(join(directory, 'claim.json'));
    const claim: unknown = JSON.parse(claimText);
    if (
      !keys(claim, [
        'schemaVersion',
        'receiptId',
        'predecessorTaskId',
        'taskId',
        'courseId',
        'chapterId',
        'savedAt',
      ]) ||
      claim.schemaVersion !== 1 ||
      claim.receiptId !== predecessorId ||
      claim.predecessorTaskId !== parent.predecessorTaskId ||
      claim.courseId !== parent.courseId ||
      typeof claim.taskId !== 'string' ||
      !ID.test(claim.taskId) ||
      [parent.taskId, parent.predecessorTaskId, ...(parent.excludedTaskIds ?? [])].includes(
        claim.taskId,
      ) ||
      typeof claim.chapterId !== 'string' ||
      !ID.test(claim.chapterId) ||
      parent.excludedChapterIds.includes(claim.chapterId) ||
      typeof claim.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(claim.savedAt)) ||
      (await regular(
        join(
          this.dataDir,
          'state/practice-revalidation',
          `predecessor-${parent.predecessorTaskId}.claim.json`,
        ),
      )) !== claimText
    )
      throw new Error('REVALIDATION_PARENT_CLAIM_INVALID');
    const before = await new StateStore(directory).load();
    if (
      !snapshot ||
      !before ||
      snapshot.state !== 'PAUSED' ||
      snapshot.taskId !== claim.taskId ||
      snapshot.courseId !== parent.courseId ||
      snapshot.chapterId !== claim.chapterId
    )
      throw new Error('REVALIDATION_REQUIRES_ZERO_ACTION_PAUSED_TASK');
    let reviewedOperations = parent.reviewedOperations;
    if (reviewSubmission || reviewClose) {
      const prior = before.pendingOperations;
      const added = snapshot.pendingOperations.slice(prior.length);
      const submit = added.at(-1);
      const prefix = added.slice(0, -1);
      const validClosePrefix =
        prefix.length === 0 ||
        (prefix.length === 1 &&
          prefix[0].kind === 'practice-submit' &&
          prefix[0].status === 'completed') ||
        (prefix.length === 2 &&
          prefix[0].kind === 'practice-pause' &&
          prefix[0].status === 'completed' &&
          prefix[1].kind === 'practice-submit' &&
          prefix[1].status === 'completed');
      const validSubmissionPrefix =
        prefix.length === 0 ||
        (prefix.length === 1 &&
          prefix[0].kind === 'practice-pause' &&
          prefix[0].status === 'completed');
      if (
        JSON.stringify(snapshot.pendingOperations.slice(0, prior.length)) !==
          JSON.stringify(prior) ||
        added.some((op) => op.taskId !== claim.taskId) ||
        !(reviewClose ? validClosePrefix : validSubmissionPrefix) ||
        submit?.kind !== (reviewClose ? 'practice-close' : 'practice-submit') ||
        submit.status !== 'awaiting-confirmation'
      )
        throw new Error(
          reviewClose
            ? 'REVALIDATION_REVIEW_CLOSE_REQUIRED'
            : 'REVALIDATION_REVIEW_SUBMISSION_REQUIRED',
        );
      reviewedOperations = [...(parent.reviewedOperations ?? [parent.operation]), { ...submit }];
      const unknown = snapshot.pendingOperations.filter((op) =>
        ['pending', 'executing', 'awaiting-confirmation'].includes(op.status),
      );
      if (JSON.stringify(unknown) !== JSON.stringify(reviewedOperations))
        throw new Error('REVALIDATION_REVIEW_UNKNOWN_MISMATCH');
    } else if (
      JSON.stringify(snapshot.pendingOperations) !== JSON.stringify(before.pendingOperations)
    ) {
      throw new Error('REVALIDATION_REQUIRES_ZERO_ACTION_PAUSED_TASK');
    }
    let reusedZeroActionChapterId: string | undefined;
    if (reuseZeroActionChapter) {
      const target = parent.predecessorChapterId;
      if (
        parent.decision !== DECISION ||
        !parent.predecessorRevalidationId ||
        target === snapshot.chapterId ||
        target === parent.chapterId ||
        !parent.excludedChapterIds.includes(target)
      )
        throw new Error('REVALIDATION_ZERO_ACTION_PROOF_REQUIRED');
      // The parent's zero-action successor check proves the target's task had
      // no effects. Also reject any operation for that chapter's other ancestors.
      let cursor: PracticeRevalidationReceipt | undefined = parent;
      while (cursor) {
        if (
          cursor.chapterId === target ||
          (cursor.predecessorChapterId === target &&
            snapshot.pendingOperations.some((op) => op.taskId === cursor!.predecessorTaskId))
        )
          throw new Error('REVALIDATION_CHAPTER_HAS_OPERATIONS');
        cursor = cursor.predecessorRevalidationId
          ? await this.loadChecked(cursor.predecessorRevalidationId, ancestors)
          : undefined;
      }
      reusedZeroActionChapterId = target;
    }
    return {
      originalReviewId,
      originalReviewDigest: parent.originalReviewDigest,
      predecessorRevalidationId: parent.id,
      predecessorRevalidationDigest: parent.integrityDigest,
      excludedTaskIds: [
        ...new Set([
          ...(parent.excludedTaskIds ?? []),
          parent.taskId,
          parent.predecessorTaskId,
          claim.taskId,
        ]),
      ],
      snapshotDigest: snapshot.integrityDigest,
      businessDigest: businessDigest(snapshot),
      predecessorTaskId: claim.taskId,
      predecessorChapterId: claim.chapterId,
      courseId: parent.courseId,
      taskId: parent.taskId,
      chapterId: parent.chapterId,
      operation: { ...parent.operation },
      ...(reviewedOperations ? { reviewedOperations: structuredClone(reviewedOperations) } : {}),
      ...(reusedZeroActionChapterId ? { reusedZeroActionChapterId } : {}),
      excludedChapterIds: [...new Set([...parent.excludedChapterIds, claim.chapterId])].filter(
        (chapter) => chapter !== reusedZeroActionChapterId,
      ),
    };
  }
}
