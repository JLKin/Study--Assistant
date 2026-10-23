import type { Page } from 'playwright';
import { RECOVERY_COOLDOWN_MS } from '../../contracts/src/index';
import type { SiteObservation } from '../../contracts/src/monitor';
import type { TaskEngine } from '../../task-engine/src/index';
import { BrowserContinuousInputGuard } from './browser-continuous-input-guard';
import {
  BrowserNavigationPlaybackCandidate,
  type NavigationPlaybackOutcome,
} from './browser-navigation-playback-candidate';
import { ZhihuishuMonitorSiteAdapter } from './zhihuishu';
import { ZHIHUISHU_IDENTITY_EVIDENCE, type ZhihuishuIdentityEvidence } from './zhihuishu-evidence';

export interface ContinuousNavigationOptions {
  navigation?: boolean;
  startPlayAfterNavigation?: boolean;
  maxTransitions?: number;
  pollIntervalMs?: number;
  totalTimeoutMs?: number;
  onObservation?: (sample: SiteObservation, completedTransitions: number) => void;
}
export interface ContinuousNavigationResult {
  outcomes: NavigationPlaybackOutcome[];
  completedTransitions: number;
  stopReason: string | null;
  samples: number;
  initialTaskId: string | null;
}

/** Internal bounded candidate. It never starts/resumes a task or enters production factories. */
export class ContinuousNavigationCandidateSession {
  private used = false;
  private readonly options: Readonly<ContinuousNavigationOptions>;
  constructor(
    private readonly page: Page,
    private readonly engine: TaskEngine,
    private readonly identityEvidence: readonly ZhihuishuIdentityEvidence[] = ZHIHUISHU_IDENTITY_EVIDENCE,
    options: Readonly<ContinuousNavigationOptions> = {},
  ) {
    this.options = { ...options };
  }

