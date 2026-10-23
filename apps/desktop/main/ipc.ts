import {
  COMMANDS,
  type CommandEnvelope,
  type Result,
} from '../../../packages/contracts/src/index.js';
import { CONFIG_VALIDATORS, isRecord } from '../../../packages/contracts/src/config.js';

export const COMMAND_CHANNEL = 'study:command';
export const EVENT_CHANNEL = 'study:event';

/** 允许在设置界面里改的刷课参数（与 tools/auto-study 的 config.json 同名）。 */
export const AUTO_SETTING_KEYS = new Set([
  'progressThreshold',
  'pollIntervalMs',
  'popupPollIntervalMs',
  'playStallMs',
  'stallReloadMs',
  'maxPopupActionsPerVideo',
  'answerDelayMs',
  'afterCloseDelayMs',
  'afterSwitchDelayMs',
  'restartFromZero',
  'captchaWaitMs',
  'alertBeep',
  'alertBringToFront',
  'stopOnDetection',
  'startUrl',
]);
export interface SenderIdentity {
  senderId: number;
  expectedSenderId: number;
  frameUrl: string;
  expectedUrl: string;
  isMainFrame: boolean;
}
export function validateSender(sender: SenderIdentity): boolean {
  return (
    sender.senderId === sender.expectedSenderId &&
    sender.isMainFrame &&
    sender.frameUrl === sender.expectedUrl
  );
}
export function parseCommand(input: unknown): CommandEnvelope | null {
  if (
    !isRecord(input) ||
    Object.keys(input).some((k) => !['command', 'correlationId', 'payload'].includes(k))
  )
    return null;
  if (!COMMANDS.includes(input.command as CommandEnvelope['command'])) return null;
  if (typeof input.correlationId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(input.correlationId))
    return null;
  if (input.command === 'settings.update') {
    if (!isRecord(input.payload) || Object.keys(input.payload).length === 0) return null;
    for (const [key, value] of Object.entries(input.payload)) {
      if (key === 'schemaVersion' || !Object.hasOwn(CONFIG_VALIDATORS, key)) return null;
      // Illegal numeric values are repaired per item; reject strings, nested objects and sensitive keys.
      const expected =
        key === 'logLevel'
          ? 'string'
          : ['notificationsEnabled', 'practiceAllowFullText'].includes(key)
            ? 'boolean'
            : 'number';
      if (typeof value !== expected) return null;
      if (typeof value === 'number' && !Number.isFinite(value)) return null;
      if (key === 'logLevel' && !CONFIG_VALIDATORS.logLevel(value)) return null;
    }
  } else if (input.command === 'course.confirm') {
    if (
      !isRecord(input.payload) ||
      Object.keys(input.payload).length !== 1 ||
      typeof input.payload.courseId !== 'string' ||
      !/^[\w-]{1,128}$/.test(input.payload.courseId)
    )
      return null;
  } else if (input.command === 'auto.start') {
    // 可选：{ course?: string } —— 课程名留空表示全部课程
    if (input.payload !== undefined) {
      if (!isRecord(input.payload)) return null;
      if (Object.keys(input.payload).some((k) => k !== 'course')) return null;
      if (input.payload.course !== undefined) {
        if (typeof input.payload.course !== 'string') return null;
        if (!/^[\u4e00-\u9fa5\w·()（）\- ]{1,40}$/.test(input.payload.course)) return null;
      }
    }
  } else if (input.command === 'auto.config.save') {
    // 只允许改已知的刷课参数，类型限定 number / boolean / [number, number]
    if (!isRecord(input.payload) || Object.keys(input.payload).length === 0) return null;
    if (Object.keys(input.payload).some((key) => !AUTO_SETTING_KEYS.has(key))) return null;
    for (const [key, value] of Object.entries(input.payload)) {
      if (key === 'startUrl') {
        // 网址：空字符串表示回到默认入口，其余必须是 http(s)
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        if (trimmed !== '' && !/^https?:\/\/[^\s]+$/i.test(trimmed)) return null;
        continue;
      }
      if (typeof value === 'boolean') continue;
      if (typeof value === 'number' && Number.isFinite(value)) continue;
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        value.every((item) => typeof item === 'number' && Number.isFinite(item))
      )
        continue;
      return null;
    }
  } else if (input.payload !== undefined) return null;
  return input as unknown as CommandEnvelope;
}
export function rejected(code: string, correlationId = 'rejected-command'): Result {
  return {
    ok: false,
    code,
    message: code === 'FORBIDDEN' ? '请求来源不受信任' : '命令或参数不合法',
    correlationId,
  };
}
