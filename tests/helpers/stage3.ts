import type { CourseObservation, TaskSnapshot } from '../../packages/contracts/src/index';
import type {
  PracticeAction,
  PracticeContext,
  PracticeFeedback,
  PracticeQuestion,
  PracticeSiteAdapter,
  PracticeVideo,
} from '../../packages/contracts/src/practice';
import type { SnapshotInput, SnapshotStore } from '../../packages/persistence/src/index';
import { TaskEngine } from '../../packages/task-engine/src/index';
import type { PracticeOptions } from '../../packages/practice/src/index';

export const sampleQuestion = (): PracticeQuestion => ({
  type: 'single',
  stem: '光合作用需要二氧化碳吗',
  complete: true,
  options: [
    { id: 'A', text: '正确' },
    { id: 'B', text: '错误' },
  ],
});
export function fixedRandom(index = 0): PracticeOptions {
  return { randomIndex: () => index };
}
/** Optional legacy OCR tools only; current automation defaults to DOM. */
export function legacyOcrOptions(index = 0): PracticeOptions {
  return { ...fixedRandom(index), recognition: 'legacy-ocr' };
}
export function course(): CourseObservation {
  return {
    courseId: 'stage3-course',
    title: '模拟课程',
    source: 'fixture',
    authenticated: true,
    pageKind: 'course',
    confidence: 'verified',
    platformCompleted: null,
    observedAt: new Date().toISOString(),
    evidence: ['fixture-only'],
  };
}
export function memory(previous: TaskSnapshot | null = null) {
  let snapshot = previous;
  const writes: SnapshotInput[] = [];
  const store: SnapshotStore = {
    load: async () => structuredClone(snapshot),
    write: async (input) => {
      writes.push(structuredClone(input));
      snapshot = { ...structuredClone(input), integrityDigest: '0'.repeat(64) };
      return structuredClone(snapshot);
    },
  };
  return { store, writes, snapshot: () => snapshot };
}
export async function setup(granted = true, storage = memory()) {
  const engine = new TaskEngine({
    store: storage.store,
    stage2Capabilities: { enabled: true, inspect: async () => course(), backup: async () => true },
    ...(granted ? { stage3FixturePractice: true as const } : {}),
  });
  await engine.browserConnected();
  await engine.confirmCourse(course(), 'stage3-course');
  if (!(await engine.start()).ok) throw new Error('FIXTURE_START_FAILED');
  return { engine, storage };
}
/** Mutable fault harness: no browser or network is involved. */
export class PracticeFaultAdapter implements PracticeSiteAdapter {
  readonly kind = 'fixture' as const;
  current: PracticeContext = {
    source: 'fixture',
    classification: 'non-graded',
    explicitNonGraded: true,
    authenticated: true,
    courseId: 'stage3-course',
    popupId: 'popup',
    revision: 'v1',
  };
  currentQuestion: PracticeQuestion | null = sampleQuestion();
  currentVideo: PracticeVideo = {
    mediaId: 'video',
    generation: 1,
    paused: false,
    manualRevision: 0,
  };
  actions: PracticeAction[] = [];
  reply: 'correct' | 'incorrect' | 'unknown' = 'correct';
  correctionReply: 'correct' | 'incorrect' | 'unknown' = 'correct';
  correctTexts: string[] | undefined = ['错误'];
  feedbackValue: PracticeFeedback = { status: 'unknown' };
  async context(): Promise<PracticeContext> {
    return structuredClone(this.current);
  }
  async question(): Promise<PracticeQuestion | null> {
    return structuredClone(this.currentQuestion);
  }
  async capture(): Promise<Uint8Array> {
    return new Uint8Array([1]);
  }
  async video(): Promise<PracticeVideo> {
    return structuredClone(this.currentVideo);
  }
  async prepare(
    _action: PracticeAction,
    context: PracticeContext,
    video: PracticeVideo,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (
      JSON.stringify(context) !== JSON.stringify(this.current) ||
      video.generation !== this.currentVideo.generation ||
      video.manualRevision !== this.currentVideo.manualRevision
    )
      throw new Error('PRACTICE_CONTEXT_CHANGED');
  }
  async perform(
    action: PracticeAction,
    _context: PracticeContext,
    _video: PracticeVideo,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.actions.push(structuredClone(action));
    if (action.type === 'pause') this.currentVideo.paused = true;
    if (action.type === 'restore') this.currentVideo.paused = false;
    if (action.type === 'submit' || action.type === 'correct') {
      const status = action.type === 'submit' ? this.reply : this.correctionReply;
      this.feedbackValue =
        status === 'unknown'
          ? { status }
          : status === 'correct'
            ? { status, receipt: action.submissionId }
            : { status, receipt: action.submissionId, correctTexts: this.correctTexts };
    }
  }
  async feedback(): Promise<PracticeFeedback> {
    return this.feedbackValue;
  }
  async verify(): Promise<boolean> {
    return true;
  }
  submissions() {
    return this.actions.filter((action) => action.type === 'submit' || action.type === 'correct');
  }
}
