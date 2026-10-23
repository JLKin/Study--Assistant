import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { EventEmitter } from 'node:events';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import type { SiteSignal } from '../../packages/contracts/src/monitor';
import { monitorAdapterForPage } from '../../packages/site-adapter/src/monitor';

let server: Server;
let browser: Browser;
let page: Page;
let baseUrl: string;
type FixtureApi = Record<string, (...args: unknown[]) => unknown>;
const call = (method: string, ...args: unknown[]) =>
  page.evaluate(
    ({ method: name, args: values }) =>
      (window as unknown as { stage2Fixture: FixtureApi }).stage2Fixture[name](...values),
    { method, args },
  );
const signal = () => new AbortController().signal;

describe.runIf(process.platform === 'win32')(
  '阶段 2 真实本机视频 fixture 集成（非真实平台验收）',
  () => {
    beforeAll(async () => {
      const edgePath = await findEdge();
      if (!edgePath) throw new Error('本机视频 fixture 集成需要 Microsoft Edge。');
      const [html, media] = await Promise.all([
        readFile(fileURLToPath(new URL('../fixtures/local-site/stage2.html', import.meta.url))),
        readFile(fileURLToPath(new URL('../fixtures/local-site/stage2.webm', import.meta.url))),
      ]);
      server = createServer((request, response) => {
        if (request.url === '/stage2.webm') {
          response.writeHead(200, { 'content-type': 'video/webm', 'content-length': media.length });
          response.end(media);
        } else {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(html);
        }
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('本机fixture监听失败');
      baseUrl = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ executablePath: edgePath, headless: true });
      page = await (await browser.newContext()).newPage();
    });
    beforeEach(async () => {
      await page.goto(`${baseUrl}/stage2-fixture`);
      await call('reset');
      await call('scenario', 'normal');
      await expect
        .poll(() =>
          page
            .locator('#stage2-video')
            .evaluate((element) => (element as HTMLVideoElement).readyState),
        )
        .toBeGreaterThanOrEqual(2);
    });
    afterAll(async () => {
      await browser?.close();
      if (server?.listening) await new Promise<void>((done) => server.close(() => done()));
    });

    it('加载真实本地VP8视频并观察播放时间，保留独立schema1契约', async () => {
      const adapter = monitorAdapterForPage(page);
      const before = await adapter.observe();
      expect(before).toMatchObject({
        course: { source: 'fixture', authenticated: true, confidence: 'verified' },
        player: { paused: false, playbackRate: 1 },
        chapters: [{ platformCompleted: false }, { platformCompleted: false }],
      });
      await expect
        .poll(async () => (await adapter.observe()).player?.currentTime ?? 0)
        .toBeGreaterThan(before.player!.currentTime);
      expect(
        await page
          .locator('#stage2-video')
          .evaluate((element) => (element as HTMLVideoElement).videoWidth),
      ).toBe(96);
      expect(
        JSON.parse((await page.locator('#stage1-observation').textContent()) ?? '{}').schemaVersion,
      ).toBe(1);
      expect(await page.locator('#submission-count').textContent()).toBe('0');
    });

    it('缓冲、卡顿、倍速丢失、登录失效、弹窗、计分与未知场景均可确定性控制', async () => {
      const adapter = monitorAdapterForPage(page);
      await call('scenario', 'buffering');
      expect((await adapter.observe()).player).toMatchObject({
        currentTime: 1,
        paused: false,
        buffering: true,
      });
      await call('scenario', 'stalled');
      const first = await adapter.observe();
      expect((await adapter.observe()).player?.currentTime).toBe(first.player?.currentTime);
      await call('scenario', 'rate-lost');
      expect((await adapter.observe()).player?.playbackRate).toBe(1);
      await call('scenario', 'login-expired');
      expect((await adapter.observe()).course.authenticated).toBe(false);
      for (const scenario of ['popup', 'graded', 'unknown']) {
        await call('scenario', 'normal');
        await call('scenario', scenario);
        await expect(
          adapter.perform(
            { type: 'recover-play', chapterId: 'chapter-001' },
            'fixture-course-001',
            signal(),
          ),
        ).rejects.toThrow('保护条件');
      }
      expect(await call('actions')).toEqual([]);
      expect(await page.locator('#submission-count').textContent()).toBe('0');
    });

    it('81%以上和视频ended均不伪造平台完成；平台标记迟到由fixture独立发布', async () => {
      const adapter = monitorAdapterForPage(page);
      await call('scenario', 'chapter-late');
      const waiting = await adapter.observe();
      expect(waiting.player!.currentTime / waiting.player!.duration).toBeGreaterThan(0.81);
      expect(waiting.chapters[0].platformCompleted).toBe(false);
      await call('scenario', 'ended');
      expect((await adapter.observe()).chapters[0].platformCompleted).toBe(false);
      await call('delayChapterCompletion', 'chapter-001', 50);
      await expect
        .poll(async () => (await adapter.observe()).chapters[0].platformCompleted)
        .toBe(true);
      expect((await adapter.observe()).course.platformCompleted).toBe(false);
    });

    it('手动倍速仅观察，恢复播放和核验后导航只改本地视频，计分提交次数为零', async () => {
      const adapter = monitorAdapterForPage(page);
      await page.locator('#manual-rate-150').click();
      expect(
        await page
          .locator('#stage2-video')
          .evaluate((element) => (element as HTMLVideoElement).playbackRate),
      ).toBe(1.5);
      expect((await adapter.observe()).player?.playbackRate).toBe(1.5);
      expect(await call('actions')).toEqual([]);
      await call('scenario', 'buffering');
      await adapter.perform(
        { type: 'recover-play', chapterId: 'chapter-001' },
        'fixture-course-001',
        signal(),
      );
      expect((await adapter.observe()).player).toMatchObject({ paused: false, buffering: false });
      await call('scenario', 'ended');
      await call('completeChapter', 'chapter-001');
      await adapter.perform(
        { type: 'navigate', fromChapterId: 'chapter-001', chapterId: 'chapter-002' },
        'fixture-course-001',
        signal(),
      );
      expect((await adapter.observe()).currentChapterId).toBe('chapter-002');
      expect(await call('actions')).toMatchObject([{ type: 'recover-play' }, { type: 'navigate' }]);
      expect(await page.locator('#submission-count').textContent()).toBe('0');
    });

    it('适配器拒绝自动调速，手动设置的倍速与动作记录保持不变', async () => {
      const adapter = monitorAdapterForPage(page);
      await page.locator('#manual-rate-150').click();
      await expect(
        adapter.perform(
          { type: 'set-rate', chapterId: 'chapter-001', rate: 1.25 },
          'fixture-course-001',
          signal(),
        ),
      ).rejects.toThrow();
      expect((await adapter.observe()).player?.playbackRate).toBe(1.5);
      expect(await call('actions')).toEqual([]);
    });

    it('用户可信pointer/key关键操作产生manual信号，程序媒体pause与滚动不会', async () => {
      const events: SiteSignal[] = [];
      const unsubscribe = await monitorAdapterForPage(page).subscribe((event) =>
        events.push(event),
      );
      try {
        await page
          .locator('#stage2-video')
          .evaluate((element) => (element as HTMLVideoElement).pause());
        await page.mouse.wheel(0, 200);
        await call('scenario', 'scroll');
        await expect
          .poll(() => events.some((event) => event.type === 'media' && event.eventName === 'pause'))
          .toBe(true);
        expect(events.filter((event) => event.type === 'manual')).toEqual([]);
        await page.locator('#manual-pause').click();
        await expect
          .poll(() => events.some((event) => event.type === 'manual' && event.action === 'pause'))
          .toBe(true);
        const count = events.filter((event) => event.type === 'manual').length;
        await page.locator('#manual-chapter').focus();
        await page.keyboard.press('Enter');
        await expect
          .poll(() => events.filter((event) => event.type === 'manual').length)
          .toBeGreaterThan(count);
      } finally {
        unsubscribe();
      }
    });

    it('合成pointer/key与程序click不冒充人工；取消订阅移除页面及context事件监听', async () => {
      const events: SiteSignal[] = [];
      const contextListeners = (page.context() as unknown as EventEmitter).listenerCount('page');
      const navigationListeners = (page as unknown as EventEmitter).listenerCount('framenavigated');
      const unsubscribe = await monitorAdapterForPage(page).subscribe((event) =>
        events.push(event),
      );
      await page.locator('#manual-pause').dispatchEvent('pointerdown');
      await page.locator('#manual-pause').dispatchEvent('keydown', { key: ' ' });
      await call('scenario', 'manual-pause');
      expect(events.filter((event) => event.type === 'manual')).toEqual([]);
      unsubscribe();
      expect((page.context() as unknown as EventEmitter).listenerCount('page')).toBe(
        contextListeners,
      );
      expect((page as unknown as EventEmitter).listenerCount('framenavigated')).toBe(
        navigationListeners,
      );
      await page.locator('#manual-pause').click();
      expect(events.filter((event) => event.type === 'manual')).toEqual([]);
    });

    it('恢复动作已准备但取消发生于最后授权时，迟到执行不会恢复播放', async () => {
      const adapter = monitorAdapterForPage(page);
      await adapter.perform(
        { type: 'recover-play', chapterId: 'chapter-001' },
        'fixture-course-001',
        signal(),
      );
      await call('scenario', 'buffering');
      const controller = new AbortController();
      await page.exposeBinding('testCancelFinalAuthorization', () =>
        controller.abort(new Error('人工暂停')),
      );
      await page.evaluate(() => {
        const scope = window as unknown as Record<string, unknown>;
        const name = Object.keys(scope)
          .filter((key) => key.startsWith('stage2Authorize_'))
          .at(-1)!;
        const original = scope[name] as (token: string) => Promise<boolean>;
        scope[name] = async (token: string) => {
          await (scope.testCancelFinalAuthorization as () => Promise<void>)();
          return original(token);
        };
      });
      await expect(
        adapter.perform(
          { type: 'recover-play', chapterId: 'chapter-001' },
          'fixture-course-001',
          controller.signal,
        ),
      ).rejects.toThrow();
      expect((await adapter.observe()).player?.buffering).toBe(true);
      expect(
        await page
          .locator('#stage2-video')
          .evaluate((element) => (element as HTMLVideoElement).paused),
      ).toBe(true);
      expect(await call('actions')).toHaveLength(1);
    });

    it('落盘等待后的源章平台完成标记变化仍由最终页面门槛拒绝', async () => {
      const adapter = monitorAdapterForPage(page);
      await adapter.perform(
        { type: 'recover-play', chapterId: 'chapter-001' },
        'fixture-course-001',
        signal(),
      );
      await call('scenario', 'ended');
      await call('completeChapter', 'chapter-001');
      await page.evaluate(() => {
        const scope = window as unknown as Record<string, unknown>;
        const name = Object.keys(scope)
          .filter((key) => key.startsWith('stage2Authorize_'))
          .at(-1)!;
        const original = scope[name] as (token: string) => Promise<boolean>;
        scope[name] = async (token: string) => {
          (scope.stage2Fixture as FixtureApi).completeChapter('chapter-001', false);
          return original(token);
        };
      });
      await expect(
        adapter.perform(
          { type: 'navigate', fromChapterId: 'chapter-001', chapterId: 'chapter-002' },
          'fixture-course-001',
          signal(),
        ),
      ).rejects.toThrow('动作前网页');
      expect((await adapter.observe()).currentChapterId).toBe('chapter-001');
      expect(await call('actions')).toHaveLength(1);
    });

    it.each([
      { name: '课程', patch: { courseId: 'fixture-course-002' } },
      { name: '登录', patch: { authenticated: false } },
      { name: '弹窗', patch: { popup: 'present' } },
      { name: '计分页', patch: { pageKind: 'graded' } },
      { name: '章节', patch: { currentChapterId: 'chapter-002' } },
    ])('最后授权期间$name变化不得执行已准备的动作', async ({ patch }) => {
      const adapter = monitorAdapterForPage(page);
      await adapter.perform(
        { type: 'recover-play', chapterId: 'chapter-001' },
        'fixture-course-001',
        signal(),
      );
      await call('scenario', 'buffering');
      await page.evaluate((change) => {
        const scope = window as unknown as Record<string, unknown>;
        const name = Object.keys(scope)
          .filter((key) => key.startsWith('stage2Authorize_'))
          .at(-1)!;
        const original = scope[name] as (token: string) => Promise<boolean>;
        scope[name] = async (token: string) => {
          (scope.stage2Fixture as FixtureApi).set(change);
          return original(token);
        };
      }, patch);
      await expect(
        adapter.perform(
          { type: 'recover-play', chapterId: 'chapter-001' },
          'fixture-course-001',
          signal(),
        ),
      ).rejects.toThrow('动作前网页');
      expect(await call('actions')).toHaveLength(1);
      expect(
        await page
          .locator('#stage2-video')
          .evaluate((element) => (element as HTMLVideoElement).paused),
      ).toBe(true);
    });

    it('安全刷新真实reload一次并恢复实际播放，仅本次自动刷新navigation标注automated', async () => {
      const adapter = monitorAdapterForPage(page);
      const events: SiteSignal[] = [];
      const unsubscribe = await adapter.subscribe((event) => events.push(event));
      try {
        await call('scenario', 'buffering');
        await adapter.perform(
          { type: 'refresh', chapterId: 'chapter-001' },
          'fixture-course-001',
          signal(),
        );
        await expect.poll(async () => (await adapter.observe()).player?.paused).toBe(false);
        expect(await call('actions')).toMatchObject([{ type: 'refresh' }]);
        expect(events.filter((event) => event.type === 'navigation')).toEqual([
          { type: 'navigation', automated: true },
        ]);
        const current = (await adapter.observe()).player!.currentTime;
        await expect
          .poll(async () => (await adapter.observe()).player?.currentTime ?? 0)
          .toBeGreaterThan(current);
        await page.reload();
        expect(events.filter((event) => event.type === 'navigation').at(-1)?.automated).toBe(false);
      } finally {
        unsubscribe();
      }
    });

    it('刷新失败保留缓冲场景并供上层暂停；预先取消刷新不会reload', async () => {
      const adapter = monitorAdapterForPage(page);
      await call('configure', { refreshSucceeds: false, recoverSucceeds: false });
      await call('scenario', 'buffering');
      await adapter.perform(
        { type: 'refresh', chapterId: 'chapter-001' },
        'fixture-course-001',
        signal(),
      );
      expect((await adapter.observe()).player).toMatchObject({ currentTime: 1, buffering: true });
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        adapter.perform(
          { type: 'refresh', chapterId: 'chapter-001' },
          'fixture-course-001',
          cancelled.signal,
        ),
      ).rejects.toThrow();
      expect(await call('actions')).toHaveLength(1);
    });

    it('新标签或页面关闭发出非自动navigation；相同DOM离开可信路径后拒绝动作', async () => {
      const adapter = monitorAdapterForPage(page);
      const events: SiteSignal[] = [];
      const unsubscribe = await adapter.subscribe((event) => events.push(event));
      const extra = await page.context().newPage();
      await extra.close();
      await expect
        .poll(() =>
          events.some((event) => event.eventName === 'new-page' && event.automated === false),
        )
        .toBe(true);
      await page.goto(`${baseUrl}/unverified-page`);
      expect((await adapter.observe()).course.confidence).toBe('uncertain');
      await expect(
        adapter.perform(
          { type: 'recover-play', chapterId: 'chapter-001' },
          'fixture-course-001',
          signal(),
        ),
      ).rejects.toThrow('保护条件');
      unsubscribe();
    });

    it('目标页面关闭必定发出非自动navigation信号', async () => {
      const closing = await page.context().newPage();
      await closing.goto(`${baseUrl}/stage2-fixture`);
      const events: SiteSignal[] = [];
      const unsubscribe = await monitorAdapterForPage(closing).subscribe((event) =>
        events.push(event),
      );
      await closing.close();
      expect(events).toContainEqual({ type: 'navigation', eventName: 'close', automated: false });
      unsubscribe();
    });
  },
);
