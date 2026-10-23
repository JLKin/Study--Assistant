import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import {
  ZhihuishuMonitorSiteAdapter,
  zhihuishuCatalogueKey,
  zhihuishuCourseId,
} from '../../packages/site-adapter/src/zhihuishu';
import type { ZhihuishuDomSample } from '../../packages/site-adapter/src/zhihuishu-dom';

const route = 'synthetic-navigation-controls-001';
const address = `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${route}`;
const mediaAddress = new URL('/media.webm', address).href;
const title = '合成不可用目录控件';
const catalogue = [
  { ordinal: '1.1', title: '合成第一节', seconds: 5 },
  { ordinal: '1.2', title: '合成第二节', seconds: 5 },
];
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
.video-study{width:700px}.header_userInfo{width:40px;height:20px}
.time_icofinish{display:inline-block;width:12px;height:12px}
.catalogue_title{display:inline-block}
</style></head><body><main class="video-study">
<div class="header_userInfo">合成登录控件</div><div class="userLinks"><i class="iconheiyemoshi-anquantuichu"></i></div>
<div class="source-name">${title}</div><h2 id="lessonOrder">1.1、合成第一节</h2>
<video id="vjs_container_html5_api" src="/media.webm" muted preload="auto"></video>
<ul class="chapterScrollbar">
<li class="video current_play"><b class="hour">1.1</b><span class="catalogue_title">合成第一节</span><i class="time_ico_half"></i><b class="time_icofinish"></b><span class="time">00:00:05</span></li>
<li class="video"><b class="hour">1.2</b><button class="target-wrapper"><span class="catalogue_title">合成第二节</span></button><i class="time_ico_half"></i><span class="time">00:00:05</span></li>
</ul></main></body></html>`;

let browser: Browser;
let context: BrowserContext;
let page: Page;
const signal = () => new AbortController().signal;

describe.runIf(process.platform === 'win32')(
  '目录不可用祖先保护（纯合成页面，非真实站点验收）',
  () => {
    beforeAll(async () => {
      const edge = await findEdge();
      if (!edge) throw new Error('需要本机 Edge 运行离线目录回归');
      const media = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
      browser = await chromium.launch({ executablePath: edge, headless: true });
      context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (request) =>
        request.fulfill(
          request.request().url() === address
            ? { status: 200, contentType: 'text/html; charset=utf-8', body: html }
            : request.request().url() === mediaAddress
              ? { status: 200, contentType: 'video/webm', body: media }
              : { status: 404, body: '' },
        ),
      );
    });
    beforeEach(async () => {
      page = await context.newPage();
      await page.goto(address);
      await expect
        .poll(() =>
          page.locator('video').evaluate((element) => (element as HTMLVideoElement).readyState),
        )
        .toBeGreaterThanOrEqual(2);
      await page.evaluate(() => {
        Object.defineProperty(document.querySelector('video')!, 'ended', {
          configurable: true,
          value: true,
        });
        // 旧代码若发出点击，会立即产生完整反馈；失败用例无需等待导航超时。
        document.querySelectorAll('.catalogue_title')[1].addEventListener('click', () => {
          const scope = window as unknown as { navigationClicks?: number };
          scope.navigationClicks = (scope.navigationClicks ?? 0) + 1;
          document.querySelector('.current_play')!.classList.remove('current_play');
          document.querySelectorAll('li.video')[1].classList.add('current_play');
          document.querySelector('#lessonOrder')!.textContent = '1.2、合成第二节';
          Object.defineProperty(document.querySelector('video')!, 'ended', {
            configurable: true,
            value: false,
          });
        });
      });
    });
    afterEach(async () => {
      await page?.close();
    });
    afterAll(async () => {
      await browser?.close();
    });

    it.each([
      'row-aria-disabled',
      'root-inert',
      'ancestor-disabled-class',
      'ancestor-native-disabled',
      'disabled-after-prepare',
    ] as const)('%s不发出目录点击，保留当前章节和播放器状态', async (mode) => {
      const adapter = new ZhihuishuMonitorSiteAdapter(page, [
        {
          courseId: zhihuishuCourseId(route),
          catalogue: zhihuishuCatalogueKey({ title, catalogue } as ZhihuishuDomSample),
          completionMarkers: 'finish-half-v1',
        },
      ]);
      const before = await adapter.observe();
      const action = {
        type: 'navigate',
        chapterId: before.chapters[1].chapterId,
        fromChapterId: before.currentChapterId!,
      } as const;
      const disable = () =>
        page.evaluate((mode) => {
          const row = document.querySelectorAll('li.video')[1];
          if (mode === 'row-aria-disabled' || mode === 'disabled-after-prepare')
            row.setAttribute('aria-disabled', 'true');
          if (mode === 'root-inert')
            document.querySelector('.video-study')!.setAttribute('inert', '');
          if (mode === 'ancestor-disabled-class') row.classList.add('disabled');
          if (mode === 'ancestor-native-disabled')
            (document.querySelector('.target-wrapper') as HTMLButtonElement).disabled = true;
        }, mode);
      if (mode !== 'disabled-after-prepare') await disable();
      await adapter.prepare(action, before.course.courseId!, signal());
      // 准备成功不授予永久许可；最终动作必须重新检查祖先的不可用状态。
      if (mode === 'disabled-after-prepare') await disable();
      await expect(adapter.perform(action, before.course.courseId!, signal())).rejects.toThrow();
      expect(
        await page.evaluate(
          () => (window as unknown as { navigationClicks?: number }).navigationClicks ?? 0,
        ),
      ).toBe(0);
      const after = await adapter.observe();
      expect(after.currentChapterId).toBe(before.currentChapterId);
      expect(after.player).toMatchObject({ paused: true, ended: true, playbackRate: 1 });
    });
  },
);
