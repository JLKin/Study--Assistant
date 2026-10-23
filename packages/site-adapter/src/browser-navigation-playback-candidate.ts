import { randomUUID } from 'node:crypto';
import type { ElementHandle, Page } from 'playwright';
import type { Result, TaskView } from '../../contracts/src/index';
import type { SiteAction, SiteObservation } from '../../contracts/src/monitor';
import { TaskEngine } from '../../task-engine/src/index';
import { BrowserNavigationCandidate } from './browser-navigation-candidate';
import { ZhihuishuMonitorSiteAdapter } from './zhihuishu';
import { ZHIHUISHU_IDENTITY_EVIDENCE, type ZhihuishuIdentityEvidence } from './zhihuishu-evidence';
import type { BrowserContinuousInputGuard } from './browser-continuous-input-guard';

type Navigation = Extract<SiteAction, { type: 'navigate' }>;
export interface NavigationPlaybackPermissions {
  navigation?: boolean;
  startPlayAfterNavigation?: boolean;
  allowCompletedSourceBeforeEnd?: boolean;
  nextVideoAt81Percent?: boolean;
  continuousGuard?: BrowserContinuousInputGuard;
  keepMonitoringOnSuccess?: boolean;
}
export interface NavigationPlaybackOutcome {
  navigationOperationId: string;
  playbackOperationId: string;
  navigation: Result<TaskView> | null;
  playback: Result<TaskView> | null;
  playbackOutcome: 'not-run' | 'already-playing' | 'confirmed' | 'unknown';
  navigationDispatchCalls: 0 | 1;
  playbackPerformCalls: 0 | 1;
  stopReason: string | null;
  navigationDiagnostics: ReturnType<BrowserNavigationCandidate['diagnostics']>;
  playbackDiagnostics: {
    stage: 'not-run' | 'target-check' | 'preparation' | 'play-action' | 'feedback' | 'confirmed';
    failure: string | null;
  };
}

/** Internal one-shot offline candidate. Production factories/IPC never construct this coordinator. */
export class BrowserNavigationPlaybackCandidate {
  private readonly navigator: BrowserNavigationCandidate;
  private readonly identityEvidence: readonly ZhihuishuIdentityEvidence[];
  private readonly navigationAllowed: boolean;
  private readonly playbackAllowed: boolean;
  private readonly continuousGuard: BrowserContinuousInputGuard | undefined;
  private readonly keepMonitoring: boolean;
  private used = false;
  private media: ElementHandle<HTMLVideoElement> | null = null;
  private readonly mediaScope = `zhsPlaybackMedia_${randomUUID().replaceAll('-', '')}`;

  constructor(
    private readonly page: Page,
    private readonly engine: TaskEngine,
    identityEvidence: readonly ZhihuishuIdentityEvidence[] = ZHIHUISHU_IDENTITY_EVIDENCE,
    permissions: Readonly<NavigationPlaybackPermissions> = {},
  ) {
    this.identityEvidence = identityEvidence;
    this.navigationAllowed = permissions.navigation === true;
    this.playbackAllowed = permissions.startPlayAfterNavigation === true;
    this.continuousGuard = permissions.continuousGuard;
    this.keepMonitoring = permissions.keepMonitoringOnSuccess === true;
    if (this.keepMonitoring && !this.continuousGuard) throw new Error('CONTINUOUS_GUARD_REQUIRED');
    this.navigator = new BrowserNavigationCandidate(page, identityEvidence, {
      navigation: permissions.navigation === true,
      allowCompletedSourceBeforeEnd: permissions.allowCompletedSourceBeforeEnd === true,
      nextVideoAt81Percent: permissions.nextVideoAt81Percent === true,
      retainGuardAfterConfirmation: true,
      continuousGuard: permissions.continuousGuard,
    });
  }

