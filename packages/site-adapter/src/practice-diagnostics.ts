/** Only enumerated metadata may cross the diagnostic binding or enter an acceptance report. */
export const PRACTICE_STOP_REASONS = [
  'SIGNAL_ABORTED',
  'GRANT_EXPIRED',
  'MAIN_FRAME_NAVIGATED',
  'CHILD_FRAME_NAVIGATED',
  'PAGE_CLOSED',
  'PAGE_GUARD_INVALIDATED',
  'PAGE_INPUT',
  'MEDIA_EMPTIED',
  'MEDIA_LOADSTART',
  'MEDIA_RATECHANGE',
  'MEDIA_NODE_CHANGED',
  'MEDIA_SOURCE_CHANGED',
  'LESSON_CHANGED',
  'INPUT_RETARGETED',
  'INPUT_GUARD_FAILED',
  'PAGE_GRANT_EXPIRED',
  'ROUTE_CHANGED',
  'PAGE_SAMPLE_EMPTY',
  'DOM_ROUTE_CHECK',
  'DOM_MEDIA_CHECK',
  'DOM_ALERT_CHECK',
  'DOM_DIALOG_CHECK',
  'DOM_STATE_CHECK',
  'DOM_NOTE_CHECK',
  'DOM_QUESTION_CHECK',
  'DOM_INPUT_CHECK',
  'DOM_ACTION_CHECK',
  'DOM_RESTORE_CHECK',
  'DOM_SAMPLE_FAILED',
  'BROWSER_SAMPLE_FAILED',
  'INPUT_ISSUE_FAILED',
  'ADAPTER_DISPOSED',
] as const;
export type PracticeStopReason = (typeof PRACTICE_STOP_REASONS)[number];
export function practiceStopReason(value: unknown): PracticeStopReason | null {
  return typeof value === 'string' && (PRACTICE_STOP_REASONS as readonly string[]).includes(value)
    ? (value as PracticeStopReason)
    : null;
}
export interface PracticeStopDiagnostic {
  reason: PracticeStopReason;
  origin: 'node' | 'page' | 'dom';
  phase: string;
  elapsedMs: number;
}
