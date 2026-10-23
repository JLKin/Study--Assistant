import { SCHEMA_VERSION, type AppConfig, type ConfigIssue } from './index.js';

export const DEFAULT_CONFIG: Readonly<AppConfig> = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  pollIntervalMs: 3000,
  targetPlaybackRate: 1.5,
  bufferTimeoutMs: 30000,
  stallTimeoutMs: 15000,
  logLevel: 'INFO',
  logRetentionDays: 30,
  notificationsEnabled: true,
  practiceAllowFullText: false,
  practiceConfidenceThreshold: 70,
});
const integerBetween = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export const CONFIG_VALIDATORS: Record<keyof AppConfig, (value: unknown) => boolean> = {
  schemaVersion: (v) => v === 1,
  pollIntervalMs: (v) => integerBetween(v, 1000, 10000),
  targetPlaybackRate: (v) => [1, 1.25, 1.5].includes(v as number),
  bufferTimeoutMs: (v) => integerBetween(v, 10000, 300000),
  stallTimeoutMs: (v) => integerBetween(v, 5000, 120000),
  logLevel: (v) => ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].includes(v as string),
  logRetentionDays: (v) => integerBetween(v, 1, 365),
  notificationsEnabled: (v) => typeof v === 'boolean',
  practiceAllowFullText: (v) => typeof v === 'boolean',
  practiceConfidenceThreshold: (v) => integerBetween(v, 0, 100),
};
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function repairConfig(input: unknown): { config: AppConfig; issues: ConfigIssue[] } {
  if (!isRecord(input)) throw new Error('CONFIG_UNREADABLE');
  if ('schemaVersion' in input && input.schemaVersion !== 1) throw new Error('SCHEMA_UNSUPPORTED');
  const config = { ...DEFAULT_CONFIG };
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof AppConfig>) {
    // Additive schema-1 defaults: absence in legacy settings is not an invalid value.
    if (!(key in input) && ['practiceAllowFullText', 'practiceConfidenceThreshold'].includes(key))
      continue;
    if (CONFIG_VALIDATORS[key](input[key])) {
      Object.assign(config, { [key]: input[key] });
    } else {
      issues.push({
        key,
        reason: '类型、范围或枚举无效，已回退该项默认值',
        requiresConfirmation: ['pollIntervalMs', 'bufferTimeoutMs', 'stallTimeoutMs'].includes(key),
      });
    }
  }
  // Each valid polling interval is <= both default timeouts, so only dependent fields need repair.
  for (const key of ['bufferTimeoutMs', 'stallTimeoutMs'] as const) {
    if (config[key] < config.pollIntervalMs) {
      config[key] = DEFAULT_CONFIG[key];
      issues.push({
        key,
        reason: '不得小于轮询间隔，已回退该项默认值',
        requiresConfirmation: true,
      });
    }
  }
  return { config, issues };
}
