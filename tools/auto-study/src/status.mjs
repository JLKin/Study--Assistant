// 运行状态落盘：供控制台实时显示
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './browser.mjs';

const STATUS_FILE = join(STATE_DIR, 'status.json');
const ALERT_FILE = join(STATE_DIR, 'alert.json');

export function writeStatus(patch = {}) {
  mkdirSync(STATE_DIR, { recursive: true });
  const prev = readStatus();
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeAlert(patch) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ALERT_FILE, JSON.stringify({ ...patch, at: Date.now() }, null, 2), 'utf8');
}

export function readAlert() {
  try {
    return JSON.parse(readFileSync(ALERT_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function clearAlert() {
  writeAlert({ kind: null, message: null });
}
