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

const syntheticRoute = 'synthetic-catalogue-regression-001';
const address = `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${syntheticRoute}`;
const mediaAddress = new URL('/media.webm', address).href;
const catalogue = [
  { ordinal: '1.1', title: '合成第一节', seconds: 5 },
  { ordinal: '1.2', title: '合成第二节', seconds: 5 },
];
const title = '合成目录反例课程';
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
.video-study{width:700px}.header_userInfo{width:40px;height:20px}
.time_icofinish{display:inline-block;width:12px;height:12px}
.catalogue_title{display:inline-block}
</style></head><body><p>仅本地合成目录回归，不构成真实平台验收。</p>
<main class="video-study"><div class="header_userInfo">合成登录控件</div>
<div class="userLinks"><i class="iconheiyemoshi-anquantuichu"></i></div>
<div class="source-name">${title}</div><h2 id="lessonOrder">1.1、合成第一节</h2>
<video id="vjs_container_html5_api" src="/media.webm" muted preload="auto"></video>
<ul class="chapterScrollbar">
<li class="video current_play"><b class="hour">1.1</b><span class="catalogue_title">合成第一节</span><i class="time_ico_half"></i><b class="time_icofinish"></b><span class="time">00:00:05</span></li>
<li class="video"><b class="hour">1.2</b><span class="catalogue_title">合成第二节</span><i class="time_ico_half"></i><span class="time">00:00:05</span></li>
</ul></main></body></html>`;

let browser: Browser;
let context: BrowserContext;
let page: Page;

function adapterFor(rows = catalogue) {
  return new ZhihuishuMonitorSiteAdapter(page, [
    {
      courseId: zhihuishuCourseId(syntheticRoute),
      catalogue: zhihuishuCatalogueKey({ title, catalogue: rows } as ZhihuishuDomSample),
      completionMarkers: 'finish-half-v1',
    },
  ]);
}

describe.runIf(process.platform === 'win32')('目录定位反例（纯合成页面，非真实站点验收）', () => {
  beforeAll(async () => {
    const edge = await findEdge();
    if (!edge) throw new Error('需要本机 Edge 运行离线目录回归');
    const media = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
    // 独立临时浏览器资料；全部请求本地拦截，不连接专用 Edge 或真实课程。
    browser = await chromium.launch({ executablePath: edge, headless: true });
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      return route.fulfill(
        url === address
          ? { status: 200, contentType: 'text/html; charset=utf-8', body: html }
          : url === mediaAddress
            ? { status: 200, contentType: 'video/webm', body: media }
            : { status: 404, body: '' },
      );
    });
  });
  beforeEach(async () => {
    page = await context.newPage();
    await page.goto(address);
    await expect
      .poll(() =>
        page.locator('video').evaluate((element) => (element as HTMLVideoElement).readyState),
      )
      .toBeGreaterThanOrEqual(2);
  });
  afterEach(async () => {
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('目录外及非video菜单与相似类名不会污染视频数量或当前章节', async () => {
    await page.evaluate(() => {
      const list = document.querySelector('.chapterScrollbar')!;
      list.insertAdjacentHTML(
        'beforeend',
        '<li class="chapter-test current_play"><span>章节测验 已完成</span></li>' +
          '<li class="lesson button section current_play"><span>课程资料</span></li>',
      );
      document.querySelectorAll('li.video')[1].className =
        'video lesson button section current_played';
      document.body.insertAdjacentHTML(
        'beforeend',
        '<ul class="chapterScrollbar"><li class="video current_play">外部无关目录</li></ul>',
      );
    });
    const observed = await adapterFor().observe();
    expect(observed.course.confidence).toBe('verified');
    expect(observed.chapters.map((chapter) => chapter.title)).toEqual([
      '1.1 合成第一节',
      '1.2 合成第二节',
    ]);
    expect(observed.currentChapterId).toBe(observed.chapters[0].chapterId);
    expect(observed.chapters.map((chapter) => chapter.platformCompleted)).toEqual([true, false]);
  });

  it('标题中的普通嵌套span仍只代表一个视频条目，身份保持不变', async () => {
    const before = await adapterFor().observe();
    await page
      .locator('.catalogue_title')
      .first()
      .evaluate((element) => {
        const nested = document.createElement('span');
        nested.textContent = element.textContent;
        element.replaceChildren(nested);
      });
    const after = await adapterFor().observe();
    expect(after.course.confidence).toBe('verified');
    expect(after.chapters).toHaveLength(2);
    expect(after.chapters.map((chapter) => chapter.chapterId)).toEqual(
      before.chapters.map((chapter) => chapter.chapterId),
    );
    expect(after.currentChapterId).toBe(before.currentChapterId);
  });

  it.each(['duplicate-title', 'duplicate-catalogue'] as const)(
    '%s使控件定位歧义，不能授予课程或导航能力',
    async (mode) => {
      await page.evaluate((mode) => {
        if (mode === 'duplicate-title') {
          const control = document.querySelectorAll('.catalogue_title')[1];
          control.parentElement!.append(control.cloneNode(true));
        } else {
          document
            .querySelector('.video-study')!
            .append(document.querySelector('.chapterScrollbar')!.cloneNode(true));
        }
      }, mode);
      const observed = await adapterFor().observe();
      expect(observed.course.confidence).toBe('uncertain');
      expect(observed.currentChapterId).toBeNull();
      expect(observed.chapters).toHaveLength(0);
      expect(observed.capabilities?.navigation).toBe(false);
    },
  );

  it('unfinished、incomplete和已完成文案不会替代明确的平台完成图标', async () => {
    await page
      .locator('li.video')
      .nth(1)
      .evaluate((element) => {
        element.classList.add('unfinished', 'incomplete', 'completed');
        element.insertAdjacentHTML('beforeend', '<span>已学 已完成 已看完</span>');
      });
    const observed = await adapterFor().observe();
    expect(observed.course.confidence).toBe('verified');
    expect(observed.chapters.map((chapter) => chapter.platformCompleted)).toEqual([true, false]);
    expect(observed.course.platformCompleted).toBe(false);
  });

  it('前40字相同的标题仍按不同编号保留独立身份，不按标题前缀去重', async () => {
    const prefix = '同一段较长的目录标题前缀'.repeat(4);
    const rows = catalogue.map((row, index) => ({ ...row, title: `${prefix}${index + 1}` }));
    expect(rows[0].title.slice(0, 40)).toBe(rows[1].title.slice(0, 40));
    await page.evaluate((rows) => {
      document.querySelectorAll('.catalogue_title').forEach((element, index) => {
        element.textContent = rows[index].title;
      });
      document.querySelector('#lessonOrder')!.textContent = `1.1、${rows[0].title}`;
    }, rows);
    const observed = await adapterFor(rows).observe();
    expect(observed.course.confidence).toBe('verified');
    expect(observed.chapters.map((chapter) => chapter.title)).toEqual(
      rows.map((row) => `${row.ordinal} ${row.title}`),
    );
    expect(new Set(observed.chapters.map((chapter) => chapter.chapterId)).size).toBe(2);
    expect(observed.currentChapterId).toBe(observed.chapters[0].chapterId);
  });
});
