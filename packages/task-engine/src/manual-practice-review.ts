import type { OperationRecord } from '../../contracts/src/index';
import type { SiteObservation } from '../../contracts/src/monitor';
import {
  ManualPracticeReviewStore,
  type PracticeReviewReceipt,
} from '../../persistence/src/manual-practice-review';
import type { PracticeRevalidationStore } from '../../persistence/src/practice-revalidation';

type AdmissionReceipt = Pick<
  PracticeReviewReceipt,
  'id' | 'integrityDigest' | 'courseId' | 'chapterId' | 'taskId' | 'operation'
> & {
  readonly excludedChapterIds?: readonly string[];
  readonly reviewedOperations?: readonly OperationRecord[];
};
type AdmissionStore = ManualPracticeReviewStore | PracticeRevalidationStore;

const issued = new WeakSet<ManualPracticeReviewAuthorization>();
export function validManualPracticeReview(value: ManualPracticeReviewAuthorization): boolean {
  return issued.has(value) && value.valid();
}
const sameOperation = (a: OperationRecord, b: OperationRecord) =>
  a.operationId === b.operationId &&
  a.taskId === b.taskId &&
  a.kind === b.kind &&
  a.status === b.status &&
  a.savedAt === b.savedAt;
const fresh = (time: string) => {
  const age = Date.now() - Date.parse(time);
  return Number.isFinite(age) && age >= -5000 && age <= 30000;
};

/** Internal, single-new-task capability. A persisted receipt alone never enables start/resume. */
export class ManualPracticeReviewAuthorization {
  readonly issuedAt = Date.now();
  readonly expiresAt = this.issuedAt + 600000;
  private claimedTask: string | null = null;
  private constructor(
    private readonly store: AdmissionStore,
    readonly receipt: Readonly<AdmissionReceipt>,
    readonly chapterId: string,
    private readonly observe: (signal: AbortSignal) => Promise<SiteObservation>,
  ) {
    issued.add(this);
  }

  static async create(
    store: AdmissionStore,
    receiptId: string,
    observe: (signal: AbortSignal) => Promise<SiteObservation>,
    signal: AbortSignal,
  ): Promise<ManualPracticeReviewAuthorization> {
    signal.throwIfAborted();
    const receipt = await store.load(receiptId);
    const observed = await observe(signal);
    signal.throwIfAborted();
    const copied: AdmissionReceipt = structuredClone(receipt);
    Object.freeze(copied.operation);
    copied.reviewedOperations?.forEach(Object.freeze);
    if (copied.reviewedOperations) Object.freeze(copied.reviewedOperations);
    if (copied.excludedChapterIds) Object.freeze(copied.excludedChapterIds);
    const authorization = new ManualPracticeReviewAuthorization(
      store,
      Object.freeze(copied),
      observed.currentChapterId ?? '',
      observe,
    );
    if (!authorization.safe(observed, true)) throw new Error('REVIEW_FRESH_CHAPTER_REQUIRED');
    return authorization;
  }

  valid(): boolean {
    return issued.has(this) && this.issuedAt <= Date.now() && Date.now() < this.expiresAt;
  }

  permits(operations: readonly OperationRecord[], courseId: string, taskId?: string): boolean {
    const unknown = operations.filter((op) =>
      ['pending', 'executing', 'awaiting-confirmation'].includes(op.status),
    );
    const reviewed = this.receipt.reviewedOperations ?? [this.receipt.operation];
    return (
      this.valid() &&
      courseId === this.receipt.courseId &&
      unknown.length === reviewed.length &&
      unknown.every((operation, index) => sameOperation(operation, reviewed[index])) &&
      (taskId === undefined ? this.claimedTask === null : this.claimedTask === taskId)
    );
  }

  async claim(taskId: string, signal: AbortSignal): Promise<void> {
    if (!this.valid() || this.claimedTask !== null || taskId === this.receipt.taskId)
      throw new Error('REVIEW_ALREADY_USED');
    await this.verify(signal, true);
    // Reload and revalidate the complete backups immediately before the durable exclusive claim.
    const current = await this.store.load(this.receipt.id);
    if (current.integrityDigest !== this.receipt.integrityDigest) throw new Error('REVIEW_CHANGED');
    await this.store.claim(this.receipt.id, taskId, this.chapterId, signal);
    signal.throwIfAborted();
    if (!this.valid()) throw new Error('REVIEW_EXPIRED');
    this.claimedTask = taskId;
  }

  async verify(signal: AbortSignal, starting = false): Promise<void> {
    signal.throwIfAborted();
    if (!this.valid() || (!starting && this.claimedTask === null))
      throw new Error('REVIEW_EXPIRED');
    const observed = await this.observe(signal);
    signal.throwIfAborted();
    if (!this.valid() || !this.safe(observed, starting)) throw new Error('REVIEW_CONTEXT_CHANGED');
  }

  private safe(observed: SiteObservation, starting: boolean): boolean {
    const { course, player } = observed;
    return (
      !!this.chapterId &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(this.chapterId) &&
      this.chapterId !== this.receipt.chapterId &&
      !this.receipt.excludedChapterIds?.includes(this.chapterId) &&
      course.courseId === this.receipt.courseId &&
      course.authenticated === true &&
      course.pageKind === 'course' &&
      course.confidence === 'verified' &&
      ['fixture', 'zhihuishu-dom'].includes(course.source) &&
      !course.evidence.some((item) => item.startsWith('READ_ONLY_PREVIEW：')) &&
      fresh(course.observedAt) &&
      observed.currentChapterId === this.chapterId &&
      !!player &&
      player.chapterId === this.chapterId &&
      player.confidence === 'verified' &&
      fresh(player.observedAt) &&
      Number.isFinite(player.currentTime) &&
      player.currentTime >= 0 &&
      Number.isFinite(player.duration) &&
      player.duration > 0 &&
      player.currentTime <= player.duration &&
      observed.chapters.some(
        (ch) =>
          ch.chapterId === this.chapterId && ch.confidence === 'verified' && fresh(ch.observedAt),
      ) &&
      (starting
        ? observed.popup === 'none' && !player.paused && !player.ended && !player.buffering
        : observed.popup !== 'unknown')
    );
  }
}
