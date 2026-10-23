import { randomUUID } from 'node:crypto';
import type { Disposable, Locator, Page } from 'playwright';
import type { SiteAction, SiteObservation, SiteSignal } from '../../contracts/src/monitor';
import { ZhihuishuMonitorSiteAdapter } from './zhihuishu';
import { ZHIHUISHU_IDENTITY_EVIDENCE, type ZhihuishuIdentityEvidence } from './zhihuishu-evidence';
import type { BrowserContinuousInputGuard } from './browser-continuous-input-guard';
import {
  readCandidateNavigationFeedback,
  type CandidateFeedback,
  type CandidateFeedbackReason,
} from './candidate-navigation-feedback';

type NavigationAction = Extract<SiteAction, { type: 'navigate' }>;
type Phase =
  'idle' | 'prepared' | 'dispatching' | 'awaiting-feedback' | 'confirmed' | 'unknown' | 'cancelled';
interface CandidateInput {
  type: 'candidate-input';
  token: string;
}
interface InputArm {
  token: string;
  ordinal: string;
  expiresAt: number;
  consumed: boolean;
  blocked: boolean;
}
interface InputScope {
  arm: InputArm | null;
  blocked: boolean;
  cleanup: () => void;
  mediaEpoch: number;
  metadataCount: number;
  readyEpoch: number;
  observedMedia: HTMLVideoElement | null;
  commitMedia: HTMLVideoElement | null;
  commitEpoch: number | null;
  commitMetadataCount: number | null;
  catalogueTimes: string[] | null;
  confirmedMedia: HTMLVideoElement | null;
  confirmedEpoch: number | null;
  confirmedMetadataCount: number | null;
  mediaError: boolean;
  mediaErrorCode: number | null;
}
type DiagnosticStage =
  | 'idle'
  | 'preparation'
  | 'source-check'
  | 'native-command'
  | 'input-correlation'
  | 'target-feedback'
  | 'confirmed';
const failureCodes = [
  'CANDIDATE_SOURCE_OR_TARGET_UNSAFE',
  'CANDIDATE_TARGET_NOT_UNIQUE',
  'CANDIDATE_CONTROL_UNSAFE',
  'CANDIDATE_INPUT_NOT_CORRELATED',
  'CANDIDATE_TARGET_FEEDBACK_TIMEOUT',
  'CANDIDATE_TARGET_FEEDBACK_UNSAFE',
  'CANDIDATE_PAGE_TIMEOUT',
  'CANDIDATE_CLOSED',
  'CANDIDATE_CRITICAL_INPUT_OR_PAGE_CHANGE',
  'CANDIDATE_CANCELLED',
  'CANDIDATE_UNEXPECTED_FAILURE',
] as const;
type DiagnosticFailure = (typeof failureCodes)[number];
interface ControlExpectation {
  url: string;
  duration: number;
  completedSourceBeforeEnd: boolean;
  nextVideoAt81Percent: boolean;
  title: string;
  sourceOrdinal: string;
  targetOrdinal: string;
  chapters: Array<{ ordinal: string; title: string }>;
}

/**
 * Offline, explicitly granted browser-input candidate; never selected by the production factory.
 * This deliberately does NOT implement MonitorSiteAdapter. Its native input command is a commit
 * boundary: a preceding page check and the browser input cannot share one DOM task. Cancellation
 * after that boundary cannot retract input already sent, so its outcome must be treated as unknown.
 * Correlation recognizes only one expected primary pointerdown while the command is in flight.
 * A simultaneous human click on the very same target is inherently indistinguishable; this is a
 * documented candidate limitation, not a guarantee of perfect human/input attribution. No website
 * detection signal or event isTrusted value is modified, and unexpected critical input still stops.
 */
export class BrowserNavigationCandidate {
  readonly commitModel = 'browser-input-candidate' as const;
  private readonly reader: ZhihuishuMonitorSiteAdapter;
  private readonly navigationAllowed: boolean;
  private readonly completedSourceBeforeEnd: boolean;
  private readonly nextVideoAt81Percent: boolean;
  private readonly listeners = new Set<(event: SiteSignal) => void>();
  private readonly invalidation = new AbortController();
  private readonly bindingName = `zhsCandidateInput_${randomUUID().replaceAll('-', '')}`;
  private readonly scopeName = `zhsCandidateScope_${randomUUID().replaceAll('-', '')}`;
  private phase: Phase = 'idle';
  private dispatchCalls: 0 | 1 = 0;
  private busy = false;
  private disposed = false;
  private watcher: Promise<void> | null = null;
  private binding: Disposable | null = null;
  private detachEvents: (() => void) | null = null;
  private nativeCommand: Promise<void> | null = null;
  private readonly retainGuard: boolean;
  private readonly continuousGuard: BrowserContinuousInputGuard | undefined;
  private continuousRegistered = false;
  private committedInputToken: string | null = null;
  private correlationConfirmed = false;
  private diagnosticStage: DiagnosticStage = 'idle';
  private diagnosticFailure: DiagnosticFailure | null = null;
  private feedbackReason: CandidateFeedbackReason | null = null;
  private feedbackSamples = 0;
  private loadingSamples = 0;
  private lastMedia: CandidateFeedback['media'] | null = null;
  private lastNodes: CandidateFeedback['nodes'] | null = null;
  private readonly feedbackTrail: Array<CandidateFeedback & { observedAt: string }> = [];

