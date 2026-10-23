import { createHash, randomUUID } from 'node:crypto';
import type { Disposable, ElementHandle, Page } from 'playwright';
import type { CourseObservation } from '../../contracts/src/index';
import type {
  MonitorSiteAdapter,
  SiteAction,
  SiteObservation,
  SiteSignal,
} from '../../contracts/src/monitor';
import {
  readZhihuishuDom,
  type ZhihuishuDomAction,
  type ZhihuishuDomSample,
} from './zhihuishu-dom';
import { ZHIHUISHU_IDENTITY_EVIDENCE, type ZhihuishuIdentityEvidence } from './zhihuishu-evidence';

/** 仅此已现场取证的课程路由；未知路径不能产生真实适配器。 */
export function isZhihuishuStudyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://studyvideoh5.zhihuishu.com' &&
      !url.username &&
      !url.password &&
      url.pathname === '/stuStudy' &&
      !url.hash &&
      [...url.searchParams.keys()].length === 1 &&
      url.searchParams.getAll('recruitAndCourseId').length === 1 &&
      /^[A-Za-z0-9_+/=.-]{8,256}$/.test(url.searchParams.get('recruitAndCourseId') ?? '')
    );
  } catch {
    return false;
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const zhihuishuCourseId = (route: string) =>
  `zhs_c_${digest(['https://studyvideoh5.zhihuishu.com', 'stuStudy-v1', route])}`;
export const zhihuishuCatalogueKey = (data: ZhihuishuDomSample) =>
  digest([data.title, data.catalogue]);
export const zhihuishuChapterId = (courseId: string, catalogue: string, ordinal: string) =>
  `zhs_v1_${digest([courseId, catalogue, ordinal])}`;

function uncertain(evidence: string): SiteObservation {
  return {
    course: {
      courseId: null,
      title: null,
      observedAt: new Date().toISOString(),
      confidence: 'uncertain',
      source: 'zhihuishu-dom',
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
    capabilities: {
      playbackRate: false,
      recoverPlay: false,
      refresh: false,
      navigation: false,
      completionMarkers: false,
    },
  };
}

/** 真实人工验收已报告平台检测脚本；生产入口停用，不继续注入监听、读取DOM或动作。 */
export class RestrictedZhihuishuSiteAdapter implements MonitorSiteAdapter {
  readonly kind = 'zhihuishu-dom' as const;
  async observe(signal?: AbortSignal): Promise<SiteObservation> {
    signal?.throwIfAborted();
    return uncertain(
      'SITE_AUTOMATION_RESTRICTED：取消自动调速后，用户截图确认平台仍提示异常脚本；真实适配已锁止，待确认平台允许的接入方式。',
    );
  }
  async inspect(signal?: AbortSignal): Promise<CourseObservation> {
    return (await this.observe(signal)).course;
  }
  async subscribe(_listener: (event: SiteSignal) => void): Promise<() => void> {
    return () => undefined;
  }
  async prepare(_action: SiteAction, _courseId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    throw new Error('SITE_AUTOMATION_RESTRICTED');
  }
  async perform(_action: SiteAction, _courseId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    throw new Error('SITE_AUTOMATION_RESTRICTED');
  }
}

/** 内部瞬时动作许可；不写入 schema 1，也不从持久化状态恢复。 */
export interface ZhihuishuActionPermissions {
  /** 内部单次验收显式授予；不由 UI、配置或持久化状态自动恢复。 */
  startPlay?: boolean;
  /** 内部连续人工输入保护；缺失、失效或 blocked 时不能启动播放。 */
  criticalInputGuard?: string;
  /** 连续会话的外层人工守卫；与本次子守卫注册关系一并在最终DOM检查。 */
  continuousInputGuard?: string;
  /** 内部单次播放锁定的节点对象；不读取或持久化媒体地址。 */
  expectedMedia?: ElementHandle<HTMLVideoElement>;
  /** 内部一次播放期间的 load/metadata 换代保护。 */
  mediaLifecycleGuard?: string;
}

/** 候选实现；生产工厂不授予真实自动动作。自动倍速和刷新始终拒绝。 */
export class ZhihuishuMonitorSiteAdapter implements MonitorSiteAdapter {
  readonly kind = 'zhihuishu-dom' as const;
  private baseline: { courseId: string; catalogue: string } | null = null;
  private invalidated = false;
  private waiting = false;
  private readonly startPlayAllowed: boolean;
  private readonly criticalInputGuard: string | undefined;
  private readonly continuousInputGuard: string | undefined;
  private readonly expectedMedia: ElementHandle<HTMLVideoElement> | undefined;
  private readonly mediaLifecycleGuard: string | undefined;
  private readonly invalidation = new AbortController();
  private readonly listeners = new Set<(event: SiteSignal) => void>();
  constructor(
    private readonly page: Page,
    /** 内部派生 DOM 测试可注入合成证据；生产工厂始终使用现场核验清单，不来自UI/配置。 */
    private readonly identityEvidence: readonly ZhihuishuIdentityEvidence[] = ZHIHUISHU_IDENTITY_EVIDENCE,
    permissions: Readonly<ZhihuishuActionPermissions> = {},
  ) {
    this.startPlayAllowed = permissions.startPlay === true;
    this.criticalInputGuard = permissions.criticalInputGuard;
    this.continuousInputGuard = permissions.continuousInputGuard;
    this.expectedMedia = permissions.expectedMedia;
    this.mediaLifecycleGuard = permissions.mediaLifecycleGuard;
  }

  private invalidate(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    this.invalidation.abort(new Error('真实页面已变化或出现原生对话框，必须重新人工确认。'));
    for (const listener of this.listeners) listener({ type: 'navigation', automated: false });
  }

  /** evaluate 没有原生 timeout；对话框、取消、失效均必须使 Node 等待立即结束。 */
  private async bounded<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    this.invalidation.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        this.invalidation.signal.removeEventListener('abort', invalidated);
        this.page.off('dialog', dialog);
        if (error) reject(error);
        else resolve(value as T);
      };
      const aborted = () => finish(signal?.reason ?? new Error('动作已取消。'));
      const invalidated = () => finish(this.invalidation.signal.reason);
      const dialog = () => this.invalidate();
      const timer = setTimeout(() => {
        this.invalidate();
        finish(new Error('真实页面读取或动作超时，已停用本次适配。'));
      }, 3000);
      signal?.addEventListener('abort', aborted, { once: true });
      this.invalidation.signal.addEventListener('abort', invalidated, { once: true });
      this.page.on('dialog', dialog);
      // 即使先取消，仍观察迟到的 rejection，避免未处理 Promise。
      work.then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });
  }

  private evidence(data: ZhihuishuDomSample): ZhihuishuIdentityEvidence | undefined {
    return this.identityEvidence.find(
      (entry) =>
        entry.courseId === zhihuishuCourseId(data.route) &&
        entry.catalogue === zhihuishuCatalogueKey(data),
    );
  }

  private completionVerified(data: ZhihuishuDomSample): boolean {
    return (
      this.evidence(data)?.completionMarkers === 'finish-half-v1' &&
      data.completion.length === data.catalogue.length &&
      data.completion.every(
        (row, index) =>
          row.ordinal === data.catalogue[index].ordinal && typeof row.completed === 'boolean',
      )
    );
  }

  private async disposeBinding(binding: Disposable): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      void binding
        .dispose()
        .catch(() => undefined)
        .then(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  }

  private async read(signal?: AbortSignal): Promise<ZhihuishuDomSample | null> {
    signal?.throwIfAborted();
    if (this.invalidated || this.page.isClosed() || !isZhihuishuStudyUrl(this.page.url()))
      return null;
    const url = this.page.url();
    try {
      const data = await this.bounded(this.page.evaluate(readZhihuishuDom, undefined), signal);
      signal?.throwIfAborted();
      if (!data || this.page.url() !== url || this.invalidated) return null;
      const identity = {
        courseId: zhihuishuCourseId(data.route),
        catalogue: zhihuishuCatalogueKey(data),
      };
      if (
        this.baseline &&
        (identity.courseId !== this.baseline.courseId ||
          identity.catalogue !== this.baseline.catalogue)
      ) {
        this.invalidate();
        return null;
      }
      if (!this.evidence(data)) return null;
      this.baseline ??= identity;
      return data;
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
    if (!data)
      return uncertain('真实课程不在本轮已核验路由/目录证据内，或媒体不一致；待真实环境人工验收。');
    const observedAt = new Date().toISOString();
    const courseId = zhihuishuCourseId(data.route);
    const key = zhihuishuCatalogueKey(data);
    const chapter = (ordinal: string) => zhihuishuChapterId(courseId, key, ordinal);
    const complete = this.completionVerified(data);
    const safe = data.authenticated === true && !data.graded && data.popup === 'none';
    return {
      course: {
        courseId,
        title: data.title,
        observedAt,
        confidence: data.authenticated === true && !data.graded ? 'verified' : 'uncertain',
        source: this.kind,
        authenticated: data.authenticated,
        pageKind: data.graded ? 'graded' : 'course',
        platformCompleted: complete ? data.completion.every((row) => row.completed === true) : null,
        evidence: [
          '实测 stuStudy DOM v1；课程/章节为路由与目录指纹的适配层标识，不是后端 ID。',
          `当前平台目录编号：${data.currentOrdinal}；共 ${data.catalogue.length} 个视频。`,
          complete
            ? '本轮人工核验 finish/half 完成标记；动作反馈仍须真实环境人工验收。'
            : '完成标记缺失或尚无语义证据，导航保持关闭。',
          '倍速由用户手动设置；自动刷新始终关闭。',
        ],
      },
      player: {
        ...data.player,
        buffering:
          !data.player.paused && !data.player.ended && (data.player.buffering || this.waiting),
        chapterId: chapter(data.currentOrdinal),
        observedAt,
        confidence: 'verified',
      },
      chapters: data.catalogue.map((row, index) => ({
        chapterId: chapter(row.ordinal),
        title: `${row.ordinal} ${row.title}`,
        platformCompleted: complete ? data.completion[index].completed : null,
        observedAt,
        confidence: 'verified',
      })),
      currentChapterId: chapter(data.currentOrdinal),
      supportedRates: [],
      popup: data.popup,
      safeToRefresh: false,
      capabilities: {
        playbackRate: false,
        startPlay: safe && this.startPlayAllowed,
        recoverPlay: safe,
        refresh: false,
        navigation: safe && complete,
        completionMarkers: safe && complete,
      },
    };
  }

  async subscribe(listener: (event: SiteSignal) => void): Promise<() => void> {
    if (this.invalidated) throw new Error('真实页面适配已失效。');
    const name = `zhsSignal_${randomUUID().replaceAll('-', '')}`;
    let active = true;
    this.listeners.add(listener);
    let exposed: Disposable | undefined;
    const changed = () => {
      if (active) this.invalidate();
    };
    const navigation = (frame: ReturnType<Page['mainFrame']>) => {
      if (frame === this.page.mainFrame()) changed();
    };
    this.page.on('framenavigated', navigation);
    this.page.on('close', changed);
    // 只观察原生对话框出现，不 accept/dismiss，也不读取其文字。
    this.page.on('dialog', changed);
    this.page.context().on('page', changed);
    const detach = () => {
      this.listeners.delete(listener);
      this.page.off('framenavigated', navigation);
      this.page.off('close', changed);
      this.page.off('dialog', changed);
      this.page.context().off('page', changed);
      void exposed?.dispose().catch(() => undefined);
      void this.page
        .evaluate((binding) => {
          const scope = window as unknown as Record<string, unknown>;
          (scope[`${binding}_cleanup`] as (() => void) | undefined)?.();
          delete scope[`${binding}_cleanup`];
        }, name)
        .catch(() => undefined);
    };
    try {
      const bindingWork = this.page.exposeBinding(
        name,
        (source, event: SiteSignal | { type: 'install' }) => {
          if (
            !active ||
            this.invalidated ||
            source.page !== this.page ||
            source.frame !== this.page.mainFrame() ||
            !event
          )
            return false;
          if (event.type === 'install') return true;
          if (!['media', 'manual'].includes(event.type)) return false;
          if (event.type === 'media') {
            if (event.eventName === 'waiting') this.waiting = true;
            if (['media-replaced', 'playing', 'pause', 'ended'].includes(event.eventName ?? ''))
              this.waiting = false;
            listener({ type: 'media', eventName: event.eventName });
          } else listener({ type: 'manual' });
        },
      );
      // 迟到的 binding 在取消/超时后同样清理。
      void bindingWork.then(
        (resource) => {
          if (!active) void resource.dispose().catch(() => undefined);
        },
        () => undefined,
      );
      exposed = await this.bounded(bindingWork);
      await this.bounded(
        this.page.evaluate(async (binding) => {
          const scope = window as unknown as Record<string, unknown>;
          const authorize = scope[binding] as
            ((event: { type: 'install' }) => Promise<boolean>) | undefined;
          if (!authorize || !(await authorize({ type: 'install' }))) return;
          const send = (event: SiteSignal) => {
            void (scope[binding] as ((value: SiteSignal) => Promise<void>) | undefined)?.(
              event,
            ).catch(() => undefined);
          };
          // 与只读识别一致：必须只有一个课程根和一个媒体，根外/歧义媒体不参与。
          const currentMedia = (): HTMLVideoElement | null => {
            const roots = document.querySelectorAll('.video-study');
            const videos = document.querySelectorAll('video');
            if (
              roots.length !== 1 ||
              videos.length !== 1 ||
              !(videos[0] instanceof HTMLVideoElement) ||
              videos[0].id !== 'vjs_container_html5_api' ||
              !roots[0].contains(videos[0])
            )
              return null;
            return videos[0];
          };
          let observedMedia = currentMedia();
          const trackMedia = (current: HTMLVideoElement) => {
            if (current === observedMedia) return;
            observedMedia = current;
            send({ type: 'media', eventName: 'media-replaced' });
          };
          const media = (event: Event) => {
            const current = currentMedia();
            if (!current || event.target !== current) return;
            // 同任务替换后立刻发事件时，先重置旧节点的 waiting，再处理当前事件。
            trackMedia(current);
            send({ type: 'media', eventName: event.type });
          };
          // 新节点没有首个媒体事件时也清除旧节点缓冲；仅观察 childList 和对象身份。
          const observer = new MutationObserver(() => {
            const current = currentMedia();
            if (current) trackMedia(current);
          });
          observer.observe(document, { childList: true, subtree: true });
          const events = [
            'play',
            'pause',
            'waiting',
            'playing',
            'timeupdate',
            'ratechange',
            'ended',
            'seeking',
          ];
          // 媒体事件不冒泡，使用捕获；仅观察，不调用 play/pause 或改倍速。
          events.forEach((type) => document.addEventListener(type, media, true));
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
              event.target.closest(
                '#vjs_container,.videoArea,.speedBox,.chapterScrollbar li,.el-dialog__wrapper,[role="dialog"]',
              )
            )
              send({ type: 'manual' });
          };
          document.addEventListener('pointerdown', manual, true);
          document.addEventListener('keydown', manual, true);
          scope[`${binding}_cleanup`] = () => {
            observer.disconnect();
            events.forEach((type) => document.removeEventListener(type, media, true));
            document.removeEventListener('pointerdown', manual, true);
            document.removeEventListener('keydown', manual, true);
          };
        }, name),
      );
    } catch (error) {
      active = false;
      detach();
      throw error;
    }
    return () => {
      if (!active) return;
      active = false;
      detach();
    };
  }

  private async actionState(action: SiteAction, courseId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (action?.type === 'set-rate') throw new Error('自动倍速调整已移除，请在网站手动设置倍速。');
    if (action?.type === 'start-play' && !this.startPlayAllowed)
      throw new Error('开始播放未获得本次明确授权，已拒绝动作。');
    if (
      action?.type !== 'start-play' &&
      action?.type !== 'recover-play' &&
      action?.type !== 'navigate'
    )
      throw new Error('真实平台刷新待真实环境人工验收，已拒绝动作。');
    const data = await this.read(signal);
    if (
      !data ||
      zhihuishuCourseId(data.route) !== courseId ||
      data.authenticated !== true ||
      data.graded ||
      data.popup !== 'none'
    )
      throw new Error('真实网页动作保护条件不满足。');
    const key = zhihuishuCatalogueKey(data);
    const currentId = zhihuishuChapterId(courseId, key, data.currentOrdinal);
    if (action.type === 'start-play') {
      if (action.chapterId !== currentId || !data.player.paused || data.player.ended)
        throw new Error('开始播放仅允许本次确认的当前暂停且未结束章节。');
      return { data, action: { type: 'start-play' } as ZhihuishuDomAction['action'] };
    }
    if (action.type === 'recover-play') {
      if (action.chapterId !== currentId || data.player.paused || data.player.ended)
        throw new Error('用户已暂停、视频结束或章节变化，禁止自动恢复播放。');
      return { data, action: { type: 'recover-play' } as ZhihuishuDomAction['action'] };
    }
    if (!this.completionVerified(data)) throw new Error('完成标记待真实环境人工验收，已拒绝导航。');
    const source = data.completion.find((row) => row.ordinal === data.currentOrdinal);
    const target = data.completion.find((row) => row.completed === false);
    if (
      action.fromChapterId !== currentId ||
      !data.player.ended ||
      source?.completed !== true ||
      !target ||
      action.chapterId !== zhihuishuChapterId(courseId, key, target.ordinal) ||
      action.chapterId === currentId
    )
      throw new Error('导航必须从已结束且平台已完成章节进入首个未完成章。');
    return {
      data,
      action: { type: 'navigate', targetOrdinal: target.ordinal } as ZhihuishuDomAction['action'],
    };
  }

  async prepare(action: SiteAction, courseId: string, signal: AbortSignal): Promise<void> {
    const initial = await this.actionState(action, courseId, signal);
    if (initial.action.type === 'navigate') {
      const targetOrdinal = initial.action.targetOrdinal;
      const index = initial.data.catalogue.findIndex((row) => row.ordinal === targetOrdinal);
      await this.bounded(
        this.page
          .locator('.video-study')
          .locator('.chapterScrollbar')
          .locator('li.video')
          .nth(index)
          .locator('.catalogue_title')
          .scrollIntoViewIfNeeded({ timeout: 2000 }),
        signal,
      );
    }
    const after = await this.actionState(action, courseId, signal);
    if (after.data.currentOrdinal !== initial.data.currentOrdinal)
      throw new Error('准备控件期间章节变化，已取消动作。');
  }

  async perform(action: SiteAction, courseId: string, signal: AbortSignal): Promise<void> {
    const state = await this.actionState(action, courseId, signal);
    const expectedUrl = this.page.url();
    const authorization = `zhsAuthorize_${randomUUID().replaceAll('-', '')}`;
    const permit = randomUUID();
    let consumed = false;
    let active = true;
    let resource: Disposable | undefined;
    const bindingWork = this.page.exposeBinding(authorization, (source, token: string) => {
      if (
        !active ||
        consumed ||
        this.invalidated ||
        signal.aborted ||
        token !== permit ||
        this.page.isClosed() ||
        this.page.url() !== expectedUrl ||
        source.page !== this.page ||
        source.frame !== this.page.mainFrame()
      )
        return false;
      consumed = true;
      return true;
    });
    void bindingWork.then(
      (binding) => {
        if (!active) void binding.dispose().catch(() => undefined);
      },
      () => undefined,
    );
    try {
      resource = await this.bounded(bindingWork, signal);
      signal.throwIfAborted();
      const issued = await this.bounded(
        this.page.evaluate(readZhihuishuDom, {
          authorization,
          permit,
          expectedUrl,
          route: state.data.route,
          title: state.data.title,
          catalogue: JSON.stringify(state.data.catalogue),
          ordinal: state.data.currentOrdinal,
          completionVerified: this.completionVerified(state.data),
          criticalInputGuard: this.criticalInputGuard,
          continuousInputGuard: this.continuousInputGuard,
          expectedMedia: this.expectedMedia,
          mediaLifecycleGuard: this.mediaLifecycleGuard,
          action: state.action,
        }),
        signal,
      );
      if (!issued) throw new Error('最后读取未能确认安全页面，网页动作已拒绝。');
      if (state.action.type === 'navigate') {
        const targetOrdinal = state.action.targetOrdinal;
        const until = Date.now() + 8000;
        let stableTargetSamples = 0;
        // 单次普通点击后只等待媒体/目录反馈；不重发点击，也不修改播放状态。
        for (;;) {
          signal.throwIfAborted();
          const after = await this.read(signal);
          if (!after) {
            stableTargetSamples = 0;
            if (this.invalidated || this.page.url() !== expectedUrl || Date.now() >= until)
              throw new Error('导航后媒体无法可靠识别，结果待人工核验。');
            await this.bounded(new Promise<void>((resolve) => setTimeout(resolve, 150)), signal);
            continue;
          }
          if (after.authenticated !== true || after.popup !== 'none' || after.graded)
            throw new Error('导航后页面失去可靠身份或出现弹窗，结果待人工核验。');
          if (!this.completionVerified(after))
            throw new Error('导航后完整完成标记无法可靠核验，结果待人工核验。');
          if (
            after.completion.find((row) => row.ordinal === state.data.currentOrdinal)?.completed !==
            true
          )
            throw new Error('导航后源章节完成标记变化，结果待人工核验。');
          if (Date.now() >= until) throw new Error('导航反馈超时，结果待人工核验。');
          if (after.currentOrdinal === targetOrdinal && !after.player.ended) stableTargetSamples++;
          else stableTargetSamples = 0;
          if (stableTargetSamples >= 2) {
            this.waiting = false;
            break;
          }
          if (![state.data.currentOrdinal, targetOrdinal].includes(after.currentOrdinal))
            throw new Error('导航反馈超时或章节与预期不符，结果待人工核验。');
          await this.bounded(new Promise<void>((resolve) => setTimeout(resolve, 150)), signal);
        }
      }
    } finally {
      active = false;
      if (resource) await this.disposeBinding(resource);
    }
  }
}
