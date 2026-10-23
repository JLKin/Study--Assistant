export type QuestionType = 'single' | 'multiple' | 'boolean';
/** These fields are transient. Never add them to schema-1 snapshots or logs. */
export interface PracticeQuestion {
  type: QuestionType;
  stem: string;
  options: { id: string; text: string }[];
  complete: boolean;
}
export interface PracticeContext {
  source: 'fixture' | 'zhihuishu-verified' | 'real-unverified';
  /** Ephemeral internal permit identity. Never include in schema-1 snapshots. */
  authorizationId?: string;
  classification: 'non-graded' | 'exam' | 'graded' | 'unknown';
  explicitNonGraded: boolean;
  authenticated: boolean;
  courseId: string;
  popupId: string;
  revision: string;
  /** Observed before this session; never a receipt for a new submission. */
  existingFeedback?: 'correct' | 'incorrect';
}
export interface PracticeVideo {
  mediaId: string;
  generation: number;
  paused: boolean;
  manualRevision: number;
}
export type PracticeFeedback =
  | { status: 'correct'; receipt: string }
  | { status: 'incorrect'; receipt: string; correctTexts?: string[] }
  | { status: 'unknown' };
export type PracticeAction =
  | { type: 'pause' | 'close' | 'restore' }
  | { type: 'submit' | 'correct'; optionIds: string[]; submissionId: string };
export interface PracticeSiteAdapter {
  readonly kind: 'fixture' | 'zhihuishu-verified' | 'real-unverified';
  parseCapturedQuestion?(text: string): PracticeQuestion | null;
  watchManual?(signal: AbortSignal, onManual: () => void): Promise<() => Promise<void>>;
  context(signal: AbortSignal): Promise<PracticeContext>;
  question(signal: AbortSignal): Promise<PracticeQuestion | null>;
  capture(signal: AbortSignal): Promise<Uint8Array>;
  video(signal: AbortSignal): Promise<PracticeVideo>;
  prepare(
    action: PracticeAction,
    context: PracticeContext,
    video: PracticeVideo,
    signal: AbortSignal,
  ): Promise<void>;
  /** Final synchronous page-side checks must accompany each effect. */
  perform(
    action: PracticeAction,
    context: PracticeContext,
    video: PracticeVideo,
    signal: AbortSignal,
  ): Promise<void>;
  feedback(signal: AbortSignal): Promise<PracticeFeedback>;
  verify(action: PracticeAction, video: PracticeVideo, signal: AbortSignal): Promise<boolean>;
}
