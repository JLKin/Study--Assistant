/** 实际 /stuStudy 页面于 2026-10-17 只读取证的结构；无网络/存储/账户正文读取。 */
export interface ZhihuishuDomSample {
  route: string;
  title: string;
  catalogue: Array<{ ordinal: string; title: string; seconds: number }>;
  /** 独立于目录指纹；动态标记变化不得改变已保存的章节 ID。 */
  completion: Array<{ ordinal: string; completed: boolean | null }>;
  currentOrdinal: string;
  authenticated: true | 'unknown';
  popup: 'none' | 'present';
  graded: boolean;
  player: {
    currentTime: number;
    duration: number;
    playbackRate: number;
    paused: boolean;
    ended: boolean;
    buffering: boolean;
  };
  rates: number[];
}

export interface ZhihuishuDomAction {
  authorization: string;
  permit: string;
  expectedUrl: string;
  route: string;
  title: string;
  catalogue: string;
  ordinal: string;
  completionVerified: boolean;
  criticalInputGuard?: string;
  continuousInputGuard?: string;
  expectedMedia?: HTMLVideoElement;
  mediaLifecycleGuard?: string;
  action:
    { type: 'start-play' } | { type: 'recover-play' } | { type: 'navigate'; targetOrdinal: string };
}

/** 默认只读；受保护动作先取得最后授权，再在同一页面任务完整重读和执行。倍速不在动作契约内。 */
export async function readZhihuishuDom(
  request?: ZhihuishuDomAction,
): Promise<ZhihuishuDomSample | null> {
  if (request) {
    if (!['start-play', 'recover-play', 'navigate'].includes(request.action?.type))
      throw new Error('不允许的真实网页动作。');
    const scope = window as unknown as Record<string, unknown>;
    const authorize = scope[request.authorization] as
      ((token: string) => Promise<boolean>) | undefined;
    if (!authorize || !(await authorize(request.permit))) throw new Error('动作已取消或授权失效。');
  }
  const url = new URL(location.href);
  if (
    url.origin !== 'https://studyvideoh5.zhihuishu.com' ||
    url.username ||
    url.password ||
    url.pathname !== '/stuStudy' ||
    url.hash ||
    [...url.searchParams.keys()].length !== 1 ||
    url.searchParams.getAll('recruitAndCourseId').length !== 1
  )
    return null;
  const route = url.searchParams.get('recruitAndCourseId') ?? '';
  if (!/^[A-Za-z0-9_+/=.-]{8,256}$/.test(route)) return null;
  const one = (selector: string, root: ParentNode = document): Element | null => {
    const elements = root.querySelectorAll(selector);
    return elements.length === 1 ? elements[0] : null;
  };
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    );
  };
  const root = one('.video-study');
  if (!root) return null;
  const heading = one('.source-name', root)?.textContent?.trim();
  const list = one('.chapterScrollbar', root);
  const media = one('video#vjs_container_html5_api', root);
  const caption = one('#lessonOrder', root)?.textContent?.trim();
  if (!heading || heading.length > 200 || !list || !(media instanceof HTMLVideoElement) || !caption)
    return null;
  if (document.querySelectorAll('video').length !== 1) return null;
  const rows = [...list.querySelectorAll('li.video')];
  if (
    rows.length < 1 ||
    rows.length > 1000 ||
    rows.filter((row) => row.classList.contains('current_play')).length !== 1
  )
    return null;
  const catalogue: ZhihuishuDomSample['catalogue'] = [];
  const completion: ZhihuishuDomSample['completion'] = [];
  let currentOrdinal = '';
  for (const row of rows) {
    const ordinal = one('.hour', row)?.textContent?.trim() ?? '';
    const title = one('.catalogue_title', row)?.textContent?.trim() ?? '';
    const duration = one('.time', row)?.textContent?.trim() ?? '';
    if (
      !/^\d{1,3}(?:\.\d{1,3}){0,4}$/.test(ordinal) ||
      !title ||
      title.length > 200 ||
      !/^\d{2}:\d{2}:\d{2}$/.test(duration)
    )
      return null;
    const parts = duration.split(':').map(Number);
    if (parts[1] > 59 || parts[2] > 59) return null;
    const seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (seconds <= 0) return null;
    catalogue.push({ ordinal, title, seconds });
    const half = row.querySelectorAll('.time_ico_half');
    const finish = row.querySelectorAll('.time_icofinish');
    completion.push({
      ordinal,
      completed:
        half.length !== 1 || finish.length > 1
          ? null
          : finish.length === 0
            ? false
            : visible(finish[0])
              ? true
              : null,
    });
    if (row.classList.contains('current_play')) {
      currentOrdinal = ordinal;
      if (
        !caption.startsWith(ordinal) ||
        caption.slice(ordinal.length).replace(/^[\s、，,:：.-]+/u, '') !== title
      )
        return null;
    }
  }
  if (new Set(catalogue.map((row) => row.ordinal)).size !== catalogue.length) return null;
  const current = catalogue.find((row) => row.ordinal === currentOrdinal);
  if (
    !current ||
    media.readyState < 1 ||
    !Number.isFinite(media.duration) ||
    media.duration <= 0 ||
    !Number.isFinite(media.currentTime) ||
    media.currentTime < 0 ||
    media.currentTime > media.duration + 0.1 ||
    !Number.isFinite(media.playbackRate) ||
    media.playbackRate <= 0 ||
    media.playbackRate > 16 ||
    Math.abs(current.seconds - media.duration) > 2
  )
    return null;
  const blockers = [
    ...document.querySelectorAll(
      '.el-dialog__wrapper,[role="dialog"],.vjs-modal-dialog,.mask,.v-modal,.ep-overlay-dialog,[aria-modal="true"],iframe[src*="captcha.gtimg.com"]',
    ),
  ].filter(visible);
  // 非模态脚本限制提示同样阻断动作；只读取提示容器，不采集或保存页面正文。
  for (const notice of document.querySelectorAll(
    '[role="alert"],.el-message,.el-notification,.el-message-box__wrapper',
  )) {
    if (
      visible(notice) &&
      /检测.{0,20}(脚本|插件)|(?:脚本|插件).{0,20}(?:执行|检测|异常|禁止)/u.test(
        notice.textContent ?? '',
      )
    )
      blockers.push(notice);
  }
  const graded = blockers.some((element) =>
    /考试|计分|测验|作业/.test(element.querySelector('.el-dialog__title')?.textContent ?? ''),
  );
  const userInfo = one('.header_userInfo', root);
  const authenticated =
    userInfo &&
    visible(userInfo) &&
    root.querySelectorAll('.userLinks .iconheiyemoshi-anquantuichu').length === 1 &&
    blockers.length === 0
      ? true
      : 'unknown';
  const sample: ZhihuishuDomSample = {
    route,
    title: heading,
    catalogue,
    completion,
    currentOrdinal,
    authenticated,
    graded,
    popup: blockers.length ? 'present' : 'none',
    // 倍速由用户在网站选择，菜单结构与历史支持白名单不再参与只读识别。
    rates: [],
    player: {
      currentTime: media.currentTime,
      duration: media.duration,
      playbackRate: media.playbackRate,
      paused: media.paused,
      ended: media.ended,
      buffering: !media.paused && !media.ended && media.readyState < 3,
    },
  };
  if (request) {
    if (
      location.href !== request.expectedUrl ||
      route !== request.route ||
      heading !== request.title ||
      JSON.stringify(catalogue) !== request.catalogue ||
      currentOrdinal !== request.ordinal ||
      authenticated !== true ||
      graded ||
      blockers.length
    )
      throw new Error('动作前课程、目录、登录、弹窗或完成标记发生变化。');
    if (request.action.type === 'start-play') {
      if (request.continuousInputGuard !== undefined) {
        if (
          typeof request.continuousInputGuard !== 'string' ||
          !/^zhsContinuousScope_[a-f0-9]{32}$/u.test(request.continuousInputGuard)
        )
          throw new Error('连续人工操作保护标识无效，禁止启动播放。');
        const outer = (
          window as unknown as Record<
            string,
            { blocked?: boolean; mediaError?: boolean; activeScope?: string | null } | undefined
          >
        )[request.continuousInputGuard];
        if (
          !outer ||
          outer.blocked !== false ||
          outer.mediaError !== false ||
          typeof request.criticalInputGuard !== 'string' ||
          outer.activeScope !== request.criticalInputGuard
        )
          throw new Error('连续人工操作保护已失效，禁止启动播放。');
      }
      if (request.criticalInputGuard !== undefined) {
        if (
          typeof request.criticalInputGuard !== 'string' ||
          !/^[A-Za-z0-9_]{1,128}$/.test(request.criticalInputGuard)
        )
          throw new Error('人工操作保护标识无效，禁止启动播放。');
        const guard = (
          window as unknown as Record<
            string,
            | {
                blocked?: boolean;
                confirmedMedia?: HTMLVideoElement;
                observedMedia?: HTMLVideoElement;
                confirmedEpoch?: number | null;
                mediaEpoch?: number;
                readyEpoch?: number;
                confirmedMetadataCount?: number | null;
                metadataCount?: number;
              }
            | undefined
          >
        )[request.criticalInputGuard];
        if (
          !guard ||
          guard.blocked !== false ||
          guard.confirmedEpoch == null ||
          guard.confirmedEpoch !== guard.mediaEpoch ||
          guard.readyEpoch !== guard.mediaEpoch ||
          guard.confirmedMetadataCount !== guard.metadataCount ||
          guard.confirmedMedia !== media ||
          guard.observedMedia !== media
        )
          throw new Error('人工操作保护已失效，禁止启动播放。');
      }
      if (request.expectedMedia !== undefined && request.expectedMedia !== media)
        throw new Error('当前媒体节点已替换，禁止启动播放。');
      if (request.mediaLifecycleGuard !== undefined) {
        if (
          typeof request.mediaLifecycleGuard !== 'string' ||
          !/^[A-Za-z0-9_]{1,128}$/.test(request.mediaLifecycleGuard)
        )
          throw new Error('媒体换代保护标识无效，禁止启动播放。');
        const guard = (
          window as unknown as Record<string, { media?: Element; invalid?: boolean } | undefined>
        )[request.mediaLifecycleGuard];
        if (!guard || guard.media !== media || guard.invalid !== false)
          throw new Error('媒体加载状态已变化，禁止启动播放。');
      }
      if (!media.paused || media.ended) throw new Error('开始播放仅允许当前暂停且未结束视频。');
      // 单次原生调用；失败原样上抛，不改静音/倍速、不重试或代替用户授权。
      await media.play();
    } else if (request.action.type === 'recover-play') {
      if (media.paused || media.ended) throw new Error('用户已暂停或视频结束，禁止自动恢复播放。');
      await media.play();
    } else {
      if (!request.completionVerified || completion.some((row) => row.completed === null))
        throw new Error('平台完成标记尚未可靠确认，禁止切章。');
      const targetOrdinal = request.action.targetOrdinal;
      const source = completion.find((row) => row.ordinal === currentOrdinal);
      const firstIncomplete = completion.find((row) => row.completed === false);
      const index = catalogue.findIndex((row) => row.ordinal === targetOrdinal);
      const control = index >= 0 ? one('.catalogue_title', rows[index]) : null;
      const reachable = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return [0.15, 0.5, 0.85].some((x) =>
          [0.15, 0.5, 0.85].some((y) => {
            const hit = document.elementFromPoint(
              rect.left + rect.width * x,
              rect.top + rect.height * y,
            );
            return !!hit && element.contains(hit);
          }),
        );
      };
      // 标题通常位于行/按钮内部；祖先的不可用语义同样禁止普通目录动作。
      const unavailable = (element: Element): boolean => {
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          if (
            ancestor.getAttribute('aria-disabled') === 'true' ||
            ancestor.matches(':disabled') ||
            ancestor.hasAttribute('inert') ||
            ancestor.classList.contains('disabled')
          )
            return true;
          if (ancestor === root) return false;
        }
        return true;
      };
      if (
        !media.ended ||
        source?.completed !== true ||
        firstIncomplete?.ordinal !== targetOrdinal ||
        targetOrdinal === currentOrdinal ||
        !(control instanceof HTMLElement) ||
        !visible(control) ||
        !reachable(control) ||
        unavailable(control)
      )
        throw new Error('章节导航保护条件不满足或普通标题控件被遮挡。');
      control.click();
    }
  }
  return sample;
}