  constructor(
    private readonly page: Page,
    identityEvidence: readonly ZhihuishuIdentityEvidence[] = ZHIHUISHU_IDENTITY_EVIDENCE,
    permissions: Readonly<{
      navigation?: boolean;
      allowCompletedSourceBeforeEnd?: boolean;
      nextVideoAt81Percent?: boolean;
      retainGuardAfterConfirmation?: boolean;
      continuousGuard?: BrowserContinuousInputGuard;
    }> = {},
  ) {
    if (
      permissions.allowCompletedSourceBeforeEnd === true &&
      permissions.nextVideoAt81Percent === true
    )
      throw new Error('CANDIDATE_ACCEPTANCE_MODES_CONFLICT');
    this.reader = new ZhihuishuMonitorSiteAdapter(page, identityEvidence);
    this.navigationAllowed = permissions.navigation === true;
    // Explicit acceptance-only alternative: an already credited, user-paused source.
    // This never permits leaving an unfinished chapter early or inferring completion.
    this.completedSourceBeforeEnd = permissions.allowCompletedSourceBeforeEnd === true;
    this.nextVideoAt81Percent = permissions.nextVideoAt81Percent === true;
    this.retainGuard = permissions.retainGuardAfterConfirmation === true;
    this.continuousGuard = permissions.continuousGuard;
  }

  view(): { phase: Phase; dispatchCalls: 0 | 1 } {
    return { phase: this.phase, dispatchCalls: this.dispatchCalls };
  }

  diagnostics(): Readonly<{
    stage: DiagnosticStage;
    failure: DiagnosticFailure | null;
    feedback: CandidateFeedbackReason | null;
    samples: number;
    loadingSamples: number;
    lastMedia: CandidateFeedback['media'] | null;
    lastNodes: CandidateFeedback['nodes'] | null;
    feedbackTrail: Array<CandidateFeedback & { observedAt: string }>;
  }> {
    return {
      stage: this.diagnosticStage,
      failure: this.diagnosticFailure,
      feedback: this.feedbackReason,
      samples: this.feedbackSamples,
      loadingSamples: this.loadingSamples,
      lastMedia: this.lastMedia ? structuredClone(this.lastMedia) : null,
      lastNodes: this.lastNodes ? structuredClone(this.lastNodes) : null,
      feedbackTrail: structuredClone(this.feedbackTrail),
    };
  }

  retainedGuardScope(): string {
    this.assertActive();
    if (!this.retainGuard || this.phase !== 'confirmed' || !this.binding)
      throw new Error('CANDIDATE_RETAINED_GUARD_UNAVAILABLE');
    return this.scopeName;
  }

  async assertRetainedGuard(signal: AbortSignal): Promise<void> {
    this.assertActive(signal);
    await this.continuousGuard?.assertActive(signal);
    const scopeName = this.retainedGuardScope();
    const safe = await this.bounded(
      this.page.evaluate((name) => {
        const scope = (window as unknown as Record<string, InputScope | undefined>)[name];
        const media = document.querySelectorAll('video');
        return (
          !!scope &&
          !scope.blocked &&
          !scope.mediaError &&
          scope.arm === null &&
          scope.confirmedEpoch !== null &&
          scope.confirmedEpoch === scope.mediaEpoch &&
          scope.confirmedMetadataCount === scope.metadataCount &&
          scope.readyEpoch === scope.mediaEpoch &&
          media.length === 1 &&
          scope.confirmedMedia === media[0] &&
          scope.observedMedia === media[0]
        );
      }, scopeName),
      signal,
    );
    this.assertActive(signal);
    if (!safe) throw new Error('CANDIDATE_RETAINED_GUARD_UNAVAILABLE');
  }

  async observe(signal?: AbortSignal): Promise<SiteObservation> {
    const sample = await this.reader.observe(signal);
    const safe =
      !this.disposed &&
      !this.invalidation.signal.aborted &&
      sample.course.confidence === 'verified' &&
      sample.course.authenticated === true &&
      sample.course.pageKind === 'course' &&
      sample.popup === 'none';
    return {
      ...sample,
      supportedRates: [],
      safeToRefresh: false,
      capabilities: {
        playbackRate: false,
        startPlay: false,
        recoverPlay: false,
        refresh: false,
        navigation:
          safe &&
          this.navigationAllowed &&
          this.dispatchCalls === 0 &&
          sample.capabilities?.completionMarkers === true,
        completionMarkers: safe && sample.capabilities?.completionMarkers === true,
      },
    };
  }