  async runOnce(
    action: Navigation,
    courseId: string,
    signal: AbortSignal = this.engine.signal,
  ): Promise<NavigationPlaybackOutcome> {
    if (this.used) throw new Error('NAVIGATION_PLAYBACK_ALREADY_CONSUMED');
    this.used = true;
    const output: NavigationPlaybackOutcome = {
      navigationOperationId: randomUUID(),
      playbackOperationId: randomUUID(),
      navigation: null,
      playback: null,
      playbackOutcome: 'not-run',
      navigationDispatchCalls: 0,
      playbackPerformCalls: 0,
      stopReason: null,
      navigationDiagnostics: this.navigator.diagnostics(),
      playbackDiagnostics: { stage: 'not-run', failure: null },
    };
    if (!this.navigationAllowed) {
      output.stopReason = 'NAVIGATION_PLAYBACK_NOT_GRANTED';
      await this.navigator.dispose();
      return output;
    }
    const taskId = this.engine.view().taskId;
    const active = AbortSignal.any([
      signal,
      this.engine.signal,
      ...(this.continuousGuard ? [this.continuousGuard.signal] : []),
    ]);
    const cancelled = () => {
      void this.engine.suspend('单次切章播放衔接已取消；不重发。');
    };
    const externalCancellation = signal !== this.engine.signal;
    if (externalCancellation) signal.addEventListener('abort', cancelled, { once: true });
    let unsubscribe: (() => void) | undefined;
    try {
      active.throwIfAborted();
      if (!taskId || this.engine.confirmedCourse !== courseId)
        throw new Error('NAVIGATION_PLAYBACK_TASK_REQUIRED');
      unsubscribe = await this.navigator.subscribe((event) => {
        if (event.type === 'manual' || event.type === 'navigation')
          void this.engine.suspend('切章播放衔接遇人工操作或页面变化，已取消；不重发。', true);
      });
      output.navigation = await this.engine.execute({
        operationId: output.navigationOperationId,
        kind: 'chapter-navigation',
        prepare: (current) => this.navigator.prepareNavigation(action, courseId, current),
        issue: async (current) => {
          await this.navigator.navigateOnce(action, courseId, current);
        },
        verify: async (current) => {
          await this.navigator.assertRetainedGuard(current);
          const after = await this.navigator.observe(current);
          this.assertTarget(after, action, courseId);
          return 'confirmed';
        },
      });
      // execute returns success only after OPERATION_COMPLETED has actually been saved.
      if (!output.navigation.ok || output.navigation.code !== 'OPERATION_COMPLETED') return output;
      if (!this.playbackAllowed) return output;
      active.throwIfAborted();
      if (this.engine.view().taskId !== taskId) throw new Error('NAVIGATION_PLAYBACK_TASK_CHANGED');
      await this.navigator.assertRetainedGuard(active);
      const scope = this.navigator.retainedGuardScope();
      output.playbackDiagnostics.stage = 'target-check';
      this.media = (await this.bounded(
        this.page
          .locator('.video-study video#vjs_container_html5_api')
          .elementHandle({ timeout: 2000 }),
        active,
      )) as ElementHandle<HTMLVideoElement> | null;
      if (!this.media) throw new Error('NAVIGATION_PLAYBACK_MEDIA_UNAVAILABLE');
      await this.bounded(
        this.media.evaluate((media, name) => {
          const scopes = window as unknown as Record<string, unknown>;
          const state = { media, invalid: false, cleanup: (): void => undefined };
          const invalidated = () => {
            state.invalid = true;
          };
          const events = ['loadstart', 'emptied', 'loadedmetadata'];
          events.forEach((type) => media.addEventListener(type, invalidated));
          state.cleanup = () =>
            events.forEach((type) => media.removeEventListener(type, invalidated));
          scopes[name] = state;
        }, this.mediaScope),
        active,
      );
      const player = new ZhihuishuMonitorSiteAdapter(this.page, this.identityEvidence, {
        startPlay: true,
        criticalInputGuard: scope,
        continuousInputGuard: this.continuousGuard?.scopeName,
        expectedMedia: this.media,
        mediaLifecycleGuard: this.mediaScope,
      });
      const before = await this.targetSample(player, action, courseId, active);
      const rate = before.player!.playbackRate;
      const duration = before.player!.duration;
      let baseline = { time: before.player!.currentTime, at: Date.now() };
      const advancing = async (current: AbortSignal) => {
        output.playbackDiagnostics.stage = 'feedback';
        const until = Date.now() + 3000;
        let previousTime = baseline.time;
        while (Date.now() < until) {
          const later = await this.targetSample(player, action, courseId, current);
          if (Date.now() >= until) break;
          if (
            later.player!.paused ||
            later.player!.buffering ||
            later.player!.playbackRate !== rate ||
            Math.abs(later.player!.duration - duration) > 0.2
          ) {
            output.playbackDiagnostics.failure = 'PLAYBACK_FEEDBACK_STATE_INVALID';
            return 'unknown' as const;
          }
          const time = later.player!.currentTime;
          const delta = time - baseline.time;
          if (
            time < previousTime - 0.02 ||
            delta < -0.02 ||
            delta > ((Date.now() - baseline.at) / 1000) * rate + 0.35
          ) {
            output.playbackDiagnostics.failure = 'PLAYBACK_FEEDBACK_UNNATURAL_PROGRESS';
            return 'unknown' as const;
          }
          if (delta >= 0.2) return 'confirmed' as const;
          previousTime = time;
          await this.delay(150, current);
        }
        output.playbackDiagnostics.failure = 'PLAYBACK_FEEDBACK_NO_PROGRESS';
        return 'unknown' as const;
      };
      if (!before.player!.paused) {
        if ((await advancing(active)) !== 'confirmed') {
          output.playbackOutcome = 'unknown';
          await this.engine.suspend('网站已播放但时间推进无法确认；不补发播放。');
        } else {
          output.playbackOutcome = 'already-playing';
          output.playbackDiagnostics.stage = 'confirmed';
        }
        return output;
      }
      const playAction = { type: 'start-play', chapterId: action.chapterId } as const;
      output.playback = await this.engine.execute({
        operationId: output.playbackOperationId,
        kind: 'playback-start',
        prepare: async (current) => {
          output.playbackDiagnostics.stage = 'preparation';
          const latest = await this.targetSample(player, action, courseId, current);
          if (!latest.player!.paused || latest.player!.playbackRate !== rate)
            throw new Error('NAVIGATION_PLAYBACK_STATE_CHANGED');
          await player.prepare(playAction, courseId, current);
        },
        issue: async (current) => {
          const latest = await this.targetSample(player, action, courseId, current);
          if (
            !latest.player!.paused ||
            latest.player!.playbackRate !== rate ||
            Math.abs(latest.player!.duration - duration) > 0.2
          )
            throw new Error('NAVIGATION_PLAYBACK_STATE_CHANGED');
          baseline = { time: latest.player!.currentTime, at: Date.now() };
          output.playbackPerformCalls = 1;
          output.playbackDiagnostics.stage = 'play-action';
          await player.perform(playAction, courseId, current);
        },
        verify: advancing,
      });
      output.playbackOutcome = output.playback.ok ? 'confirmed' : 'unknown';
      if (output.playback.ok) output.playbackDiagnostics.stage = 'confirmed';
      else output.playbackDiagnostics.failure ??= 'PLAYBACK_ACTION_OR_FEEDBACK_UNCONFIRMED';
      return output;
    } catch {
      output.stopReason = 'NAVIGATION_PLAYBACK_CANCELLED_OR_UNSAFE';
      if (output.playbackPerformCalls) output.playbackOutcome = 'unknown';
      if (output.playbackDiagnostics.stage !== 'not-run')
        output.playbackDiagnostics.failure ??= 'PLAYBACK_GUARD_OR_TARGET_INVALID';
      await this.engine.suspend('切章播放衔接无法可靠确认，已停止；不重发。');
      return output;
    } finally {
      output.navigationDispatchCalls = this.navigator.view().dispatchCalls;
      output.navigationDiagnostics = this.navigator.diagnostics();
      if (externalCancellation) signal.removeEventListener('abort', cancelled);
      unsubscribe?.();
      // This one-shot no longer owns any monitor after cleanup; preserve actual video state.
      let successful =
        output.navigation?.ok === true &&
        ['confirmed', 'already-playing'].includes(output.playbackOutcome) &&
        output.stopReason === null;
      if (this.keepMonitoring && successful) {
        try {
          await this.continuousGuard!.assertActive(active);
        } catch {
          successful = false;
          output.stopReason = 'CONTINUOUS_GUARD_BLOCKED_AFTER_PLAYBACK';
        }
      }
      if (this.engine.view().state === 'MONITORING' && !(this.keepMonitoring && successful))
        await this.engine.suspend('单次切章播放衔接已结束；视频状态保持不变。');
      try {
        await this.navigator.dispose();
      } catch {
        output.stopReason = 'CONTINUOUS_CHILD_CLEANUP_UNSAFE';
        await this.engine.suspend('连续会话子作用域无法可靠释放，已停止；不重发。');
      }
      if (this.media)
        await this.bounded(
          this.media.evaluate((_, name) => {
            const scopes = window as unknown as Record<
              string,
              { cleanup?: () => void } | undefined
            >;
            scopes[name]?.cleanup?.();
            delete scopes[name];
          }, this.mediaScope),
          AbortSignal.timeout(3000),
        ).catch(() => undefined);
      await this.media?.dispose().catch(() => undefined);
      this.media = null;
    }
  }

