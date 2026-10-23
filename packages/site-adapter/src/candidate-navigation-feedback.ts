/** Candidate-only feedback: complete shell checks precede any media-loading tolerance. */
export type CandidateFeedbackReason =
  | 'source-pending'
  | 'metadata-pending'
  | 'target-ready'
  | 'scope-invalid'
  | 'url-changed'
  | 'shell-invalid'
  | 'authentication-unavailable'
  | 'blocking-popup'
  | 'catalogue-changed'
  | 'completion-marker-unreliable'
  | 'source-completion-regressed'
  | 'chapter-mismatch'
  | 'caption-mismatch'
  | 'media-invalid'
  | 'media-node-pending'
  | 'media-node-missing'
  | 'media-nodes-ambiguous'
  | 'media-node-type-invalid'
  | 'media-node-mismatch'
  | 'media-not-ready'
  | 'media-seeking'
  | 'media-duration-invalid'
  | 'media-time-invalid'
  | 'media-rate-invalid'
  | 'media-duration-mismatch'
  | 'media-ended'
  | 'media-error';

export interface CandidateMediaFeedback {
  readyState: number;
  networkState: number;
  currentTime: number | null;
  duration: number | null;
  playbackRate: number | null;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  catalogueSeconds: number;
  errorCode: number | null;
}

export interface CandidateNodeFeedback {
  documentVideoCount: number;
  rootVideoCount: number;
  expectedVideoCount: number;
  expectedIdCount: number;
  expectedIsVideo: boolean;
  trackedMediaError: boolean;
  trackedErrorCode: number | null;
}

export interface CandidateFeedback {
  kind: 'source-ready' | 'target-loading' | 'target-ready' | 'blocked';
  reason: CandidateFeedbackReason;
  generation: number;
  media?: CandidateMediaFeedback;
  nodes?: CandidateNodeFeedback;
}

export interface CandidateFeedbackExpectation {
  scopeName: string;
  continuousScopeName?: string;
  url: string;
  title: string;
  sourceOrdinal: string;
  targetOrdinal: string;
  chapters: Array<{ ordinal: string; title: string }>;
}

