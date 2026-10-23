export const SCHEMA_VERSION = 1 as const;
export const RECOVERY_COOLDOWN_MS = 5000 as const;
export const TASK_STATES = [
  'IDLE',
  'WAIT_LOGIN',
  'COURSE_CONFIRM',
  'MONITORING',
  'PRACTICE_ACTIVE',
  'BUFFER_RECOVERY',
  'PAUSED',
  'RECOVERING',
  'STOPPING',
  'COMPLETED',
  'ERROR',
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export enum Priority {
  User = 0,
  Connection = 1,
  ManualInteraction = 2,
  Practice = 3,
  Recovery = 4,
  PlaybackRate = 5,
  Observation = 6,
}
export interface Result<T = unknown> {
  ok: boolean;
  code: string;
  message: string;
  correlationId: string;
  data?: T;
}
export interface AppConfig {
  schemaVersion: 1;
  pollIntervalMs: number;
  /** schema 1 历史保留字段；不再驱动调速，倍速由用户在网页设置。 */
  targetPlaybackRate: 1 | 1.25 | 1.5;
  bufferTimeoutMs: number;
  stallTimeoutMs: number;
  logLevel: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  logRetentionDays: number;
  notificationsEnabled: boolean;
  practiceAllowFullText: boolean;
  practiceConfidenceThreshold: number;
}
export interface ConfigIssue {
  key: string;
  reason: string;
  requiresConfirmation: boolean;
}
export interface ConfigView {
  config: AppConfig;
  issues: ConfigIssue[];
  blocked: boolean;
  source: 'default' | 'primary' | 'backup';
}
export type ObservationConfidence = 'verified' | 'uncertain';
export interface CourseObservation {
  courseId: string | null;
  title: string | null;
  observedAt: string;
  confidence: ObservationConfidence;
  source: 'fixture' | 'zhihuishu-dom' | 'real-unverified';
  authenticated: boolean | 'unknown';
  pageKind: 'course' | 'graded' | 'unknown';
  platformCompleted: boolean | null;
  evidence: string[];
}
export interface SiteAdapter {
  readonly kind: 'fixture' | 'zhihuishu-dom' | 'real-unverified';
  inspect(signal?: AbortSignal): Promise<CourseObservation>;
}
export interface BrowserStatus {
  state: 'CLOSED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED';
  isolatedProfile: boolean;
  endpointScope: 'loopback';
  reason?: string;
}
export interface OperationRecord {
  operationId: string;
  taskId: string;
  kind: string;
  status: 'pending' | 'executing' | 'awaiting-confirmation' | 'completed' | 'failed';
  savedAt: string;
}
export interface TaskSnapshot {
  schemaVersion: 1;
  taskId: string | null;
  courseId: string | null;
  chapterId: string | null;
  savedAt: string;
  state: TaskState;
  pendingOperations: OperationRecord[];
  confirmedPlatformStatuses: Array<{ chapterId: string; completed: boolean; observedAt: string }>;
  integrityDigest: string;
}
export interface TaskView {
  state: TaskState;
  taskId: string | null;
  reason: string;
  cancelled: boolean;
  persistenceHealthy: boolean;
}
export interface CheckItem {
  id: string;
  label: string;
  status: 'pass' | 'warning' | 'fail';
  critical: boolean;
  message: string;
}
export interface SelfCheck {
  checkedAt: string;
  canStart: boolean;
  items: CheckItem[];
}
export interface LogEntry {
  at: string;
  level: AppConfig['logLevel'];
  module: 'app' | 'browser' | 'task' | 'config' | 'system' | 'security';
  code: string;
  message: string;
}
export interface Dashboard {
  stage: 1 | 2;
  task: TaskView;
  browser: BrowserStatus;
  settings: ConfigView;
  selfCheck: SelfCheck;
  course: CourseObservation | null;
  logs: LogEntry[];
  dataLocation: string;
  monitor?: import('./monitor').MonitorView;
  auto?: Record<string, unknown>;
}
export const COMMANDS = [
  'app.status',
  'system.check',
  'browser.open',
  'browser.reopen',
  'course.inspect',
  'course.confirm',
  'task.start',
  'task.pause',
  'task.resume',
  'task.stop',
  'settings.get',
  'settings.update',
  'settings.acknowledge',
  'backup.create',
  'recovery.inspect',
  'report.open',
  'diagnostics.export',
  'auto.start',
  'auto.stop',
  'auto.status',
  'auto.config',
  'auto.config.save',
  'auto.browser.open',
  'auto.profile.reset',
  'app.disclaimer',
  'app.disclaimer.accept',
  'app.update.check',
  'app.update.open',
  'app.quit',
] as const;
export type Command = (typeof COMMANDS)[number];
export interface CommandEnvelope {
  command: Command;
  correlationId: string;
  payload?: unknown;
}
export interface AppEvent {
  type:
    | 'task.statusChanged'
    | 'browser.statusChanged'
    | 'site.courseDiscovered'
    | 'site.playerObserved'
    | 'site.chapterObserved'
    | 'log.entry'
    | 'system.warning'
    | 'settings.changed'
    | 'auto.statusChanged'
    | 'auto.log'
    | 'app.update';
  data: unknown;
}
export interface UpdateInfo {
  current: string;
  latest: string | null;
  minSupported: string | null;
  force: boolean;
  notes: string;
  url: string | null;
  checkedAt: string | null;
  source: 'network' | 'cache' | 'none';
  error: string | null;
}
export interface DesktopApi {
  status(): Promise<Result<Dashboard>>;
  selfCheck(): Promise<Result<SelfCheck>>;
  openBrowser(): Promise<Result>;
  reopenBrowser(): Promise<Result>;
  inspectCourse(): Promise<Result<CourseObservation>>;
  confirmCourse(courseId: string): Promise<Result>;
  start(): Promise<Result>;
  pause(): Promise<Result>;
  resume(): Promise<Result>;
  stop(): Promise<Result>;
  getSettings(): Promise<Result<ConfigView>>;
  updateSettings(patch: Partial<AppConfig>): Promise<Result<ConfigView>>;
  acknowledgeSettings(): Promise<Result<ConfigView>>;
  createBackup(): Promise<Result>;
  inspectRecovery(): Promise<Result>;
  openReport(): Promise<Result>;
  exportDiagnostics(): Promise<Result>;
  autoStart(course?: string): Promise<Result>;
  autoStop(): Promise<Result>;
  autoStatus(): Promise<Result>;
  autoConfig(): Promise<Result<Record<string, unknown>>>;
  autoConfigSave(patch: Record<string, unknown>): Promise<Result<Record<string, unknown>>>;
  autoProfileReset(): Promise<Result<{ profile?: string | null }>>;
  autoBrowserOpen(url?: string): Promise<Result<{ url?: string | null }>>;
  disclaimer(): Promise<Result<{ accepted: boolean; at: string | null }>>;
  acceptDisclaimer(): Promise<Result<{ accepted: boolean; at: string | null }>>;
  updateCheck(): Promise<Result<UpdateInfo>>;
  updateOpen(url: string): Promise<Result>;
  quit(): Promise<Result>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
