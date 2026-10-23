import { randomUUID } from 'node:crypto';
import {
  RECOVERY_COOLDOWN_MS,
  type CourseObservation,
  type OperationRecord,
  type Result,
  type TaskSnapshot,
  type TaskState,
  type TaskView,
} from '../../contracts/src/index';
import type { Logger } from '../../logging/src/index';
import type { SnapshotInput, SnapshotStore } from '../../persistence/src/index';
import type { SiteObservation } from '../../contracts/src/monitor';
import type { PracticeAction, PracticeContext } from '../../contracts/src/practice';
import { validPracticeGrant, type VerifiedPracticeGrant } from './practice-grant';
import {
  validManualPracticeReview,
  type ManualPracticeReviewAuthorization,
} from './manual-practice-review';

interface FixtureCapabilities {
  enabled: true;
  inspect: (signal: AbortSignal) => Promise<CourseObservation>;
  backup: (signal: AbortSignal) => Promise<boolean>;
}
/** Stage 2 enables verified fixture and real DOM observations; unknown adapters remain locked. */
export interface Stage2Capabilities {
  enabled: true;
  inspect: (signal: AbortSignal) => Promise<CourseObservation>;
  backup: (signal: AbortSignal) => Promise<boolean>;
}
export interface TaskEngineOptions {
  store: SnapshotStore;
  logger?: Pick<Logger, 'log'>;
  onChange?: (view: TaskView) => void;
  /** Internal integration-test harness. The desktop service must never populate this option. */
  testCapabilities?: FixtureCapabilities;
  stage2Capabilities?: Stage2Capabilities;
  /** Internal stage-3 fixture harness only. Never populated by production desktop/IPC. */
  stage3FixturePractice?: true;
  /** Explicit internal real-site acceptance only; production desktop/IPC never populate this. */
  stage3VerifiedPractice?: VerifiedPracticeGrant;
}
export interface GuardedOperation {
  operationId: string;
  /** playback-rate 仅保留历史类型兼容，执行入口始终拒绝。 */
  kind:
    | 'fixture-mutation'
    | 'recovery'
    | 'page-refresh'
    | 'playback-rate'
    | 'playback-start'
    | 'practice-pause'
    | 'practice-submit'
    | 'practice-correct'
    | 'practice-close'
    | 'practice-restore'
    | 'chapter-navigation';
  prepare?: (signal: AbortSignal) => Promise<void>;
  /** Must issue the effect directly; all cancellable preparation belongs in prepare. */
  issue: (signal: AbortSignal) => Promise<void>;
  verify: (signal: AbortSignal) => Promise<'confirmed' | 'unknown' | 'failed'>;
}

class Cancelled extends Error {}
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Cancelled());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Cancelled());
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => undefined);
  });
}

/** Sole action entry point. Without explicit capabilities production remains disabled. */
export class TaskEngine {
  private state: TaskState = 'IDLE';
  private reason = '阶段 1 基础框架；课程自动化尚未启用。';
  private taskId: string | null = null;
  private courseId: string | null = null;
  private chapterId: string | null = null;
  private confirmedCourseId: string | null = null;
  private confirmedCourseSource: CourseObservation['source'] | null = null;
  private connected = false;
  private persistenceHealthy = true;
  private cancelled = true;
  private controller = new AbortController();
  private epoch = 0;
  private active = false;
  private commandBusy = false;
  private operationBusy = false;
  private operations: OperationRecord[] = [];
  private platformStatuses: TaskSnapshot['confirmedPlatformStatuses'] = [];
  private initialization: Promise<Result<TaskView>> | null = null;
  private readonly cooldown = new Map<string, number>();
  private practiceStart = 0;
  private readonly practiceGrant?: VerifiedPracticeGrant;
  private realPracticeClaimed = false;
  private practiceAdmissionBusy = false;
  private issuingPracticeId: string | null = null;
  private manualReview?: ManualPracticeReviewAuthorization;
  private manualReviewTaskId: string | null = null;

