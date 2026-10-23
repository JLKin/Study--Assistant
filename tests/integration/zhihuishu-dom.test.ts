import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import {
  ZhihuishuMonitorSiteAdapter,
  zhihuishuCourseId,
  zhihuishuCatalogueKey,
  zhihuishuChapterId,
} from '../../packages/site-adapter/src/zhihuishu';
import {
  readZhihuishuDom,
  type ZhihuishuDomSample,
} from '../../packages/site-adapter/src/zhihuishu-dom';
import type { SiteSignal } from '../../packages/contracts/src/monitor';

const address =
  'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-course-route-001';
// 仅真实 DOM 结构派生的合成页面，所有 HTTPS 请求均拦截，不加载真实课程/凭据。
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{height:1800px}.video-study{width:700px}.header_userInfo{width:30px;height:20px}
#vjs_container{width:300px;height:160px}.speedBox{width:160px;height:40px}.speedTab{display:inline-block;width:45px;height:30px}
.time_icofinish{display:inline-block;width:12px;height:12px}.catalogue_title{display:inline-block}
</style></head><body><div class="video-study"><div class="header_userInfo">测试</div><div class="userLinks"><i class="iconheiyemoshi-anquantuichu"></i></div>
<div class="source-name">合成课程</div><span id="lessonOrder">1.1、合成第一节</span>
<div id="vjs_container"><video id="vjs_container_html5_api" src="/media.webm" muted preload="auto"></video></div>
<div class="speedBox"><div class="speedTab" rate="1">X 1</div><div class="speedTab" rate="1.25">X 1.25</div><div class="speedTab" rate="1.5">X 1.5</div></div>
<ul class="chapterScrollbar"><li class="video current_play"><b class="hour">1.1</b><span class="catalogue_title">合成第一节</span><i class="time_ico_half"></i><b class="time_icofinish"></b><span class="time">00:00:05</span></li><li class="video"><b class="hour">1.2</b><span class="catalogue_title">合成第二节</span><i class="time_ico_half"></i><span class="time">00:00:05</span></li></ul></div>
<script>for(const el of document.querySelectorAll('.speedTab'))el.addEventListener('click',()=>{document.querySelector('video').playbackRate=Number(el.getAttribute('rate'));window.actionCount=(window.actionCount||0)+1;});</script></body></html>`;
let browser: Browser;
let page: Page;
const signal = () => new AbortController().signal;
const catalogueEvidence = {
  title: '合成课程',
  catalogue: [
    { ordinal: '1.1', title: '合成第一节', seconds: 5 },
    { ordinal: '1.2', title: '合成第二节', seconds: 5 },
  ],
} as ZhihuishuDomSample;
const syntheticEvidence = [
  {
    courseId: zhihuishuCourseId('synthetic-course-route-001'),
    catalogue: zhihuishuCatalogueKey(catalogueEvidence),
  },
];
const fixtureAdapter = () => new ZhihuishuMonitorSiteAdapter(page, syntheticEvidence);
const completionAdapter = () =>
  new ZhihuishuMonitorSiteAdapter(
    page,
    syntheticEvidence.map((entry) => ({ ...entry, completionMarkers: 'finish-half-v1' as const })),
  );

describe.runIf(process.platform === 'win32')('真实结构派生 DOM 回归（非真实平台人工验收）', () => {
  beforeAll(async () => {
    const media = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
    const edge = await findEdge();
    if (!edge) throw new Error('需要本机 Edge 进行派生 DOM 回归');
    browser = await chromium.launch({ executablePath: edge, headless: true });
    const context = await browser.newContext();
    await context.route('**/*', (route) =>
      route.fulfill(
        route.request().url().endsWith('/media.webm')
          ? { status: 200, contentType: 'video/webm', body: media }
          : { status: 200, contentType: 'text/html', body: html },
      ),
    );
    page = await context.newPage();
  });
  beforeEach(async () => {
    await page.goto(address);
    await expect
      .poll(() => page.locator('video').evaluate((el) => (el as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('结构化真实来源和兼容ID，无图标语义不会写成完成', async () => {
    const adapter = fixtureAdapter();
    expect(await page.evaluate(readZhihuishuDom, undefined)).not.toBeNull();
    const observed = await adapter.observe();
    expect(observed.course).toMatchObject({
      source: 'zhihuishu-dom',
      confidence: 'verified',
      authenticated: true,
      platformCompleted: null,
    });
    expect(observed.course.courseId).toMatch(/^zhs_c_[a-f0-9]{64}$/);
    expect(observed.currentChapterId).toMatch(/^zhs_v1_[a-f0-9]{64}$/);
    expect(observed.chapters).toHaveLength(2);
    expect(observed.chapters.every((c) => c.platformCompleted === null)).toBe(true);
    expect(observed.capabilities).toMatchObject({
      playbackRate: false,
      refresh: false,
      navigation: false,
      completionMarkers: false,
    });
    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain('synthetic-course-route-001');
    await expect(
      adapter.perform(
        {
          type: 'navigate',
          chapterId: observed.chapters[1].chapterId,
          fromChapterId: observed.currentChapterId!,
        },
        observed.course.courseId!,
        signal(),
      ),
    ).rejects.toThrow('待真实环境人工验收');
    await expect(
      adapter.perform(
        { type: 'refresh', chapterId: observed.currentChapterId! },
        observed.course.courseId!,
        signal(),
      ),
    ).rejects.toThrow('待真实环境人工验收');
    await expect(
      adapter.perform(
        { type: 'recover-play', chapterId: observed.currentChapterId! },
        observed.course.courseId!,
        signal(),
      ),
    ).rejects.toThrow('禁止自动恢复播放');
  });
  it('自动调速准备和执行都拒绝，实际倍速与暂停不变且零菜单点击', async () => {
    const adapter = fixtureAdapter();
    const before = await adapter.observe();
    const action = { type: 'set-rate', rate: 1.5, chapterId: before.currentChapterId! } as const;
    await expect(adapter.prepare(action, before.course.courseId!, signal())).rejects.toThrow(
      '手动设置倍速',
    );
    await expect(adapter.perform(action, before.course.courseId!, signal())).rejects.toThrow(
      '手动设置倍速',
    );
    expect((await adapter.observe()).player).toMatchObject({ playbackRate: 1, paused: true });
    expect(
      await page.evaluate(() => (window as unknown as { actionCount?: number }).actionCount ?? 0),
    ).toBe(0);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      adapter.prepare(action, before.course.courseId!, cancelled.signal),
    ).rejects.toThrow();
    await expect(
      adapter.perform(action, before.course.courseId!, cancelled.signal),
    ).rejects.toThrow();
    expect(
      await page.evaluate(() => (window as unknown as { actionCount?: number }).actionCount ?? 0),
    ).toBe(0);
  });
  it.each([1.25, 2])('用户手动选 %s 倍速仍可只读观察，不受旧菜单白名单影响', async (rate) => {
    const adapter = fixtureAdapter();
    if (rate === 2)
      await page.locator('.speedTab[rate="1.5"]').evaluate((element) => {
        element.setAttribute('rate', '2');
        element.textContent = 'X 2';
      });
    const events: SiteSignal[] = [];
    const dispose = await adapter.subscribe((event) => events.push(event));
    await page.locator(`.speedTab[rate="${rate}"]`).click();
    await expect.poll(() => events.some((event) => event.type === 'manual')).toBe(true);
    const after = await adapter.observe();
    expect(after.course.confidence).toBe('verified');
    expect(after.player).toMatchObject({ playbackRate: rate, paused: true });
    expect(after.supportedRates).toEqual([]);
    expect(after.capabilities?.playbackRate).toBe(false);
    await expect.poll(() => events.some((event) => event.eventName === 'ratechange')).toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as { actionCount?: number }).actionCount ?? 0),
    ).toBe(1);
    dispose();
  });
  it('只读观察不依赖倍速菜单，缺失菜单也不会恢复自动调速', async () => {
    const adapter = fixtureAdapter();
    await page.locator('.speedBox').evaluate((element) => element.remove());
    const before = await adapter.observe();
    expect(before.course.confidence).toBe('verified');
    expect(before.player?.playbackRate).toBe(1);
    expect(before.capabilities?.playbackRate).toBe(false);
    await expect(
      adapter.prepare(
        { type: 'set-rate', rate: 1.5, chapterId: before.currentChapterId! },
        before.course.courseId!,
        signal(),
      ),
    ).rejects.toThrow('手动设置倍速');
    expect((await adapter.observe()).player?.playbackRate).toBe(1);
    expect(
      await page.evaluate(() => (window as unknown as { actionCount?: number }).actionCount ?? 0),
    ).toBe(0);
  });
  it('目录变化永久失效，新目录创建不同章节ID', async () => {
    const adapter = fixtureAdapter();
    const first = await adapter.observe();
    await page
      .locator('.catalogue_title')
      .nth(1)
      .evaluate((el) => {
        el.textContent = '不同的第二节';
      });
    expect((await adapter.observe()).course.confidence).toBe('uncertain');
    const next = await fixtureAdapter().observe();
    expect(next.course.confidence).toBe('uncertain');
    const revised = {
      ...catalogueEvidence,
      catalogue: catalogueEvidence.catalogue.map((row, index) =>
        index === 1 ? { ...row, title: '不同的第二节' } : row,
      ),
    };
    expect(
      zhihuishuChapterId(first.course.courseId!, zhihuishuCatalogueKey(revised), '1.1'),
    ).not.toBe(first.currentChapterId);
  });
  it.each([
    'duplicate-current',
    'wrong-duration',
    'missing-user',
    'modal',
    'wrong-caption',
    'duplicate-ordinal',
  ] as const)('%s 阻止可靠课程或自动动作', async (mode) => {
    await page.evaluate((mode) => {
      if (mode === 'duplicate-current')
        document.querySelectorAll('li.video')[1].classList.add('current_play');
      if (mode === 'wrong-duration') document.querySelector('.time')!.textContent = '00:20:00';
      if (mode === 'missing-user') document.querySelector('.header_userInfo')!.remove();
      if (mode === 'modal') {
        const el = document.createElement('div');
        el.className = 'el-dialog__wrapper';
        el.textContent = '测试弹窗';
        document.body.append(el);
      }
      if (mode === 'wrong-caption')
        document.querySelector('#lessonOrder')!.textContent = '另一个视频';
      if (mode === 'duplicate-ordinal') document.querySelectorAll('.hour')[1].textContent = '1.1';
    }, mode);
    const adapter = fixtureAdapter();
    expect((await adapter.observe()).course.confidence).toBe('uncertain');
  });
  it('路由变化失效，重载必须重新适配', async () => {
    const adapter = fixtureAdapter();
    const events: SiteSignal[] = [];
    const dispose = await adapter.subscribe((event) => events.push(event));
    await adapter.observe();
    await page.evaluate(() =>
      history.pushState({}, '', '?recruitAndCourseId=synthetic-another-route-002'),
    );
    await expect.poll(() => events.some((event) => event.type === 'navigation')).toBe(true);
    expect((await adapter.observe()).course.confidence).toBe('uncertain');
    dispose();
  });
  it('媒体事件可观察，可信关键输入触发manual而滚动不触发', async () => {
    const adapter = fixtureAdapter();
    const events: SiteSignal[] = [];
    const dispose = await adapter.subscribe((event) => events.push(event));
    await page.mouse.wheel(0, 100);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.filter((event) => event.type === 'manual')).toHaveLength(0);
    await page.locator('video').dispatchEvent('waiting');
    await expect.poll(() => events.some((event) => event.eventName === 'waiting')).toBe(true);
    await page.locator('.speedTab').first().click();
    await expect.poll(() => events.some((event) => event.type === 'manual')).toBe(true);
    const count = events.length;
    dispose();
    await page.locator('video').dispatchEvent('playing');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events).toHaveLength(count);
  });
  it('生产证据清单拒绝未核验路由，即使 DOM 看起来完整', async () => {
    const observed = await new ZhihuishuMonitorSiteAdapter(page).observe();
    expect(observed.course.confidence).toBe('uncertain');
    expect(observed.capabilities?.playbackRate).toBe(false);
  });
  it('完成语义证据与完整布尔标记共同授予能力，动态标记不改变章节 ID', async () => {
    const adapter = completionAdapter();
    const before = await adapter.observe();
    expect(before.chapters.map((row) => row.platformCompleted)).toEqual([true, false]);
    expect(before.capabilities).toMatchObject({
      completionMarkers: true,
      navigation: true,
      recoverPlay: true,
      playbackRate: false,
      refresh: false,
    });
    await page
      .locator('li.video')
      .nth(1)
      .evaluate((row) => {
        const icon = document.createElement('b');
        icon.className = 'time_icofinish';
        row.append(icon);
      });
    const after = await adapter.observe();
    expect(after.chapters.map((row) => row.platformCompleted)).toEqual([true, true]);
    expect(after.course.platformCompleted).toBe(true);
    expect(after.chapters.map((row) => row.chapterId)).toEqual(
      before.chapters.map((row) => row.chapterId),
    );
  });
  it.each(['missing-half', 'duplicate-half', 'duplicate-finish', 'hidden-finish'] as const)(
    '%s令完成标记整体保持未知且关闭切章',
    async (mode) => {
      await page
        .locator('li.video')
        .first()
        .evaluate((row, mode) => {
          if (mode === 'missing-half') row.querySelector('.time_ico_half')!.remove();
          if (mode === 'duplicate-half')
            row.append(row.querySelector('.time_ico_half')!.cloneNode());
          if (mode === 'duplicate-finish')
            row.append(row.querySelector('.time_icofinish')!.cloneNode());
          if (mode === 'hidden-finish')
            (row.querySelector('.time_icofinish') as HTMLElement).style.display = 'none';
        }, mode);
      const observed = await completionAdapter().observe();
      expect(observed.capabilities?.navigation).toBe(false);
      expect(observed.capabilities?.completionMarkers).toBe(false);
      expect(observed.chapters.every((row) => row.platformCompleted === null)).toBe(true);
      expect(observed.capabilities?.recoverPlay).toBe(true);
    },
  );
  it('恢复只调用标准play，保持手动倍速；人为暂停和结束均拒绝', async () => {
    const adapter = fixtureAdapter();
    const observed = await adapter.observe();
    const action = { type: 'recover-play', chapterId: observed.currentChapterId! } as const;
    await page.locator('video').evaluate((element) => {
      const media = element as HTMLVideoElement;
      media.playbackRate = 1.25;
      Object.defineProperty(media, 'paused', { configurable: true, value: false });
      media.play = async () => {
        (window as unknown as { recoverCount?: number }).recoverCount =
          ((window as unknown as { recoverCount?: number }).recoverCount ?? 0) + 1;
      };
    });
    await adapter.prepare(action, observed.course.courseId!, signal());
    await adapter.perform(action, observed.course.courseId!, signal());
    expect(
      await page.evaluate(() => (window as unknown as { recoverCount?: number }).recoverCount),
    ).toBe(1);
    expect((await adapter.observe()).player?.playbackRate).toBe(1.25);
    await page
      .locator('video')
      .evaluate((media) =>
        Object.defineProperty(media, 'paused', { configurable: true, value: true }),
      );
    await expect(adapter.perform(action, observed.course.courseId!, signal())).rejects.toThrow(
      '禁止自动恢复播放',
    );
    await page.locator('video').evaluate((media) => {
      Object.defineProperty(media, 'paused', { configurable: true, value: false });
      Object.defineProperty(media, 'ended', { configurable: true, value: true });
    });
    await expect(adapter.prepare(action, observed.course.courseId!, signal())).rejects.toThrow(
      '禁止自动恢复播放',
    );
    expect(
      await page.evaluate(() => (window as unknown as { recoverCount?: number }).recoverCount),
    ).toBe(1);
  });
  it.each([undefined, false])(
    '开始播放权限 %s 时准备和执行均拒绝，零play调用',
    async (startPlay) => {
      const adapter = new ZhihuishuMonitorSiteAdapter(page, syntheticEvidence, { startPlay });
      const observed = await adapter.observe();
      expect(observed.capabilities?.startPlay).toBe(false);
      const action = { type: 'start-play', chapterId: observed.currentChapterId! } as const;
      await page.locator('video').evaluate((element) => {
        (element as HTMLVideoElement).play = async () => {
          (window as unknown as { playCount?: number }).playCount = 1;
        };
      });
      await expect(adapter.prepare(action, observed.course.courseId!, signal())).rejects.toThrow(
        '明确授权',
      );
      await expect(adapter.perform(action, observed.course.courseId!, signal())).rejects.toThrow(
        '明确授权',
      );
      expect(
        await page.evaluate(() => (window as unknown as { playCount?: number }).playCount ?? 0),
      ).toBe(0);
    },
  );
  it('单次显式开始调用原生play并观察实际时间前进，保持静音与手动倍速，不授予默认恢复', async () => {
    const permissions = { startPlay: true };
    const adapter = new ZhihuishuMonitorSiteAdapter(page, syntheticEvidence, permissions);
    // 页面正常点击先建立浏览器用户激活，测试不以改静音规避播放策略。
    await page.locator('body').click({ position: { x: 20, y: 500 } });
    await page.locator('video').evaluate((element) => {
      const media = element as HTMLVideoElement;
      media.muted = false;
      media.playbackRate = 1.25;
      const play = media.play.bind(media);
      media.play = () => {
        (window as unknown as { playCount?: number }).playCount =
          ((window as unknown as { playCount?: number }).playCount ?? 0) + 1;
        return play();
      };
    });
    const before = await adapter.observe();
    expect(before.capabilities?.startPlay).toBe(true);
    const action = { type: 'start-play', chapterId: before.currentChapterId! } as const;
    await adapter.prepare(action, before.course.courseId!, signal());
    await adapter.perform(action, before.course.courseId!, signal());
    await expect
      .poll(async () => (await adapter.observe()).player?.currentTime ?? 0)
      .toBeGreaterThan(before.player!.currentTime + 0.15);
    expect((await adapter.observe()).player).toMatchObject({
      paused: false,
      ended: false,
      playbackRate: 1.25,
    });
    expect(
      await page.locator('video').evaluate((element) => (element as HTMLVideoElement).muted),
    ).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { playCount?: number }).playCount)).toBe(
      1,
    );
    // 已播放不能再次当作开始；普通恢复仍遵守原有的“用户暂停则拒绝”规则。
    await expect(adapter.perform(action, before.course.courseId!, signal())).rejects.toThrow(
      '当前暂停且未结束',
    );
    await page.locator('video').evaluate((element) => (element as HTMLVideoElement).pause());
    await expect(
      adapter.perform(
        { type: 'recover-play', chapterId: before.currentChapterId! },
        before.course.courseId!,
        signal(),
      ),
    ).rejects.toThrow('禁止自动恢复播放');
    permissions.startPlay = false;
    expect((await adapter.observe()).capabilities?.startPlay).toBe(true);
    expect((await fixtureAdapter().observe()).capabilities?.startPlay).toBe(false);
  });
  it.each(['wrong-chapter', 'ended', 'playing', 'popup'] as const)(
    '显式开始%s在准备时拒绝且不调用play',
    async (mode) => {
      const adapter = new ZhihuishuMonitorSiteAdapter(page, syntheticEvidence, { startPlay: true });
      const before = await adapter.observe();
      await page.evaluate((mode) => {
        const media = document.querySelector('video')!;
        media.play = async () => {
          (window as unknown as { playCount?: number }).playCount = 1;
        };
        if (mode === 'ended')
          Object.defineProperty(media, 'ended', { configurable: true, value: true });
        if (mode === 'playing')
          Object.defineProperty(media, 'paused', { configurable: true, value: false });
        if (mode === 'popup') {
          const popup = document.createElement('div');
          popup.setAttribute('role', 'dialog');
          popup.textContent = '请人工处理';
          document.body.append(popup);
        }
      }, mode);
      const action = {
        type: 'start-play',
        chapterId: mode === 'wrong-chapter' ? 'not-current' : before.currentChapterId!,
      } as const;
      await expect(adapter.prepare(action, before.course.courseId!, signal())).rejects.toThrow();
      expect(
        await page.evaluate(() => (window as unknown as { playCount?: number }).playCount ?? 0),
      ).toBe(0);
    },
  );
  it.each(['playing', 'catalogue', 'popup', 'cancelled'] as const)(
    '显式开始最后授权时%s变化，零play调用',
    async (mode) => {
      const adapter = new ZhihuishuMonitorSiteAdapter(page, syntheticEvidence, { startPlay: true });
      const before = await adapter.observe();
      await page.locator('video').evaluate((media) => {
        (media as HTMLVideoElement).play = async () => {
          (window as unknown as { playCount?: number }).playCount = 1;
        };
      });
      const controller = new AbortController();
      const original = page.exposeBinding.bind(page);
      const override = vi.spyOn(page, 'exposeBinding').mockImplementation((name, callback) =>
        original(name, async (source, ...args) => {
          if (name.startsWith('zhsAuthorize_')) {
            if (mode === 'cancelled') controller.abort();
            else
              await page.evaluate((mode) => {
                if (mode === 'playing')
                  Object.defineProperty(document.querySelector('video')!, 'paused', {
                    configurable: true,
                    value: false,
                  });
                if (mode === 'catalogue')
                  document.querySelectorAll('.catalogue_title')[1].textContent = '目录变化';
                if (mode === 'popup') {
                  const notice = document.createElement('div');
                  notice.setAttribute('role', 'alert');
                  notice.textContent = '检测到异常脚本';
                  document.body.append(notice);
                }
              }, mode);
          }
          return callback(source, ...args);
        }),
      );
      try {
        await expect(
          adapter.perform(
            { type: 'start-play', chapterId: before.currentChapterId! },
            before.course.courseId!,
            controller.signal,
          ),
        ).rejects.toThrow();
        expect(
          await page.evaluate(() => (window as unknown as { playCount?: number }).playCount ?? 0),
        ).toBe(0);
      } finally {
        override.mockRestore();
      }
    },
  );
  it('显式开始遇到原生拒绝只调用一次，不改静音、倍速或切换后备方式', async () => {
    const adapter = new ZhihuishuMonitorSiteAdapter(page, syntheticEvidence, { startPlay: true });
    const before = await adapter.observe();
    await page.locator('video').evaluate((element) => {
      const media = element as HTMLVideoElement;
      media.muted = false;
      media.playbackRate = 1.25;
      media.play = async () => {
        (window as unknown as { playCount?: number }).playCount =
          ((window as unknown as { playCount?: number }).playCount ?? 0) + 1;
        throw new DOMException('user activation required', 'NotAllowedError');
      };
    });
    await expect(
      adapter.perform(
        { type: 'start-play', chapterId: before.currentChapterId! },
        before.course.courseId!,
        signal(),
      ),
    ).rejects.toThrow('user activation required');
    expect(
      await page.locator('video').evaluate((element) => ({
        muted: (element as HTMLVideoElement).muted,
        rate: (element as HTMLVideoElement).playbackRate,
      })),
    ).toEqual({ muted: false, rate: 1.25 });
    expect(await page.evaluate(() => (window as unknown as { playCount?: number }).playCount)).toBe(
      1,
    );
  });
  it('准备导航只滚动不点击，完整条件满足后仅点一次首个未完成标题并等待异步反馈', async () => {
    const adapter = completionAdapter();
    const observed = await adapter.observe();
    await page
      .locator('video')
      .evaluate((media) =>
        Object.defineProperty(media, 'ended', { configurable: true, value: true }),
      );
    await page
      .locator('.catalogue_title')
      .nth(1)
      .evaluate((element) =>
        element.addEventListener('click', () => {
          (window as unknown as { navigateCount?: number }).navigateCount =
            ((window as unknown as { navigateCount?: number }).navigateCount ?? 0) + 1;
          setTimeout(() => {
            document.querySelector('li.current_play')!.classList.remove('current_play');
            document.querySelectorAll('li.video')[1].classList.add('current_play');
            document.querySelector('#lessonOrder')!.textContent = '1.2、合成第二节';
            Object.defineProperty(document.querySelector('video')!, 'ended', {
              configurable: true,
              value: false,
            });
          }, 100);
        }),
      );
    const action = {
      type: 'navigate',
      fromChapterId: observed.currentChapterId!,
      chapterId: observed.chapters[1].chapterId,
    } as const;
    await adapter.prepare(action, observed.course.courseId!, signal());
    expect(
      await page.evaluate(
        () => (window as unknown as { navigateCount?: number }).navigateCount ?? 0,
      ),
    ).toBe(0);
    await adapter.perform(action, observed.course.courseId!, signal());
    expect((await adapter.observe()).currentChapterId).toBe(action.chapterId);
    expect((await adapter.observe()).player).toMatchObject({ paused: true, playbackRate: 1 });
    expect(
      await page.evaluate(() => (window as unknown as { navigateCount?: number }).navigateCount),
    ).toBe(1);
  });
  it('根外隐藏目录副本不影响准备导航，且只点击已核验课程根内目标一次', async () => {
    await page.evaluate(() => {
      const root = document.querySelector('.video-study')!;
      const catalogue = root.querySelector('.chapterScrollbar')!;
      const duplicate = catalogue.cloneNode(true) as HTMLElement;
      duplicate.style.display = 'none';
      document.body.prepend(duplicate);
      const counts = { root: 0, outside: 0 };
      (window as unknown as { navigationClicks: typeof counts }).navigationClicks = counts;
      duplicate.querySelectorAll('.catalogue_title').forEach((element) => {
        element.addEventListener('click', () => counts.outside++);
      });
      const video = root.querySelector('video')!;
      Object.defineProperty(video, 'ended', { configurable: true, value: true });
      const scope = window as unknown as { releaseNavigationFeedback?: () => void };
      catalogue.querySelectorAll('.catalogue_title')[1].addEventListener('click', () => {
        counts.root++;
        // 由测试显式释放反馈，避免机器调度延迟使“点击不是确认”断言偶发失败。
        scope.releaseNavigationFeedback = () => {
          catalogue.querySelector('.current_play')!.classList.remove('current_play');
          catalogue.querySelectorAll('li.video')[1].classList.add('current_play');
          root.querySelector('#lessonOrder')!.textContent = '1.2、合成第二节';
          Object.defineProperty(video, 'ended', { configurable: true, value: false });
          delete scope.releaseNavigationFeedback;
        };
      });
    });
    const adapter = completionAdapter();
    const observed = await adapter.observe();
    expect(observed.course.confidence).toBe('verified');
    expect(observed.chapters).toHaveLength(2);
    const action = {
      type: 'navigate',
      fromChapterId: observed.currentChapterId!,
      chapterId: observed.chapters[1].chapterId,
    } as const;
    const clicks = () =>
      page.evaluate(
        () =>
          (window as unknown as { navigationClicks: { root: number; outside: number } })
            .navigationClicks,
      );
    await adapter.prepare(action, observed.course.courseId!, signal());
    expect(await clicks()).toEqual({ root: 0, outside: 0 });
    let settled = false;
    const outcome = adapter.perform(action, observed.course.courseId!, signal()).then(
      () => {
        settled = true;
        return { ok: true };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false, error };
      },
    );
    await expect.poll(clicks).toEqual({ root: 1, outside: 0 });
    expect(settled).toBe(false);
    await page.evaluate(() =>
      (
        window as unknown as { releaseNavigationFeedback?: () => void }
      ).releaseNavigationFeedback?.(),
    );
    expect(await outcome).toEqual({ ok: true });
    const after = await adapter.observe();
    expect(after.currentChapterId).toBe(action.chapterId);
    expect(after.player).toMatchObject({ paused: true, ended: false, playbackRate: 1 });
    expect(await clicks()).toEqual({ root: 1, outside: 0 });
  });
  it.each(['delayed-media', 'stale-media'] as const)(
    '等时长导航%s不能仅凭目录标题变化误确认，也不重复点击',
    async (mode) => {
      const adapter = completionAdapter();
      const before = await adapter.observe();
      await page
        .locator('video')
        .evaluate((media) =>
          Object.defineProperty(media, 'ended', { configurable: true, value: true }),
        );
      const events: SiteSignal[] = [];
      const dispose = await adapter.subscribe((event) => events.push(event));
      await page.locator('video').dispatchEvent('waiting');
      await expect.poll(() => events.some((event) => event.eventName === 'waiting')).toBe(true);
      await page
        .locator('.catalogue_title')
        .nth(1)
        .evaluate((element) => {
          element.addEventListener('click', () => {
            (window as unknown as { navigateCount?: number }).navigateCount =
              ((window as unknown as { navigateCount?: number }).navigateCount ?? 0) + 1;
            document.querySelector('li.current_play')!.classList.remove('current_play');
            document.querySelectorAll('li.video')[1].classList.add('current_play');
            document.querySelector('#lessonOrder')!.textContent = '1.2、合成第二节';
            // 同为5秒，故仅依赖元数据时长和目录标题会错误复用旧 ended 媒体。
          });
        });
      const controller = new AbortController();
      let settled = false;
      const work = adapter.perform(
        {
          type: 'navigate',
          fromChapterId: before.currentChapterId!,
          chapterId: before.chapters[1].chapterId,
        },
        before.course.courseId!,
        controller.signal,
      );
      // 立即附上两种结果处理，避免预计的超时 rejection 成为未处理 Promise。
      const outcome = work.then(
        () => {
          settled = true;
          return { ok: true, error: null };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false, error };
        },
      );
      await expect.poll(() => page.locator('#lessonOrder').textContent()).toContain('1.2');
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(settled).toBe(false);
      if (mode === 'delayed-media') {
        await page.locator('video').evaluate((media) => {
          Object.defineProperty(media, 'ended', { configurable: true, value: false });
          Object.defineProperty(media, 'paused', { configurable: true, value: false });
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);
        expect(await outcome).toMatchObject({ ok: true });
        expect((await adapter.observe()).player?.buffering).toBe(false);
      } else {
        expect(await outcome).toMatchObject({ ok: false });
      }
      expect(
        await page.evaluate(() => (window as unknown as { navigateCount?: number }).navigateCount),
      ).toBe(1);
      dispose();
    },
  );
  it.each(['not-ended', 'source-incomplete', 'covered', 'popup', 'cancelled'] as const)(
    '导航%s不点击，不放宽完成条件',
    async (mode) => {
      const adapter = completionAdapter();
      const observed = await adapter.observe();
      await page
        .locator('video')
        .evaluate(
          (media, ended) =>
            Object.defineProperty(media, 'ended', { configurable: true, value: ended }),
          mode !== 'not-ended',
        );
      await page.evaluate((mode) => {
        document.querySelectorAll('.catalogue_title')[1].addEventListener('click', () => {
          (window as unknown as { navigateCount?: number }).navigateCount = 1;
        });
        if (mode === 'source-incomplete') document.querySelector('.time_icofinish')!.remove();
        if (mode === 'covered' || mode === 'popup') {
          const cover = document.createElement('div');
          cover.style.cssText = 'position:fixed;inset:0;background:white;z-index:100';
          if (mode === 'popup') cover.setAttribute('role', 'dialog');
          document.body.append(cover);
        }
      }, mode);
      const controller = new AbortController();
      if (mode === 'cancelled') controller.abort();
      await expect(
        adapter.perform(
          {
            type: 'navigate',
            fromChapterId: observed.currentChapterId!,
            chapterId: observed.chapters[1].chapterId,
          },
          observed.course.courseId!,
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(
        await page.evaluate(
          () => (window as unknown as { navigateCount?: number }).navigateCount ?? 0,
        ),
      ).toBe(0);
    },
  );
  it('非模态脚本检测提示阻断观察和全部动作，正常成功toast不影响', async () => {
    const adapter = completionAdapter();
    await page.evaluate(() => {
      const notice = document.createElement('div');
      notice.setAttribute('role', 'alert');
      notice.textContent = '操作成功';
      document.body.append(notice);
    });
    const before = await adapter.observe();
    expect(before.course.confidence).toBe('verified');
    await page.locator('[role=alert]').evaluate((element) => {
      element.textContent = '检测到脚本执行';
    });
    const after = await adapter.observe();
    expect(after.popup).toBe('present');
    expect(after.course.confidence).toBe('uncertain');
    expect(Object.values(after.capabilities!).every((enabled) => !enabled)).toBe(true);
    await expect(
      adapter.perform(
        { type: 'recover-play', chapterId: before.currentChapterId! },
        before.course.courseId!,
        signal(),
      ),
    ).rejects.toThrow();
  });
  it.each(['pause', 'catalogue', 'popup', 'cancelled'] as const)(
    '最后单次授权前%s变化，同任务最终检查拒绝且零play调用',
    async (mode) => {
      const adapter = completionAdapter();
      const observed = await adapter.observe();
      await page.locator('video').evaluate((element) => {
        Object.defineProperty(element, 'paused', { configurable: true, value: false });
        (element as HTMLVideoElement).play = async () => {
          (window as unknown as { playCount?: number }).playCount = 1;
        };
      });
      const controller = new AbortController();
      const original = page.exposeBinding.bind(page);
      const override = vi.spyOn(page, 'exposeBinding').mockImplementation((name, callback) =>
        original(name, async (source, ...args) => {
          if (name.startsWith('zhsAuthorize_')) {
            if (mode === 'cancelled') controller.abort();
            else
              await page.evaluate((mode) => {
                if (mode === 'pause')
                  Object.defineProperty(document.querySelector('video')!, 'paused', {
                    configurable: true,
                    value: true,
                  });
                if (mode === 'catalogue')
                  document.querySelectorAll('.catalogue_title')[1].textContent = '目录已变化';
                if (mode === 'popup') {
                  const alert = document.createElement('div');
                  alert.setAttribute('role', 'alert');
                  alert.textContent = '检测到脚本执行';
                  document.body.append(alert);
                }
              }, mode);
          }
          return callback(source, ...args);
        }),
      );
      try {
        await expect(
          adapter.perform(
            { type: 'recover-play', chapterId: observed.currentChapterId! },
            observed.course.courseId!,
            controller.signal,
          ),
        ).rejects.toThrow();
        expect(
          await page.evaluate(() => (window as unknown as { playCount?: number }).playCount ?? 0),
        ).toBe(0);
      } finally {
        override.mockRestore();
      }
    },
  );
});
