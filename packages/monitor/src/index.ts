import { randomUUID } from 'node:crypto';
import { RECOVERY_COOLDOWN_MS, type AppConfig, type Result } from '../../contracts/src/index';
import type {
  MonitorSiteAdapter,
  MonitorView,
  SiteAction,
  SiteObservation,
} from '../../contracts/src/monitor';
import { PlayerMonitor } from '../../player/src/index';
import { ChapterTracker, VERIFICATION_PROGRESS } from '../../chapters/src/index';
import type { TaskEngine } from '../../task-engine/src/index';

interface Options {
  engine: TaskEngine;
  config: () => AppConfig;
  onObservation?: (view: MonitorView) => void;
  now?: () => number;
  /** 单元测试可关闭定时器，生产始终事件 + 轮询。 */
  polling?: boolean;
  /** Explicit stage-3 integration; defaults keep the existing popup stop rule. */
  practice?: (observation: SiteObservation, signal: AbortSignal) => Promise<Result>;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** 单课程协调器：不接收 renderer 选择器/点击命令，所有副作用只走 TaskEngine。 */
export class MonitorSession {
  private adapter: MonitorSiteAdapter | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private queued = false;
  private generation = 0;
  private readonly player = new PlayerMonitor();
  private readonly chapters = new ChapterTracker();
  private taskId: string | null = null;
  private recoveryIssuedAt: number | null = null;
  private recoveryBaseline: number | null = null;
  private ownAction: SiteAction | null = null;
  private finalCheck = false;
  private lastMediaAt = Number.NEGATIVE_INFINITY;
  private nextDelay: number | null = null;
  private catalog: string[] | null = null;
  private readonly thresholdChecks = new Set<string>();
  private realChapterId: string | null = null;
  private practiceCompletedAt = Number.NEGATIVE_INFINITY;
  private data: MonitorView = {
    observation: null,
    chapters: [],
    nextPollAt: null,
    refreshAttempts: 0,
    reason: '请先检查并人工确认当前课程；真实站点待真实环境人工验收。',
  };

