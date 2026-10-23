// 提醒：响铃 + 窗口置顶 + 状态落盘（全部可由用户开关）
import { spawn } from 'node:child_process';
import { writeAlert, clearAlert } from './status.mjs';

/** 主板蜂鸣器/系统提示音：优先 PowerShell，失败退回 BEL 字符。 */
export function beep(times = 3, freq = 1200, ms = 500) {
  const script = `1..${times} | ForEach-Object { [console]::beep(${freq},${ms}); Start-Sleep -Milliseconds 150 }`;
  try {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch {
    process.stdout.write('\u0007');
    return false;
  }
}

/**
 * 触发一次提醒。
 * @param {{kind:string, message:string, page?:import('playwright').Page, logger?:any, config?:any}} opts
 */
export async function raiseAlert({ kind, message, page, logger, config = {} }) {
  const wantBeep = config.alertBeep !== false;
  const wantFront = config.alertBringToFront !== false;
  writeAlert({ kind, message, beep: wantBeep, front: wantFront });
  logger?.error(`【需要人工】${message}`, { kind, beep: wantBeep, front: wantFront });
  if (wantBeep) beep(3);
  if (wantFront && page) {
    await page.bringToFront?.().catch(() => {});
  }
  return true;
}

export { clearAlert };