  /** Real adapter effects are callable only from this engine's current recorded issue callback. */
  canIssuePracticeAction(
    action: PracticeAction,
    courseId: string,
    authorizationId: string,
  ): boolean {
    const current = this.operations.at(-1);
    return (
      !!this.practiceGrant &&
      this.practiceGrant.id === authorizationId &&
      this.practiceGrant.courseId === courseId &&
      this.confirmedCourse === courseId &&
      this.confirmedSource === 'zhihuishu-dom' &&
      this.realPracticeClaimed &&
      validPracticeGrant(this.practiceGrant) &&
      (!this.manualReview ||
        (this.taskId === this.manualReviewTaskId &&
          validManualPracticeReview(this.manualReview))) &&
      this.active &&
      !this.cancelled &&
      !this.signal.aborted &&
      this.state === 'PRACTICE_ACTIVE' &&
      this.operationBusy &&
      !!current &&
      current.status === 'executing' &&
      this.issuingPracticeId === current.operationId &&
      current.kind === `practice-${action.type}` &&
      (!('submissionId' in action) || action.submissionId === current.operationId)
    );
  }

  async beginPractice(context?: PracticeContext): Promise<Result<TaskView>> {
    const real = this.confirmedSource === 'zhihuishu-dom';
    if (
      real
        ? !this.practiceGrant ||
          !validPracticeGrant(this.practiceGrant) ||
          this.realPracticeClaimed ||
          context?.source !== 'zhihuishu-verified' ||
          context.authorizationId !== this.practiceGrant.id ||
          context.courseId !== this.practiceGrant.courseId ||
          context.courseId !== this.confirmedCourse ||
          context.classification !== 'non-graded' ||
          !context.explicitNonGraded ||
          !context.authenticated
        : !this.options.stage3FixturePractice || this.confirmedSource !== 'fixture'
    )
      return this.result(false, 'PRACTICE_LOCKED', '真实练习待真实环境人工验收。');
    if (
      !this.active ||
      this.cancelled ||
      this.state !== 'MONITORING' ||
      this.operationBusy ||
      this.practiceAdmissionBusy
    )
      return this.result(false, 'TASK_NOT_RUNNING', '任务不允许进入练习。');
    if (real) {
      this.practiceAdmissionBusy = true;
      const signal = this.signal,
        epoch = this.epoch;
      try {
        if (!(await cancellable(this.practiceGrant!.claim(signal), signal)))
          return this.result(
            false,
            'PRACTICE_CLAIM_USED',
            '单次练习授权已消费或不可写，禁止重放。',
          );
        this.realPracticeClaimed = true;
        this.requireActive(signal, epoch);
        if (!validPracticeGrant(this.practiceGrant!)) throw new Cancelled();
      } catch {
        return this.result(false, 'PRACTICE_LOCKED', '练习授权已失效或取消。');
      } finally {
        this.practiceAdmissionBusy = false;
      }
    }
    this.practiceStart = this.operations.length;
    this.change(
      'PRACTICE_ACTIVE',
      real ? '受控非计分练习单次验收中。' : '本地非计分练习模拟辅助中。',
    );
    return this.save('PRACTICE_STARTED');
  }

  async endPractice(): Promise<Result<TaskView>> {
    if (this.state !== 'PRACTICE_ACTIVE' || this.cancelled || this.operationBusy)
      return this.result(false, 'TASK_NOT_RUNNING', '练习已暂停。');
    this.change('MONITORING', '本地练习模拟结束；真实站点待真实环境人工验收。');
    return this.save('PRACTICE_COMPLETED');
  }

  constructor(private readonly options: TaskEngineOptions) {
    if (options.stage3VerifiedPractice)
      this.practiceGrant = Object.freeze({ ...options.stage3VerifiedPractice });
    this.controller.abort();
  }

