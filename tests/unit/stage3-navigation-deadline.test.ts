import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { BrowserNavigationCandidate } from '../../packages/site-adapter/src/browser-navigation-candidate';

// Model deadline ordering only; no browser, input, network, or persistence effects.
type DeadlinePort = {
  confirmTarget(expected: object, signal: AbortSignal): Promise<void>;
  invalidation: AbortController;
};
const loading = { kind: 'target-loading', reason: 'media-not-ready', generation: 1 };
const ready = { kind: 'target-ready', reason: 'target-ready', generation: 1 };
function candidate(evaluate = vi.fn().mockResolvedValue(loading)) {
  const page = { isClosed: () => false, evaluate } as unknown as Page;
  return new BrowserNavigationCandidate(page) as unknown as DeadlinePort;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('剩余总预算计时器比墙钟截止早1ms，仍归类为目标总超时', async () => {
  const clock = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => Math.min(clock(), 7999));
  const running = candidate().confirmTarget({}, new AbortController().signal);
  const rejected = expect(running).rejects.toThrow('CANDIDATE_TARGET_FEEDBACK_TIMEOUT');
  await Promise.all([vi.advanceTimersByTimeAsync(8000), rejected]);
});

it('8秒总预算尚充足时的独立3秒页面挂起仍是页面超时', async () => {
  const running = candidate(vi.fn(() => new Promise(() => {}))).confirmTarget(
    {},
    new AbortController().signal,
  );
  const rejected = expect(running).rejects.toThrow('CANDIDATE_PAGE_TIMEOUT');
  await Promise.all([vi.advanceTimersByTimeAsync(3000), rejected]);
});

it('总预算边界同时用户取消，保留取消原因', async () => {
  const clock = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => Math.min(clock(), 7999));
  const control = new AbortController();
  setTimeout(() => control.abort(new Error('USER_CANCELLED')), 8000);
  const running = candidate().confirmTarget({}, control.signal);
  const rejected = expect(running).rejects.toThrow('USER_CANCELLED');
  await Promise.all([vi.advanceTimersByTimeAsync(8000), rejected]);
});

it('总预算边界同时页面失效，保留失效原因', async () => {
  const clock = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => Math.min(clock(), 7999));
  const instance = candidate();
  setTimeout(() => instance.invalidation.abort(new Error('PAGE_INVALIDATED')), 8000);
  const running = instance.confirmTarget({}, new AbortController().signal);
  const rejected = expect(running).rejects.toThrow('PAGE_INVALIDATED');
  await Promise.all([vi.advanceTimersByTimeAsync(8000), rejected]);
});

it('第二次目标反馈恰好在总期限到达，不能迟到确认', async () => {
  const evaluate = vi.fn(() => {
    if (Date.now() >= 7950) return new Promise((resolve) => setTimeout(() => resolve(ready), 50));
    return Promise.resolve(Date.now() >= 7800 ? ready : loading);
  });
  const running = candidate(evaluate).confirmTarget({}, new AbortController().signal);
  const rejected = expect(running).rejects.toThrow('CANDIDATE_TARGET_FEEDBACK_TIMEOUT');
  await Promise.all([vi.advanceTimersByTimeAsync(8000), rejected]);
});