  async run(
    requestedPlan: { courseId: string; chapterIds: string[] },
    signal: AbortSignal = this.engine.signal,
  ): Promise<ContinuousNavigationResult> {
    if (this.used) throw new Error('CONTINUOUS_SESSION_ALREADY_CONSUMED');
    this.used = true;
    const output: ContinuousNavigationResult = {
      outcomes: [],
      completedTransitions: 0,
      stopReason: null,
      samples: 0,
      initialTaskId: this.engine.view().taskId,
    };
    const max = this.options.maxTransitions ?? 3;
    const interval = this.options.pollIntervalMs ?? 3000;
    const timeout = this.options.totalTimeoutMs ?? 20 * 60_000;
    if (this.options.navigation !== true || this.options.startPlayAfterNavigation !== true) {
      output.stopReason = 'CONTINUOUS_NOT_GRANTED';
      return output;
    }
    if (
      !Number.isInteger(max) ||
      max < 1 ||
      max > 3 ||
      !Number.isInteger(interval) ||
      interval < 50 ||
      interval > 3000 ||
      !Number.isInteger(timeout) ||
      timeout < 1000 ||
      timeout > 20 * 60_000 ||
      typeof requestedPlan.courseId !== 'string' ||
      !requestedPlan.courseId ||
      !Array.isArray(requestedPlan.chapterIds) ||
      requestedPlan.chapterIds.some((id) => typeof id !== 'string' || !id) ||
      requestedPlan.chapterIds.length < 2 ||
      requestedPlan.chapterIds.length > max + 1 ||
      new Set(requestedPlan.chapterIds).size !== requestedPlan.chapterIds.length
    ) {
      output.stopReason = 'CONTINUOUS_PLAN_INVALID';
      return output;
    }
    const plan = {
      courseId: requestedPlan.courseId,
      chapterIds: [...requestedPlan.chapterIds],
    };
    const taskSignal = this.engine.signal;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('CONTINUOUS_TOTAL_DEADLINE')), timeout);
    const guard = new BrowserContinuousInputGuard(this.page, () => {
      void this.engine.suspend('连续验收遇人工操作、媒体或页面变化；已停止，不自动继续。', true);
    });
    const active = AbortSignal.any([signal, taskSignal, deadline.signal, guard.signal]);
    const cancel = () => {
      void this.engine.suspend('连续验收已取消；未发动作不再执行，未知不重发。');
    };
    active.addEventListener('abort', cancel, { once: true });
    const reader = new ZhihuishuMonitorSiteAdapter(this.page, this.identityEvidence);
    let baseline: SiteObservation | null = null;
    const seenCompleted = new Set<string>();
    let expectedIndex = 0;
    let previous: { time: number; at: number; duration: number; rate: number } | null = null;
    let lastHopFinishedAt = Number.NEGATIVE_INFINITY;
    const fail = (reason: string): never => {
      output.stopReason = reason;
      throw new Error(reason);
    };
    const requireActive = () => {
      active.throwIfAborted();
      if (
        this.engine.signal !== taskSignal ||
        this.engine.view().taskId !== output.initialTaskId ||
        this.engine.view().state !== 'MONITORING' ||
        this.engine.confirmedCourse !== plan.courseId
      )
        fail('CONTINUOUS_TASK_CHANGED');
    };
    const delay = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        requireActive();
        const abort = () => {
          clearTimeout(wait);
          reject(active.reason);
        };
        const wait = setTimeout(() => {
          active.removeEventListener('abort', abort);
          resolve();
        }, ms);
        active.addEventListener('abort', abort, { once: true });
      });
    const observe = async (currentIndex = expectedIndex) => {
      requireActive();
      await guard.assertActive(active);
      const sample = await reader.observe(active);
      requireActive();
      await guard.assertActive(active);
      if (sample.popup !== 'none') fail('CONTINUOUS_POPUP');
      const player = sample.player;
      if (
        sample.course.courseId !== plan.courseId ||
        sample.course.confidence !== 'verified' ||
        sample.course.authenticated !== true ||
        sample.course.pageKind !== 'course' ||
        sample.capabilities?.completionMarkers !== true ||
        sample.currentChapterId !== plan.chapterIds[currentIndex] ||
        !player ||
        player.chapterId !== sample.currentChapterId ||
        player.confidence !== 'verified' ||
        sample.chapters.some(
          (row) => row.confidence !== 'verified' || row.platformCompleted === null,
        )
      )
        fail('CONTINUOUS_OBSERVATION_UNSAFE');
      if (!player) throw new Error('CONTINUOUS_OBSERVATION_UNSAFE');
      const source = sample.chapters.findIndex((row) => row.chapterId === plan.chapterIds[0]);
      if (
        source < 0 ||
        plan.chapterIds.some((id, index) => sample.chapters[source + index]?.chapterId !== id)
      )
        fail('CONTINUOUS_PLAN_NOT_ADJACENT');
      if (
        baseline &&
        (sample.course.title !== baseline.course.title ||
          sample.chapters.length !== baseline.chapters.length ||
          sample.chapters.some(
            (row, index) =>
              row.chapterId !== baseline!.chapters[index].chapterId ||
              row.title !== baseline!.chapters[index].title ||
              (baseline!.chapters[index].platformCompleted === true &&
                row.platformCompleted !== true),
          ))
      )
        fail('CONTINUOUS_CATALOGUE_CHANGED');
      for (const row of sample.chapters) {
        if (seenCompleted.has(row.chapterId) && row.platformCompleted !== true)
          fail('CONTINUOUS_COMPLETION_REGRESSED');
        if (row.platformCompleted === true) seenCompleted.add(row.chapterId);
      }
      if (player.paused || player.ended || player.buffering) fail('CONTINUOUS_SOURCE_NOT_PLAYING');
      const now = Date.now();
      if (
        previous &&
        (player.playbackRate !== previous.rate ||
          Math.abs(player.duration - previous.duration) > 0.2 ||
          player.currentTime < previous.time - 0.1 ||
          player.currentTime - previous.time > ((now - previous.at) / 1000) * previous.rate + 0.75)
      )
        fail('CONTINUOUS_PROGRESS_UNNATURAL');
      if (baseline && player.playbackRate !== baseline.player!.playbackRate)
        fail('CONTINUOUS_RATE_CHANGED');
      previous = {
        time: player.currentTime,
        at: now,
        duration: player.duration,
        rate: player.playbackRate,
      };
      output.samples++;
      this.options.onObservation?.(structuredClone(sample), output.completedTransitions);
      requireActive();
      if (!(await this.engine.recordObservation(sample)).ok)
        fail('CONTINUOUS_OBSERVATION_WRITE_FAILED');
      return sample;
    };
    try {
      requireActive();
      await guard.install(active);
      baseline = await observe();
      for (expectedIndex = 0; expectedIndex < plan.chapterIds.length - 1; expectedIndex++) {
        for (;;) {
          const sample = await observe();
          const source = sample.chapters.find(
            (row) => row.chapterId === plan.chapterIds[expectedIndex],
          )!;
          const target = sample.chapters.find(
            (row) => row.chapterId === plan.chapterIds[expectedIndex + 1],
          )!;
          if (target.platformCompleted !== false) fail('CONTINUOUS_TARGET_ALREADY_COMPLETED');
          if (
            sample.player!.currentTime >= sample.player!.duration * 0.81 &&
            source.platformCompleted === true &&
            Date.now() - lastHopFinishedAt >= RECOVERY_COOLDOWN_MS
          )
            break;
          await delay(
            sample.player!.currentTime >= sample.player!.duration * 0.79
              ? Math.min(interval, 500)
              : interval,
          );
        }
        requireActive();
        await guard.assertActive(active);
        const coordinator = new BrowserNavigationPlaybackCandidate(
          this.page,
          this.engine,
          this.identityEvidence,
          {
            navigation: true,
            startPlayAfterNavigation: true,
            nextVideoAt81Percent: true,
            continuousGuard: guard,
            keepMonitoringOnSuccess: true,
          },
        );
        const actionDeadline = AbortSignal.timeout(25000);
        const result = await coordinator.runOnce(
          {
            type: 'navigate',
            fromChapterId: plan.chapterIds[expectedIndex],
            chapterId: plan.chapterIds[expectedIndex + 1],
          },
          plan.courseId,
          AbortSignal.any([active, actionDeadline]),
        );
        output.outcomes.push(result);
        if (
          result.navigation?.code !== 'OPERATION_COMPLETED' ||
          !['confirmed', 'already-playing'].includes(result.playbackOutcome) ||
          result.stopReason !== null
        )
          fail('CONTINUOUS_HOP_NOT_CONFIRMED');
        output.completedTransitions++;
        lastHopFinishedAt = Date.now();
        requireActive();
        await guard.assertActive(active);
        previous = null;
        await observe(expectedIndex + 1);
      }
    } catch {
      output.stopReason ??= active.aborted ? 'CONTINUOUS_CANCELLED' : 'CONTINUOUS_UNSAFE';
    } finally {
      clearTimeout(timer);
      active.removeEventListener('abort', cancel);
      if (this.engine.view().state === 'MONITORING')
        await this.engine.suspend(
          output.stopReason
            ? '连续验收已停止；不自动重试。'
            : '限定连续验收已完成；视频状态保持不变。',
        );
      await guard.dispose();
    }
    return output;
  }
}
