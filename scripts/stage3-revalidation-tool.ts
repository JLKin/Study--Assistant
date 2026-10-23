import { resolve } from 'node:path';
import { ManualPracticeReviewStore } from '../packages/persistence/src/manual-practice-review';
import { PracticeRevalidationStore } from '../packages/persistence/src/practice-revalidation';
import { recordedPracticeChapter } from './stage3-recorded-chapter';

export async function prepareRevalidation(args: string[]): Promise<void> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (
      ![
        '--data-dir',
        '--review-id',
        '--acknowledge-digest',
        '--predecessor-id',
        '--review-submission',
        '--review-close',
        '--reuse-zero-action-chapter',
      ].includes(args[i]) ||
      values.has(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error('REVALIDATION_INVALID_ARGUMENTS');
    values.set(args[i], args[i + 1]);
  }
  const directory = values.get('--data-dir'),
    reviewId = values.get('--review-id');
  if (!directory || !reviewId) throw new Error('REVALIDATION_DATA_AND_REVIEW_REQUIRED');
  const dataDir = resolve(directory);
  const original = new ManualPracticeReviewStore(dataDir, recordedPracticeChapter(resolve('.')));
  const store = new PracticeRevalidationStore(dataDir, original);
  const digest = values.get('--acknowledge-digest');
  const predecessorId = values.get('--predecessor-id');
  if (values.has('--review-submission') && values.get('--review-submission') !== 'true')
    throw new Error('REVALIDATION_INVALID_ARGUMENTS');
  const reviewSubmission = values.get('--review-submission') === 'true';
  if (values.has('--review-close') && values.get('--review-close') !== 'true')
    throw new Error('REVALIDATION_INVALID_ARGUMENTS');
  const reviewClose = values.get('--review-close') === 'true';
  if (
    values.has('--reuse-zero-action-chapter') &&
    values.get('--reuse-zero-action-chapter') !== 'true'
  )
    throw new Error('REVALIDATION_INVALID_ARGUMENTS');
  const reuseZeroActionChapter = values.get('--reuse-zero-action-chapter') === 'true';
  if (reviewClose && (reviewSubmission || reuseZeroActionChapter))
    throw new Error('REVALIDATION_REVIEW_FLAGS_CONFLICT');
  if (!digest) {
    console.log(
      JSON.stringify(
        {
          mode: 'preview-only',
          ...(await store.preview(
            reviewId,
            predecessorId,
            reviewSubmission,
            reuseZeroActionChapter,
            reviewClose,
          )),
          ...(reviewClose ? { decision: 'abandon-reviewed-close-allow-one-fresh-task' } : {}),
          ...(reviewSubmission
            ? { decision: 'abandon-reviewed-submission-allow-one-fresh-task' }
            : {}),
          taskStarted: false,
          browserActions: 0,
        },
        null,
        2,
      ),
    );
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const receipt = await store.record(
      reviewId,
      digest,
      reviewClose
        ? 'abandon-reviewed-close-allow-one-fresh-task'
        : reviewSubmission
          ? 'abandon-reviewed-submission-allow-one-fresh-task'
          : 'allow-one-new-practice-after-zero-actions',
      controller.signal,
      predecessorId,
      reuseZeroActionChapter,
    );
    console.log(
      JSON.stringify(
        {
          mode: 'revalidation-prepared',
          receiptId: receipt.id,
          predecessorTaskId: receipt.predecessorTaskId,
          excludedChapterIds: receipt.excludedChapterIds,
          oldOutcome: receipt.outcome,
          taskStarted: false,
          browserActions: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}
