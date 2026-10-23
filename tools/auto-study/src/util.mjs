import { randomInt } from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const rand = (min, max) => randomInt(min, max + 1);

export async function sleepRange([min, max]) {
  await sleep(rand(min, max));
}

export function pick(list) {
  if (!list || list.length === 0) return null;
  return list[randomInt(0, list.length)];
}

/** 带次数上限的重试；最后一次失败原样抛出。 */
export async function retry(fn, { attempts = 3, delay = 800, onError } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i);
    } catch (error) {
      lastError = error;
      if (onError) onError(error, i);
      if (i < attempts - 1) await sleep(delay);
    }
  }
  throw lastError;
}

export function ratio(current, duration) {
  if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) return 0;
  return current / duration;
}

export function short(text, max = 80) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 给任何 promise 加硬超时：Playwright 调用在页面/CDP 断掉时会永久挂起，必须兜住。 */
export async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超时 ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