  constructor(private readonly options: Options) {}
  view(): MonitorView {
    return structuredClone(this.data);
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async attach(adapter: MonitorSiteAdapter): Promise<void> {
    this.halt();
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.adapter = adapter;
    this.realChapterId = null;
    this.data.observation = null;
    this.data.chapters = [];
    const generation = this.generation;
    const unsubscribe = await adapter.subscribe((event) => {
      if (generation !== this.generation) return;
      if (event.type === 'manual' && !this.options.engine.signal.aborted) {
        void this.options.engine.suspend('检测到用户手动关键操作，自动化已暂停；滚动不触发暂停。');
      } else if (
        event.type === 'navigation' &&
        !(this.ownAction?.type === 'refresh' && event.automated === true)
      ) {
        void this.options.engine.suspend(
          '页面导航或目标页面发生变化，请重新检查并确认课程。',
          true,
        );
      } else if (this.running()) {
        if (
          event.type === 'media' &&
          event.eventName === 'timeupdate' &&
          this.now() - this.lastMediaAt < this.options.config().pollIntervalMs
        )
          return;
        this.lastMediaAt = this.now();
        void this.tick();
      }
    });
    if (generation === this.generation) this.unsubscribe = unsubscribe;
    else unsubscribe();
  }

  async inspectCourse(signal?: AbortSignal) {
    if (!this.adapter) throw new Error('NO_ADAPTER');
    const observed = await this.adapter.observe(signal);
    signal?.throwIfAborted();
    this.data.observation = observed;
    if (!this.running()) {
      this.data.chapters = observed.chapters.map((chapter) => ({
        chapterId: chapter.chapterId,
        platformCompleted: chapter.platformCompleted,
        videoProgress:
          chapter.chapterId === observed.currentChapterId && observed.player
            ? observed.player.currentTime / observed.player.duration
            : null,
        verificationTriggered: false,
        status:
          chapter.platformCompleted === null
            ? 'unknown'
            : chapter.platformCompleted
              ? 'confirmed'
              : 'pending',
        retries: 0,
      }));
      this.data.reason =
        observed.course.source === 'zhihuishu-dom'
          ? '真实 DOM 只读预览；平台完成标记及锁止能力待真实环境人工验收。'
          : '课程只读预览；请核对并人工确认后开始监测。';
    }
    this.publish();
    return observed.course;
  }

  async start(resuming = false): Promise<Result> {
    const result = await (resuming ? this.options.engine.resume() : this.options.engine.start());
    if (!result.ok) return result;
    if (this.taskId !== this.options.engine.view().taskId) {
      this.taskId = this.options.engine.view().taskId;
      this.data.refreshAttempts = this.options.engine.refreshAttempts;
      this.catalog = null;
    }
    this.player.reset();
    this.chapters.reset();
    this.thresholdChecks.clear();
    this.recoveryIssuedAt = null;
    this.recoveryBaseline = null;
    this.finalCheck = false;
    this.realChapterId = null;
    await this.tick();
    return this.running()
      ? result
      : {
          ...result,
          ok: false,
          code: 'MONITOR_PAUSED',
          message: this.options.engine.view().reason,
        };
  }

  halt(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.data.nextPollAt = null;
    this.queued = false;
  }

  dispose(): void {
    this.halt();
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.adapter = null;
    this.data.observation = null;
    this.data.chapters = [];
    this.data.reason = '目标页面已解绑，请重新连接、检查并人工确认课程。';
  }

  private running(): boolean {
    return this.options.engine.view().state === 'MONITORING' && !this.options.engine.signal.aborted;
  }

  async tick(): Promise<void> {
    if (!this.running() || !this.adapter) return;
    if (this.busy) {
      this.queued = true;
      return;
    }
    this.busy = true;
    this.halt();
    this.nextDelay = null;
    const signal = this.options.engine.signal;
    const generation = this.generation;
    try {
      let observation = await abortable(this.adapter.observe(signal), signal);
      if (!this.live(signal, generation)) return;
      this.data.observation = observation;
      if (observation.popup === 'present') {
        if (!this.options.practice || !this.safe(observation)) {
          this.data.chapters = [];
          await this.options.engine.suspend(
            '发现页面弹窗，本阶段请您手动处理；处理后请重新检查并确认课程。',
            true,
          );
          return;
        }
        const remaining = Math.min(
          RECOVERY_COOLDOWN_MS,
          RECOVERY_COOLDOWN_MS - (this.now() - this.practiceCompletedAt),
        );
        if (remaining > 0) {
          const beforeCooldown = observation;
          await this.delay(remaining, signal);
          observation = await abortable(this.adapter.observe(signal), signal);
          if (!this.live(signal, generation)) return;
          if (
            !this.safe(observation) ||
            observation.popup !== 'present' ||
            observation.currentChapterId !== beforeCooldown.currentChapterId ||
            Math.abs(observation.player!.duration - beforeCooldown.player!.duration) > 0.2 ||
            observation.chapters.length !== beforeCooldown.chapters.length ||
            observation.chapters.some(
              (chapter, i) => chapter.chapterId !== beforeCooldown.chapters[i].chapterId,
            )
          ) {
            await this.options.engine.suspend('练习冷却后页面状态变化，请人工检查。', true);
            return;
          }
        }
        const beforePractice = observation;
        const result = await abortable(this.options.practice(observation, signal), signal);
        if (!result.ok) {
          if (this.live(signal, generation))
            await this.options.engine.suspend('练习未确认完成，停止连续监测；未知不重发。');
          return;
        }
        if (!this.live(signal, generation)) return;
        observation = await abortable(this.adapter.observe(signal), signal);
        if (!this.live(signal, generation)) return;
        if (
          !this.safe(observation) ||
          observation.popup !== 'none' ||
          observation.currentChapterId !== beforePractice.currentChapterId ||
          Math.abs(observation.player!.duration - beforePractice.player!.duration) > 0.2
        ) {
          await this.options.engine.suspend('练习后页面、章节或播放器未确认，停止连续监测。', true);
          return;
        }
        this.player.reset();
        this.practiceCompletedAt = this.now();
        this.data.observation = observation;
      }
      if (!this.safe(observation)) {
        this.data.chapters = [];
        await this.options.engine.suspend(
          '登录、课程、章节或页面状态不明，已暂停；请重新人工确认。',
          true,
        );
        return;
      }
      if (observation.course.source === 'zhihuishu-dom') {
        if (this.realChapterId && this.realChapterId !== observation.currentChapterId) {
          await this.options.engine.suspend('真实当前章节发生变化，请重新检查并人工确认。', true);
          return;
        }
        this.realChapterId = observation.currentChapterId;
      }
      const catalog = observation.chapters.map((chapter) => chapter.chapterId);
      if (
        this.catalog &&
        (catalog.length !== this.catalog.length ||
          catalog.some((id, index) => id !== this.catalog![index]))
      ) {
        this.data.chapters = [];
        await this.options.engine.suspend(
          '章节清单变化或不完整，禁止省略章节；请重新检查并确认课程。',
          true,
        );
        return;
      }
      this.catalog ??= catalog;
      if (
        observation.player!.currentTime / observation.player!.duration >= VERIFICATION_PROGRESS &&
        !this.thresholdChecks.has(observation.currentChapterId!)
      ) {
        this.thresholdChecks.add(observation.currentChapterId!);
        const extra = await abortable(this.adapter.observe(signal), signal);
        if (!this.live(signal, generation)) return;
        this.data.observation = extra;
        if (
          !this.safe(extra) ||
          extra.currentChapterId !== observation.currentChapterId ||
          extra.chapters.length !== catalog.length ||
          extra.chapters.some((c, i) => c.chapterId !== catalog[i])
        ) {
          await this.options.engine.suspend(
            '81% 额外核验发现课程或章节状态变化，请人工检查。',
            true,
          );
          return;
        }
        observation = extra;
        this.data.observation = extra;
      }
      const analysis = this.chapters.inspect(observation, this.now());
      this.data.chapters = analysis.chapters;
      this.publish();
      const saved = await this.options.engine.recordObservation(observation);
      if (!saved.ok || !this.live(signal, generation)) return;
      if (observation.popup !== 'none') {
        await this.options.engine.suspend('发现弹窗或页面性质不明，本阶段由用户手动处理。');
        return;
      }
      const chapterActions =
        observation.course.source === 'fixture' ||
        (observation.capabilities?.completionMarkers === true &&
          observation.capabilities.navigation === true);
      if (analysis.blocked && chapterActions) {
        await this.options.engine.suspend('平台标记与播放器信息未知或复核后冲突，禁止继续导航。');
        return;
      }
      if (analysis.waiting && chapterActions) {
        this.nextDelay = 3000;
        this.data.reason = '章节标记冲突：每 3 秒复核，最多额外 3 次。';
        return;
      }
      if (analysis.allCompleted && chapterActions) {
        // 全课程再读取一轮才结束；媒体事件不能替代最后一次平台核验。
        if (this.finalCheck)
          await this.options.engine.suspend(
            observation.course.source === 'fixture'
              ? '模拟课程各章平台标记已再次核验；真实站点待真实环境人工验收。'
              : '已再次核验当前课程各章平台标记；请人工核对结果。',
          );
        else {
          this.finalCheck = true;
          this.queued = true;
        }
        return;
      }
      this.finalCheck = false;
      if (analysis.nextChapterId && chapterActions) {
        const navigation = await this.execute(
          {
            type: 'navigate',
            chapterId: analysis.nextChapterId,
            fromChapterId: observation.currentChapterId!,
          },
          observation,
          signal,
        );
        if (
          navigation.ok &&
          observation.course.source === 'zhihuishu-dom' &&
          this.live(signal, generation)
        )
          this.realChapterId = analysis.nextChapterId;
        this.player.reset();
        this.recoveryIssuedAt = null;
        return;
      }
      const player = observation.player!;
      const decision = this.player.observe(player, this.now(), this.options.config());
      if (this.recoveryIssuedAt !== null) {
        if (
          !player.buffering &&
          !player.paused &&
          player.currentTime > (this.recoveryBaseline ?? -1)
        ) {
          this.recoveryIssuedAt = null;
          this.recoveryBaseline = null;
          this.player.reset();
          return;
        } else if (this.now() - this.recoveryIssuedAt >= RECOVERY_COOLDOWN_MS) {
          if (!observation.safeToRefresh || this.data.refreshAttempts >= 1 || player.paused) {
            await this.options.engine.suspend('播放恢复失败或不满足安全刷新条件，请手动检查。');
            return;
          }
          const result = await this.execute(
            { type: 'refresh', chapterId: player.chapterId },
            observation,
            signal,
          );
          if (result.code === 'RECOVERY_COOLDOWN') this.nextDelay = 100;
          else {
            this.recoveryIssuedAt = null;
            this.player.reset();
          }
          return;
        } else return;
      }
      if (decision !== 'none') {
        if (!this.permitted(observation, 'recover-play')) {
          await this.options.engine.suspend('真实平台恢复播放能力尚未核验，请人工处理。');
          return;
        }
        await this.execute(
          { type: 'recover-play', chapterId: player.chapterId },
          observation,
          signal,
        );
        return;
      }
      this.data.reason = chapterActions
        ? '正在核验平台标记与播放器；倍速由您在网站手动设置，播放进度不代表平台完成。'
        : '真实播放器监测中；倍速由您在网站手动设置，平台完成图标语义、刷新与自动切章待真实环境人工验收。';
    } catch {
      if (this.live(signal, generation))
        await this.options.engine.suspend('页面观察或反馈读取失败，已暂停；未知动作不重发。');
    } finally {
      this.busy = false;
      this.publish();
      if (this.running()) {
        // 合并媒体事件，避免 timeupdate 造成无限观察/重复写入。
        this.schedule(this.nextDelay ?? (this.queued ? 0 : this.options.config().pollIntervalMs));
      }
    }
  }

  private live(signal: AbortSignal, generation: number): boolean {
    return !signal.aborted && generation === this.generation && this.running();
  }
  private safe(o: SiteObservation): boolean {
    const fresh = (value: string) => {
      const age = Date.now() - Date.parse(value);
      return Number.isFinite(age) && age >= -5000 && age <= 30000;
    };
    return (
      ['fixture', 'zhihuishu-dom'].includes(o.course.source) &&
      o.course.source === this.options.engine.confirmedSource &&
      o.course.source === this.adapter?.kind &&
      o.course.confidence === 'verified' &&
      o.course.authenticated === true &&
      o.course.pageKind === 'course' &&
      o.course.courseId === this.options.engine.confirmedCourse &&
      fresh(o.course.observedAt) &&
      !!o.player &&
      o.player.confidence === 'verified' &&
      fresh(o.player.observedAt) &&
      o.player.chapterId === o.currentChapterId &&
      o.chapters.some((c) => c.chapterId === o.currentChapterId) &&
      o.chapters.every((c) => fresh(c.observedAt) && c.confidence === 'verified') &&
      Number.isFinite(o.player.currentTime) &&
      o.player.currentTime >= 0 &&
      Number.isFinite(o.player.duration) &&
      o.player.duration > 0 &&
      o.player.currentTime <= o.player.duration &&
      Number.isFinite(o.player.playbackRate) &&
      o.player.playbackRate > 0
    );
  }

  private permitted(observation: SiteObservation, type: SiteAction['type']): boolean {
    if (type === 'set-rate' || type === 'start-play') return false;
    if (observation.course.source === 'fixture') return true;
    const capabilities = observation.capabilities;
    if (!capabilities) return false;
    if (type === 'recover-play') return capabilities.recoverPlay === true;
    if (type === 'refresh') return capabilities.refresh === true && observation.safeToRefresh;
    return capabilities.navigation === true && capabilities.completionMarkers === true;
  }

  private async execute(
    action: SiteAction,
    before: SiteObservation,
    signal: AbortSignal,
  ): Promise<Result> {
    // Explicit startup has its own one-shot validation entry; ordinary monitor start/resume never plays.
    if (action.type === 'start-play')
      return {
        ok: false,
        code: 'EXPLICIT_PLAYBACK_START_REQUIRED',
        message: '启动播放需要独立明确意图；开始或继续监测不会自动播放。',
        correlationId: randomUUID(),
      };
    if (action.type === 'set-rate')
      return {
        ok: false,
        code: 'AUTOMATIC_RATE_DISABLED',
        message: '自动调速已取消，请在网站手动设置倍速。',
        correlationId: randomUUID(),
      };
    const adapter = this.adapter!;
    const generation = this.generation;
    const kind =
      action.type === 'navigate'
        ? 'chapter-navigation'
        : action.type === 'refresh'
          ? 'page-refresh'
          : 'recovery';
    this.ownAction = action;
    try {
      const result = await this.options.engine.execute({
        operationId: randomUUID(),
        kind,
        prepare: async (active) => {
          const latest = await adapter.observe(active);
          if (
            !this.live(active, generation) ||
            !this.safe(latest) ||
            !this.permitted(latest, action.type) ||
            latest.popup !== 'none' ||
            latest.currentChapterId !== before.currentChapterId
          )
            throw new Error('PAGE_CHANGED');
          if (
            action.type === 'navigate' &&
            (!latest.player?.ended ||
              latest.chapters.find((c) => c.chapterId === action.fromChapterId)
                ?.platformCompleted !== true)
          )
            throw new Error('CHAPTER_NOT_COMPLETE');
          if (action.type === 'refresh' && !latest.safeToRefresh) throw new Error('UNSAFE_REFRESH');
          await adapter.prepare?.(action, latest.course.courseId!, active);
        },
        issue: (active) => {
          if (action.type === 'refresh') this.data.refreshAttempts++;
          if (action.type === 'recover-play') {
            this.recoveryIssuedAt = this.now();
            this.recoveryBaseline = before.player!.currentTime;
          }
          return adapter.perform(action, before.course.courseId!, active);
        },
        verify: async (active) => {
          const after = await adapter.observe(active);
          if (!this.live(active, generation) || !this.safe(after) || after.popup !== 'none')
            return 'unknown';
          if (action.type === 'navigate')
            return after.currentChapterId === action.chapterId &&
              after.player!.ended === false &&
              after.chapters.find((c) => c.chapterId === action.fromChapterId)
                ?.platformCompleted === true
              ? 'confirmed'
              : 'unknown';
          if (after.currentChapterId !== action.chapterId) return 'unknown';
          if (action.type === 'recover-play')
            return after.player!.paused === false ? 'confirmed' : 'failed';
          const baseline = after.player!.currentTime;
          // 刷新可能重新加载到 0；从刷新后的基线验证时间推进，最多等待 3 秒。
          for (let attempt = 0; attempt < 6; attempt++) {
            await this.delay(500, active);
            const later = await adapter.observe(active);
            if (
              !this.safe(later) ||
              later.currentChapterId !== action.chapterId ||
              later.popup !== 'none'
            )
              return 'unknown';
            if (
              !later.player!.buffering &&
              !later.player!.paused &&
              (later.player!.currentTime > baseline || later.player!.ended)
            )
              return 'confirmed';
          }
          return 'failed';
        },
      });
      if (result.ok) this.queued = true;
      else if (
        !['RECOVERY_COOLDOWN', 'CANCELLED', 'TASK_NOT_RUNNING'].includes(result.code) &&
        this.running()
      ) {
        await this.options.engine.suspend(result.message);
      }
      if (action.type === 'refresh' && result.ok)
        this.data.reason = '已用唯一安全刷新次数，并复核恢复反馈。';
      return result;
    } finally {
      this.ownAction = null;
      signal.throwIfAborted();
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('CANCELLED'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private schedule(delay: number): void {
    if (this.options.polling === false) return;
    this.data.nextPollAt = this.now() + delay;
    this.queued = false;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }
  private publish(): void {
    try {
      this.options.onObservation?.(this.view());
    } catch {
      /* UI观察不可越过引擎 */
    }
  }
}
