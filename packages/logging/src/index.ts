import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEntry } from '../../contracts/src/index';

export const LOG_MESSAGES = {
  APP_STARTED: '应用已启动。',
  APP_STOPPING: '应用正在退出，专用 Edge 将保留。',
  APP_FAILED: '应用操作失败，请查看自检。',
  BROWSER_OPENED: '专用 Edge 已连接，请手动登录。',
  BROWSER_DISCONNECTED: '浏览器连接断开，自动任务已暂停。',
  BROWSER_FAILED: '浏览器操作失败，请检查 Edge 和专用目录。',
  CONFIG_LOADED: '配置已读取。',
  CONFIG_REPAIRED: '非法配置项已修复，请检查设置。',
  CONFIG_FAILED: '配置不可用，任务已锁止。',
  SELF_CHECK_COMPLETE: '环境自检已完成。',
  TASK_STATE_CHANGED: '任务状态已更新。',
  TASK_PAUSED: '自动任务已暂停，浏览器播放状态保持不变。',
  TASK_STARTED: '课程监测已开始，按当前已核验能力执行受保护动作。',
  TASK_RESUMED: '用户已明确继续课程监测。',
  TASK_STOPPED: '自动任务已停止，浏览器保持打开。',
  TASK_BLOCKED: '自动任务启动条件未满足。',
  STATE_WRITE_FAILED: '关键状态无法保存，已禁止新的网页自动操作。',
  STATE_RECOVERY_REQUIRED: '发现既有任务状态，需要人工确认后恢复。',
  COURSE_UNVERIFIED: '课程信息尚未可靠识别，禁止自动操作。',
  SITE_AUTOMATION_RESTRICTED: '用户报告平台检测到脚本执行；真实适配入口已锁止，停止网页自动操作。',
  COURSE_OBSERVED: '已读取课程观察，请核对后人工确认；真实站点待真实环境人工验收。',
  COURSE_CONFIRMED: '用户已确认当前课程。',
  COMMAND_REJECTED: '命令被安全校验拒绝。',
  LOG_WRITE_FAILED: '普通日志暂时无法写入。',
  LOG_BUFFER_FULL: '普通日志缓冲已满，需要处理。',
  UNKNOWN_EVENT: '未识别的运行事件。',
} as const;
export type LogCode = keyof typeof LOG_MESSAGES;

export interface LoggerOptions {
  onFailure?: () => void;
}

/** Only fixed messages are accepted. Raw errors, URLs and website text never enter this queue. */
export class Logger {
  private entries: LogEntry[] = [];
  private pending: string[] = [];
  private pendingBytes = 0;
  private running: Promise<void> | null = null;
  private failed = false;
  private overflow = false;
  private failureNotified = false;
  private readonly directory: string;

  constructor(
    dataDir: string,
    private readonly options: LoggerOptions = {},
  ) {
    this.directory = join(dataDir, 'logs');
  }

  get healthy(): boolean {
    return !this.failed && !this.overflow;
  }

  log(level: LogEntry['level'], module: LogEntry['module'], inputCode: string): void {
    const code: LogCode = Object.hasOwn(LOG_MESSAGES, inputCode)
      ? (inputCode as LogCode)
      : 'UNKNOWN_EVENT';
    const safeLevel = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].includes(level)
      ? level
      : 'WARNING';
    const safeModule = ['app', 'browser', 'task', 'config', 'system', 'security'].includes(module)
      ? module
      : 'security';
    const entry: LogEntry = {
      at: new Date().toISOString(),
      level: safeLevel,
      module: safeModule,
      code,
      message: LOG_MESSAGES[code],
    };
    const serialized = `${JSON.stringify(entry)}\n`;
    const bytes = Buffer.byteLength(serialized);
    if (this.pending.length >= 500 || this.pendingBytes + bytes > 1024 * 1024) {
      this.overflow = true;
      this.notifyFailure();
      return;
    }
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries.shift();
    this.pending.push(serialized);
    this.pendingBytes += bytes;
    void this.drain();
  }

  readEntries(): LogEntry[] {
    return structuredClone(this.entries);
  }

  async flush(timeoutMs = 3000): Promise<boolean> {
    const limit = Math.max(0, Math.min(3000, timeoutMs));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          do {
            await this.drain();
          } while (this.pending.length && !this.failed);
          return this.pending.length === 0 && !this.overflow;
        })(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), limit);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private notifyFailure(): void {
    if (this.failureNotified) return;
    // Mark before invoking: a task pause may itself log into this full queue.
    this.failureNotified = true;
    try {
      this.options.onFailure?.();
    } catch {
      /* A UI observer cannot change queue safety. */
    }
  }

  private drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        await mkdir(this.directory, { recursive: true });
        while (this.pending.length) {
          const item = this.pending[0];
          const date = (JSON.parse(item) as LogEntry).at.slice(0, 10);
          await appendFile(join(this.directory, `${date}.jsonl`), item, 'utf8');
          this.pending.shift();
          this.pendingBytes -= Buffer.byteLength(item);
        }
        this.failed = false;
        if (!this.overflow) this.failureNotified = false;
      } catch {
        this.failed = true;
        this.notifyFailure();
      }
    })().finally(() => {
      this.running = null;
      if (this.pending.length && !this.failed) void this.drain();
    });
    return this.running;
  }
}
