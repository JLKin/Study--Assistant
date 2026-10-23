import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import type { SiteSignal } from '../../packages/contracts/src/monitor';
import {
  ZhihuishuMonitorSiteAdapter,
  zhihuishuCatalogueKey,
  zhihuishuCourseId,
} from '../../packages/site-adapter/src/zhihuishu';
import { readZhihuishuDom } from '../../packages/site-adapter/src/zhihuishu-dom';

const address =
  'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-media-events-001';

// 所有请求在本地 fulfill；派生 DOM 不构成真实平台人工验收。
describe.runIf(process.platform === 'win32')('真实派生媒体节点替换回归（仅离线）', () => {
  let browser: Browser;
  let page: Page;
  let adapter: ZhihuishuMonitorSiteAdapter;
  let dispose: (() => void) | undefined;
  let events: SiteSignal[];

  beforeAll(async () => {
    const edge = await findEdge();
    if (!edge) throw new Error('需要本机 Edge 运行离线派生 DOM 测试');
    browser = await chromium.launch({ executablePath: edge, headless: true });
    const context = await browser.newContext();
    const [html, media] = await Promise.all([
      readFile(new URL('../fixtures/local-site/zhihuishu-derived.html', import.meta.url)),
      readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url)),
    ]);
    await context.route('**/*', (route) =>
      route.fulfill(
        route.request().url().endsWith('/synthetic-derived.webm')
          ? { status: 200, contentType: 'video/webm', body: media }
          : { status: 200, contentType: 'text/html', body: html },
      ),
    );
  });

  beforeEach(async () => {
    page = await browser.contexts()[0].newPage();
    await page.goto(address);
    await expect
      .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2);
    const sample = await page.evaluate(readZhihuishuDom, undefined);
    if (!sample) throw new Error('合成课程必须先通过同一 DOM 身份识别');
    adapter = new ZhihuishuMonitorSiteAdapter(page, [
      {
        courseId: zhihuishuCourseId(sample.route),
        catalogue: zhihuishuCatalogueKey(sample),
      },
    ]);
    events = [];
    dispose = await adapter.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    dispose?.();
    dispose = undefined;
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function replaceMedia() {
    await page.locator('video').evaluate((old) => {
      const scope = window as unknown as { retiredMedia?: Element };
      scope.retiredMedia = old;
      old.replaceWith(old.cloneNode(true));
    });
    await expect
      .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => events.some((event) => event.eventName === 'media-replaced'))
      .toBe(true);
  }

  it('新媒体节点的 waiting→playing 可清除缓冲，暂停、结束、时间等媒体事件均可观察', async () => {
    await page.locator('video').dispatchEvent('waiting');
    await expect.poll(() => events.some((event) => event.eventName === 'waiting')).toBe(true);
    await replaceMedia();
    await page
      .locator('video')
      .evaluate((node) =>
        Object.defineProperty(node, 'paused', { configurable: true, value: false }),
      );
    const names = [
      'play',
      'waiting',
      'playing',
      'pause',
      'ended',
      'timeupdate',
      'ratechange',
      'seeking',
    ];
    events.length = 0;
    for (const name of names) await page.locator('video').dispatchEvent(name);
    await expect
      .poll(() => events.filter((event) => event.type === 'media').length)
      .toBe(names.length);
    expect(events.map((event) => event.eventName)).toEqual(names);
    expect(events.every((event) => event.type === 'media')).toBe(true);
    expect((await adapter.observe()).player?.buffering).toBe(false);
  });

  it('已退役媒体节点的迟到事件不得改变当前缓冲标志', async () => {
    await replaceMedia();
    events.length = 0;
    await page.evaluate(() => {
      const scope = window as unknown as { retiredMedia: Element };
      scope.retiredMedia.dispatchEvent(new Event('waiting'));
      scope.retiredMedia.dispatchEvent(new Event('playing'));
    });
    await page.waitForTimeout(80);
    expect(events).toEqual([]);
  });

  it('旧节点等待后，新节点没有首个媒体事件也不能继承旧缓冲状态', async () => {
    await page.locator('video').dispatchEvent('waiting');
    await expect.poll(() => events.some((event) => event.eventName === 'waiting')).toBe(true);
    await page.evaluate(() => {
      const old = document.querySelector('video')!;
      const current = document.createElement('video');
      current.id = old.id;
      // 无 source、无媒体事件的合成节点，仅提供只读观察需要的播放器值。
      Object.defineProperties(current, {
        duration: { configurable: true, value: old.duration },
        readyState: { configurable: true, value: 4 },
        paused: { configurable: true, value: false },
        ended: { configurable: true, value: false },
      });
      old.replaceWith(current);
    });
    await expect.poll(async () => (await adapter.observe()).player?.buffering).toBe(false);
    expect(events.filter((event) => event.eventName !== 'media-replaced')).toEqual([
      { type: 'media', eventName: 'waiting' },
    ]);
  });

  it('同任务替换后立即发媒体事件，先重置旧等待且只报告一次节点替换', async () => {
    await page.locator('video').dispatchEvent('waiting');
    await expect.poll(() => events.some((event) => event.eventName === 'waiting')).toBe(true);
    events.length = 0;
    await page.evaluate(() => {
      const old = document.querySelector('video')!;
      const current = document.createElement('video');
      current.id = old.id;
      Object.defineProperties(current, {
        duration: { configurable: true, value: old.duration },
        readyState: { configurable: true, value: 4 },
        paused: { configurable: true, value: false },
        ended: { configurable: true, value: false },
      });
      old.replaceWith(current);
      current.dispatchEvent(new Event('timeupdate'));
    });
    await expect
      .poll(() => events.map((event) => event.eventName))
      .toEqual(['media-replaced', 'timeupdate']);
    expect((await adapter.observe()).player?.buffering).toBe(false);
  });

  it.each(['outside-video', 'duplicate-root', 'duplicate-video'] as const)(
    '%s 导致媒体身份不唯一时，根外和当前媒体事件均忽略',
    async (mode) => {
      await page.evaluate((kind) => {
        const video = document.querySelector('video')!;
        const duplicate = video.cloneNode(false) as HTMLElement;
        duplicate.removeAttribute('src');
        if (kind === 'outside-video') document.body.append(duplicate);
        else if (kind === 'duplicate-video')
          document.querySelector('.video-study')!.append(duplicate);
        else {
          const root = document.createElement('main');
          root.className = 'video-study';
          document.body.append(root);
        }
        video.dispatchEvent(new Event('waiting'));
        duplicate.dispatchEvent(new Event('playing'));
      }, mode);
      await page.waitForTimeout(80);
      expect(events).toEqual([]);
    },
  );

  it('解除订阅后新旧媒体均不再回调', async () => {
    await replaceMedia();
    await expect
      .poll(() => events.some((event) => event.eventName === 'media-replaced'))
      .toBe(true);
    events.length = 0;
    dispose?.();
    dispose = undefined;
    // dispose 的页面清理与本次 evaluate 顺序进入同一页面连接。
    await page.evaluate(() => {
      const scope = window as unknown as { retiredMedia: Element };
      scope.retiredMedia.dispatchEvent(new Event('waiting'));
      document.querySelector('video')!.dispatchEvent(new Event('playing'));
      const media = document.querySelector('video')!;
      media.replaceWith(media.cloneNode(true));
    });
    await page.waitForTimeout(80);
    expect(events).toEqual([]);
  });
});
