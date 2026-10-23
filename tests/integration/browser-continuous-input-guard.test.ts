import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import { BrowserContinuousInputGuard } from '../../packages/site-adapter/src/browser-continuous-input-guard';

const childName = `zhsCandidateScope_${'a'.repeat(32)}`;
const address = 'https://continuous-guard.invalid/fixture';
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
.video-study{width:600px}video{width:240px;height:140px}.catalogue_title{display:block;width:200px;height:40px}
</style></head><body><p>仅本地离线守卫fixture，不是真实课程。</p><main class="video-study">
<div id="vjs_container"><video id="vjs_container_html5_api" src="/fixture.webm" muted preload="auto"></video></div>
<ul class="chapterScrollbar"><li class="video"><b class="hour">1.2</b><span class="catalogue_title">相邻目标</span></li></ul>
</main></body></html>`;
interface ScopeView {
  blocked: boolean;
  activeScope: string | null;
  mediaError: boolean;
  expectedInputs: number;
  criticalInputs: number;
  trackedMediaCount: number;
  mediaGeneration: number;
}
let browser: Browser;
let context: BrowserContext;
let page: Page;
let clip: Buffer;
const guards: BrowserContinuousInputGuard[] = [];
const signal = () => new AbortController().signal;
const createGuard = (invalidated = () => undefined) => {
  const guard = new BrowserContinuousInputGuard(page, invalidated);
  guards.push(guard);
  return guard;
};
const view = (guard: BrowserContinuousInputGuard) =>
  page.evaluate((name) => {
    const scope = (window as unknown as Record<string, ScopeView | undefined>)[name];
    return scope
      ? {
          blocked: scope.blocked,
          activeScope: scope.activeScope,
          mediaError: scope.mediaError,
          expectedInputs: scope.expectedInputs,
          criticalInputs: scope.criticalInputs,
          trackedMediaCount: scope.trackedMediaCount,
          mediaGeneration: scope.mediaGeneration,
        }
      : null;
  }, guard.scopeName);
const installChild = () =>
  page.evaluate((name) => {
    (window as unknown as Record<string, unknown>)[name] = {
      blocked: false,
      mediaError: false,
      arm: null,
    };
  }, childName);
const armChild = () =>
  page.evaluate((name) => {
    (window as unknown as Record<string, { arm: unknown }>)[name].arm = {
      ordinal: '1.2',
      expiresAt: performance.now() + 5000,
      consumed: false,
      blocked: false,
    };
  }, childName);

describe.runIf(process.platform === 'win32')('连续外层人工守卫：独立本地fixture', () => {
  beforeAll(async () => {
    const edge = await findEdge();
    if (!edge) throw new Error('离线连续守卫测试需要本机Edge');
    clip = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
    browser = await chromium.launch({ executablePath: edge, headless: true });
  });
  beforeEach(async () => {
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', (request) =>
      request.fulfill(
        request.request().url().endsWith('/fixture.webm')
          ? { status: 200, contentType: 'video/webm', body: clip }
          : { status: 200, contentType: 'text/html; charset=utf-8', body: fixture },
      ),
    );
    page = await context.newPage();
    await page.goto(address);
    await expect
      .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const guard of guards.splice(0)) await guard.dispose();
    await context?.close();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('每个arm只允许一次预期pointerdown，即使child未及时consume也拒绝第二次', async () => {
    const invalidated = vi.fn();
    const guard = createGuard(invalidated);
    await guard.install(signal());
    await installChild();
    await guard.attachCandidate(childName, signal());
    await armChild();
    await page.locator('.catalogue_title').click();
    expect(await view(guard)).toMatchObject({
      blocked: false,
      expectedInputs: 1,
      criticalInputs: 0,
    });
    // This synthetic child deliberately never consumes; the outer WeakSet must still latch.
    await page.locator('.catalogue_title').click();
    await expect.poll(() => guard.signal.aborted).toBe(true);
    expect(await view(guard)).toMatchObject({
      blocked: true,
      expectedInputs: 1,
      criticalInputs: 1,
    });
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it('已arm的child不能新注册，注册失败永久锁止', async () => {
    const guard = createGuard();
    await guard.install(signal());
    await installChild();
    await armChild();
    await expect(guard.attachCandidate(childName, signal())).rejects.toThrow(
      'CONTINUOUS_CHILD_ATTACH_UNSAFE',
    );
    expect(guard.signal.aborted).toBe(true);
    await expect.poll(async () => (await view(guard))?.blocked).toBe(true);
  });

  it('初始ready媒体不误报；没有活动child时原生loadstart永久锁止', async () => {
    const guard = createGuard();
    await guard.install(signal());
    await expect(guard.assertActive(signal())).resolves.toBeUndefined();
    expect(await view(guard)).toMatchObject({
      blocked: false,
      activeScope: null,
      mediaGeneration: 0,
    });
    await page.locator('video').evaluate((node) => (node as HTMLVideoElement).load());
    await expect.poll(() => guard.signal.aborted).toBe(true);
    expect((await view(guard))!.mediaGeneration).toBeGreaterThan(0);
  });

  it('有效child期间允许正常metadata；释放后重载仍锁止，不清blocked', async () => {
    const guard = createGuard();
    await guard.install(signal());
    await installChild();
    await guard.attachCandidate(childName, signal());
    await page.locator('video').evaluate(async (node) => {
      const media = node as HTMLVideoElement;
      await new Promise<void>((resolve) => {
        media.addEventListener('loadedmetadata', () => resolve(), { once: true });
        media.load();
      });
    });
    await expect(guard.assertActive(signal())).resolves.toBeUndefined();
    await guard.releaseCandidate(childName);
    await page.locator('video').evaluate((node) => (node as HTMLVideoElement).load());
    await expect.poll(() => guard.signal.aborted).toBe(true);
    expect(await view(guard)).toMatchObject({ blocked: true, activeScope: null });
  });

  it('子作用域释放后短期信号到期不再取消整段会话，生命周期信号仍有效', async () => {
    const invalidated = vi.fn();
    const guard = createGuard(invalidated);
    const lifetime = new AbortController();
    const child = new AbortController();
    await guard.install(lifetime.signal);
    await installChild();
    await guard.attachCandidate(childName, child.signal);
    await guard.assertActive(child.signal);
    await guard.releaseCandidate(childName);
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        child.abort(new Error('expired single-hop deadline'));
        resolve();
      }, 30);
    });
    await expect(guard.assertActive(lifetime.signal)).resolves.toBeUndefined();
    expect(guard.signal.aborted).toBe(false);
    expect(invalidated).not.toHaveBeenCalled();
    lifetime.abort(new Error('entire session cancelled'));
    expect(guard.signal.aborted).toBe(true);
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it('章节等待期间媒体节点更换即锁止，不依赖loadstart是否仍可捕获', async () => {
    const guard = createGuard();
    await guard.install(signal());
    await page.locator('video').evaluate((node) => {
      const next = node.cloneNode(true);
      node.replaceWith(next);
    });
    await expect.poll(() => guard.signal.aborted).toBe(true);
    expect((await view(guard))!.mediaGeneration).toBeGreaterThan(0);
  });

  it.each(['install', 'attach'] as const)(
    '取消后迟到%s授权不留下可用scope或孤儿监听',
    async (mode) => {
      const expose = page.exposeBinding.bind(page);
      let delay = false;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let unblock!: () => void;
      const held = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      vi.spyOn(page, 'exposeBinding').mockImplementation((name, callback) =>
        expose(name, async (source, ...args: unknown[]) => {
          if (delay && (args[0] as { type?: string })?.type === 'authorize') {
            entered();
            await held;
          }
          return callback(source, ...args);
        }),
      );
      const controller = new AbortController();
      const guard = createGuard();
      if (mode === 'attach') await guard.install(signal());
      await installChild();
      delay = true;
      const pending =
        mode === 'install'
          ? guard.install(controller.signal)
          : guard.attachCandidate(childName, controller.signal);
      void pending.catch(() => undefined);
      await reached;
      controller.abort(new Error('offline cancelled'));
      await expect(pending).rejects.toThrow();
      unblock();
      await expect.poll(() => page.evaluate((name) => name in window, guard.scopeName)).toBe(false);
      expect(guard.signal.aborted).toBe(true);
    },
  );

  it('dispose重复安全并移除DOM域和监听，取消后不能重新安装', async () => {
    const invalidated = vi.fn();
    const guard = createGuard(invalidated);
    await guard.install(signal());
    await Promise.all([guard.dispose(), guard.dispose()]);
    expect(await view(guard)).toBeNull();
    await page.locator('.catalogue_title').click();
    await page.locator('video').evaluate((node) => (node as HTMLVideoElement).load());
    expect(invalidated).not.toHaveBeenCalled();
    await expect(guard.install(signal())).rejects.toThrow('CONTINUOUS_GUARD_UNAVAILABLE');
  });
});