  private assertTarget(sample: SiteObservation, action: Navigation, courseId: string): void {
    const fresh = (time: string) => {
      const age = Date.now() - Date.parse(time);
      return Number.isFinite(age) && age >= -5000 && age <= 30000;
    };
    if (
      sample.course.source !== 'zhihuishu-dom' ||
      sample.course.confidence !== 'verified' ||
      sample.course.courseId !== courseId ||
      sample.course.authenticated !== true ||
      sample.course.pageKind !== 'course' ||
      !fresh(sample.course.observedAt) ||
      sample.popup !== 'none' ||
      sample.currentChapterId !== action.chapterId ||
      sample.player?.chapterId !== action.chapterId ||
      sample.player.confidence !== 'verified' ||
      !fresh(sample.player.observedAt) ||
      sample.player.ended ||
      sample.capabilities?.completionMarkers !== true ||
      sample.chapters.find((row) => row.chapterId === action.fromChapterId)?.platformCompleted !==
        true
    )
      throw new Error('NAVIGATION_PLAYBACK_TARGET_UNSAFE');
  }

  private async targetSample(
    reader: ZhihuishuMonitorSiteAdapter,
    action: Navigation,
    courseId: string,
    signal: AbortSignal,
  ): Promise<SiteObservation> {
    await this.navigator.assertRetainedGuard(signal);
    await this.assertMedia(signal);
    const sample = await reader.observe(signal);
    this.assertTarget(sample, action, courseId);
    await this.assertMedia(signal);
    await this.navigator.assertRetainedGuard(signal);
    return sample;
  }

  private async assertMedia(signal: AbortSignal): Promise<void> {
    if (
      !this.media ||
      !(await this.bounded(
        this.media.evaluate((media, name) => {
          const roots = document.querySelectorAll('.video-study');
          const videos = document.querySelectorAll('video');
          const scope = (
            window as unknown as Record<string, { media?: Element; invalid?: boolean } | undefined>
          )[name];
          return (
            !!scope &&
            scope.media === media &&
            scope.invalid === false &&
            roots.length === 1 &&
            videos.length === 1 &&
            videos[0] === media &&
            roots[0].contains(media)
          );
        }, this.mediaScope),
        signal,
      ))
    )
      throw new Error('NAVIGATION_PLAYBACK_MEDIA_CHANGED');
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    await this.bounded(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
  }

  private bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value as T);
      };
      const abort = () => finish(signal.reason ?? new Error('CANCELLED'));
      const timer = setTimeout(() => finish(new Error('NAVIGATION_PLAYBACK_TIMEOUT')), 3000);
      signal.addEventListener('abort', abort, { once: true });
      work.then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });
  }
}
