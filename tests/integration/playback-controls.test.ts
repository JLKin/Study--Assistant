import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import { DEFAULT_CONFIG } from '../../packages/contracts/src/config';
import type { TaskSnapshot } from '../../packages/contracts/src/index';
import { MonitorSession } from '../../packages/monitor/src/index';
import type { SnapshotStore } from '../../packages/persistence/src/index';
import { monitorAdapterForPage } from '../../packages/site-adapter/src/monitor';
import { TaskEngine } from '../../packages/task-engine/src/index';

type FixtureApi = Record<string, (...args: unknown[]) => unknown>;
type MediaCalls = { play: number; pause: number };
type TestWindow = Window & { stage2Fixture: FixtureApi; playbackTestCalls: MediaCalls };

describe.runIf(process.platform === 'win32')(
  '播放与暂停离线验收：独立 Edge、本地实际媒体及唯一任务引擎（非真实平台验收）',
  () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let html: Buffer;
    let media: Buffer;
    let monitor: MonitorSession | null = null;
    const unexpectedRequests: string[] = [];
    const origin = 'http://127.0.0.1:18572';

    beforeAll(async () => {
      const edge = await findEdge();
      if (!edge) throw new Error('本地媒体验收需要已安装 Microsoft Edge。');
      [html, media] = await Promise.all([
        readFile(fileURLToPath(new URL('../fixtures/local-site/stage2.html', import.meta.url))),
        readFile(fileURLToPath(new URL('../fixtures/local-site/stage2.webm', import.meta.url))),
      ]);
      browser = await chromium.launch({ executablePath: edge, headless: true });
    });

    beforeEach(async () => {
      unexpectedRequests.length = 0;
      context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/stage2-fixture') {
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        } else if (url.origin === origin && url.pathname === '/stage2.webm') {
          await route.fulfill({ contentType: 'video/webm', body: media });
        } else {
          unexpectedRequests.push(url.origin + url.pathname);
          await route.abort();
        }
      });
      page = await context.newPage();
      await page.goto(`${origin}/stage2-fixture`);
      await expect.poll(async () => (await actualMedia()).readyState).toBeGreaterThanOrEqual(2);
      // Count real media-method calls after fixture loading, without changing their effects.
      await page.evaluate(() => {
        const scope = window as unknown as TestWindow;
        scope.playbackTestCalls = { play: 0, pause: 0 };
        const prototype = HTMLMediaElement.prototype;
        const originalPlay = prototype.play;
        const originalPause = prototype.pause;
        prototype.play = function () {
          scope.playbackTestCalls.play++;
          return originalPlay.call(this);
        };
        prototype.pause = function () {
          scope.playbackTestCalls.pause++;
          return originalPause.call(this);
        };
      });
    });

    afterEach(async () => {
      monitor?.dispose();
      monitor = null;
      await context?.close();
      expect(unexpectedRequests).toEqual([]);
    });

    afterAll(async () => {
      await browser?.close();
    });

    const fixture = (method: string, ...args: unknown[]) =>
      page.evaluate(
        ({ method: name, args: values }) =>
          (window as unknown as TestWindow).stage2Fixture[name](...values),
        { method, args },
      );

    function actualMedia() {
      return page.locator('#stage2-video').evaluate((element) => {
        const video = element as HTMLVideoElement;
        return {
          currentTime: video.currentTime,
          duration: video.duration,
          paused: video.paused,
          ended: video.ended,
          playbackRate: video.playbackRate,
          readyState: video.readyState,
        };
      });
    }

    const calls = () => page.evaluate(() => (window as unknown as TestWindow).playbackTestCalls);

    async function create() {
      let saved: TaskSnapshot | null = null;
      let clock = 0;
      const store: SnapshotStore = {
        load: async () => structuredClone(saved),
        write: async (snapshot) => {
          saved = { ...structuredClone(snapshot), integrityDigest: '0'.repeat(64) };
          return structuredClone(saved);
        },
      };
      const adapter = monitorAdapterForPage(page);
      const engine = new TaskEngine({
        store,
        stage2Capabilities: {
          enabled: true,
          inspect: (signal) => adapter.inspect(signal),
          backup: async () => true,
        },
      });
      const session = new MonitorSession({
        engine,
        config: () => ({ ...DEFAULT_CONFIG }),
        now: () => clock,
        polling: false,
      });
      monitor = session;
      await engine.browserConnected();
      await session.attach(adapter);
      const course = await adapter.inspect();
      expect((await engine.confirmCourse(course, course.courseId!)).ok).toBe(true);
      return {
        engine,
        session,
        adapter,
        snapshot: () => structuredClone(saved),
        advanceTo: (time: number) => {
          clock = time;
        },
      };
    }

    it('视频已暂停时开始与继续只监测，超时后也不强行播放或产生恢复操作', async () => {
      await page.locator('#manual-pause').click();
      const h = await create();
      const before = await actualMedia();
      const methods = await calls();
      expect(before.paused).toBe(true);
      expect((await h.session.start()).ok).toBe(true);
      h.advanceTo(90000);
      await h.session.tick();
      expect((await h.engine.pause()).ok).toBe(true);
      expect((await h.session.start(true)).ok).toBe(true);
      h.advanceTo(180000);
      await h.session.tick();
      expect(await actualMedia()).toMatchObject({ paused: true, currentTime: before.currentTime });
      expect(await calls()).toEqual(methods);
      expect(await fixture('actions')).toEqual([]);
      expect(h.snapshot()!.pendingOperations).toEqual([]);
    });

    it('网页正常播放和暂停控件使任务安全暂停；用户暂停后继续监测不抢播', async () => {
      await page.locator('#manual-pause').click();
      const h = await create();
      expect((await h.session.start()).ok).toBe(true);
      await page.locator('#manual-play').click();
      await expect.poll(() => h.engine.view().state).toBe('PAUSED');
      await expect.poll(async () => (await actualMedia()).paused).toBe(false);
      const playingAt = (await actualMedia()).currentTime;
      await expect.poll(async () => (await actualMedia()).currentTime).toBeGreaterThan(playingAt);
      expect((await h.session.start(true)).ok).toBe(true);
      await page.locator('#manual-pause').click();
      await expect.poll(() => h.engine.view().state).toBe('PAUSED');
      const paused = await actualMedia();
      const methods = await calls();
      expect(paused.paused).toBe(true);
      expect((await h.session.start(true)).ok).toBe(true);
      h.advanceTo(90000);
      await h.session.tick();
      expect(await actualMedia()).toMatchObject({ paused: true, currentTime: paused.currentTime });
      expect(await calls()).toEqual(methods);
      expect(await fixture('actions')).toEqual([]);
      expect(h.snapshot()!.pendingOperations).toEqual([]);
    });

    it.each(['pause', 'stop'] as const)(
      '助手任务 %s 不调用网页 pause，实际视频继续推进且不产生新动作',
      async (command) => {
        await page.locator('#manual-play').click();
        const h = await create();
        expect((await h.session.start()).ok).toBe(true);
        const before = await actualMedia();
        const methods = await calls();
        expect(before.paused).toBe(false);
        expect((await h.engine[command]()).ok).toBe(true);
        await h.session.tick();
        expect(h.engine.view().state).toBe(command === 'pause' ? 'PAUSED' : 'IDLE');
        await expect
          .poll(async () => (await actualMedia()).currentTime)
          .toBeGreaterThan(before.currentTime + 0.1);
        expect((await actualMedia()).paused).toBe(false);
        expect(await calls()).toEqual(methods);
        expect(await fixture('actions')).toEqual([]);
        expect(h.snapshot()!.pendingOperations).toEqual([]);
      },
    );

    it('仅已播放态的缓冲超时触发一次受保护恢复，真实媒体时间恢复推进', async () => {
      // Only the fault notification is simulated; post-recovery playback is native VP8 media.
      await fixture('scenario', 'buffering');
      expect((await actualMedia()).paused).toBe(true);
      const h = await create();
      expect((await h.session.start()).ok).toBe(true);
      h.advanceTo(29999);
      await h.session.tick();
      expect(await fixture('actions')).toEqual([]);
      const before = await actualMedia();
      h.advanceTo(30000);
      await h.session.tick();
      await expect
        .poll(() => h.snapshot()!.pendingOperations)
        .toMatchObject([{ kind: 'recovery', status: 'completed' }]);
      // The fixture's simulated time=1 is not the native video's recovery baseline.
      await expect
        .poll(async () => (await actualMedia()).currentTime)
        .toBeGreaterThan(before.currentTime + 0.1);
      expect((await actualMedia()).paused).toBe(false);
      h.advanceTo(30001);
      await h.session.tick();
      const recoveredAt = (await actualMedia()).currentTime;
      await expect
        .poll(async () => (await actualMedia()).currentTime)
        .toBeGreaterThan(recoveredAt + 0.1);
      // Do not manufacture a second 30-second stall while the native video runs in real time.
      h.advanceTo(30002);
      await h.session.tick();
      expect(await fixture('actions')).toEqual([
        { type: 'recover-play', chapterId: 'chapter-001' },
      ]);
      expect(h.snapshot()!.pendingOperations).toHaveLength(1);
      expect(h.engine.view().state).toBe('MONITORING');
    });

    it('真实视频自然结束后仍等待平台标记；明确完成后仅导航一次且新章实际播放', async () => {
      await page.locator('#stage2-video').evaluate((element) => {
        (element as HTMLVideoElement).loop = false;
      });
      await page.locator('#manual-play').click();
      const h = await create();
      expect((await h.session.start()).ok).toBe(true);
      await expect.poll(async () => (await actualMedia()).ended, { timeout: 8500 }).toBe(true);
      await h.session.tick();
      const ended = await actualMedia();
      expect(ended.currentTime).toBe(ended.duration);
      expect((await h.adapter.observe()).chapters[0].platformCompleted).toBe(false);
      expect(await fixture('actions')).toEqual([]);
      await fixture('completeChapter', 'chapter-001');
      await expect
        .poll(async () => {
          await h.session.tick();
          return h.snapshot()!.pendingOperations;
        })
        .toMatchObject([{ kind: 'chapter-navigation', status: 'completed' }]);
      expect((await h.adapter.observe()).currentChapterId).toBe('chapter-002');
      expect((await actualMedia()).ended).toBe(false);
      expect((await actualMedia()).paused).toBe(false);
      const nextAt = (await actualMedia()).currentTime;
      await expect
        .poll(async () => (await actualMedia()).currentTime)
        .toBeGreaterThan(nextAt + 0.1);
      await h.session.tick();
      expect(await fixture('actions')).toEqual([
        { type: 'navigate', fromChapterId: 'chapter-001', chapterId: 'chapter-002' },
      ]);
      expect(h.snapshot()!.pendingOperations).toHaveLength(1);
      expect(h.snapshot()!.chapterId).toBe('chapter-002');
      expect(await page.locator('#submission-count').textContent()).toBe('0');
    });
  },
);