  async subscribe(listener: (event: SiteSignal) => void): Promise<() => void> {
    this.assertActive();
    this.listeners.add(listener);
    try {
      await this.ensureWatching();
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
    return () => this.listeners.delete(listener);
  }

  async prepareNavigation(
    action: NavigationAction,
    courseId: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertUnused(signal);
    if (this.busy) throw new Error('CANDIDATE_OPERATION_BUSY');
    this.busy = true;
    try {
      this.diagnosticStage = 'preparation';
      await this.ensureWatching(signal);
      const before = await this.source(action, courseId, signal);
      const expected = expectation(
        before,
        action,
        this.page.url(),
        this.completedSourceBeforeEnd,
        this.nextVideoAt81Percent,
      );
      await this.bounded(
        this.target(expected.targetOrdinal).scrollIntoViewIfNeeded({ timeout: 2000 }),
        signal,
      );
      await this.source(action, courseId, signal);
      await this.checkControl(expected, signal);
      this.assertUnused(signal);
      this.phase = 'prepared';
    } catch (error) {
      this.recordFailure(error, signal);
      this.phase = 'cancelled';
      this.invalidate({ type: 'navigation', automated: false });
      await this.cleanup();
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async navigateOnce(
    action: NavigationAction,
    courseId: string,
    signal: AbortSignal,
  ): Promise<{
    commitModel: 'browser-input-candidate';
    phase: 'confirmed';
    dispatchCalls: 1;
    targetChapterId: string;
  }> {
    this.assertUnused(signal);
    if (this.busy) throw new Error('CANDIDATE_OPERATION_BUSY');
    this.busy = true;
    try {
      this.diagnosticStage = 'source-check';
      // Monitoring is owned by the candidate, even when its caller never calls subscribe().
      await this.ensureWatching(signal);
      const before = await this.source(action, courseId, signal);
      const expected = expectation(
        before,
        action,
        this.page.url(),
        this.completedSourceBeforeEnd,
        this.nextVideoAt81Percent,
      );
      await this.checkControl(expected, signal);
      const token = randomUUID();
      // This is a fresh complete page check immediately before the native-command commit.
      // It does not claim atomicity with the later protocol-delivered input.
      await this.source(action, courseId, signal);
      this.committedInputToken = token;
      // Only arm after the last full source read, in the final DOM control check.
      await this.checkControl(expected, signal, token);
      this.assertActive(signal);
      this.dispatchCalls = 1;
      this.phase = 'dispatching';
      this.diagnosticStage = 'native-command';
      // Exactly one ordinary command. No force, DOM click, fallback, explicit retry or play().
      this.nativeCommand = this.target(expected.targetOrdinal).click({ timeout: 2000 });
      await this.bounded(this.nativeCommand, signal);
      this.assertActive(signal);
      this.diagnosticStage = 'input-correlation';
      const correlated = await this.bounded(
        this.page.evaluate(
          ({ scopeName, token }) => {
            const scope = (window as unknown as Record<string, InputScope | undefined>)[scopeName];
            const arm = scope?.arm;
            if (scope) scope.arm = null;
            return !!arm && arm.token === token && arm.consumed && !arm.blocked;
          },
          { scopeName: this.scopeName, token },
        ),
        signal,
      );
      if (!correlated) throw new Error('CANDIDATE_INPUT_NOT_CORRELATED');
      this.correlationConfirmed = true;
      this.phase = 'awaiting-feedback';
      this.diagnosticStage = 'target-feedback';
      await this.confirmTarget(expected, signal);
      this.assertActive(signal);
      this.phase = 'confirmed';
      this.diagnosticStage = 'confirmed';
      return {
        commitModel: this.commitModel,
        phase: 'confirmed',
        dispatchCalls: 1,
        targetChapterId: action.chapterId,
      };
    } catch (error) {
      this.recordFailure(error, signal);
      this.phase = this.dispatchCalls ? 'unknown' : 'cancelled';
      this.invalidate({ type: 'navigation', automated: false });
      throw error;
    } finally {
      // Cancelling our wait cannot retract Playwright input already in flight. Keep the
      // critical-input latch installed until that single bounded command settles.
      await this.nativeCommand?.catch(() => undefined);
      // Only an explicit coordinator grant retains the original guard after confirmation.
      if (!(this.retainGuard && this.phase === 'confirmed')) await this.cleanup();
      this.busy = false;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate({ type: 'navigation', automated: false });
    await this.nativeCommand?.catch(() => undefined);
    await this.cleanup();
    this.listeners.clear();
  }

  private assertActive(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    this.invalidation.signal.throwIfAborted();
    if (this.disposed || this.page.isClosed()) throw new Error('CANDIDATE_CLOSED');
  }

  private recordFailure(error: unknown, signal?: AbortSignal): void {
    if (this.diagnosticFailure) return;
    const code = error instanceof Error ? error.message : '';
    this.diagnosticFailure = signal?.aborted
      ? 'CANDIDATE_CANCELLED'
      : failureCodes.includes(code as DiagnosticFailure)
        ? (code as DiagnosticFailure)
        : 'CANDIDATE_UNEXPECTED_FAILURE';
  }

  private assertUnused(signal?: AbortSignal): void {
    this.assertActive(signal);
    if (!this.navigationAllowed) throw new Error('CANDIDATE_NAVIGATION_NOT_GRANTED');
    if (this.dispatchCalls) throw new Error('CANDIDATE_NATIVE_COMMAND_ALREADY_CONSUMED');
  }

  private invalidate(event: SiteSignal): void {
    if (this.invalidation.signal.aborted) return;
    this.invalidation.abort(new Error('CANDIDATE_CRITICAL_INPUT_OR_PAGE_CHANGE'));
    for (const listener of this.listeners) listener(event);
  }

  private async bounded<T>(
    work: Promise<T>,
    signal?: AbortSignal,
    timeout = 3000,
    timeoutCode:
      'CANDIDATE_PAGE_TIMEOUT' | 'CANDIDATE_TARGET_FEEDBACK_TIMEOUT' = 'CANDIDATE_PAGE_TIMEOUT',
  ): Promise<T> {
    this.assertActive(signal);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        this.invalidation.signal.removeEventListener('abort', invalidated);
        if (error) reject(error);
        else resolve(value as T);
      };
      const aborted = () => finish(signal?.reason ?? new Error('CANDIDATE_CANCELLED'));
      const invalidated = () => finish(this.invalidation.signal.reason);
      const timer = setTimeout(() => finish(new Error(timeoutCode)), Math.max(1, timeout));
      signal?.addEventListener('abort', aborted, { once: true });
      this.invalidation.signal.addEventListener('abort', invalidated, { once: true });
      work.then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });
  }

  private ensureWatching(signal?: AbortSignal): Promise<void> {
    this.assertActive(signal);
    this.watcher ??= this.installWatcher(signal);
    return this.watcher;
  }

  private async installWatcher(signal?: AbortSignal): Promise<void> {
    const changed = () => this.invalidate({ type: 'navigation', automated: false });
    const navigated = (frame: ReturnType<Page['mainFrame']>) => {
      if (frame === this.page.mainFrame()) changed();
    };
    this.page.on('framenavigated', navigated);
    this.page.on('close', changed);
    this.page.on('dialog', changed);
    this.page.context().on('page', changed);
    this.detachEvents = () => {
      this.page.off('framenavigated', navigated);
      this.page.off('close', changed);
      this.page.off('dialog', changed);
      this.page.context().off('page', changed);
    };
    try {
      const bindingWork = this.page.exposeBinding(
        this.bindingName,
        (source, event: SiteSignal | CandidateInput) => {
          if (
            source.page !== this.page ||
            source.frame !== this.page.mainFrame() ||
            !event ||
            this.disposed
          )
            return;
          if (event.type === 'manual') this.invalidate({ type: 'manual' });
          if (
            event.type === 'candidate-input' &&
            (event.token !== this.committedInputToken ||
              !(
                this.phase === 'dispatching' ||
                (this.correlationConfirmed &&
                  ['awaiting-feedback', 'confirmed'].includes(this.phase))
              ) ||
              this.dispatchCalls !== 1)
          )
            this.invalidate({ type: 'manual' });
        },
      );
      void bindingWork.then(
        (binding) => {
          if (this.disposed || this.invalidation.signal.aborted)
            void binding.dispose().catch(() => undefined);
        },
        () => undefined,
      );
      this.binding = await this.bounded(bindingWork, signal);
      const installation = this.page.evaluate(installCandidateInput, {
        bindingName: this.bindingName,
        scopeName: this.scopeName,
      });
      // A delayed evaluate must not leave an orphaned input listener after cancellation.
      void installation.then(
        () => {
          if (this.disposed || this.invalidation.signal.aborted) void this.cleanup();
        },
        () => undefined,
      );
      await this.bounded(installation, signal);
      if (this.continuousGuard) {
        await this.continuousGuard.attachCandidate(
          this.scopeName,
          signal ?? new AbortController().signal,
        );
        this.continuousRegistered = true;
      }
    } catch (error) {
      this.invalidate({ type: 'navigation', automated: false });
      await this.cleanup();
      throw error;
    }
  }

  private target(ordinal: string): Locator {
    const exactOrdinal = new RegExp(`^\\s*${ordinal.replaceAll('.', '\\.')}\\s*$`);
    return this.page
      .locator('.video-study')
      .locator('.chapterScrollbar')
      .locator('li.video')
      .filter({ has: this.page.locator('.hour').filter({ hasText: exactOrdinal }) })
      .locator('.catalogue_title');
  }

  private async source(
    action: NavigationAction,
    courseId: string,
    signal: AbortSignal,
  ): Promise<SiteObservation> {
    this.assertUnused(signal);
    const sample = await this.observe(signal);
    const source = sample.chapters.find((chapter) => chapter.chapterId === action.fromChapterId);
    const sourceIndex = sample.chapters.findIndex(
      (chapter) => chapter.chapterId === action.fromChapterId,
    );
    const target = this.nextVideoAt81Percent
      ? sample.chapters[sourceIndex + 1]
      : sample.chapters.find((chapter) => chapter.platformCompleted === false);
    if (
      action.type !== 'navigate' ||
      sample.course.courseId !== courseId ||
      sample.course.source !== 'zhihuishu-dom' ||
      sample.course.confidence !== 'verified' ||
      sample.course.authenticated !== true ||
      sample.course.pageKind !== 'course' ||
      sample.popup !== 'none' ||
      sample.capabilities?.navigation !== true ||
      sample.capabilities.completionMarkers !== true ||
      sample.currentChapterId !== action.fromChapterId ||
      sample.player?.chapterId !== action.fromChapterId ||
      sample.player.confidence !== 'verified' ||
      (this.nextVideoAt81Percent
        ? sample.player.paused !== false ||
          sample.player.ended !== false ||
          sample.player.currentTime < sample.player.duration * 0.81 ||
          sample.player.currentTime >= sample.player.duration
        : this.completedSourceBeforeEnd
          ? sample.player.paused !== true ||
            sample.player.ended !== false ||
            sample.player.currentTime >= sample.player.duration
          : sample.player.ended !== true) ||
      source?.platformCompleted !== true ||
      target?.chapterId !== action.chapterId ||
      action.chapterId === action.fromChapterId ||
      sample.chapters.some((chapter) => chapter.platformCompleted === null)
    )
      throw new Error('CANDIDATE_SOURCE_OR_TARGET_UNSAFE');
    this.assertActive(signal);
    return sample;
  }

  private async checkControl(
    expected: ControlExpectation,
    signal: AbortSignal,
    token?: string,
  ): Promise<void> {
    const matches = await this.bounded(this.target(expected.targetOrdinal).count(), signal);
    if (matches !== 1) throw new Error('CANDIDATE_TARGET_NOT_UNIQUE');
    const safe = await this.bounded(
      this.target(expected.targetOrdinal).evaluate(checkCandidateControl, {
        ...expected,
        scopeName: this.scopeName,
        continuousScopeName: this.continuousGuard?.scopeName,
        token,
      }),
      signal,
    );
    if (!safe) throw new Error('CANDIDATE_CONTROL_UNSAFE');
  }

  private async confirmTarget(expected: ControlExpectation, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 8000;
    const untilDeadline = async <T>(work: Promise<T>): Promise<T> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('CANDIDATE_TARGET_FEEDBACK_TIMEOUT');
      try {
        // Classify the timer by the budget that selected it. At the boundary,
        // timer scheduling and Date.now() may disagree by a millisecond.
        const value = await this.bounded(
          work,
          signal,
          Math.min(3000, remaining),
          remaining <= 3000 ? 'CANDIDATE_TARGET_FEEDBACK_TIMEOUT' : 'CANDIDATE_PAGE_TIMEOUT',
        );
        if (Date.now() >= deadline) throw new Error('CANDIDATE_TARGET_FEEDBACK_TIMEOUT');
        return value;
      } catch (error) {
        if (Date.now() >= deadline && !signal.aborted && !this.invalidation.signal.aborted)
          throw new Error('CANDIDATE_TARGET_FEEDBACK_TIMEOUT');
        throw error;
      }
    };
    let stable = 0;
    let stableGeneration: number | null = null;
    for (;;) {
      this.assertActive(signal);
      if (Date.now() >= deadline) throw new Error('CANDIDATE_TARGET_FEEDBACK_TIMEOUT');
      const after = await untilDeadline(
        this.page.evaluate(readCandidateNavigationFeedback, {
          ...expected,
          scopeName: this.scopeName,
          continuousScopeName: this.continuousGuard?.scopeName,
        }),
      );
      if (Date.now() >= deadline) throw new Error('CANDIDATE_TARGET_FEEDBACK_TIMEOUT');
      this.feedbackSamples++;
      this.feedbackReason = after.reason;
      this.lastMedia = after.media ?? null;
      this.lastNodes = after.nodes ?? null;
      this.feedbackTrail.push({ ...after, observedAt: new Date().toISOString() });
      if (this.feedbackTrail.length > 16) this.feedbackTrail.shift();
      if (after.kind === 'blocked') throw new Error('CANDIDATE_TARGET_FEEDBACK_UNSAFE');
      if (after.kind === 'target-loading') this.loadingSamples++;
      if (after.kind === 'target-ready') {
        stable = after.generation === stableGeneration ? stable + 1 : 1;
        stableGeneration = after.generation;
      } else {
        stable = 0;
        stableGeneration = null;
      }
      if (stable >= 2) {
        if (this.retainGuard) {
          const locked = await untilDeadline(
            this.page.evaluate(
              ({ name, generation }) => {
                const scope = (window as unknown as Record<string, InputScope | undefined>)[name];
                const media = document.querySelectorAll('video');
                if (
                  !scope ||
                  scope.blocked ||
                  scope.arm !== null ||
                  scope.mediaEpoch !== generation ||
                  scope.readyEpoch !== generation ||
                  media.length !== 1 ||
                  media[0] !== scope.observedMedia
                )
                  return false;
                scope.confirmedMedia = scope.observedMedia;
                scope.confirmedEpoch = generation;
                scope.confirmedMetadataCount = scope.metadataCount;
                return true;
              },
              { name: this.scopeName, generation: stableGeneration },
            ),
          );
          if (!locked) throw new Error('CANDIDATE_TARGET_FEEDBACK_UNSAFE');
          if (Date.now() >= deadline) throw new Error('CANDIDATE_TARGET_FEEDBACK_TIMEOUT');
        }
        return;
      }
      await untilDeadline(new Promise<void>((resolve) => setTimeout(resolve, 150)));
    }
  }