/** Executed as a single read-only page task; never changes media, input or site controls. */
export function readCandidateNavigationFeedback(
  expected: CandidateFeedbackExpectation,
): CandidateFeedback {
  const blocked = (reason: CandidateFeedbackReason): CandidateFeedback => ({
    kind: 'blocked',
    reason,
    generation: -1,
  });
  const scope = (
    window as unknown as Record<
      string,
      | {
          blocked: boolean;
          mediaEpoch: number;
          metadataCount: number;
          readyEpoch: number;
          observedMedia: HTMLVideoElement | null;
          commitMedia: HTMLVideoElement | null;
          commitEpoch: number | null;
          commitMetadataCount: number | null;
          catalogueTimes: string[] | null;
          mediaError: boolean;
          mediaErrorCode: number | null;
        }
      | undefined
    >
  )[expected.scopeName];
  if (
    !scope ||
    scope.blocked ||
    scope.commitEpoch === null ||
    scope.commitMetadataCount === null ||
    !scope.catalogueTimes
  )
    return blocked('scope-invalid');
  if (expected.continuousScopeName !== undefined) {
    const outer = (
      window as unknown as Record<
        string,
        { blocked: boolean; activeScope: string | null; mediaError: boolean } | undefined
      >
    )[expected.continuousScopeName];
    if (!outer || outer.blocked || outer.mediaError || outer.activeScope !== expected.scopeName)
      return blocked('scope-invalid');
  }
  if (location.href !== expected.url) return blocked('url-changed');
  const one = (selector: string, root: ParentNode = document): Element | null => {
    const nodes = root.querySelectorAll(selector);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    );
  };
  // A popup or site warning remains fatal even while metadata is unavailable.
  if (
    [
      ...document.querySelectorAll(
        '.el-dialog__wrapper,[role="dialog"],.vjs-modal-dialog,.mask,.v-modal,.ep-overlay-dialog,[aria-modal="true"],iframe[src*="captcha.gtimg.com"]',
      ),
    ].some(visible)
  )
    return blocked('blocking-popup');
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
    return blocked('blocking-popup');
  const root = one('.video-study');
  if (!root || one('.source-name', root)?.textContent?.trim() !== expected.title)
    return blocked('shell-invalid');
  const user = one('.header_userInfo', root);
  if (
    !user ||
    !visible(user) ||
    root.querySelectorAll('.userLinks .iconheiyemoshi-anquantuichu').length !== 1
  )
    return blocked('authentication-unavailable');
  const list = one('.chapterScrollbar', root);
  if (!list) return blocked('catalogue-changed');
  const rows = [...list.querySelectorAll('li.video')];
  if (rows.length !== expected.chapters.length || rows.length !== scope.catalogueTimes.length)
    return blocked('catalogue-changed');
  const completion: boolean[] = [];
  const seconds: number[] = [];
  for (const [index, row] of rows.entries()) {
    const time = one('.time', row)?.textContent?.trim() ?? '';
    if (
      one('.hour', row)?.textContent?.trim() !== expected.chapters[index].ordinal ||
      one('.catalogue_title', row)?.textContent?.trim() !== expected.chapters[index].title ||
      time !== scope.catalogueTimes[index] ||
      !/^\d{2}:\d{2}:\d{2}$/.test(time)
    )
      return blocked('catalogue-changed');
    const parts = time.split(':').map(Number);
    const duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts[1] > 59 || parts[2] > 59 || duration <= 0) return blocked('catalogue-changed');
    seconds.push(duration);
    const half = row.querySelectorAll('.time_ico_half');
    const finish = row.querySelectorAll('.time_icofinish');
    if (half.length !== 1 || finish.length > 1 || (finish.length === 1 && !visible(finish[0])))
      return blocked('completion-marker-unreliable');
    completion.push(finish.length === 1);
  }
  const sourceIndex = expected.chapters.findIndex((row) => row.ordinal === expected.sourceOrdinal);
  if (sourceIndex < 0 || !completion[sourceIndex]) return blocked('source-completion-regressed');
  const active = rows.filter((row) => row.classList.contains('current_play'));
  if (active.length !== 1) return blocked('chapter-mismatch');
  const index = rows.indexOf(active[0]);
  const ordinal = expected.chapters[index].ordinal;
  if (![expected.sourceOrdinal, expected.targetOrdinal].includes(ordinal))
    return blocked('chapter-mismatch');
  const caption = one('#lessonOrder', root)?.textContent?.trim() ?? '';
  if (
    !caption.startsWith(ordinal) ||
    caption.slice(ordinal.length).replace(/^[\s、，,:：.-]+/u, '') !==
      expected.chapters[index].title
  )
    return blocked('caption-mismatch');
  const ids = document.querySelectorAll('#vjs_container_html5_api');
  const videos = root.querySelectorAll('video#vjs_container_html5_api');
  const trackedErrorCode =
    scope.mediaErrorCode ??
    scope.commitMedia?.error?.code ??
    scope.observedMedia?.error?.code ??
    null;
  const nodes: CandidateNodeFeedback = {
    documentVideoCount: document.querySelectorAll('video').length,
    rootVideoCount: root.querySelectorAll('video').length,
    expectedVideoCount: videos.length,
    expectedIdCount: ids.length,
    expectedIsVideo: ids.length === 1 && ids[0] instanceof HTMLVideoElement,
    trackedMediaError:
      scope.mediaError === true || !!scope.commitMedia?.error || !!scope.observedMedia?.error,
    trackedErrorCode:
      trackedErrorCode !== null && [1, 2, 3, 4].includes(trackedErrorCode)
        ? trackedErrorCode
        : null,
  };
  const nodesBlocked = (reason: CandidateFeedbackReason): CandidateFeedback => ({
    ...blocked(reason),
    nodes,
  });
  // A detached source can still fail; replacing it must not erase a known native error.
  if (
    nodes.trackedMediaError &&
    !(
      nodes.documentVideoCount === 1 &&
      nodes.rootVideoCount === 1 &&
      nodes.expectedVideoCount === 1 &&
      nodes.expectedIdCount === 1 &&
      nodes.expectedIsVideo
    )
  )
    return nodesBlocked('media-error');
  if (
    nodes.documentVideoCount > 1 ||
    nodes.rootVideoCount > 1 ||
    nodes.expectedVideoCount > 1 ||
    nodes.expectedIdCount > 1
  )
    return nodesBlocked('media-nodes-ambiguous');
  if (nodes.expectedIdCount === 1 && !nodes.expectedIsVideo)
    return nodesBlocked('media-node-type-invalid');
  if (
    nodes.documentVideoCount === 0 &&
    nodes.rootVideoCount === 0 &&
    nodes.expectedVideoCount === 0 &&
    nodes.expectedIdCount === 0
  ) {
    // Only an already correlated target transition may wait for an absent node. Absence
    // supplies no new-media evidence and never authorizes another click or playback.
    return ordinal === expected.targetOrdinal
      ? {
          kind: 'target-loading',
          reason: 'media-node-pending',
          generation: scope.mediaEpoch,
          nodes,
        }
      : nodesBlocked('media-node-missing');
  }
  if (
    nodes.documentVideoCount !== 1 ||
    nodes.rootVideoCount !== 1 ||
    nodes.expectedVideoCount !== 1 ||
    nodes.expectedIdCount !== 1
  )
    return nodesBlocked('media-node-mismatch');
  const media = videos[0];
  if (!(media instanceof HTMLVideoElement)) return nodesBlocked('media-node-type-invalid');
  const time = media.currentTime;
  const duration = media.duration;
  const rate = media.playbackRate;
  const metrics: CandidateMediaFeedback = {
    readyState: media.readyState,
    networkState: media.networkState,
    currentTime: Number.isFinite(time) ? time : null,
    duration: Number.isFinite(duration) ? duration : null,
    playbackRate: Number.isFinite(rate) ? rate : null,
    paused: media.paused,
    ended: media.ended,
    seeking: media.seeking,
    catalogueSeconds: seconds[index],
    errorCode: media.error?.code ?? null,
  };
  const mediaBlocked = (reason: CandidateFeedbackReason): CandidateFeedback => ({
    ...blocked(reason),
    media: metrics,
    nodes,
  });
  if (nodes.trackedMediaError || media.error) return mediaBlocked('media-error');
  const generation = scope.mediaEpoch;
  const freshMetadata =
    scope.metadataCount > scope.commitMetadataCount &&
    scope.observedMedia === media &&
    scope.readyEpoch === generation &&
    (generation > scope.commitEpoch || media !== scope.commitMedia);
  const loading = (reason: CandidateFeedbackReason = 'metadata-pending'): CandidateFeedback => ({
    kind: 'target-loading',
    reason,
    generation,
    media: metrics,
    nodes,
  });
  // A changed caption and equal duration do not prove the old media was replaced/reloaded.
  if (ordinal === expected.targetOrdinal && !freshMetadata) return loading();
  // Metadata alone does not imply the player has settled its new time/duration.
  // This is still read-only bounded waiting; shell, marker, error and input gates ran first.
  if (metrics.readyState < 2) return loading('media-not-ready');
  if (metrics.seeking) return loading('media-seeking');
  if (!Number.isFinite(duration) || duration <= 0) return mediaBlocked('media-duration-invalid');
  if (!Number.isFinite(time) || time < 0 || time > duration + 0.1)
    return mediaBlocked('media-time-invalid');
  if (!Number.isFinite(rate) || rate <= 0 || rate > 16) return mediaBlocked('media-rate-invalid');
  if (Math.abs(seconds[index] - duration) > 2) return mediaBlocked('media-duration-mismatch');
  if (ordinal === expected.sourceOrdinal)
    return { kind: 'source-ready', reason: 'source-pending', generation, media: metrics, nodes };
  if (metrics.ended) return mediaBlocked('media-ended');
  return { kind: 'target-ready', reason: 'target-ready', generation, media: metrics, nodes };
}
