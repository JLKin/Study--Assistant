import type { CourseObservation, ObservationConfidence, SiteAdapter } from './index';

/** 此契约只描述观察与受保护动作；fixture 已验证不等于真实平台已验证。 */
export interface PlayerObservation {
  chapterId: string;
  currentTime: number;
  duration: number;
  playbackRate: number;
  paused: boolean;
  buffering: boolean;
  ended: boolean;
  observedAt: string;
  confidence: ObservationConfidence;
}
export interface ChapterObservation {
  chapterId: string;
  title: string;
  platformCompleted: boolean | null;
  observedAt: string;
  confidence: ObservationConfidence;
}
/** 按项声明当前页面已核验的能力；不表示真实站点已整体通过人工验收。 */
export interface SiteCapabilities {
  playbackRate: boolean;
  /** 仅显式、临时授权的开始播放操作；省略或非 true 均不授予，不改变任务继续语义。 */
  startPlay?: boolean;
  recoverPlay: boolean;
  refresh: boolean;
  navigation: boolean;
  completionMarkers: boolean;
}
export interface SiteObservation {
  course: CourseObservation;
  player: PlayerObservation | null;
  chapters: ChapterObservation[];
  currentChapterId: string | null;
  supportedRates: number[];
  popup: 'none' | 'present' | 'unknown';
  /** true 仅表示模拟或经核验适配层明确允许刷新，未知一律不刷新。 */
  safeToRefresh: boolean;
  /** 既有 fixture 可省略；真实 DOM 适配器必须按项显式授予能力。 */
  capabilities?: SiteCapabilities;
}
export type SiteSignal = {
  type: 'media' | 'manual' | 'navigation';
  eventName?: string;
  automated?: boolean;
  action?: 'play' | 'pause' | 'chapter' | 'popup' | 'rate' | 'seek';
};
export type SiteAction =
  | { type: 'set-rate'; rate: number; chapterId: string }
  | { type: 'start-play'; chapterId: string }
  | { type: 'recover-play'; chapterId: string }
  | { type: 'refresh'; chapterId: string }
  | { type: 'navigate'; chapterId: string; fromChapterId: string };
export interface MonitorSiteAdapter extends SiteAdapter {
  observe(signal?: AbortSignal): Promise<SiteObservation>;
  subscribe(listener: (event: SiteSignal) => void): Promise<() => void>;
  /**
   * 在操作意图落盘前准备普通页面控件（例如前置窗口、悬停显示菜单）。
   * 必须支持取消，不得点击选项或产生课程动作；失败即不创建操作记录。
   * 返回后 TaskEngine 仍会重新读取安全状态；实际动作只能由 perform 发出。
   */
  prepare?(action: SiteAction, courseId: string, signal: AbortSignal): Promise<void>;
  /** 必须在发出动作的同一页面任务中再次检查课程、章节与取消令牌。 */
  perform(action: SiteAction, courseId: string, signal: AbortSignal): Promise<void>;
}
export interface ChapterVerification {
  chapterId: string;
  platformCompleted: boolean | null;
  videoProgress: number | null;
  verificationTriggered: boolean;
  status: 'pending' | 'confirmed' | 'conflict' | 'unknown';
  retries: number;
}
export interface MonitorView {
  observation: SiteObservation | null;
  chapters: ChapterVerification[];
  nextPollAt: number | null;
  refreshAttempts: number;
  reason: string;
}