  private async cleanup(): Promise<void> {
    this.detachEvents?.();
    this.detachEvents = null;
    const binding = this.binding;
    this.binding = null;
    // Cleanup is bounded and does not click, alter media or dismiss a dialog.
    await Promise.allSettled([
      settleCleanup(
        this.page.evaluate((scopeName) => {
          const scopes = window as unknown as Record<string, InputScope | undefined>;
          scopes[scopeName]?.cleanup();
          delete scopes[scopeName];
        }, this.scopeName),
      ),
      binding ? settleCleanup(binding.dispose()) : Promise.resolve(),
    ]);
    if (this.continuousRegistered) {
      this.continuousRegistered = false;
      await this.continuousGuard!.releaseCandidate(this.scopeName);
    }
  }
}

/** Observe even late failures while clearing the deadline as soon as cleanup settles. */
function settleCleanup(work: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    work.then(done, done);
  });
}

function expectation(
  sample: SiteObservation,
  action: NavigationAction,
  url: string,
  completedSourceBeforeEnd: boolean,
  nextVideoAt81Percent: boolean,
): ControlExpectation {
  const chapters = sample.chapters.map((chapter) => {
    const match = /^(\d{1,3}(?:\.\d{1,3}){0,4}) (.+)$/u.exec(chapter.title);
    if (!match) throw new Error('CANDIDATE_ORDINAL_UNAVAILABLE');
    return { ordinal: match[1], title: match[2] };
  });
  const sourceIndex = sample.chapters.findIndex(
    (chapter) => chapter.chapterId === action.fromChapterId,
  );
  const targetIndex = sample.chapters.findIndex(
    (chapter) => chapter.chapterId === action.chapterId,
  );
  if (sourceIndex < 0 || targetIndex < 0 || !sample.course.title)
    throw new Error('CANDIDATE_ORDINAL_UNAVAILABLE');
  return {
    url,
    duration: sample.player!.duration,
    completedSourceBeforeEnd,
    nextVideoAt81Percent,
    title: sample.course.title,
    sourceOrdinal: chapters[sourceIndex].ordinal,
    targetOrdinal: chapters[targetIndex].ordinal,
    chapters,
  };
}

