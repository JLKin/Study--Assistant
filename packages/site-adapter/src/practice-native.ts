import { randomUUID } from 'node:crypto';
import type { Page, Disposable, Frame } from 'playwright';
import type { CourseObservation } from '../../contracts/src/index';
import type { MonitorSiteAdapter, SiteObservation } from '../../contracts/src/monitor';
import type {
  PracticeAction,
  PracticeContext,
  PracticeSiteAdapter,
  PracticeVideo,
} from '../../contracts/src/practice';
import { parseNativeQuestion, type NativeQuestionLayout } from '../../practice/src/native-question';
import {
  validPracticeGrant,
  type VerifiedPracticeGrant,
} from '../../task-engine/src/practice-grant';
import type { TaskEngine } from '../../task-engine/src/index';
import { delay } from '../../contracts/src/async';
import { isZhihuishuStudyUrl, zhihuishuCourseId } from './zhihuishu';
import { nativePracticeDom, type NativePracticeRequest } from './practice-native-dom';
import {
  practiceStopReason,
  type PracticeStopReason,
  type PracticeStopDiagnostic,
} from './practice-diagnostics';

/** Explicit single-course candidate. The production adapter factory deliberately never selects it. */
export class VerifiedZhihuishuPracticeAdapter implements PracticeSiteAdapter {
  readonly kind = 'zhihuishu-verified' as const;
  private readonly key = `stage3_${randomUUID().replaceAll('-', '')}`;
  private readonly binding = `${this.key}_manual`;
  private handle?: Disposable;
  private onManual?: () => void;
  private invalid = false;
  private layout: NativeQuestionLayout | null = null;
  private readonly grant: VerifiedPracticeGrant;
  private expiration?: ReturnType<typeof setTimeout>;
  private disposing?: Promise<void>;
  private armedSignal?: AbortSignal;
  private nativeCommand?: Promise<void>;
  private readonly startedAt = Date.now();
  private stopDiagnostic: PracticeStopDiagnostic | null = null;
  private phase = 'idle';
  private armedAbort = () => {
    this.changed('SIGNAL_ABORTED');
    void this.dispose();
  };
  private constructor(
    private readonly page: Page,
    grant: VerifiedPracticeGrant,
    private readonly url: string,
    private readonly engine: TaskEngine,
    private readonly allowExistingFeedback = false,
  ) {
    this.grant = Object.freeze({ ...grant });
  }
  static async arm(
    page: Page,
    grant: VerifiedPracticeGrant,
    signal: AbortSignal,
    engine: TaskEngine,
    options: { allowExistingFeedback?: boolean } = {},
  ) {
    signal.throwIfAborted();
    if (
      !isZhihuishuStudyUrl(page.url()) ||
      !validPracticeGrant(grant) ||
      zhihuishuCourseId(new URL(page.url()).searchParams.get('recruitAndCourseId')!) !==
        grant.courseId
    )
      throw new Error('PRACTICE_LOCKED');
    const adapter = new VerifiedZhihuishuPracticeAdapter(
      page,
      grant,
      page.url(),
      engine,
      options.allowExistingFeedback === true,
    );
    try {
      adapter.handle = await page.exposeBinding(adapter.binding, (source, reason: unknown) => {
        if (source.page === page && source.frame === page.mainFrame()) {
          adapter.changed(practiceStopReason(reason) ?? 'PAGE_GUARD_INVALIDATED', 'page');
        }
      });
      await adapter.sample('arm', signal);
      adapter.armedSignal = signal;
      signal.addEventListener('abort', adapter.armedAbort, { once: true });
      if (signal.aborted) {
        adapter.armedAbort();
        signal.throwIfAborted();
      }
      page.on('framenavigated', adapter.frameChanged);
      page.on('close', adapter.pageClosed);
      adapter.expiration = setTimeout(
        () => {
          adapter.changed('GRANT_EXPIRED');
          void adapter.dispose();
        },
        Math.max(0, grant.expiresAt - Date.now()),
      );
      return adapter;
    } catch (error) {
      await adapter.dispose();
      throw error;
    }
  }
  /** Detached copy; cleanup cannot replace the first observed cause with cancellation. */
  diagnostics() {
    return {
      stop: this.stopDiagnostic ? { ...this.stopDiagnostic } : null,
      disposed: !!this.disposing,
    };
  }
  private record(reason: PracticeStopReason, origin: PracticeStopDiagnostic['origin']) {
    this.stopDiagnostic ??= {
      reason,
      origin,
      phase: this.phase,
      elapsedMs: Math.max(0, Date.now() - this.startedAt),
    };
  }
  private changed = (
    reason: PracticeStopReason,
    origin: PracticeStopDiagnostic['origin'] = 'node',
  ) => {
    this.record(reason, origin);
    this.invalid = true;
    this.onManual?.();
  };
  private frameChanged = (frame: Frame) =>
    this.changed(
      frame === this.page.mainFrame() ? 'MAIN_FRAME_NAVIGATED' : 'CHILD_FRAME_NAVIGATED',
    );
  private pageClosed = () => this.changed('PAGE_CLOSED');
  private request(mode: NativePracticeRequest['mode']): NativePracticeRequest {
    return {
      mode,
      key: this.key,
      binding: this.binding,
      url: this.url,
      courseId: this.grant.courseId,
      grantId: this.grant.id,
      expiresAt: this.grant.expiresAt,
      allowExistingFeedback: this.allowExistingFeedback,
    };
  }
  private async sample(
    mode: NativePracticeRequest['mode'],
    signal: AbortSignal,
    extra: Partial<NativePracticeRequest> = {},
  ) {
    this.phase = mode;
    if (signal.aborted) {
      this.record('SIGNAL_ABORTED', 'node');
      signal.throwIfAborted();
    }
    if (this.invalid || !validPracticeGrant(this.grant) || this.page.url() !== this.url) {
      this.record(
        this.disposing
          ? 'ADAPTER_DISPOSED'
          : !validPracticeGrant(this.grant)
            ? 'GRANT_EXPIRED'
            : this.page.url() !== this.url
              ? 'ROUTE_CHANGED'
              : 'PAGE_GUARD_INVALIDATED',
        'node',
      );
      throw new Error('PRACTICE_LOCKED');
    }
    let result;
    try {
      result = await this.page.evaluate(nativePracticeDom, { ...this.request(mode), ...extra });
    } catch (error) {
      // The only parsed text is our own fixed reason-code prefix; never retain exception text.
      const reason =
        error instanceof Error
          ? practiceStopReason(
              error.message.match(/NATIVE_PRACTICE_CONTEXT_CHANGED:([A-Z_]+)/)?.[1],
            )
          : null;
      this.record(reason ?? 'BROWSER_SAMPLE_FAILED', reason ? 'dom' : 'node');
      throw error;
    }
    if (signal.aborted) this.record('SIGNAL_ABORTED', 'node');
    signal.throwIfAborted();
    if (!result) {
      this.record('PAGE_SAMPLE_EMPTY', 'dom');
      throw new Error('PRACTICE_LOCKED');
    }
    return result;
  }
  async inspect(signal: AbortSignal): Promise<CourseObservation> {
    const sample = await this.sample('sample', signal);
    return {
      source: 'zhihuishu-dom',
      courseId: this.grant.courseId,
      title: sample.title,
      authenticated: true,
      pageKind: 'course',
      confidence: 'verified',
      platformCompleted: null,
      evidence: ['manual-ai-tutor-note-v1', 'internal-single-use-candidate'],
      observedAt: new Date().toISOString(),
    };
  }
  /** Keep generic popup protection; only this armed candidate can verify the tutor overlay. */
  async observeForReview(
    monitor: Pick<MonitorSiteAdapter, 'observe'>,
    signal: AbortSignal,
  ): Promise<SiteObservation> {
    signal.throwIfAborted();
    const before = await monitor.observe(signal);
    signal.throwIfAborted();
    if (before.popup !== 'present') return before;
    const context = await this.context(signal);
    const course = await this.inspect(signal);
    const after = await monitor.observe(signal);
    const latest = await this.context(signal);
    signal.throwIfAborted();
    if (
      context.source !== 'zhihuishu-verified' ||
      context.authorizationId !== this.grant.id ||
      context.courseId !== this.grant.courseId ||
      context.classification !== 'non-graded' ||
      !context.explicitNonGraded ||
      !context.authenticated ||
      JSON.stringify(context) !== JSON.stringify(latest) ||
      course.courseId !== this.grant.courseId ||
      ![before, after].every(
        (sample) =>
          sample.course.courseId === this.grant.courseId &&
          sample.course.source === 'zhihuishu-dom' &&
          sample.course.pageKind === 'course' &&
          sample.popup === 'present' &&
          !!sample.currentChapterId &&
          sample.player?.chapterId === sample.currentChapterId &&
          sample.player.confidence === 'verified',
      ) ||
      before.currentChapterId !== after.currentChapterId ||
      before.player?.duration !== after.player?.duration ||
      JSON.stringify(before.chapters.map((chapter) => chapter.chapterId)) !==
        JSON.stringify(after.chapters.map((chapter) => chapter.chapterId))
    )
      throw new Error('REVIEW_PRACTICE_CONTEXT_CHANGED');
    // No monitor action capability is granted by the practice-specific course observation.
    return { ...after, course };
  }
  async watchManual(signal: AbortSignal, onManual: () => void) {
    if (this.invalid) throw new Error('PRACTICE_LOCKED');
    this.onManual = onManual;
    const abort = () => {
      this.record('SIGNAL_ABORTED', 'node');
      this.invalid = true;
      void this.dispose();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      signal.throwIfAborted();
    }
    return async () => {
      signal.removeEventListener('abort', abort);
      await this.dispose();
    };
  }
  async context(signal: AbortSignal) {
    return (await this.sample('sample', signal)).context;
  }
  async question(signal: AbortSignal) {
    return (await this.sample('sample', signal)).question;
  }
  async video(signal: AbortSignal) {
    return (await this.sample('sample', signal)).video;
  }
  async capture(signal: AbortSignal) {
    const before = await this.sample('sample', signal);
    if (!before.layout?.fullyVisible || !before.layout.unanswered || !before.captureClip)
      throw new Error('QUESTION_IMAGE_UNCERTAIN');
    const bytes = await this.page.screenshot({ clip: before.captureClip, timeout: 3000 });
    const after = await this.sample('sample', signal);
    if (JSON.stringify(before.context) !== JSON.stringify(after.context))
      throw new Error('PRACTICE_CONTEXT_CHANGED');
    if (
      !after.layout?.fullyVisible ||
      !after.layout.unanswered ||
      JSON.stringify(before.captureClip) !== JSON.stringify(after.captureClip)
    )
      throw new Error('QUESTION_IMAGE_UNCERTAIN');
    this.layout = structuredClone(before.layout);
    return bytes;
  }
  parseCapturedQuestion(text: string) {
    return this.layout ? parseNativeQuestion(text, this.layout) : null;
  }
  async prepare(
    _action: PracticeAction,
    context: PracticeContext,
    video: PracticeVideo,
    signal: AbortSignal,
  ) {
    const sample = await this.sample('sample', signal);
    if (
      JSON.stringify(sample.context) !== JSON.stringify(context) ||
      JSON.stringify(sample.video) !== JSON.stringify(video)
    )
      throw new Error('PRACTICE_CONTEXT_CHANGED');
  }
  async perform(
    action: PracticeAction,
    context: PracticeContext,
    video: PracticeVideo,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (
      !this.engine.canIssuePracticeAction(action, context.courseId, context.authorizationId ?? '')
    )
      throw new Error('PRACTICE_LOCKED');
    if (action.type === 'submit') {
      const selected = await this.clickOnce(action, context, video, 'option', signal);
      if (selected.requiresSubmit) await this.clickOnce(action, context, video, 'submit', signal);
    } else if (action.type === 'close') {
      await this.clickOnce(action, context, video, 'close', signal);
    } else await this.sample('action', signal, { action, context, video });
  }
  private async clickOnce(
    action: PracticeAction,
    context: PracticeContext,
    video: PracticeVideo,
    inputPart: 'option' | 'submit' | 'close',
    signal: AbortSignal,
  ) {
    const inputToken = randomUUID();
    await this.sample('input-arm', signal, { action, context, video, inputPart, inputToken });
    const handle = await this.page.evaluateHandle(
      ({ key, token }) => {
        const state = (
          window as unknown as Record<string, { input?: { token: string; target: HTMLElement } }>
        )[key];
        return state?.input?.token === token ? state.input.target : null;
      },
      { key: this.key, token: inputToken },
    );
    try {
      signal.throwIfAborted();
      if (
        this.invalid ||
        !this.engine.canIssuePracticeAction(action, context.courseId, context.authorizationId ?? '')
      )
        throw new Error('PRACTICE_LOCKED');
      const target = handle.asElement();
      if (!target) throw new Error('NATIVE_INPUT_TARGET_MISSING');
      // One ordinary browser command, bounded and bound to this exact node.
      // The capture latch validates again at pointerdown and click. No fallback.
      this.phase = 'input-command';
      this.nativeCommand = target.click({ timeout: 2000 });
      try {
        await this.nativeCommand;
      } catch (error) {
        this.record('INPUT_ISSUE_FAILED', 'node');
        throw error;
      }
      let after = await this.sample('input-finish', signal, { inputToken });
      while (after.closePending) {
        // Observe the original close transition; never issue a second click.
        await delay(50, signal);
        after = await this.sample('input-finish', signal, { inputToken });
      }
      if (!after.inputConfirmed) throw new Error('NATIVE_INPUT_UNCONFIRMED');
      return after;
    } finally {
      await this.nativeCommand?.catch(() => undefined);
      await handle.dispose().catch(() => undefined);
      await this.page
        .evaluate(nativePracticeDom, { ...this.request('input-clear'), inputToken })
        .catch(() => undefined);
    }
  }
  async feedback(signal: AbortSignal) {
    const end = Date.now() + 4000;
    do {
      const sample = await this.sample('feedback', signal);
      if (sample.feedback.status !== 'unknown' || !sample.feedbackPending) return sample.feedback;
      await delay(100, signal);
    } while (Date.now() < end);
    return { status: 'unknown' as const };
  }
  async verify(action: PracticeAction, _video: PracticeVideo, signal: AbortSignal) {
    return (await this.sample('sample', signal, { action })).verified;
  }
  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      clearTimeout(this.expiration);
      this.invalid = true;
      await this.page
        .evaluate(nativePracticeDom, this.request('input-cancel'))
        .catch(() => undefined);
      await this.nativeCommand?.catch(() => undefined);
      this.armedSignal?.removeEventListener('abort', this.armedAbort);
      this.page.off('framenavigated', this.frameChanged);
      this.page.off('close', this.pageClosed);
      await this.page.evaluate(nativePracticeDom, this.request('dispose')).catch(() => undefined);
      await this.handle?.dispose().catch(() => undefined);
      this.handle = undefined;
      this.onManual = undefined;
      this.layout = null;
    })();
    return this.disposing;
  }
}
