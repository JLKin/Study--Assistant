import { randomUUID } from 'node:crypto';
import {
  isZhihuishuStudyUrl,
  RestrictedZhihuishuSiteAdapter,
  ZhihuishuMonitorSiteAdapter,
} from './zhihuishu';
import type { ZhihuishuIdentityEvidence } from './zhihuishu-evidence';
import type { Disposable, Page } from 'playwright';
import type { CourseObservation } from '../../contracts/src/index';
import type {
  MonitorSiteAdapter,
  SiteAction,
  SiteObservation,
  SiteSignal,
} from '../../contracts/src/monitor';

interface FixtureChapter {
  chapterId: string;
  title: string;
  platformCompleted: boolean | null;
}
interface FixturePlayer {
  chapterId: string;
  currentTime: number;
  duration: number;
  playbackRate: number;
  paused: boolean;
  buffering: boolean;
  ended: boolean;
}
interface FixtureData {
  schemaVersion: 2;
  courseId: string;
  title: string;
  authenticated: boolean;
  pageKind: 'course' | 'graded' | 'unknown';
  platformCompleted: boolean | null;
  chapters: FixtureChapter[];
  currentChapterId: string;
  player: FixturePlayer | null;
  supportedRates: number[];
  popup: 'none' | 'present' | 'unknown';
  safeToRefresh: boolean;
}

const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const title = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const completion = (value: unknown): value is boolean | null =>
  value === null || typeof value === 'boolean';
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function isStage2FixtureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      !url.username &&
      !url.password &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.pathname === '/stage2-fixture'
    );
  } catch {
    return false;
  }
}

function validData(value: unknown): value is FixtureData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (
    data.schemaVersion !== 2 ||
    !id(data.courseId) ||
    !title(data.title) ||
    typeof data.authenticated !== 'boolean' ||
    !['course', 'graded', 'unknown'].includes(String(data.pageKind)) ||
    !completion(data.platformCompleted) ||
    !id(data.currentChapterId) ||
    !Array.isArray(data.chapters) ||
    data.chapters.length < 1 ||
    data.chapters.length > 1000 ||
    !Array.isArray(data.supportedRates) ||
    data.supportedRates.length < 1 ||
    data.supportedRates.length > 16 ||
    !data.supportedRates.every((rate) => finite(rate) && rate > 0 && rate <= 16) ||
    new Set(data.supportedRates).size !== data.supportedRates.length ||
    !['none', 'present', 'unknown'].includes(String(data.popup)) ||
    typeof data.safeToRefresh !== 'boolean'
  )
    return false;
  const chapters = data.chapters as Array<Record<string, unknown>>;
  if (
    !chapters.every(
      (chapter) =>
        chapter &&
        typeof chapter === 'object' &&
        id(chapter.chapterId) &&
        title(chapter.title) &&
        completion(chapter.platformCompleted),
    ) ||
    new Set(chapters.map((chapter) => chapter.chapterId)).size !== chapters.length ||
    !chapters.some((chapter) => chapter.chapterId === data.currentChapterId)
  )
    return false;
  if (data.player === null) return true;
  if (!data.player || typeof data.player !== 'object') return false;
  const player = data.player as Record<string, unknown>;
  return (
    player.chapterId === data.currentChapterId &&
    finite(player.currentTime) &&
    player.currentTime >= 0 &&
    finite(player.duration) &&
    player.duration > 0 &&
    player.currentTime <= player.duration + 0.1 &&
    finite(player.playbackRate) &&
    player.playbackRate > 0 &&
    player.playbackRate <= 16 &&
    typeof player.paused === 'boolean' &&
    typeof player.buffering === 'boolean' &&
    typeof player.ended === 'boolean'
  );
}

function unknown(kind: MonitorSiteAdapter['kind'], evidence: string): SiteObservation {
  return {
    course: {
      courseId: null,
      title: null,
      observedAt: new Date().toISOString(),
      confidence: 'uncertain',
      source: kind,
      authenticated: 'unknown',
      pageKind: 'unknown',
      platformCompleted: null,
      evidence: [evidence],
    },
    player: null,
    chapters: [],
    currentChapterId: null,
    supportedRates: [],
    popup: 'unknown',
    safeToRefresh: false,
  };
}