function installCandidateInput({
  bindingName,
  scopeName,
}: {
  bindingName: string;
  scopeName: string;
}) {
  const scopes = window as unknown as Record<string, unknown>;
  if (scopes[scopeName]) throw new Error('CANDIDATE_INPUT_SCOPE_EXISTS');
  const send = (event: SiteSignal | CandidateInput) => {
    const listener = scopes[bindingName] as
      ((value: SiteSignal | CandidateInput) => Promise<void>) | undefined;
    void listener?.(event).catch(() => undefined);
  };
  const scope: InputScope = {
    arm: null,
    blocked: false,
    cleanup: () => undefined,
    mediaEpoch: 0,
    metadataCount: 0,
    readyEpoch: -1,
    observedMedia: null,
    commitMedia: null,
    commitEpoch: null,
    commitMetadataCount: null,
    catalogueTimes: null,
    confirmedMedia: null,
    confirmedEpoch: null,
    confirmedMetadataCount: null,
    mediaError: false,
    mediaErrorCode: null,
  };
  const trackedMedia = new Set<HTMLVideoElement>();
  const mediaErrored = (event: Event) => {
    if (
      !event.isTrusted ||
      !(event.target instanceof HTMLVideoElement) ||
      !trackedMedia.has(event.target)
    )
      return;
    scope.mediaError = true;
    scope.mediaErrorCode = event.target.error?.code ?? null;
  };
  const watchMediaError = (media: HTMLVideoElement | null) => {
    if (!media || trackedMedia.has(media)) return;
    trackedMedia.add(media);
    media.addEventListener('error', mediaErrored);
    if (media.error) {
      scope.mediaError = true;
      scope.mediaErrorCode = media.error.code;
    }
  };
  const mediaChanged = (event: Event) => {
    if (
      !event.isTrusted ||
      !(event.target instanceof HTMLVideoElement) ||
      event.target.id !== 'vjs_container_html5_api'
    )
      return;
    watchMediaError(event.target);
    if (event.type === 'loadstart' || scope.observedMedia !== event.target) {
      scope.mediaEpoch++;
      scope.readyEpoch = -1;
    }
    scope.observedMedia = event.target;
    if (event.type === 'loadedmetadata') {
      scope.metadataCount++;
      scope.readyEpoch = scope.mediaEpoch;
    }
  };
  const manual = (event: Event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    if (
      event instanceof KeyboardEvent &&
      ![
        ' ',
        'Enter',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'k',
        'j',
        'l',
        '+',
        '-',
      ].includes(event.key)
    )
      return;
    if (
      !(event instanceof KeyboardEvent) &&
      !event.target.closest(
        '#vjs_container,.videoArea,.speedBox,.chapterScrollbar li,.el-dialog__wrapper,[role="dialog"]',
      )
    )
      return;
    const arm = scope.arm;
    const target = event.target.closest('.catalogue_title');
    const row = target?.closest('li.video');
    if (
      arm &&
      !scope.blocked &&
      !arm.consumed &&
      !arm.blocked &&
      performance.now() <= arm.expiresAt &&
      event instanceof PointerEvent &&
      event.type === 'pointerdown' &&
      event.button === 0 &&
      event.isPrimary &&
      target &&
      row?.querySelector('.hour')?.textContent?.trim() === arm.ordinal &&
      target.closest('.video-study') &&
      document.querySelectorAll('.video-study').length === 1
    ) {
      arm.consumed = true;
      // A reload before the actual expected input cannot prove this navigation.
      scope.commitMedia = document.querySelector<HTMLVideoElement>('video#vjs_container_html5_api');
      watchMediaError(scope.commitMedia);
      scope.commitEpoch = scope.mediaEpoch;
      scope.commitMetadataCount = scope.metadataCount;
      send({ type: 'candidate-input', token: arm.token });
      return;
    }
    scope.blocked = true;
    if (arm) arm.blocked = true;
    send({ type: 'manual' });
  };
  document.addEventListener('pointerdown', manual, true);
  document.addEventListener('keydown', manual, true);
  document.addEventListener('loadstart', mediaChanged, true);
  document.addEventListener('loadedmetadata', mediaChanged, true);
  const initialMedia = document.querySelectorAll('video#vjs_container_html5_api');
  if (initialMedia.length === 1 && initialMedia[0] instanceof HTMLVideoElement)
    watchMediaError(initialMedia[0]);
  scope.cleanup = () => {
    scope.blocked = true;
    scope.arm = null;
    document.removeEventListener('pointerdown', manual, true);
    document.removeEventListener('keydown', manual, true);
    document.removeEventListener('loadstart', mediaChanged, true);
    document.removeEventListener('loadedmetadata', mediaChanged, true);
    trackedMedia.forEach((media) => media.removeEventListener('error', mediaErrored));
    trackedMedia.clear();
  };
  scopes[scopeName] = scope;
}