  view(): TaskView {
    return {
      state: this.state,
      taskId: this.taskId,
      reason: this.reason,
      cancelled: this.cancelled,
      persistenceHealthy: this.persistenceHealthy,
    };
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get confirmedCourse(): string | null {
    return this.confirmedCourseId;
  }

  get confirmedSource(): CourseObservation['source'] | null {
    return this.confirmedCourseSource;
  }

  get refreshAttempts(): number {
    return this.operations.filter(
      (entry) => entry.taskId === this.taskId && entry.kind === 'page-refresh',
    ).length;
  }

  /** P0 cancellation happens before any persistence wait; media state is left untouched. */
  async suspend(reason: string, clearConfirmation = false): Promise<Result<TaskView>> {
    if (clearConfirmation) this.clearConfirmation();
    this.cancel('PAUSED', reason);
    return this.save('TASK_SUSPENDED');
  }

  /** Persist only reliable schema-1 IDs and explicit platform markers, never player samples. */
  async recordObservation(observation: SiteObservation): Promise<Result<TaskView>> {
    const epoch = this.epoch;
    await this.init();
    if (!this.persistenceHealthy)
      return this.result(false, 'STATE_WRITE_FAILED', '关键状态不可写，禁止自动操作。');
    if (epoch !== this.epoch || !this.active || this.cancelled)
      return this.result(false, 'TASK_NOT_RUNNING', '任务已暂停或尚未开始。');
    if (
      !this.confirmedCourseId ||
      !this.validObservation(observation.course, this.confirmedCourseId, true)
    ) {
      await this.suspend('登录、课程或页面性质已变化，请重新人工确认。', true);
      return this.result(false, 'COURSE_UNVERIFIED', '当前观察不属于已确认的可靠课程。');
    }
    const chapterIds = new Set<string>();
    const reliable =
      observation.chapters.length <= 10000 &&
      observation.chapters.every((chapter) => {
        const age = Date.now() - Date.parse(chapter.observedAt);
        if (
          !/^[a-zA-Z0-9_-]{1,128}$/.test(chapter.chapterId) ||
          chapterIds.has(chapter.chapterId) ||
          chapter.confidence !== 'verified' ||
          !Number.isFinite(age) ||
          age < -5000 ||
          age > 30000 ||
          ![true, false, null].includes(chapter.platformCompleted)
        )
          return false;
        chapterIds.add(chapter.chapterId);
        return true;
      });
    if (
      !reliable ||
      observation.currentChapterId === null ||
      !chapterIds.has(observation.currentChapterId)
    ) {
      await this.suspend('章节观察缺失或不可靠，请人工核验。');
      return this.result(false, 'CHAPTER_UNVERIFIED', '章节观察无法可靠保存。');
    }
    this.chapterId = observation.currentChapterId;
    this.platformStatuses = observation.chapters
      .filter((chapter) => chapter.platformCompleted !== null)
      .map((chapter) => ({
        chapterId: chapter.chapterId,
        completed: chapter.platformCompleted!,
        observedAt: chapter.observedAt,
      }));
    return this.save('OBSERVATION_SAVED');
  }

  init(): Promise<Result<TaskView>> {
    this.initialization ??= this.initialize();
    return this.initialization;
  }

  async browserConnected(): Promise<Result<TaskView>> {
    await this.init();
    this.connected = true;
    if (this.state === 'IDLE') this.change('WAIT_LOGIN', '请在专用 Edge 中手动登录并进入课程。');
    return this.save('BROWSER_CONNECTED');
  }

  async browserDisconnected(): Promise<Result<TaskView>> {
    this.connected = false;
    this.clearConfirmation();
    this.cancel('PAUSED', '浏览器已断开，请重新连接并人工确认课程。');
    return this.save('BROWSER_DISCONNECTED');
  }

  async confirmCourse(observation: CourseObservation, courseId: string): Promise<Result<TaskView>> {
    await this.init();
    if (!this.persistenceHealthy)
      return this.result(false, 'STATE_WRITE_FAILED', '关键状态不可写，禁止自动操作。');
    if (!this.connected) return this.result(false, 'BROWSER_DISCONNECTED', '请先连接专用 Edge。');
    if (this.active || this.commandBusy)
      return this.result(false, 'TASK_BUSY', '请先暂停当前任务。');
    if (!this.validObservation(observation, courseId, false)) {
      this.clearConfirmation();
      this.cancel('PAUSED', '课程或页面性质无法可靠确认，请人工处理。');
      await this.save('COURSE_UNVERIFIED');
      return this.result(false, 'COURSE_UNVERIFIED', '课程或页面性质尚未可靠识别。');
    }
    if (this.courseId !== courseId) {
      this.chapterId = null;
      this.platformStatuses = [];
      this.taskId = null;
    }
    this.courseId = courseId;
    this.confirmedCourseId = courseId;
    this.confirmedCourseSource = observation.source;
    this.change(
      this.state === 'PAUSED' && this.taskId ? 'PAUSED' : 'COURSE_CONFIRM',
      observation.source === 'zhihuishu-dom'
        ? '用户已确认真实 DOM 课程；仅启用已核验能力，待真实环境人工验收。'
        : '用户已确认当前本机模拟课程，可手动开始阶段 2 监测。',
    );
    this.options.logger?.log('INFO', 'task', 'COURSE_CONFIRMED');
    return this.save('COURSE_CONFIRMED');
  }

  start(): Promise<Result<TaskView>> {
    return this.activate(false);
  }
  resume(): Promise<Result<TaskView>> {
    return this.activate(true);
  }

  /** Internal stage-3 acceptance only. Never called by ordinary desktop start/resume or IPC. */
  startAfterManualPracticeReview(
    authorization: ManualPracticeReviewAuthorization,
  ): Promise<Result<TaskView>> {
    return this.activate(false, authorization);
  }

  async pause(): Promise<Result<TaskView>> {
    // P0 is synchronous up to the first await, even while a store or worker is waiting.
    this.cancel('PAUSED', '用户已暂停自动任务；Edge 页面与播放状态保持不变。');
    this.options.logger?.log('INFO', 'task', 'TASK_PAUSED');
    return this.save('TASK_PAUSED');
  }

  async stop(): Promise<Result<TaskView>> {
    this.cancel('IDLE', '用户已停止自动任务；浏览器保持打开。');
    this.clearConfirmation();
    this.options.logger?.log('INFO', 'task', 'TASK_STOPPED');
    return this.save('TASK_STOPPED');
  }

  /** Minimal guarded executor for future modules, exercised only by fixture capabilities in stage 1. */
  async execute(operation: GuardedOperation): Promise<Result<TaskView>> {
    const practice = operation.kind.startsWith('practice-');
    if (
      practice &&
      !(this.confirmedSource === 'fixture' && this.options.stage3FixturePractice) &&
      !(
        this.confirmedSource === 'zhihuishu-dom' &&
        this.realPracticeClaimed &&
        this.practiceGrant &&
        this.practiceGrant.courseId === this.confirmedCourse &&
        validPracticeGrant(this.practiceGrant)
      )
    )
      return this.result(false, 'PRACTICE_LOCKED', '练习动作仅允许受控fixture。');
    if (operation.kind === 'playback-rate')
      return this.result(
        false,
        'AUTOMATIC_RATE_DISABLED',
        '自动调速已移除，请在网页中手动设置倍速。',
      );
    if (!this.capability())
      return this.result(false, 'STAGE_UNAVAILABLE', '阶段 1 未启用网页自动动作。');
    if (
      ![
        'fixture-mutation',
        'recovery',
        'page-refresh',
        'playback-start',
        'chapter-navigation',
        'practice-pause',
        'practice-submit',
        'practice-correct',
        'practice-close',
        'practice-restore',
      ].includes(operation.kind) ||
      (operation.kind === 'fixture-mutation' && !this.options.testCapabilities?.enabled)
    )
      return this.result(false, 'INVALID_OPERATION', '当前任务不支持该动作类型。');
    if (!this.persistenceHealthy)
      return this.result(false, 'STATE_WRITE_FAILED', '关键状态不可写，禁止自动操作。');
    if (
      !this.active ||
      this.cancelled ||
      this.state !== (practice ? 'PRACTICE_ACTIVE' : 'MONITORING')
    )
      return this.result(false, 'TASK_NOT_RUNNING', '任务尚未开始或已暂停。');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operation.operationId))
      return this.result(false, 'INVALID_OPERATION', '操作标识无效。');
    if (this.operations.some((entry) => entry.operationId === operation.operationId)) {
      return this.result(
        false,
        'DUPLICATE_OPERATION',
        '已有操作记录，禁止重复执行；未知结果必须人工核验。',
      );
    }
    if (this.operationBusy) return this.result(false, 'OPERATION_BUSY', '已有操作执行中。');
    if (practice) {
      const session = this.operations.slice(this.practiceStart);
      if (session.some((entry) => entry.kind === operation.kind))
        return this.result(false, 'PRACTICE_BUDGET', '同一练习各类动作最多一次。');
      if (
        operation.kind === 'practice-correct' &&
        !session.some((entry) => entry.kind === 'practice-submit' && entry.status === 'completed')
      )
        return this.result(false, 'PRACTICE_BUDGET', '首次提交未确认，不允许纠正。');
    }
    if (this.operations.length >= 1000)
      return this.result(false, 'LEDGER_FULL', '操作记录已达阶段 1 限额。');
    if (operation.kind === 'page-refresh' && this.refreshAttempts >= 1)
      return this.result(false, 'REFRESH_LIMIT', '当前任务已记录刷新，禁止再次刷新。');
    const cooldownKind =
      operation.kind === 'page-refresh'
        ? 'recovery'
        : operation.kind === 'practice-correct'
          ? 'practice-submit'
          : operation.kind;
    const elapsed = Date.now() - (this.cooldown.get(cooldownKind) ?? Number.NEGATIVE_INFINITY);
    if (operation.kind !== 'fixture-mutation' && elapsed < RECOVERY_COOLDOWN_MS) {
      return this.result(false, 'RECOVERY_COOLDOWN', '同类恢复动作须间隔 5 秒。');
    }
    this.operationBusy = true;
    const signal = this.controller.signal;
    const epoch = this.epoch;
    let record: OperationRecord | null = null;
    let issued = false;
    try {
      await this.requireSafePage(signal, epoch);
      if (operation.prepare) await cancellable(operation.prepare(signal), signal);
      this.requireActive(signal, epoch);
      await this.requireSafePage(signal, epoch);
      record = {
        operationId: operation.operationId,
        taskId: this.taskId!,
        kind: operation.kind,
        status: 'pending',
        savedAt: new Date().toISOString(),
      };
      this.operations.push(record);
      if (!(await this.save('OPERATION_INTENT')).ok)
        return this.result(false, 'STATE_WRITE_FAILED', '操作意图保存失败，未发出网页动作。');
      this.requireActive(signal, epoch);
      record.status = 'executing';
      record.savedAt = new Date().toISOString();
      if (!(await this.save('OPERATION_EXECUTING')).ok)
        return this.result(false, 'STATE_WRITE_FAILED', '执行状态保存失败，未发出网页动作。');
      await this.requireSafePage(signal, epoch);
      this.requireActive(signal, epoch);
      // No await between the final cancellation check and issuing the effect.
      issued = true;
      if (practice) this.issuingPracticeId = operation.operationId;
      this.cooldown.set(cooldownKind, Date.now());
      await cancellable(operation.issue(signal), signal);
      record.status = 'awaiting-confirmation';
      record.savedAt = new Date().toISOString();
      if (!(await this.save('OPERATION_AWAITING_CONFIRMATION')).ok)
        return this.result(false, 'STATE_WRITE_FAILED', '操作结果尚未确认，禁止重新发出。');
      this.requireActive(signal, epoch);
      const verified = await cancellable(operation.verify(signal), signal);
      this.requireActive(signal, epoch);
      if (verified === 'unknown') {
        this.cancel('PAUSED', '操作已发出但结果未知；禁止重复执行，请人工核验。');
        await this.save('OPERATION_UNCONFIRMED');
        return this.result(false, 'OPERATION_UNCONFIRMED', '操作结果未知，禁止重发。');
      }
      record.status = verified === 'confirmed' ? 'completed' : 'failed';
      record.savedAt = new Date().toISOString();
      if (verified === 'failed') this.cancel('PAUSED', '操作反馈显示失败，请人工检查。');
      const saved = await this.save(
        verified === 'confirmed' ? 'OPERATION_COMPLETED' : 'OPERATION_FAILED',
      );
      if (!saved.ok) return saved;
      return this.result(
        verified === 'confirmed',
        verified === 'confirmed' ? 'OPERATION_COMPLETED' : 'OPERATION_FAILED',
        verified === 'confirmed' ? '操作反馈已核验；不代表平台课程完成。' : '操作反馈显示失败。',
      );
    } catch (error) {
      if (record) {
        record.status =
          issued || record.status === 'executing' ? 'awaiting-confirmation' : 'failed';
        record.savedAt = new Date().toISOString();
      }
      if (!(error instanceof Cancelled))
        this.cancel('PAUSED', '网页状态或操作结果无法可靠确认，请人工处理。');
      if (record) await this.save('OPERATION_UNCONFIRMED');
      return this.result(
        false,
        error instanceof Cancelled ? 'CANCELLED' : 'UNSAFE_PAGE_OR_RESULT',
        issued ? '已发动作结果待确认，禁止重发。' : '操作已安全取消或被安全校验阻止。',
      );
    } finally {
      this.issuingPracticeId = null;
      this.operationBusy = false;
    }
  }

  private async initialize(): Promise<Result<TaskView>> {
    try {
      const snapshot = await this.options.store.load();
      if (snapshot) {
        this.taskId = snapshot.taskId;
        this.courseId = snapshot.courseId;
        this.chapterId = snapshot.chapterId;
        this.operations = snapshot.pendingOperations.map((entry) => ({
          ...entry,
          status: entry.status === 'executing' ? 'awaiting-confirmation' : entry.status,
        }));
        this.platformStatuses = snapshot.confirmedPlatformStatuses;
        if (snapshot.taskId || !['IDLE', 'WAIT_LOGIN', 'COURSE_CONFIRM'].includes(snapshot.state)) {
          this.cancel('PAUSED', '发现既有任务；请重新连接并人工核验，程序不会自动继续。');
          this.options.logger?.log('WARNING', 'task', 'STATE_RECOVERY_REQUIRED');
        }
      }
      return this.save('TASK_INITIALIZED');
    } catch {
      this.persistenceFailed();
      return this.result(
        false,
        'STATE_UNAVAILABLE',
        '状态版本不兼容、损坏或不可读；已保留原文件并禁止自动操作。',
      );
    }
  }

  private async activate(
    resuming: boolean,
    authorization?: ManualPracticeReviewAuthorization,
  ): Promise<Result<TaskView>> {
    await this.init();
    if (!this.persistenceHealthy)
      return this.result(false, 'STATE_WRITE_FAILED', '关键状态不可写，禁止自动操作。');
    const capability = this.capability();
    if (!capability?.enabled)
      return this.result(
        false,
        'STAGE_UNAVAILABLE',
        '阶段 1 仅提供控制台与安全底座；监测和任务前备份尚未实现。',
      );
    if (this.commandBusy || this.active)
      return this.result(false, 'TASK_BUSY', '任务已启动或正在处理命令。');
    if (!this.connected || !this.confirmedCourseId)
      return this.result(false, 'COURSE_NOT_CONFIRMED', '请先连接浏览器并人工确认当前课程。');
    if (resuming && this.state !== 'PAUSED')
      return this.result(false, 'INVALID_STATE', '仅暂停状态可继续。');
    const review =
      authorization ??
      (resuming && this.taskId === this.manualReviewTaskId ? this.manualReview : undefined);
    const unknown = this.operations.some((entry) =>
      ['executing', 'awaiting-confirmation'].includes(entry.status),
    );
    if (
      unknown &&
      !(
        review &&
        validManualPracticeReview(review) &&
        !this.operationBusy &&
        !this.practiceAdmissionBusy &&
        review.permits(this.operations, this.confirmedCourseId, resuming ? this.taskId! : undefined)
      )
    ) {
      return this.result(
        false,
        'UNCONFIRMED_OPERATION',
        '存在结果未知的操作，必须人工核验后再继续。',
      );
    }
    if (authorization && (!unknown || !this.options.stage2Capabilities?.enabled))
      return this.result(false, 'MANUAL_REVIEW_REJECTED', '人工决定仅用于阶段3新任务单次复验。');
    this.commandBusy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const epoch = ++this.epoch;
    this.cancelled = false;
    try {
      const observation = await cancellable(capability.inspect(signal), signal);
      if (!this.validObservation(observation, this.confirmedCourseId, true))
        throw new Error('UNSAFE');
      if (review) await cancellable(review.verify(signal, !resuming), signal);
      if (!(await cancellable(capability.backup(signal), signal))) {
        this.cancel('PAUSED', '任务前备份失败，禁止开始。');
        await this.save('BACKUP_FAILED');
        return this.result(false, 'BACKUP_FAILED', '任务前备份失败，禁止开始。');
      }
      if (signal.aborted || epoch !== this.epoch) throw new Cancelled();
      if (authorization) {
        const freshTaskId = randomUUID();
        if (!authorization.permits(this.operations, this.confirmedCourseId))
          throw new Error('REVIEW_CHANGED');
        await cancellable(authorization.claim(freshTaskId, signal), signal);
        await cancellable(authorization.verify(signal, true), signal);
        if (signal.aborted || epoch !== this.epoch) throw new Cancelled();
        this.manualReview = authorization;
        this.manualReviewTaskId = freshTaskId;
        this.taskId = freshTaskId;
        this.chapterId = authorization.chapterId;
      } else if (this.options.stage2Capabilities && !resuming) this.taskId = randomUUID();
      else this.taskId ??= randomUUID();
      this.change(
        'MONITORING',
        observation.source === 'zhihuishu-dom'
          ? '真实 DOM 课程正在监测；仅启用已核验能力，待真实环境人工验收。'
          : '本机模拟课程正在监测；真实站点待人工验收。',
      );
      const saved = await this.save(resuming ? 'TASK_RESUMED' : 'TASK_STARTED');
      if (!saved.ok) return saved;
      if (signal.aborted || epoch !== this.epoch) throw new Cancelled();
      this.active = true;
      this.options.logger?.log('INFO', 'task', resuming ? 'TASK_RESUMED' : 'TASK_STARTED');
      return this.result(
        true,
        resuming ? 'TASK_RESUMED' : 'TASK_STARTED',
        observation.source === 'zhihuishu-dom'
          ? '真实 DOM 监测已开始；待真实环境人工验收。'
          : '本机模拟监测已开始。',
      );
    } catch (error) {
      if (error instanceof Cancelled) return this.result(false, 'CANCELLED', '启动已取消。');
      this.clearConfirmation();
      this.cancel('PAUSED', '登录、课程或页面性质无法可靠确认，请人工处理。');
      await this.save('COURSE_UNVERIFIED');
      return this.result(
        false,
        review ? 'MANUAL_REVIEW_REJECTED' : 'COURSE_UNVERIFIED',
        '真实页面状态不满足安全条件。',
      );
    } finally {
      this.commandBusy = false;
    }
  }

  private validObservation(
    observation: CourseObservation,
    courseId: string,
    requireCapability: boolean,
  ): boolean {
    const age = Date.now() - Date.parse(observation.observedAt);
    return (
      /^[a-zA-Z0-9_-]{1,128}$/.test(courseId) &&
      observation.courseId === courseId &&
      observation.authenticated === true &&
      observation.pageKind === 'course' &&
      observation.confidence === 'verified' &&
      !observation.evidence.some((item) => item.startsWith('READ_ONLY_PREVIEW：')) &&
      (observation.source === 'fixture' ||
        (observation.source === 'zhihuishu-dom' &&
          this.options.stage2Capabilities?.enabled === true &&
          !this.options.testCapabilities?.enabled)) &&
      (!requireCapability ||
        (this.capability()?.enabled === true &&
          observation.source === this.confirmedCourseSource)) &&
      Number.isFinite(age) &&
      age >= -5000 &&
      age <= 30000
    );
  }

  private async requireSafePage(signal: AbortSignal, epoch: number): Promise<void> {
    this.requireActive(signal, epoch);
    const observation = await cancellable(this.capability()!.inspect(signal), signal);
    this.requireActive(signal, epoch);
    if (
      !this.confirmedCourseId ||
      !this.validObservation(observation, this.confirmedCourseId, true)
    ) {
      this.clearConfirmation();
      this.cancel('PAUSED', '课程、登录或页面性质已变化，已阻止网页动作。');
      await this.save('COURSE_UNVERIFIED');
      throw new Error('UNSAFE');
    }
    if (this.manualReview && this.taskId === this.manualReviewTaskId) {
      await cancellable(this.manualReview.verify(signal), signal);
      this.requireActive(signal, epoch);
    }
  }

  private requireActive(signal: AbortSignal, epoch: number): void {
    if (
      this.manualReview &&
      this.taskId === this.manualReviewTaskId &&
      !validManualPracticeReview(this.manualReview)
    ) {
      this.cancel('PAUSED', '本次人工处理许可已过期，请重新核验。');
      throw new Cancelled();
    }
    if (
      this.state === 'PRACTICE_ACTIVE' &&
      this.realPracticeClaimed &&
      this.practiceGrant &&
      !validPracticeGrant(this.practiceGrant)
    ) {
      this.cancel('PAUSED', '单次真实练习授权已过期。');
      throw new Cancelled();
    }
    if (
      signal.aborted ||
      epoch !== this.epoch ||
      !this.active ||
      this.cancelled ||
      !this.persistenceHealthy
    )
      throw new Cancelled();
  }

  private clearConfirmation(): void {
    this.confirmedCourseId = null;
    this.confirmedCourseSource = null;
  }

  private cancel(state: TaskState, reason: string): void {
    this.active = false;
    this.cancelled = true;
    this.epoch++;
    this.controller.abort();
    for (const record of this.operations) {
      if (record.status === 'executing') record.status = 'awaiting-confirmation';
    }
    this.change(state, reason);
  }

  private change(state: TaskState, reason: string): void {
    this.state = state;
    this.reason = reason;
    try {
      this.options.onChange?.(this.view());
    } catch {
      /* Observers cannot bypass the engine. */
    }
  }

  private async save(code: string): Promise<Result<TaskView>> {
    if (!this.persistenceHealthy)
      return this.result(false, 'STATE_WRITE_FAILED', '关键状态不可写，已禁止自动操作。');
    const snapshot: SnapshotInput = {
      schemaVersion: 1,
      taskId: this.taskId,
      courseId: this.courseId,
      chapterId: this.chapterId,
      savedAt: new Date().toISOString(),
      state: this.state,
      pendingOperations: structuredClone(this.operations),
      confirmedPlatformStatuses: structuredClone(this.platformStatuses),
    };
    try {
      await this.options.store.write(snapshot);
    } catch {
      this.persistenceFailed();
      return this.result(false, 'STATE_WRITE_FAILED', '关键状态无法保存；已禁止新的网页自动操作。');
    }
    return this.result(true, code, this.reason);
  }

  private persistenceFailed(): void {
    this.persistenceHealthy = false;
    this.cancel('PAUSED', '关键状态无法可靠保存；请修复数据目录并重新启动。');
    this.options.logger?.log('CRITICAL', 'task', 'STATE_WRITE_FAILED');
  }

  private capability(): Stage2Capabilities | FixtureCapabilities | undefined {
    return this.options.stage2Capabilities ?? this.options.testCapabilities;
  }

  private result(ok: boolean, code: string, message: string): Result<TaskView> {
    return { ok, code, message, correlationId: randomUUID(), data: this.view() };
  }
}