function cancelRead<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new Error('观察已取消'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

function rejectAutomaticRate(action: SiteAction, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (action?.type === 'set-rate') throw new Error('自动倍速调整已移除，请在网站手动设置倍速。');
}

/** 真实站点的选择器、媒体及完成标记均待真实环境人工验收。 */
export class UnverifiedMonitorSiteAdapter implements MonitorSiteAdapter {
  readonly kind = 'real-unverified' as const;
  async observe(signal?: AbortSignal): Promise<SiteObservation> {
    signal?.throwIfAborted();
    return unknown(this.kind, '待真实环境人工验收；不推断真实网站 DOM、登录和完成状态。');
  }
  async inspect(signal?: AbortSignal): Promise<CourseObservation> {
    return (await this.observe(signal)).course;
  }
  async subscribe(_listener: (event: SiteSignal) => void): Promise<() => void> {
    return () => undefined;
  }
  async perform(_action: SiteAction, _courseId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    throw new Error('真实站点适配器待真实环境人工验收，已拒绝网页动作。');
  }
}

/** 选择器和动作仅属于仓库的本机 fixture，不代表真实平台支持。 */
export class FixtureMonitorSiteAdapter implements MonitorSiteAdapter {
  readonly kind = 'fixture' as const;
  private readonly permits = new Map<string, AbortSignal>();
  private readonly authorizationBinding = `stage2Authorize_${randomUUID().replaceAll('-', '')}`;
  private authorizationReady?: Promise<Disposable>;
  private authorizationDisposing?: Promise<void>;
  private authorizationReleaseRequested = false;
  private refreshPermit?: { token: string; url: string; signal: AbortSignal; authorized: boolean };
  constructor(private readonly page: Page) {}

  private releaseAuthorization(): void {
    if (this.permits.size || !this.authorizationReady) return;
    const resource = this.authorizationReady;
    this.authorizationReady = undefined;
    this.authorizationDisposing = resource
      .then((binding) => binding.dispose())
      .catch(() => undefined);
  }

  private async read(signal?: AbortSignal): Promise<FixtureData | null> {
    signal?.throwIfAborted();
    const url = this.page.url();
    if (!isStage2FixtureUrl(url)) return null;
    try {
      const raw = await cancelRead(
        this.page
          .locator('script#stage2-observation[type="application/json"]')
          .textContent({ timeout: 1000 }),
        signal,
      );
      signal?.throwIfAborted();
      if (this.page.url() !== url) return null;
      const value: unknown = JSON.parse(raw ?? 'null');
      return validData(value) ? value : null;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }

  async inspect(signal?: AbortSignal): Promise<CourseObservation> {
    return (await this.observe(signal)).course;
  }

  async observe(signal?: AbortSignal): Promise<SiteObservation> {
    const data = await this.read(signal);
    if (!data) return unknown(this.kind, '本机阶段 2 fixture 契约无效或读取期间页面变化。');
    const observedAt = new Date().toISOString();
    const isCourse = data.pageKind === 'course';
    return {
      course: {
        courseId: isCourse ? data.courseId : null,
        title: isCourse ? data.title : null,
        observedAt,
        confidence: 'verified',
        source: this.kind,
        authenticated: data.authenticated,
        pageKind: data.pageKind,
        platformCompleted: isCourse ? data.platformCompleted : null,
        evidence: ['仅本机 stage2-observation 契约 v2；待真实环境人工验收。'],
      },
      player:
        isCourse && data.player ? { ...data.player, observedAt, confidence: 'verified' } : null,
      chapters: isCourse
        ? data.chapters.map((chapter) => ({ ...chapter, observedAt, confidence: 'verified' }))
        : [],
      currentChapterId: isCourse ? data.currentChapterId : null,
      supportedRates: isCourse ? [...data.supportedRates] : [],
      popup: data.popup,
      safeToRefresh: isCourse && data.authenticated && data.safeToRefresh && data.popup === 'none',
      capabilities: {
        playbackRate: false,
        recoverPlay: isCourse && data.authenticated && data.popup === 'none',
        refresh: isCourse && data.authenticated && data.safeToRefresh && data.popup === 'none',
        navigation: isCourse && data.authenticated && data.popup === 'none',
        completionMarkers: isCourse,
      },
    };
  }

  async subscribe(listener: (event: SiteSignal) => void): Promise<() => void> {
    if (!isStage2FixtureUrl(this.page.url())) return () => undefined;
    this.authorizationReleaseRequested = false;
    const binding = `stage2Signal_${randomUUID().replaceAll('-', '')}`;
    let active = true;
    const exposed = await this.page.exposeBinding(binding, (source, event: SiteSignal) => {
      if (
        active &&
        source.page === this.page &&
        source.frame === this.page.mainFrame() &&
        isStage2FixtureUrl(this.page.url()) &&
        event &&
        ['media', 'manual', 'navigation'].includes(event.type) &&
        (event.action === undefined ||
          ['play', 'pause', 'chapter', 'popup', 'rate', 'seek'].includes(event.action))
      )
        listener(event);
    });
    const install = async () => {
      if (!active || !isStage2FixtureUrl(this.page.url())) return;
      await this.page.evaluate((name) => {
        const scope = window as unknown as Record<string, unknown>;
        const send = (event: SiteSignal) => {
          const callback = scope[name] as ((event: SiteSignal) => Promise<void>) | undefined;
          void callback?.(event).catch(() => undefined);
        };
        const video = document.querySelector('video#stage2-video');
        const media = (event: Event) => send({ type: 'media', eventName: event.type });
        const mediaEvents = [
          'play',
          'pause',
          'waiting',
          'playing',
          'timeupdate',
          'ratechange',
          'ended',
          'seeking',
        ];
        mediaEvents.forEach((type) => video?.addEventListener(type, media));
        const manual = (event: Event) => {
          if (!event.isTrusted || !(event.target instanceof Element)) return;
          const control = event.target.closest('[data-stage2-action], video#stage2-video');
          if (!control) return;
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
          const action = control.getAttribute('data-stage2-action');
          send({ type: 'manual', ...(action ? { action: action as SiteSignal['action'] } : {}) });
        };
        document.addEventListener('pointerdown', manual, true);
        document.addEventListener('keydown', manual, true);
        scope[`${name}_cleanup`] = () => {
          mediaEvents.forEach((type) => video?.removeEventListener(type, media));
          document.removeEventListener('pointerdown', manual, true);
          document.removeEventListener('keydown', manual, true);
        };
      }, binding);
    };
    const navigated = (frame: ReturnType<Page['mainFrame']>) => {
      if (!active || frame !== this.page.mainFrame()) return;
      const permit = this.refreshPermit;
      const automated = Boolean(
        permit?.authorized && !permit.signal.aborted && frame.url() === permit.url,
      );
      this.refreshPermit = undefined;
      listener({ type: 'navigation', automated });
    };
    const loaded = () => void install().catch(() => undefined);
    const closed = () => {
      if (active) listener({ type: 'navigation', eventName: 'close', automated: false });
    };
    const opened = () => {
      if (active) listener({ type: 'navigation', eventName: 'new-page', automated: false });
    };
    this.page.on('framenavigated', navigated);
    this.page.on('domcontentloaded', loaded);
    this.page.on('close', closed);
    this.page.context().on('page', opened);
    await install();
    return () => {
      if (!active) return;
      active = false;
      this.authorizationReleaseRequested = true;
      this.releaseAuthorization();
      this.page.off('framenavigated', navigated);
      this.page.off('domcontentloaded', loaded);
      this.page.off('close', closed);
      this.page.context().off('page', opened);
      void exposed.dispose().catch(() => undefined);
      void this.page
        .evaluate((name) => {
          const scope = window as unknown as Record<string, unknown>;
          (scope[`${name}_cleanup`] as (() => void) | undefined)?.();
          delete scope[`${name}_cleanup`];
        }, binding)
        .catch(() => undefined);
    };
  }

  async prepare(action: SiteAction, _courseId: string, signal: AbortSignal): Promise<void> {
    rejectAutomaticRate(action, signal);
  }

  async perform(action: SiteAction, courseId: string, signal: AbortSignal): Promise<void> {
    rejectAutomaticRate(action, signal);
    if (
      !action ||
      !['recover-play', 'refresh', 'navigate'].includes(action.type) ||
      !id(courseId) ||
      !id(action.chapterId) ||
      (action.type === 'navigate' &&
        (!id(action.fromChapterId) || action.chapterId === action.fromChapterId))
    )
      throw new Error('网页动作契约无效，已拒绝执行。');
    const data = await this.read(signal);
    if (
      !data ||
      data.courseId !== courseId ||
      data.pageKind !== 'course' ||
      !data.authenticated ||
      data.popup !== 'none' ||
      !data.player ||
      (action.type === 'navigate'
        ? data.currentChapterId !== action.fromChapterId ||
          !data.player.ended ||
          !data.chapters.some(
            (chapter) =>
              chapter.chapterId === action.fromChapterId && chapter.platformCompleted === true,
          ) ||
          !data.chapters.some(
            (chapter) =>
              chapter.chapterId === action.chapterId && chapter.platformCompleted !== null,
          )
        : data.currentChapterId !== action.chapterId) ||
      (action.type === 'refresh' && (!data.safeToRefresh || data.player.paused))
    )
      throw new Error('网页动作保护条件不满足，已拒绝执行。');
    const url = this.page.url();
    const token = randomUUID();
    await this.authorizationDisposing;
    this.authorizationReady ??= this.page.exposeBinding(
      this.authorizationBinding,
      (source, key: string) => {
        const allowed =
          source.page === this.page &&
          source.frame === this.page.mainFrame() &&
          this.permits.has(key) &&
          !this.permits.get(key)!.aborted;
        if (allowed && this.refreshPermit?.token === key) this.refreshPermit.authorized = true;
        return allowed;
      },
    );
    await this.authorizationReady;
    signal.throwIfAborted();
    this.permits.set(token, signal);
    const cancel = () => {
      if (this.refreshPermit?.token === token) this.refreshPermit = undefined;
      void this.page
        .evaluate((key) => {
          const scope = window as unknown as { stage2ActionTokens?: Record<string, boolean> };
          if (scope.stage2ActionTokens) delete scope.stage2ActionTokens[key];
        }, token)
        .catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await this.page.evaluate((key) => {
        const scope = window as unknown as { stage2ActionTokens?: Record<string, boolean> };
        scope.stage2ActionTokens ??= {};
        scope.stage2ActionTokens[key] = true;
      }, token);
      signal.throwIfAborted();
      const refreshNavigation =
        action.type === 'refresh'
          ? this.page
              .waitForEvent('framenavigated', {
                predicate: (frame) => frame === this.page.mainFrame(),
                timeout: 3000,
              })
              .catch(() => undefined)
          : undefined;
      if (action.type === 'refresh') this.refreshPermit = { token, url, signal, authorized: false };
      await this.page.evaluate(
        async ({ key, authorize, expectedUrl, expectedCourse, expectedChapter, requested }) => {
          const scope = window as unknown as {
            [key: string]: unknown;
            stage2ActionTokens?: Record<string, boolean>;
            stage2Fixture?: { perform: (action: SiteAction) => Promise<void> };
          };
          // 最后一轮 Node 授权直接读取 AbortSignal，避免取消桥排队时沿用旧授权。
          const allowed = await (scope[authorize] as (key: string) => Promise<boolean>)(key);
          const currentUrl = new URL(location.href);
          const element = document.querySelector(
            'script#stage2-observation[type="application/json"]',
          );
          const current = JSON.parse(element?.textContent ?? 'null') as FixtureData | null;
          // 最后检查与网页动作在同一 JS 任务；取消桥会使尚未执行的令牌失效。
          if (
            location.href !== expectedUrl ||
            currentUrl.protocol !== 'http:' ||
            !['127.0.0.1', 'localhost', '[::1]'].includes(currentUrl.hostname) ||
            currentUrl.username ||
            currentUrl.password ||
            currentUrl.pathname !== '/stage2-fixture' ||
            !allowed ||
            !scope.stage2ActionTokens?.[key] ||
            !current ||
            current.schemaVersion !== 2 ||
            current.courseId !== expectedCourse ||
            current.currentChapterId !== expectedChapter ||
            current.pageKind !== 'course' ||
            current.authenticated !== true ||
            current.popup !== 'none' ||
            !current.player ||
            current.player.chapterId !== expectedChapter ||
            (requested.type === 'refresh' &&
              (current.safeToRefresh !== true || current.player.paused !== false)) ||
            (requested.type === 'navigate' &&
              (current.player.ended !== true ||
                requested.chapterId === expectedChapter ||
                !current.chapters.some(
                  (chapter) =>
                    chapter.chapterId === expectedChapter && chapter.platformCompleted === true,
                ) ||
                !current.chapters.some(
                  (chapter) =>
                    chapter.chapterId === requested.chapterId &&
                    typeof chapter.platformCompleted === 'boolean',
                ))) ||
            !scope.stage2Fixture
          )
            throw new Error('动作前网页或取消令牌发生变化，已拒绝执行。');
          scope.stage2ActionTokens[key] = false;
          await scope.stage2Fixture.perform(requested);
        },
        {
          key: token,
          authorize: this.authorizationBinding,
          expectedUrl: url,
          expectedCourse: courseId,
          expectedChapter: data.currentChapterId,
          requested: action,
        },
      );
      if (refreshNavigation) {
        await cancelRead(refreshNavigation, signal);
        await cancelRead(this.page.waitForLoadState('domcontentloaded', { timeout: 3000 }), signal);
      }
    } finally {
      this.permits.delete(token);
      if (this.authorizationReleaseRequested) this.releaseAuthorization();
      signal.removeEventListener('abort', cancel);
      cancel();
    }
  }
}

export type MonitorAdapterMode = 'restricted' | 'read-only-preview';

/** 显式检查只采样一次；没有页面监听、轮询、动作许可或重新读取。 */
export class ZhihuishuReadOnlyPreviewSiteAdapter implements MonitorSiteAdapter {
  readonly kind = 'zhihuishu-dom' as const;
  private readonly reader: ZhihuishuMonitorSiteAdapter;
  private readonly url: string;
  private snapshot?: Promise<SiteObservation>;
  private invalidated = false;

  constructor(
    private readonly page: Page,
    /** 仅内部离线测试可提供合成证据；显式检查工厂不接收UI/配置中的证据。 */
    identityEvidence?: readonly ZhihuishuIdentityEvidence[],
  ) {
    this.url = page.url();
    this.reader = new ZhihuishuMonitorSiteAdapter(page, identityEvidence);
  }

  private locked(observed: SiteObservation): SiteObservation {
    const safe =
      observed.course.confidence === 'verified' &&
      observed.course.authenticated === true &&
      observed.course.pageKind === 'course' &&
      observed.popup === 'none';
    const value = safe
      ? observed
      : unknown(this.kind, '只读检查发现弹窗、课程身份或媒体状态不明；请手动核对网站。');
    return {
      ...value,
      course: {
        ...value.course,
        evidence: [
          'READ_ONLY_PREVIEW：本次显式检查仅保留一次只读采样；不是实时监测，所有网页动作保持锁止，待真实环境人工验收。',
          ...value.course.evidence,
        ],
      },
      supportedRates: [],
      safeToRefresh: false,
      capabilities: {
        playbackRate: false,
        recoverPlay: false,
        refresh: false,
        navigation: false,
        completionMarkers: false,
      },
    };
  }

  async observe(signal?: AbortSignal): Promise<SiteObservation> {
    signal?.throwIfAborted();
    if (this.page.isClosed() || this.page.url() !== this.url) this.invalidated = true;
    if (this.invalidated)
      return this.locked(unknown(this.kind, '页面已变化；旧采样已停用，请重新显式检查。'));
    // 缓存失败或取消结果同样不重试；只有用户再次显式检查才能创建新的实例。
    this.snapshot ??= this.reader.observe(signal).then((value) => this.locked(value));
    const observed = await cancelRead(this.snapshot, signal);
    signal?.throwIfAborted();
    return structuredClone(observed);
  }

  async inspect(signal?: AbortSignal): Promise<CourseObservation> {
    return (await this.observe(signal)).course;
  }

  async subscribe(_listener: (event: SiteSignal) => void): Promise<() => void> {
    return () => undefined;
  }

  async prepare(_action: SiteAction, _courseId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    throw new Error('READ_ONLY_PREVIEW');
  }

  async perform(_action: SiteAction, _courseId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    throw new Error('READ_ONLY_PREVIEW');
  }
}

export function monitorAdapterForPage(
  page?: Page,
  mode: MonitorAdapterMode = 'restricted',
): MonitorSiteAdapter {
  if (page && isStage2FixtureUrl(page.url())) return new FixtureMonitorSiteAdapter(page);
  if (page && isZhihuishuStudyUrl(page.url()))
    return mode === 'read-only-preview'
      ? new ZhihuishuReadOnlyPreviewSiteAdapter(page)
      : new RestrictedZhihuishuSiteAdapter();
  return new UnverifiedMonitorSiteAdapter();
}