function checkCandidateControl(
  element: Element,
  expected: ControlExpectation & {
    scopeName: string;
    token?: string;
    continuousScopeName?: string;
  },
): boolean {
  const scope = (window as unknown as Record<string, InputScope | undefined>)[expected.scopeName];
  if (!scope || scope.blocked || scope.mediaError || location.href !== expected.url) return false;
  if (expected.continuousScopeName !== undefined) {
    const outer = (
      window as unknown as Record<
        string,
        { blocked: boolean; activeScope: string | null; mediaError: boolean } | undefined
      >
    )[expected.continuousScopeName];
    if (!outer || outer.blocked || outer.mediaError || outer.activeScope !== expected.scopeName)
      return false;
  }
  const roots = document.querySelectorAll('.video-study');
  if (roots.length !== 1 || !roots[0].contains(element)) return false;
  const root = roots[0];
  const visible = (node: Element): boolean => {
    const rect = node.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    );
  };
  const users = root.querySelectorAll('.header_userInfo');
  if (
    users.length !== 1 ||
    !visible(users[0]) ||
    root.querySelectorAll('.userLinks .iconheiyemoshi-anquantuichu').length !== 1
  )
    return false;
  if (
    [
      ...document.querySelectorAll(
        '.el-dialog__wrapper,[role="dialog"],.vjs-modal-dialog,.mask,.v-modal,.ep-overlay-dialog,[aria-modal="true"],iframe[src*="captcha.gtimg.com"]',
      ),
    ].some(visible)
  )
    return false;
  if (
    [
      ...document.querySelectorAll(
        '[role="alert"],.el-message,.el-notification,.el-message-box__wrapper',
      ),
    ].some(
      (node) =>
        visible(node) &&
        /检测.{0,20}(脚本|插件)|(?:脚本|插件).{0,20}(?:执行|检测|异常|禁止)/u.test(
          node.textContent ?? '',
        ),
    )
  )
    return false;
  const lists = root.querySelectorAll('.chapterScrollbar');
  if (lists.length !== 1 || !lists[0].contains(element)) return false;
  const rows = [...lists[0].querySelectorAll('li.video')];
  if (rows.length !== expected.chapters.length) return false;
  if (root.querySelector('.source-name')?.textContent?.trim() !== expected.title) return false;
  if (
    !rows.every(
      (row, index) =>
        row.querySelectorAll('.hour').length === 1 &&
        row.querySelectorAll('.catalogue_title').length === 1 &&
        row.querySelector('.hour')?.textContent?.trim() === expected.chapters[index].ordinal &&
        row.querySelector('.catalogue_title')?.textContent?.trim() ===
          expected.chapters[index].title,
    )
  )
    return false;
  const source = rows.filter((row) => row.classList.contains('current_play'));
  if (
    source.length !== 1 ||
    source[0].querySelector('.hour')?.textContent?.trim() !== expected.sourceOrdinal
  )
    return false;
  const caption = root.querySelectorAll('#lessonOrder');
  const sourceTitle = expected.chapters.find(
    (chapter) => chapter.ordinal === expected.sourceOrdinal,
  )?.title;
  const captionText = caption[0]?.textContent?.trim() ?? '';
  if (
    caption.length !== 1 ||
    !captionText.startsWith(expected.sourceOrdinal) ||
    captionText.slice(expected.sourceOrdinal.length).replace(/^[\s、，,:：.-]+/u, '') !==
      sourceTitle
  )
    return false;
  const completion = rows.map((row) => {
    const half = row.querySelectorAll('.time_ico_half');
    const finish = row.querySelectorAll('.time_icofinish');
    return half.length !== 1 || finish.length > 1
      ? null
      : finish.length === 0
        ? false
        : visible(finish[0])
          ? true
          : null;
  });
  if (
    completion.some((value) => value === null) ||
    completion[rows.indexOf(source[0])] !== true ||
    rows[
      expected.nextVideoAt81Percent
        ? rows.indexOf(source[0]) + 1
        : completion.findIndex((value) => value === false)
    ]
      ?.querySelector('.hour')
      ?.textContent?.trim() !== expected.targetOrdinal
  )
    return false;
  const media = root.querySelectorAll('video#vjs_container_html5_api');
  if (
    document.querySelectorAll('video').length !== 1 ||
    media.length !== 1 ||
    !(media[0] instanceof HTMLVideoElement) ||
    (expected.nextVideoAt81Percent
      ? media[0].paused ||
        media[0].ended ||
        !Number.isFinite(media[0].currentTime) ||
        media[0].currentTime < media[0].duration * 0.81 ||
        media[0].currentTime >= media[0].duration
      : expected.completedSourceBeforeEnd
        ? !media[0].paused ||
          media[0].ended ||
          !Number.isFinite(media[0].currentTime) ||
          media[0].currentTime < 0 ||
          media[0].currentTime >= media[0].duration
        : !media[0].ended) ||
    media[0].readyState < 1 ||
    !Number.isFinite(media[0].duration) ||
    Math.abs(media[0].duration - expected.duration) > 0.2
  )
    return false;
  const row = element.closest('li.video');
  if (row?.querySelector('.hour')?.textContent?.trim() !== expected.targetOrdinal) return false;
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (
      ancestor.getAttribute('aria-disabled') === 'true' ||
      ancestor.hasAttribute('disabled') ||
      ancestor.matches(':disabled') ||
      ancestor.hasAttribute('inert') ||
      ancestor.classList.contains('disabled')
    )
      return false;
    if (ancestor === root) break;
  }
  const rect = element.getBoundingClientRect();
  if (
    !(element instanceof HTMLElement) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  )
    return false;
  const reachable = [0.15, 0.5, 0.85].some((x) =>
    [0.15, 0.5, 0.85].some((y) => {
      const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
      return !!hit && element.contains(hit);
    }),
  );
  if (!reachable) return false;
  if (expected.token) {
    if (scope.arm) return false;
    const times = rows.map((row) => {
      const elements = row.querySelectorAll('.time');
      return elements.length === 1 ? (elements[0].textContent?.trim() ?? '') : '';
    });
    if (times.some((time) => !/^\d{2}:\d{2}:\d{2}$/.test(time))) return false;
    scope.commitMedia = media[0];
    scope.commitEpoch = scope.mediaEpoch;
    scope.commitMetadataCount = scope.metadataCount;
    scope.catalogueTimes = times;
    scope.arm = {
      token: expected.token,
      ordinal: expected.targetOrdinal,
      expiresAt: performance.now() + 3000,
      consumed: false,
      blocked: false,
    };
  }
  return true;
}
