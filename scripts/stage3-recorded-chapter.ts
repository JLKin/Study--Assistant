import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PracticeReviewChapterEvidence } from '../packages/persistence/src/manual-practice-review';

/** Frozen local evidence for the one old 8.2 attempt whose schema-1 chapterId was null.
 * No caller-provided ordinal or raw course URL; no platform outcome is inferred.
 */
export function recordedPracticeChapter(root: string): PracticeReviewChapterEvidence {
  return {
    resolve: async (snapshot) => {
      const directory = join(root, 'docs/evidence/stage3-random/2026-10-20T09-36-18Z/attempt-02');
      const evidence = [
        ['armed.json', '6ea3f98b9dadc9241f4472ecacc1d221f40816f187f2981f1ed63a1bd0c8214a'],
        ['run-result.json', '876557c0fb66198f94facc502f7f6884c25041d5ca766b9c96b9d595eec5b72e'],
      ] as const;
      const documents: string[] = [];
      for (const [name, digest] of evidence) {
        const body = await readFile(join(directory, name));
        if (createHash('sha256').update(body).digest('hex') !== digest)
          throw new Error('RECORDED_CHAPTER_EVIDENCE_CHANGED');
        documents.push(body.toString('utf8'));
      }
      const armed = JSON.parse(documents[0]);
      const result = JSON.parse(documents[1]);
      const operation = snapshot.pendingOperations.find(
        (op) => op.operationId === 'e7c82245-e2aa-41e0-a7e9-1b8915188654',
      );
      if (
        snapshot.chapterId !== null ||
        snapshot.taskId !== '1c7ff611-3f3b-4777-8b6d-492bf73efaa6' ||
        snapshot.courseId !==
          'zhs_c_95cb70ff1ed8fa75d06e4fb487bc1b96c480bc4edb723cc15d5688deca1d293f' ||
        operation?.taskId !== snapshot.taskId ||
        operation.status !== 'awaiting-confirmation' ||
        operation.kind !== 'practice-submit' ||
        operation.savedAt !== '2026-10-20T10:11:40.124Z' ||
        armed.original.ordinal !== '8.2' ||
        result.original.ordinal !== '8.2' ||
        result.postObservation.second.ordinal !== '8.2' ||
        result.pageEffects.optionClicks !== 1 ||
        !result.ledger.operations.some(
          (op: { operationId: string; status: string }) =>
            op.operationId === operation.operationId && op.status === operation.status,
        )
      )
        throw new Error('RECORDED_CHAPTER_NOT_BOUND_TO_SNAPSHOT');
      const catalogue = 'd12fb94417fe4bc43012086fa3ea1b59e082bae770333cb08ade80154b3a8153';
      // Same stable public chapter identity algorithm as SiteAdapter; no DOM is changed.
      const chapterId =
        'zhs_v1_' +
        createHash('sha256')
          .update(JSON.stringify([snapshot.courseId, catalogue, '8.2']))
          .digest('hex');
      return { chapterId, source: 'sealed-stage3-attempt02-8_2-v1' };
    },
  };
}
