import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import { StateStore } from '../../packages/persistence/src/index';
import { TaskEngine } from '../../packages/task-engine/src/index';
import type { SiteAction, SiteSignal } from '../../packages/contracts/src/monitor';
import { monitorAdapterForPage } from '../../packages/site-adapter/src/monitor';
import {
  RestrictedZhihuishuSiteAdapter,
  zhihuishuCatalogueKey,
  zhihuishuCourseId,
} from '../../packages/site-adapter/src/zhihuishu';
import type { ZhihuishuDomSample } from '../../packages/site-adapter/src/zhihuishu-dom';
import { BrowserNavigationCandidate } from '../../packages/site-adapter/src/browser-navigation-candidate';

// Every request is fulfilled locally. This is an independent derived fixture, never a real course.
const routeValue = 'synthetic-browser-navigation-candidate-001';
const address = `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${routeValue}`;
const mediaAddress = new URL('/candidate-media.webm', address).href;
const title = '普通浏览器导航离线合成课程';
const catalogue = [
  { ordinal: '1.1', title: '已结束源章节', seconds: 5 },
  { ordinal: '1.2', title: '首个未完成章节', seconds: 5 },
  { ordinal: '1.3', title: '后续未完成章节', seconds: 5 },
];
const evidence = [
  {
    courseId: zhihuishuCourseId(routeValue),
    catalogue: zhihuishuCatalogueKey({ title, catalogue } as ZhihuishuDomSample),
    completionMarkers: 'finish-half-v1' as const,
  },
];
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:20px;font:16px sans-serif}.video-study{width:720px}.header_userInfo{width:50px;height:24px}
#vjs_container{width:320px;height:220px}video{width:240px;height:140px}
.chapterScrollbar{padding:0;list-style:none}li.video{display:block;width:650px;height:44px;margin:5px 0}
.catalogue_title{display:inline-block;width:260px;height:34px;line-height:34px;cursor:pointer}
.time_icofinish{display:inline-block;width:12px;height:12px}.hour,.time{display:inline-block;margin:0 12px}
</style></head><body><p>仅离线候选测试，不代表真实平台人工验收。</p>
<main class="video-study"><div class="header_userInfo">合成登录</div>
<div class="userLinks"><i class="iconheiyemoshi-anquantuichu"></i></div>
<h1 class="source-name">${title}</h1><h2 id="lessonOrder">1.1、已结束源章节</h2>
<div id="vjs_container"><video id="vjs_container_html5_api" src="/candidate-media.webm" muted preload="auto"></video><button id="manual-control" class="videoArea">人工播放器控件</button></div>
<ul class="chapterScrollbar">${catalogue.map((row, index) => `<li class="video${index === 0 ? ' current_play' : ''}"><b class="hour">${row.ordinal}</b><span class="catalogue_title">${row.title}</span><i class="time_ico_half"></i>${index === 0 ? '<b class="time_icofinish"></b>' : ''}<span class="time">00:00:05</span></li>`).join('')}</ul></main>
<script>
window.navFixture={clicks:0,domClicks:0,trusted:[],feedback:'normal',delay:150,playCalls:0,pointerdowns:0};
const nativeClick=HTMLElement.prototype.click;
HTMLElement.prototype.click=function(){if(this.matches('.catalogue_title'))window.navFixture.domClicks++;return nativeClick.call(this)};
const media=document.querySelector('video');
const nativePlay=media.play.bind(media);
media.play=function(){window.navFixture.playCalls++;return nativePlay()};
for(const row of document.querySelectorAll('li.video')){
 const control=row.querySelector('.catalogue_title');
 control.addEventListener('pointerdown',()=>{window.navFixture.pointerdowns++;if(window.onCandidatePointer)void window.onCandidatePointer()});
 control.addEventListener('click',(event)=>{
  window.navFixture.clicks++;window.navFixture.trusted.push(event.isTrusted);
  if(window.navFixture.feedback==='none')return;
  setTimeout(()=>{
   if(window.navFixture.feedback==='source-node-gap'){
     window.removedCandidateMedia=media;media.remove();return;
   }
   document.querySelectorAll('li.video').forEach(item=>item.classList.remove('current_play'));
   row.classList.add('current_play');
   document.querySelector('#lessonOrder').textContent=row.querySelector('.hour').textContent+'、'+control.textContent;
   delete media.ended;media.currentTime=0;
   if(window.navFixture.feedback==='node-gap'){
     window.removedCandidateMedia=media;media.remove();return;
   }
   if(window.navFixture.feedback==='source-incomplete')document.querySelector('li.video .time_icofinish')?.remove();
   if(window.navFixture.feedback==='old-media')return;
   const savedRate=media.playbackRate;
   media.addEventListener('loadedmetadata',()=>{media.playbackRate=savedRate},{once:true});
   if(['metadata-staged','metadata-held'].includes(window.navFixture.feedback)){
     Object.defineProperty(media,'readyState',{configurable:true,get:()=>0});
     if(window.navFixture.feedback==='metadata-staged')setTimeout(()=>{delete media.readyState;media.load()},650);
   }else media.load();
  },window.navFixture.delay);
 });
}
</script></body></html>`;

type Navigation = Extract<SiteAction, { type: 'navigate' }>;
interface FixtureState {
  clicks: number;
  domClicks: number;
  trusted: boolean[];
  feedback: string;
  delay: number;
  playCalls: number;
  pointerdowns: number;
}
let browser: Browser;
let context: BrowserContext;
let page: Page;
let media: Buffer;
const candidates: BrowserNavigationCandidate[] = [];
const temporaryDirectories: string[] = [];
const signal = () => new AbortController().signal;
const snapshot = () =>
  page.evaluate(() =>
    structuredClone((window as unknown as { navFixture: FixtureState }).navFixture),
  );
function candidate(
  permissions: Readonly<{
    navigation?: boolean;
    allowCompletedSourceBeforeEnd?: boolean;
    nextVideoAt81Percent?: boolean;
    retainGuardAfterConfirmation?: boolean;
  }> = { navigation: true },
) {
  const instance = new BrowserNavigationCandidate(page, evidence, permissions);
  candidates.push(instance);
  return instance;
}
async function actionFor(instance: BrowserNavigationCandidate, index = 1) {
  const observed = await instance.observe();
  expect(observed.course.confidence).toBe('verified');
  const action: Navigation = {
    type: 'navigate',
    chapterId: observed.chapters[index].chapterId,
    fromChapterId: observed.currentChapterId!,
  };
  return { action, courseId: observed.course.courseId!, observed };
}
async function alreadyCompletedBeforeEnd() {
  // Only this isolated fixture simulates replay of an already credited chapter.
  await page.locator('video').evaluate((node) => {
    const video = node as HTMLVideoElement;
    video.pause();
    video.currentTime = video.duration * 0.7;
    Object.defineProperty(video, 'ended', { configurable: true, value: false });
  });
}
async function sequentialSourceAt(progress: number) {
  // Exact local progress/state injection avoids native seek rounding and never
  // changes any real course, completion marker, playback rate, or play() call.
  await page.locator('video').evaluate((node, fraction) => {
    const video = node as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      writable: true,
      value: video.duration * fraction,
    });
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    Object.defineProperty(video, 'ended', { configurable: true, value: false });
  }, progress);
}

async function holdFreshMetadataTransition(mode: 'metadata-old-time' | 'seeking-old-time') {
  // The browser must emit real loadedmetadata first. The local overrides then model
  // a transient mix of new target metadata and the previous chapter's old time.
  await page.locator('video').evaluate((node, transition) => {
    const video = node as HTMLVideoElement;
    video.addEventListener(
      'loadedmetadata',
      () => {
        Object.defineProperty(video, 'readyState', {
          configurable: true,
          value: transition === 'metadata-old-time' ? 1 : 2,
        });
        Object.defineProperty(video, 'currentTime', {
          configurable: true,
          value: video.duration + 60,
        });
        Object.defineProperty(video, 'seeking', {
          configurable: true,
          value: transition === 'seeking-old-time',
        });
      },
      { once: true },
    );
  }, mode);
}

async function selectMediaNodeGap(sourceRemainsActive = false) {
  await page.evaluate((source) => {
    (window as unknown as { navFixture: FixtureState }).navFixture.feedback = source
      ? 'source-node-gap'
      : 'node-gap';
  }, sourceRemainsActive);
}

async function insertFreshTargetVideo() {
  await page.evaluate(() => {
    const video = document.createElement('video');
    video.id = 'vjs_container_html5_api';
    video.muted = true;
    video.preload = 'auto';
    const play = video.play.bind(video);
    video.play = () => {
      (window as unknown as { navFixture: FixtureState }).navFixture.playCalls++;
      return play();
    };
    document.querySelector('#vjs_container')!.prepend(video);
    // The local route serves a real media file. Only native browser load events
    // may establish a new target generation, never fixture-dispatched events.
    video.src = '/candidate-media.webm';
    video.load();
  });
}

describe.runIf(process.platform === 'win32')(
  '普通浏览器切章候选：独立离线集成，非真实平台验收',
  () => {
    beforeAll(async () => {
      const edge = await findEdge();
      if (!edge) throw new Error('离线普通导航候选测试需要本机 Edge');
      media = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
      browser = await chromium.launch({ executablePath: edge, headless: true });
    });
    beforeEach(async () => {
      context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (request) =>
        request.fulfill(
          request.request().url() === mediaAddress
            ? { status: 200, contentType: 'video/webm', body: media }
            : request.request().isNavigationRequest()
              ? { status: 200, contentType: 'text/html; charset=utf-8', body: html }
              : { status: 404, body: '' },
        ),
      );
      page = await context.newPage();
      await page.goto(address);
      await expect
        .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).readyState))
        .toBeGreaterThanOrEqual(2);
      // Deliberate local fault injection simulates an ended source. No learning progress is fabricated on a real site.
      await page.locator('video').evaluate((node) => {
        const video = node as HTMLVideoElement;
        video.currentTime = video.duration;
        video.playbackRate = 1.25;
        Object.defineProperty(video, 'ended', { configurable: true, value: true });
      });
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      for (const instance of candidates.splice(0)) await instance.dispose();
      await context?.close();
      for (const path of temporaryDirectories.splice(0)) {
        const absolute = resolve(path);
        if (
          dirname(absolute) !== resolve(tmpdir()) ||
          !basename(absolute).startsWith('browser-navigation-candidate-')
        )
          throw new Error('拒绝清理候选测试临时目录以外的路径');
        await rm(absolute, { recursive: true, force: true });
      }
    });
    afterAll(async () => {
      await browser?.close();
    });

    it.each([undefined, false, 'true', 1])(
      'navigation=%s 不授予普通点击，准备和导航均零副作用',
      async (navigation) => {
        const instance = candidate({ navigation: navigation as boolean | undefined });
        const { action, courseId } = await actionFor(instance);
        await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
        expect(instance.view().dispatchCalls).toBe(0);
      },
    );

    it('准备仅检查/滚动；普通可信输入不自取消，等待真实目标反馈后才确认且不播放', async () => {
      const instance = candidate();
      const events: SiteSignal[] = [];
      await instance.subscribe((event) => events.push(event));
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      expect(instance.view().phase).toBe('prepared');
      const started = Date.now();
      const result = await instance.navigateOnce(action, courseId, signal());
      expect(result).toMatchObject({
        commitModel: 'browser-input-candidate',
        phase: 'confirmed',
        dispatchCalls: 1,
        targetChapterId: action.chapterId,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      expect((await instance.observe()).currentChapterId).toBe(action.chapterId);
      expect((await instance.observe()).capabilities?.navigation).toBe(false);
      expect(await snapshot()).toMatchObject({
        clicks: 1,
        domClicks: 0,
        trusted: [true],
        playCalls: 0,
      });
      expect(events.filter((event) => event.type === 'manual')).toEqual([]);
      expect(
        await page.locator('video').evaluate((node) => ({
          paused: (node as HTMLVideoElement).paused,
          rate: (node as HTMLVideoElement).playbackRate,
        })),
      ).toEqual({ paused: true, rate: 1.25 });
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect((await snapshot()).clicks).toBe(1);
    });

    it.each(['not-ended', 'source-incomplete', 'wrong-target'] as const)(
      '%s 不满足自然结束、平台完成或首未完成门槛',
      async (mode) => {
        const instance = candidate();
        const { action, courseId } = await actionFor(instance, mode === 'wrong-target' ? 2 : 1);
        await page.evaluate((kind) => {
          if (kind === 'not-ended')
            Object.defineProperty(document.querySelector('video')!, 'ended', {
              configurable: true,
              value: false,
            });
          if (kind === 'source-incomplete')
            document.querySelector('li.video .time_icofinish')!.remove();
        }, mode);
        await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
        expect((await snapshot()).clicks).toBe(0);
      },
    );

    it('显式已完成重播验收模式允许暂停且未播完的已记完成源章，仍只发一次普通点击', async () => {
      await alreadyCompletedBeforeEnd();
      const instance = candidate({ navigation: true, allowCompletedSourceBeforeEnd: true });
      const { action, courseId, observed } = await actionFor(instance);
      expect(observed.chapters[0].platformCompleted).toBe(true);
      expect(observed.player).toMatchObject({ paused: true, ended: false, playbackRate: 1.25 });
      await instance.prepareNavigation(action, courseId, signal());
      expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      await expect(instance.navigateOnce(action, courseId, signal())).resolves.toMatchObject({
        phase: 'confirmed',
        dispatchCalls: 1,
        targetChapterId: action.chapterId,
      });
      expect(await snapshot()).toMatchObject({
        clicks: 1,
        domClicks: 0,
        trusted: [true],
        playCalls: 0,
      });
      expect(
        await page.locator('video').evaluate((node) => ({
          paused: (node as HTMLVideoElement).paused,
          rate: (node as HTMLVideoElement).playbackRate,
        })),
      ).toEqual({ paused: true, rate: 1.25 });
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect((await snapshot()).clicks).toBe(1);
    });

    it.each([undefined, false, 'true', 1])(
      'allowCompletedSourceBeforeEnd=%s 不授权提前离开已完成重播源章',
      async (allowCompletedSourceBeforeEnd) => {
        await alreadyCompletedBeforeEnd();
        const instance = candidate({
          navigation: true,
          allowCompletedSourceBeforeEnd: allowCompletedSourceBeforeEnd as boolean | undefined,
        });
        const { action, courseId } = await actionFor(instance);
        await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
        expect(instance.view().dispatchCalls).toBe(0);
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it('已完成重播验收权限在构造时取值，之后改传入对象不能开启权限', async () => {
      await alreadyCompletedBeforeEnd();
      const permissions = { navigation: true, allowCompletedSourceBeforeEnd: false };
      const instance = candidate(permissions);
      permissions.allowCompletedSourceBeforeEnd = true;
      const { action, courseId } = await actionFor(instance);
      await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
      expect(instance.view().dispatchCalls).toBe(0);
      expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
    });

    it.each([
      'source-incomplete-at-99-percent',
      'playing',
      'already-ended',
      'wrong-target',
    ] as const)('已完成重播验收模式下%s仍禁止提交，不从播放比例推断完成', async (mode) => {
      await alreadyCompletedBeforeEnd();
      await page.evaluate((kind) => {
        const video = document.querySelector('video')!;
        if (kind === 'source-incomplete-at-99-percent') {
          document.querySelector('li.video .time_icofinish')!.remove();
          video.currentTime = video.duration * 0.99;
        }
        if (kind === 'playing')
          Object.defineProperty(video, 'paused', { configurable: true, value: false });
        if (kind === 'already-ended')
          Object.defineProperty(video, 'ended', { configurable: true, value: true });
      }, mode);
      const instance = candidate({ navigation: true, allowCompletedSourceBeforeEnd: true });
      const { action, courseId } = await actionFor(instance, mode === 'wrong-target' ? 2 : 1);
      await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
      expect(instance.view().dispatchCalls).toBe(0);
      expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
    });

    it.each(['source-marker', 'playing', 'ended', 'cancelled'] as const)(
      '已完成重播验收准备后%s变化使候选失效，保持零输入',
      async (mode) => {
        await alreadyCompletedBeforeEnd();
        const instance = candidate({ navigation: true, allowCompletedSourceBeforeEnd: true });
        const controller = new AbortController();
        const { action, courseId } = await actionFor(instance);
        await instance.prepareNavigation(action, courseId, controller.signal);
        if (mode === 'cancelled') controller.abort(new Error('cancel prepared replay acceptance'));
        else
          await page.evaluate((kind) => {
            if (kind === 'source-marker')
              document.querySelector('li.video .time_icofinish')!.remove();
            if (kind === 'playing')
              Object.defineProperty(document.querySelector('video')!, 'paused', {
                configurable: true,
                value: false,
              });
            if (kind === 'ended')
              Object.defineProperty(document.querySelector('video')!, 'ended', {
                configurable: true,
                value: true,
              });
          }, mode);
        await expect(instance.navigateOnce(action, courseId, controller.signal)).rejects.toThrow();
        expect(instance.view().dispatchCalls).toBe(0);
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it.each(['source-marker', 'playing', 'ended', 'at-duration'] as const)(
      '已完成重播验收最终读取后%s变化仍被最后DOM核验拒绝',
      async (mode) => {
        await alreadyCompletedBeforeEnd();
        const instance = candidate({ navigation: true, allowCompletedSourceBeforeEnd: true });
        const { action, courseId } = await actionFor(instance);
        await instance.prepareNavigation(action, courseId, signal());
        const observe = instance.observe.bind(instance);
        let reads = 0;
        vi.spyOn(instance, 'observe').mockImplementation(async (active) => {
          const sample = await observe(active);
          if (++reads === 2)
            await page.evaluate((kind) => {
              const video = document.querySelector('video')!;
              if (kind === 'source-marker')
                document.querySelector('li.video .time_icofinish')!.remove();
              if (kind === 'playing')
                Object.defineProperty(video, 'paused', { configurable: true, value: false });
              if (kind === 'ended')
                Object.defineProperty(video, 'ended', { configurable: true, value: true });
              // A native seek can clamp below duration at the last decodable frame;
              // inject the exact boundary this final guard must reject deterministically.
              if (kind === 'at-duration')
                Object.defineProperty(video, 'currentTime', {
                  configurable: true,
                  value: video.duration,
                });
            }, mode);
          return sample;
        });
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
        expect(instance.view()).toMatchObject({ phase: 'cancelled', dispatchCalls: 0 });
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it.each([0.81, 0.95])(
      '顺序81％候选在进度%s允许下一相邻视频，即使该视频已有平台完成标记，也不跳到后续未完成项',
      async (progress) => {
        await sequentialSourceAt(progress);
        await page
          .locator('li.video')
          .nth(1)
          .evaluate((row) => {
            const marker = document.createElement('b');
            marker.className = 'time_icofinish';
            row.append(marker);
          });
        const instance = candidate({ navigation: true, nextVideoAt81Percent: true });
        const { action, courseId, observed } = await actionFor(instance, 1);
        expect(observed.chapters[1].platformCompleted).toBe(true);
        expect(observed.chapters[2].platformCompleted).toBe(false);
        expect(observed.player).toMatchObject({ paused: false, ended: false, playbackRate: 1.25 });
        await instance.prepareNavigation(action, courseId, signal());
        await expect(instance.navigateOnce(action, courseId, signal())).resolves.toMatchObject({
          phase: 'confirmed',
          dispatchCalls: 1,
          targetChapterId: action.chapterId,
        });
        expect((await instance.observe()).currentChapterId).toBe(observed.chapters[1].chapterId);
        expect(await snapshot()).toMatchObject({
          clicks: 1,
          domClicks: 0,
          trusted: [true],
          playCalls: 0,
        });
        expect(
          await page.locator('video').evaluate((node) => (node as HTMLVideoElement).playbackRate),
        ).toBe(1.25);
      },
    );

    it.each([undefined, false, 'true', 1])(
      'nextVideoAt81Percent=%s不授予81％提前切章权限',
      async (nextVideoAt81Percent) => {
        await sequentialSourceAt(0.85);
        const instance = candidate({
          navigation: true,
          nextVideoAt81Percent: nextVideoAt81Percent as boolean | undefined,
        });
        const { action, courseId } = await actionFor(instance);
        await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
        expect(instance.view().dispatchCalls).toBe(0);
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it('顺序81%验收权限在构造时取值，后改传入对象不能开启', async () => {
      await sequentialSourceAt(0.85);
      const permissions = { navigation: true, nextVideoAt81Percent: false };
      const instance = candidate(permissions);
      permissions.nextVideoAt81Percent = true;
      const { action, courseId } = await actionFor(instance);
      await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
      expect(instance.view().dispatchCalls).toBe(0);
      expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
    });

    it.each([0, 0.809, 1])(
      '顺序81％候选拒绝进度%s，不把阈值以下或已到结尾算作可切章',
      async (progress) => {
        await sequentialSourceAt(progress);
        const instance = candidate({ navigation: true, nextVideoAt81Percent: true });
        const { action, courseId } = await actionFor(instance);
        await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
        expect(instance.view().dispatchCalls).toBe(0);
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it.each([0.81, 0.99])(
      '顺序81％候选在进度%s也要求源章平台明确完成，不能仅凭视频比例离开未完成章',
      async (progress) => {
        await sequentialSourceAt(progress);
        await page
          .locator('li.video .time_icofinish')
          .first()
          .evaluate((node) => node.remove());
        const instance = candidate({ navigation: true, nextVideoAt81Percent: true });
        const { action, courseId } = await actionFor(instance);
        await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
        expect(instance.view().dispatchCalls).toBe(0);
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it.each(['paused', 'ended', 'non-adjacent'] as const)(
      '顺序81％候选拒绝%s，不回退成暂停重播或跨项导航',
      async (mode) => {
        await sequentialSourceAt(0.85);
        await page.locator('video').evaluate((node, kind) => {
          if (kind === 'paused')
            Object.defineProperty(node, 'paused', { configurable: true, value: true });
          if (kind === 'ended')
            Object.defineProperty(node, 'ended', { configurable: true, value: true });
        }, mode);
        const instance = candidate({
          navigation: true,
          nextVideoAt81Percent: true,
        });
        const { action, courseId } = await actionFor(instance, mode === 'non-adjacent' ? 2 : 1);
        await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
        expect(instance.view().dispatchCalls).toBe(0);
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it.each(['below-threshold', 'paused', 'source-incomplete'] as const)(
      '顺序81％准备后%s变化在提交前拒绝，零输入',
      async (mode) => {
        await sequentialSourceAt(0.85);
        const instance = candidate({ navigation: true, nextVideoAt81Percent: true });
        const { action, courseId } = await actionFor(instance);
        await instance.prepareNavigation(action, courseId, signal());
        await page.evaluate((kind) => {
          const video = document.querySelector('video')!;
          if (kind === 'below-threshold') video.currentTime = video.duration * 0.809;
          if (kind === 'paused')
            Object.defineProperty(video, 'paused', { configurable: true, value: true });
          if (kind === 'source-incomplete')
            document.querySelector('li.video .time_icofinish')!.remove();
        }, mode);
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
        expect(instance.view().dispatchCalls).toBe(0);
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it.each(['below-threshold', 'paused', 'source-incomplete'] as const)(
      '顺序81％最终读取后%s变化仍由最后DOM核验拒绝',
      async (mode) => {
        await sequentialSourceAt(0.85);
        const instance = candidate({ navigation: true, nextVideoAt81Percent: true });
        const { action, courseId } = await actionFor(instance);
        await instance.prepareNavigation(action, courseId, signal());
        const observe = instance.observe.bind(instance);
        let reads = 0;
        vi.spyOn(instance, 'observe').mockImplementation(async (active) => {
          const sample = await observe(active);
          if (++reads === 2)
            await page.evaluate((kind) => {
              const video = document.querySelector('video')!;
              if (kind === 'below-threshold') video.currentTime = video.duration * 0.809;
              if (kind === 'paused')
                Object.defineProperty(video, 'paused', { configurable: true, value: true });
              if (kind === 'source-incomplete')
                document.querySelector('li.video .time_icofinish')!.remove();
            }, mode);
          return sample;
        });
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
        expect(instance.view()).toMatchObject({ phase: 'cancelled', dispatchCalls: 0 });
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it.each([
      'hidden',
      'occluded',
      'ancestor-disabled',
      'ancestor-aria-disabled',
      'ambiguous-control',
    ] as const)('%s 目标不允许发出浏览器点击', async (mode) => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.evaluate((kind) => {
        const row = document.querySelectorAll('li.video')[1] as HTMLElement;
        const control = row.querySelector('.catalogue_title') as HTMLElement;
        if (kind === 'hidden') control.style.display = 'none';
        if (kind === 'ancestor-disabled') row.setAttribute('disabled', '');
        if (kind === 'ancestor-aria-disabled') row.setAttribute('aria-disabled', 'true');
        if (kind === 'ambiguous-control') row.append(control.cloneNode(true));
        if (kind === 'occluded') {
          const rect = control.getBoundingClientRect();
          const overlay = document.createElement('div');
          overlay.style.cssText = `position:fixed;z-index:100000;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:#ccc`;
          document.body.append(overlay);
        }
      }, mode);
      await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
      expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      expect(instance.view().dispatchCalls).toBe(0);
    });

    it.each(['course', 'catalogue', 'source-marker', 'media-replaced'] as const)(
      '准备后%s变化会在dispatch前拒绝，零点击',
      async (mode) => {
        const instance = candidate();
        const { action, courseId } = await actionFor(instance);
        await instance.prepareNavigation(action, courseId, signal());
        await page.evaluate((kind) => {
          if (kind === 'course')
            history.replaceState(
              null,
              '',
              '/stuStudy?recruitAndCourseId=changed-synthetic-course-001',
            );
          if (kind === 'catalogue')
            document.querySelectorAll('li.video .catalogue_title')[2].textContent = '变化后的目录';
          if (kind === 'source-marker')
            document.querySelector('li.video .time_icofinish')!.remove();
          if (kind === 'media-replaced') {
            const old = document.querySelector('video')!;
            old.replaceWith(old.cloneNode(true));
          }
        }, mode);
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
        expect(instance.view().dispatchCalls).toBe(0);
      },
    );

    it('准备后其他可信人工输入立即取消，不能作为候选输入放行', async () => {
      const instance = candidate();
      const events: SiteSignal[] = [];
      await instance.subscribe((event) => events.push(event));
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      await page.locator('#manual-control').click();
      await expect
        .poll(() => events.filter((event) => event.type === 'manual').length)
        .toBeGreaterThan(0);
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect(instance.view().dispatchCalls).toBe(0);
      expect((await snapshot()).clicks).toBe(0);
    });

    it('调用方未订阅也持续保护准备后的人工输入', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      await page.locator('#manual-control').click();
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect(instance.view().dispatchCalls).toBe(0);
      expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
    });

    it('焦点位于body时的全局播放快捷键同样撤销候选意图', async () => {
      const instance = candidate();
      const events: SiteSignal[] = [];
      await instance.subscribe((event) => events.push(event));
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Space');
      await expect.poll(() => events.some((event) => event.type === 'manual')).toBe(true);
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect(instance.view().dispatchCalls).toBe(0);
      expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
    });

    it('原生对话框使准备后的候选失效，不关闭或自动确认对话框', async () => {
      const instance = candidate();
      const events: SiteSignal[] = [];
      await instance.subscribe((event) => events.push(event));
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      let seen = false;
      page.on('dialog', () => {
        seen = true;
      });
      await page.evaluate(() => {
        setTimeout(() => alert('仅离线原生对话框哨兵'), 0);
      });
      await expect
        .poll(() => seen && events.some((event) => event.type === 'navigation'))
        .toBe(true);
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect(instance.view().dispatchCalls).toBe(0);
      // 不读取对话框内容，不accept/dismiss；afterEach只销毁本例临时上下文。
    });

    it('最终源章复查期间同目标人工点击不能提前消耗候选关联许可', async () => {
      const instance = candidate();
      const events: SiteSignal[] = [];
      await instance.subscribe((event) => events.push(event));
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      await page.evaluate(() => {
        (window as unknown as { navFixture: FixtureState }).navFixture.feedback = 'none';
      });
      const observe = instance.observe.bind(instance);
      let reads = 0;
      vi.spyOn(instance, 'observe').mockImplementation(async (active) => {
        const sample = await observe(active);
        if (++reads === 2) await page.locator('li.video .catalogue_title').nth(1).click();
        return sample;
      });
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect(instance.view()).toMatchObject({ phase: 'cancelled', dispatchCalls: 0 });
      expect(events.some((event) => event.type === 'manual')).toBe(true);
      // The sole click is the deliberate human-input simulation, never the candidate command.
      expect(await snapshot()).toMatchObject({
        clicks: 1,
        pointerdowns: 1,
        domClicks: 0,
        playCalls: 0,
      });
    });

    it('最终源章复查返回前取消不提交浏览器输入', async () => {
      const instance = candidate();
      const controller = new AbortController();
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, controller.signal);
      const observe = instance.observe.bind(instance);
      let reads = 0;
      vi.spyOn(instance, 'observe').mockImplementation(async (active) => {
        const sample = await observe(active);
        if (++reads === 2) controller.abort(new Error('cancel immediately before input arm'));
        return sample;
      });
      await expect(instance.navigateOnce(action, courseId, controller.signal)).rejects.toThrow();
      expect(instance.view()).toMatchObject({ phase: 'cancelled', dispatchCalls: 0 });
      expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
    });

    it.each(['source-marker', 'popup', 'ended', 'authenticated', 'caption', 'duration'] as const)(
      '最终读取后%s变化仍被提交前DOM核验拒绝',
      async (mode) => {
        const instance = candidate();
        const { action, courseId } = await actionFor(instance);
        await instance.prepareNavigation(action, courseId, signal());
        const observe = instance.observe.bind(instance);
        let reads = 0;
        vi.spyOn(instance, 'observe').mockImplementation(async (active) => {
          const sample = await observe(active);
          if (++reads === 2)
            await page.evaluate((kind) => {
              if (kind === 'source-marker')
                document.querySelector('li.video .time_icofinish')!.remove();
              if (kind === 'ended')
                Object.defineProperty(document.querySelector('video')!, 'ended', {
                  configurable: true,
                  value: false,
                });
              if (kind === 'authenticated') document.querySelector('.header_userInfo')!.remove();
              if (kind === 'caption')
                document.querySelector('#lessonOrder')!.textContent = '1.3、后续未完成章节';
              if (kind === 'duration')
                Object.defineProperty(document.querySelector('video')!, 'duration', {
                  configurable: true,
                  value: 200,
                });
              if (kind === 'popup') {
                const popup = document.createElement('section');
                popup.setAttribute('role', 'dialog');
                popup.textContent = '最终读取后的合成阻断弹窗';
                popup.style.cssText =
                  'position:fixed;left:10px;top:10px;width:300px;height:100px;background:white;z-index:1000';
                document.body.append(popup);
              }
            }, mode);
          return sample;
        });
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
        expect(instance.view()).toMatchObject({ phase: 'cancelled', dispatchCalls: 0 });
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it('准备进行中不能并行导航或再次准备，准备完成后才能提交一次', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      const observe = instance.observe.bind(instance);
      let release!: () => void;
      let notify!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        notify = resolve;
      });
      vi.spyOn(instance, 'observe').mockImplementationOnce(async (active) => {
        notify();
        await paused;
        return observe(active);
      });
      const preparing = instance.prepareNavigation(action, courseId, signal());
      await entered;
      try {
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow(
          'CANDIDATE_OPERATION_BUSY',
        );
        await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow(
          'CANDIDATE_OPERATION_BUSY',
        );
        expect(instance.view().dispatchCalls).toBe(0);
      } finally {
        release();
      }
      await preparing;
      await expect(instance.navigateOnce(action, courseId, signal())).resolves.toMatchObject({
        phase: 'confirmed',
        dispatchCalls: 1,
      });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it.each(['before-prepare', 'after-prepare'] as const)(
      '%s 出现可见练习弹窗时零输入且保留弹窗',
      async (when) => {
        const instance = candidate();
        const { action, courseId } = await actionFor(instance);
        if (when === 'after-prepare') await instance.prepareNavigation(action, courseId, signal());
        await page.evaluate(() => {
          const popup = document.createElement('section');
          popup.setAttribute('role', 'dialog');
          popup.textContent = '合成练习，需要人工处理';
          popup.style.cssText =
            'position:fixed;left:10px;top:10px;width:300px;height:100px;background:white;z-index:1000';
          document.body.append(popup);
        });
        if (when === 'before-prepare')
          await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
        else await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
        expect(instance.view().dispatchCalls).toBe(0);
        expect(await page.locator('[role="dialog"]').isVisible()).toBe(true);
        expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
      },
    );

    it('普通输入发出期间的其他可信人工输入保留未知且不发第二次命令', async () => {
      const instance = candidate();
      const events: SiteSignal[] = [];
      await instance.subscribe((event) => events.push(event));
      const { action, courseId } = await actionFor(instance);
      await page.exposeBinding('onCandidatePointer', async () => {
        await page.locator('#manual-control').click();
      });
      await instance.prepareNavigation(action, courseId, signal());
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(events.some((event) => event.type === 'manual')).toBe(true);
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      const state = await snapshot();
      expect(state.clicks).toBeLessThanOrEqual(1);
      expect(state.domClicks).toBe(0);
      expect(state.playCalls).toBe(0);
    });

    it('单次输入后弹窗阻断反馈仍保留未知，不处理弹窗或自动播放', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.exposeBinding('onCandidatePointer', () =>
        page.evaluate(() => {
          const popup = document.createElement('section');
          popup.setAttribute('role', 'dialog');
          popup.textContent = '合成平台提示';
          popup.style.cssText =
            'position:fixed;left:10px;top:10px;width:300px;height:100px;background:white;z-index:1000';
          document.body.append(popup);
        }),
      );
      await instance.prepareNavigation(action, courseId, signal());
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(await page.locator('[role="dialog"]').isVisible()).toBe(true);
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      const state = await snapshot();
      expect(state.clicks).toBeLessThanOrEqual(1);
      expect(state.domClicks).toBe(0);
      expect(state.playCalls).toBe(0);
    });

    it('普通输入发出后释放候选仍等待已提交输入收尾，不重发并清理页面监听域', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      let disposing: Promise<void> | undefined;
      await page.exposeBinding('onCandidatePointer', () => {
        disposing = instance.dispose();
      });
      await instance.prepareNavigation(action, courseId, signal());
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect(disposing).toBeDefined();
      await disposing;
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      const state = await snapshot();
      expect(state.clicks).toBeLessThanOrEqual(1);
      expect(state.domClicks).toBe(0);
      expect(state.playCalls).toBe(0);
      expect(
        await page.evaluate(() =>
          Object.keys(window).filter((name) => name.startsWith('zhsCandidateScope_')),
        ),
      ).toEqual([]);
    });

    it('并行调用导航只允许一个提交，确认后删除候选页面关联域', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      const first = instance.navigateOnce(action, courseId, signal());
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      await expect(first).resolves.toMatchObject({ phase: 'confirmed', dispatchCalls: 1 });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
      expect(
        await page.evaluate(() =>
          Object.keys(window).filter((name) => name.startsWith('zhsCandidateScope_')),
        ),
      ).toEqual([]);
    });

    it('已发输入期间取消保留未知，不发DOM回退或第二次浏览器点击', async () => {
      const instance = candidate();
      const controller = new AbortController();
      const { action, courseId } = await actionFor(instance);
      await page.exposeBinding('onCandidatePointer', () =>
        controller.abort(new Error('cancel during input')),
      );
      await instance.prepareNavigation(action, courseId, controller.signal);
      await expect(instance.navigateOnce(action, courseId, controller.signal)).rejects.toThrow();
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      const state = await snapshot();
      expect(state.clicks).toBeLessThanOrEqual(1);
      expect(state.domClicks).toBe(0);
      expect(state.playCalls).toBe(0);
    });

    it('普通点击已发但源章平台标记回退时不能确认目标', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.evaluate(() => {
        (window as unknown as { navFixture: FixtureState }).navFixture.feedback =
          'source-incomplete';
      });
      await instance.prepareNavigation(action, courseId, signal());
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it('真实StateStore落盘已发未知导航，重建后继续拒绝且不重发', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'browser-navigation-candidate-'));
      temporaryDirectories.push(directory);
      const store = new StateStore(directory);
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      const capabilities = {
        enabled: true as const,
        inspect: async () => (await instance.observe()).course,
        backup: async () => true,
      };
      const engine = new TaskEngine({ store, stage2Capabilities: capabilities });
      await engine.browserConnected();
      await engine.confirmCourse((await instance.observe()).course, courseId);
      expect((await engine.start()).ok).toBe(true);
      await page.evaluate(() => {
        (window as unknown as { navFixture: FixtureState }).navFixture.feedback = 'none';
      });
      const operation = {
        operationId: 'browser-navigation-unknown-1',
        kind: 'chapter-navigation' as const,
        prepare: (active: AbortSignal) => instance.prepareNavigation(action, courseId, active),
        issue: async (active: AbortSignal) => {
          await instance.navigateOnce(action, courseId, active);
        },
        verify: async () => 'confirmed' as const,
      };
      expect((await engine.execute(operation)).ok).toBe(false);
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect((await store.load())?.pendingOperations).toMatchObject([
        {
          operationId: operation.operationId,
          status: 'awaiting-confirmation',
          kind: 'chapter-navigation',
        },
      ]);
      expect((await engine.execute(operation)).ok).toBe(false);
      const restored = new TaskEngine({
        store: new StateStore(directory),
        stage2Capabilities: capabilities,
      });
      await restored.init();
      await restored.browserConnected();
      expect((await restored.confirmCourse((await instance.observe()).course, courseId)).ok).toBe(
        true,
      );
      expect((await restored.resume()).code).toBe('UNCONFIRMED_OPERATION');
      expect((await snapshot()).clicks).toBe(1);
      expect((await snapshot()).domClicks).toBe(0);
      expect((await store.load())?.pendingOperations[0].status).toBe('awaiting-confirmation');
    });

    it('节点空窗仅在目标壳层可靠时等待，真实新video加载后确认且不调用播放', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await selectMediaNodeGap();
      await instance.prepareNavigation(action, courseId, signal());
      const navigating = instance.navigateOnce(action, courseId, signal());
      void navigating.catch(() => undefined);
      await expect.poll(() => instance.diagnostics().feedback).toBe('media-node-pending');
      expect(instance.diagnostics().lastNodes).toEqual({
        documentVideoCount: 0,
        rootVideoCount: 0,
        expectedVideoCount: 0,
        expectedIdCount: 0,
        expectedIsVideo: false,
        trackedMediaError: false,
        trackedErrorCode: null,
      });
      expect(instance.view()).toMatchObject({ phase: 'awaiting-feedback', dispatchCalls: 1 });
      await insertFreshTargetVideo();
      await expect(navigating).resolves.toMatchObject({ phase: 'confirmed', dispatchCalls: 1 });
      expect(instance.diagnostics()).toMatchObject({
        failure: null,
        feedback: 'target-ready',
        lastNodes: {
          documentVideoCount: 1,
          rootVideoCount: 1,
          expectedVideoCount: 1,
          expectedIdCount: 1,
          expectedIsVideo: true,
          trackedMediaError: false,
          trackedErrorCode: null,
        },
      });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
      expect(
        await page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused),
      ).toBe(true);
      const diagnostics = instance.diagnostics();
      diagnostics.lastNodes!.documentVideoCount = 99;
      const withNodes = diagnostics.feedbackTrail.find((entry) => entry.nodes);
      expect(withNodes).toBeDefined();
      withNodes!.nodes!.documentVideoCount = 99;
      diagnostics.feedbackTrail.length = 0;
      expect(instance.diagnostics().lastNodes!.documentVideoCount).toBe(1);
      expect(instance.diagnostics().feedbackTrail.length).toBeGreaterThan(0);
      expect(
        instance
          .diagnostics()
          .feedbackTrail.some((entry) => entry.nodes?.documentVideoCount === 99),
      ).toBe(false);
    });

    it('节点空窗持续缺失仍按8秒总期限停止，16项诊断有界且StateStore保留未知禁止重发', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'browser-navigation-candidate-'));
      temporaryDirectories.push(directory);
      const store = new StateStore(directory);
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      const capabilities = {
        enabled: true as const,
        inspect: async () => (await instance.observe()).course,
        backup: async () => true,
      };
      const engine = new TaskEngine({ store, stage2Capabilities: capabilities });
      await engine.browserConnected();
      await engine.confirmCourse((await instance.observe()).course, courseId);
      expect((await engine.start()).ok).toBe(true);
      await selectMediaNodeGap();
      const operation = {
        operationId: 'browser-navigation-node-gap-unknown',
        kind: 'chapter-navigation' as const,
        prepare: (active: AbortSignal) => instance.prepareNavigation(action, courseId, active),
        issue: async (active: AbortSignal) => {
          await instance.navigateOnce(action, courseId, active);
        },
        verify: async () => 'confirmed' as const,
      };
      const started = Date.now();
      expect((await engine.execute(operation)).ok).toBe(false);
      expect(Date.now() - started).toBeGreaterThanOrEqual(7500);
      expect(Date.now() - started).toBeLessThan(10500);
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(instance.diagnostics()).toMatchObject({
        failure: 'CANDIDATE_TARGET_FEEDBACK_TIMEOUT',
        feedback: 'media-node-pending',
        lastNodes: { documentVideoCount: 0, expectedIdCount: 0 },
      });
      expect(instance.diagnostics().loadingSamples).toBeGreaterThan(16);
      expect(instance.diagnostics().feedbackTrail).toHaveLength(16);
      expect((await store.load())?.pendingOperations).toMatchObject([
        {
          operationId: operation.operationId,
          kind: 'chapter-navigation',
          status: 'awaiting-confirmation',
        },
      ]);
      expect((await engine.execute(operation)).ok).toBe(false);
      await insertFreshTargetVideo();
      await expect
        .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).readyState))
        .toBeGreaterThanOrEqual(2);
      const restored = new TaskEngine({
        store: new StateStore(directory),
        stage2Capabilities: capabilities,
      });
      await restored.init();
      await restored.browserConnected();
      expect((await restored.confirmCourse((await instance.observe()).course, courseId)).ok).toBe(
        true,
      );
      expect((await restored.resume()).code).toBe('UNCONFIRMED_OPERATION');
      expect((await store.load())?.pendingOperations[0].status).toBe('awaiting-confirmation');
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it('节点空窗源章仍活动时立即阻断，不能进入目标加载等待', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await selectMediaNodeGap(true);
      await instance.prepareNavigation(action, courseId, signal());
      const started = Date.now();
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow(
        'CANDIDATE_TARGET_FEEDBACK_UNSAFE',
      );
      expect(Date.now() - started).toBeLessThan(4000);
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(instance.diagnostics().feedback).toBe('media-node-missing');
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it('节点空窗后原同节点无reload重插不构成新加载世代或目标确认', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await selectMediaNodeGap();
      await instance.prepareNavigation(action, courseId, signal());
      const controller = new AbortController();
      const navigating = instance.navigateOnce(action, courseId, controller.signal);
      void navigating.catch(() => undefined);
      await expect.poll(() => instance.diagnostics().feedback).toBe('media-node-pending');
      const gap = instance.diagnostics().feedbackTrail.at(-1)!;
      await page.evaluate(() => {
        const old = (window as unknown as { removedCandidateMedia: HTMLVideoElement })
          .removedCandidateMedia;
        document.querySelector('#vjs_container')!.prepend(old);
      });
      await expect.poll(() => instance.diagnostics().feedback).toBe('metadata-pending');
      expect(instance.diagnostics().feedbackTrail.at(-1)!.generation).toBe(gap.generation);
      expect(instance.view().phase).toBe('awaiting-feedback');
      controller.abort(new Error('offline no-fresh-generation stop'));
      await expect(navigating).rejects.toThrow('offline no-fresh-generation stop');
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it.each([
      ['hidden-extra-video', 'media-nodes-ambiguous'],
      ['duplicate-id', 'media-nodes-ambiguous'],
      ['id-is-not-video', 'media-node-type-invalid'],
      ['wrong-video-id', 'media-node-mismatch'],
      ['outside-root', 'media-node-mismatch'],
    ] as const)('节点空窗后%s立即阻断为%s，不用加载容忍掩盖节点歧义', async (mode, reason) => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await selectMediaNodeGap();
      await instance.prepareNavigation(action, courseId, signal());
      const navigating = instance.navigateOnce(action, courseId, signal());
      void navigating.catch(() => undefined);
      await expect.poll(() => instance.diagnostics().feedback).toBe('media-node-pending');
      await page.evaluate((kind) => {
        const root = document.querySelector('#vjs_container')!;
        const first = document.createElement(kind === 'id-is-not-video' ? 'div' : 'video');
        first.id = kind === 'wrong-video-id' ? 'wrong-local-video-id' : 'vjs_container_html5_api';
        (kind === 'outside-root' ? document.body : root).prepend(first);
        if (kind === 'hidden-extra-video' || kind === 'duplicate-id') {
          const extra = document.createElement(kind === 'duplicate-id' ? 'div' : 'video');
          if (kind === 'duplicate-id') extra.id = 'vjs_container_html5_api';
          extra.style.display = 'none';
          document.body.append(extra);
        }
      }, mode);
      await expect(navigating).rejects.toThrow('CANDIDATE_TARGET_FEEDBACK_UNSAFE');
      expect(instance.diagnostics().feedback).toBe(reason);
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      if (mode === 'hidden-extra-video')
        expect(instance.diagnostics().lastNodes).toMatchObject({
          documentVideoCount: 2,
          rootVideoCount: 1,
          expectedVideoCount: 1,
          expectedIdCount: 1,
        });
      if (mode === 'duplicate-id')
        expect(instance.diagnostics().lastNodes).toMatchObject({
          documentVideoCount: 1,
          expectedIdCount: 2,
        });
      if (mode === 'id-is-not-video')
        expect(instance.diagnostics().lastNodes).toMatchObject({
          documentVideoCount: 0,
          expectedVideoCount: 0,
          expectedIdCount: 1,
          expectedIsVideo: false,
        });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
    });

    it.each([
      ['popup', 'blocking-popup'],
      ['script-warning', 'blocking-popup'],
      ['authentication', 'authentication-unavailable'],
      ['catalogue', 'catalogue-changed'],
      ['completion', 'source-completion-regressed'],
      ['caption', 'caption-mismatch'],
      ['third-chapter', 'chapter-mismatch'],
      ['shell', 'shell-invalid'],
      ['url', 'url-changed'],
      ['scope', 'scope-invalid'],
    ] as const)('节点空窗期间%s仍先于媒体容忍阻断为%s', async (mode, reason) => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await selectMediaNodeGap();
      await instance.prepareNavigation(action, courseId, signal());
      const navigating = instance.navigateOnce(action, courseId, signal());
      void navigating.catch(() => undefined);
      await expect.poll(() => instance.diagnostics().feedback).toBe('media-node-pending');
      await page.evaluate((fault) => {
        if (fault === 'popup' || fault === 'script-warning') {
          const popup = document.createElement('section');
          popup.setAttribute('role', fault === 'popup' ? 'dialog' : 'alert');
          popup.textContent = fault === 'popup' ? '仅离线练习弹窗' : '检测到异常脚本';
          popup.style.cssText =
            'position:fixed;left:0;top:0;width:250px;height:80px;background:white';
          document.body.append(popup);
        }
        if (fault === 'authentication') document.querySelector('.header_userInfo')?.remove();
        if (fault === 'catalogue')
          document.querySelector('li.video .time')!.textContent = '00:00:09';
        if (fault === 'completion') document.querySelector('li.video .time_icofinish')?.remove();
        if (fault === 'caption')
          document.querySelector('#lessonOrder')!.textContent = '1.1、已结束源章节';
        if (fault === 'third-chapter') {
          document.querySelector('.current_play')?.classList.remove('current_play');
          document.querySelectorAll('li.video')[2].classList.add('current_play');
          document.querySelector('#lessonOrder')!.textContent = '1.3、后续未完成章节';
        }
        if (fault === 'shell') document.querySelector('.source-name')!.textContent = '未知课程';
        if (fault === 'url') history.replaceState({}, '', '/stuStudy?recruitAndCourseId=other');
        if (fault === 'scope') {
          const candidateWindow = window as unknown as Record<string, unknown>;
          for (const key of Object.keys(candidateWindow))
            if (key.startsWith('zhsCandidateScope_')) delete candidateWindow[key];
        }
      }, mode);
      // URL changes can be cancelled by the browser navigation listener before the
      // next page-task classification. Both paths must stop without a second input.
      if (mode === 'url') {
        await expect(navigating).rejects.toThrow(
          /CANDIDATE_(TARGET_FEEDBACK_UNSAFE|CRITICAL_INPUT_OR_PAGE_CHANGE)/,
        );
        expect(['url-changed', 'media-node-pending']).toContain(instance.diagnostics().feedback);
      } else {
        await expect(navigating).rejects.toThrow('CANDIDATE_TARGET_FEEDBACK_UNSAFE');
        expect(instance.diagnostics().feedback).toBe(reason);
      }
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it('节点空窗期间人工关键输入立即取消并清理作用域，不重发或播放', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await selectMediaNodeGap();
      await instance.prepareNavigation(action, courseId, signal());
      const navigating = instance.navigateOnce(action, courseId, signal());
      void navigating.catch(() => undefined);
      await expect.poll(() => instance.diagnostics().feedback).toBe('media-node-pending');
      await page.locator('#manual-control').click();
      await expect(navigating).rejects.toThrow('CANDIDATE_CRITICAL_INPUT_OR_PAGE_CHANGE');
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(
        await page.evaluate(() =>
          Object.keys(window).filter((name) => name.startsWith('zhsCandidateScope_')),
        ),
      ).toEqual([]);
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it('节点空窗时已detach的原媒体真实error保持sticky，新video恢复不能掩盖错误', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await selectMediaNodeGap();
      await instance.prepareNavigation(action, courseId, signal());
      const navigating = instance.navigateOnce(action, courseId, signal());
      void navigating.catch(() => undefined);
      await expect.poll(() => instance.diagnostics().feedback).toBe('media-node-pending');
      const trustedError = await page.evaluate(async () => {
        const old = (window as unknown as { removedCandidateMedia: HTMLVideoElement })
          .removedCandidateMedia;
        return new Promise<boolean>((resolve) => {
          old.addEventListener(
            'error',
            (event) => {
              const fresh = document.createElement('video');
              fresh.id = 'vjs_container_html5_api';
              fresh.muted = true;
              fresh.preload = 'auto';
              document.querySelector('#vjs_container')!.prepend(fresh);
              fresh.src = '/candidate-media.webm';
              fresh.load();
              resolve(event.isTrusted);
            },
            { once: true },
          );
          old.src = '/missing-local-candidate-media.webm';
          old.load();
        });
      });
      expect(trustedError).toBe(true);
      await expect(navigating).rejects.toThrow('CANDIDATE_TARGET_FEEDBACK_UNSAFE');
      expect(instance.diagnostics()).toMatchObject({
        feedback: 'media-error',
        lastNodes: { trackedMediaError: true, trackedErrorCode: 4 },
      });
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(await page.locator('video').count()).toBe(1);
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
    });

    it('媒体metadata过渡在可靠壳层内等待真实load世代，连续目标反馈后确认且不播放', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.evaluate(() => {
        (window as unknown as { navFixture: FixtureState }).navFixture.feedback = 'metadata-staged';
      });
      await instance.prepareNavigation(action, courseId, signal());
      await expect(instance.navigateOnce(action, courseId, signal())).resolves.toMatchObject({
        phase: 'confirmed',
      });
      expect(instance.diagnostics()).toMatchObject({
        stage: 'confirmed',
        failure: null,
        feedback: 'target-ready',
      });
      expect(instance.diagnostics().loadingSamples).toBeGreaterThan(0);
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it.each([
      ['metadata-old-time', 'media-not-ready'],
      ['seeking-old-time', 'media-seeking'],
    ] as const)(
      'fresh metadata后%s仅等待，旧time超过新duration不提前确认，恢复后才确认',
      async (mode, reason) => {
        const instance = candidate();
        const { action, courseId } = await actionFor(instance);
        await holdFreshMetadataTransition(mode);
        await instance.prepareNavigation(action, courseId, signal());
        const navigating = instance.navigateOnce(action, courseId, signal());
        void navigating.catch(() => undefined);
        await expect.poll(() => instance.diagnostics().feedback).toBe(reason);
        await expect.poll(() => instance.diagnostics().loadingSamples).toBeGreaterThan(1);
        expect(instance.view()).toMatchObject({ phase: 'awaiting-feedback', dispatchCalls: 1 });
        const transition = instance.diagnostics().lastMedia;
        expect(transition).toMatchObject({
          readyState: mode === 'metadata-old-time' ? 1 : 2,
          seeking: mode === 'seeking-old-time',
        });
        expect(transition!.currentTime!).toBeGreaterThan(transition!.duration!);
        expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
        await page.locator('video').evaluate((node) => {
          const overrides = node as unknown as {
            readyState?: number;
            currentTime?: number;
            seeking?: boolean;
          };
          delete overrides.readyState;
          delete overrides.currentTime;
          delete overrides.seeking;
        });
        await expect(navigating).resolves.toMatchObject({ phase: 'confirmed' });
        expect(instance.diagnostics()).toMatchObject({ failure: null, feedback: 'target-ready' });
        expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
      },
    );

    it('fresh metadata已ready2且非seeking时，稳定越界time立即阻断而不等待或重发', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.locator('video').evaluate((node) => {
        const video = node as HTMLVideoElement;
        video.addEventListener(
          'loadedmetadata',
          () => {
            Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
            Object.defineProperty(video, 'seeking', { configurable: true, value: false });
            Object.defineProperty(video, 'currentTime', {
              configurable: true,
              value: video.duration + 60,
            });
          },
          { once: true },
        );
      });
      await instance.prepareNavigation(action, courseId, signal());
      const started = Date.now();
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow(
        'CANDIDATE_TARGET_FEEDBACK_UNSAFE',
      );
      expect(Date.now() - started).toBeLessThan(4000);
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(instance.diagnostics()).toMatchObject({
        failure: 'CANDIDATE_TARGET_FEEDBACK_UNSAFE',
        feedback: 'media-time-invalid',
      });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
    });

    it.each([
      ['metadata-old-time', 'media-not-ready'],
      ['seeking-old-time', 'media-seeking'],
    ] as const)(
      'fresh metadata后持续%s仍服从原总期限，超时只保留未知结果',
      async (mode, reason) => {
        const instance = candidate();
        const { action, courseId } = await actionFor(instance);
        await holdFreshMetadataTransition(mode);
        await instance.prepareNavigation(action, courseId, signal());
        const started = Date.now();
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow(
          'CANDIDATE_TARGET_FEEDBACK_TIMEOUT',
        );
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(7500);
        expect(elapsed).toBeLessThan(10500);
        expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
        expect(instance.diagnostics()).toMatchObject({
          failure: 'CANDIDATE_TARGET_FEEDBACK_TIMEOUT',
          feedback: reason,
        });
        expect(instance.diagnostics().loadingSamples).toBeGreaterThan(16);
        expect(instance.diagnostics().feedbackTrail.length).toBeLessThanOrEqual(16);
        expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
        await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      },
    );

    it('fresh metadata的ready1过渡期间媒体error仍立即硬阻断', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await holdFreshMetadataTransition('metadata-old-time');
      await instance.prepareNavigation(action, courseId, signal());
      const navigating = instance.navigateOnce(action, courseId, signal());
      void navigating.catch(() => undefined);
      await expect.poll(() => instance.diagnostics().feedback).toBe('media-not-ready');
      const faultAt = Date.now();
      await page.locator('video').evaluate((node) => {
        Object.defineProperty(node, 'error', { configurable: true, value: { code: 3 } });
      });
      await expect(navigating).rejects.toThrow('CANDIDATE_TARGET_FEEDBACK_UNSAFE');
      expect(Date.now() - faultAt).toBeLessThan(3000);
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(instance.diagnostics()).toMatchObject({
        failure: 'CANDIDATE_TARGET_FEEDBACK_UNSAFE',
        feedback: 'media-error',
        lastMedia: { errorCode: 3 },
      });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it('相同时长旧媒体不能仅靠目标标题和活动目录确认，真实load后方可确认', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.evaluate(() => {
        (window as unknown as { navFixture: FixtureState }).navFixture.feedback = 'old-media';
      });
      await instance.prepareNavigation(action, courseId, signal());
      const navigating = instance.navigateOnce(action, courseId, signal());
      await expect.poll(() => instance.diagnostics().loadingSamples).toBeGreaterThan(1);
      expect(instance.view()).toMatchObject({ phase: 'awaiting-feedback', dispatchCalls: 1 });
      await page.locator('video').evaluate((node) => (node as HTMLVideoElement).load());
      await expect(navigating).resolves.toMatchObject({ phase: 'confirmed' });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it.each([
      'popup',
      'script-warning',
      'authentication',
      'catalogue',
      'completion',
      'third-chapter',
      'caption',
      'extra-media',
    ] as const)('metadata尚未就绪时%s仍立即阻断，保持一次命令和未知结果', async (mode) => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.evaluate(() => {
        (window as unknown as { navFixture: FixtureState }).navFixture.feedback = 'metadata-held';
      });
      await instance.prepareNavigation(action, courseId, signal());
      const navigating = instance.navigateOnce(action, courseId, signal());
      void navigating.catch(() => undefined);
      await expect.poll(() => instance.diagnostics().loadingSamples).toBeGreaterThan(0);
      await page.evaluate((fault) => {
        if (fault === 'popup' || fault === 'script-warning') {
          const element = document.createElement('section');
          element.setAttribute('role', fault === 'popup' ? 'dialog' : 'alert');
          element.textContent = fault === 'popup' ? '离线练习弹窗' : '检测到异常脚本';
          element.style.cssText =
            'position:fixed;left:0;top:0;width:250px;height:80px;background:white';
          document.body.append(element);
        }
        if (fault === 'authentication') document.querySelector('.header_userInfo')?.remove();
        if (fault === 'catalogue')
          document.querySelector('li.video .time')!.textContent = '00:00:09';
        if (fault === 'completion') document.querySelector('li.video .time_icofinish')?.remove();
        if (fault === 'caption')
          document.querySelector('#lessonOrder')!.textContent = '1.1、已结束源章节';
        if (fault === 'third-chapter') {
          document.querySelector('.current_play')?.classList.remove('current_play');
          document.querySelectorAll('li.video')[2].classList.add('current_play');
          document.querySelector('#lessonOrder')!.textContent = '1.3、后续未完成章节';
        }
        if (fault === 'extra-media') document.body.append(document.createElement('video'));
      }, mode);
      await expect(navigating).rejects.toThrow('CANDIDATE_TARGET_FEEDBACK_UNSAFE');
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(instance.diagnostics()).toMatchObject({
        stage: 'target-feedback',
        failure: 'CANDIDATE_TARGET_FEEDBACK_UNSAFE',
      });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
    });

    it('metadata等待期间人工关键输入立即取消，不重发且清理监听', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.evaluate(() => {
        (window as unknown as { navFixture: FixtureState }).navFixture.feedback = 'metadata-held';
      });
      await instance.prepareNavigation(action, courseId, signal());
      const navigating = instance.navigateOnce(action, courseId, signal());
      void navigating.catch(() => undefined);
      await expect.poll(() => instance.diagnostics().loadingSamples).toBeGreaterThan(0);
      await page.locator('#manual-control').click();
      await expect(navigating).rejects.toThrow('CANDIDATE_CRITICAL_INPUT_OR_PAGE_CHANGE');
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it('metadata等待总期限不因加载样本重置，超时只保留未知不重发', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.evaluate(() => {
        (window as unknown as { navFixture: FixtureState }).navFixture.feedback = 'metadata-held';
      });
      await instance.prepareNavigation(action, courseId, signal());
      const started = Date.now();
      await expect(instance.navigateOnce(action, courseId, signal())).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(10500);
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(instance.diagnostics().loadingSamples).toBeGreaterThan(2);
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it('候选pointer通知延迟到反馈阶段不会误判人工操作', async () => {
      const expose = page.exposeBinding.bind(page);
      vi.spyOn(page, 'exposeBinding').mockImplementation(async (name, callback) =>
        expose(name, async (source, ...args: unknown[]) => {
          const event = args[0] as { type?: string };
          if (event?.type === 'candidate-input')
            await new Promise((resolve) => setTimeout(resolve, 220));
          return callback(source, ...args);
        }),
      );
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.evaluate(() => {
        (window as unknown as { navFixture: FixtureState }).navFixture.delay = 500;
      });
      await instance.prepareNavigation(action, courseId, signal());
      await expect(instance.navigateOnce(action, courseId, signal())).resolves.toMatchObject({
        phase: 'confirmed',
      });
      expect(instance.diagnostics().failure).toBeNull();
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it('默认不保留成功后的守卫，明确许可后仍只能提供已确认作用域', async () => {
      const instance = candidate();
      expect(() => instance.retainedGuardScope()).toThrow('CANDIDATE_RETAINED_GUARD_UNAVAILABLE');
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      await instance.navigateOnce(action, courseId, signal());
      expect(() => instance.retainedGuardScope()).toThrow('CANDIDATE_RETAINED_GUARD_UNAVAILABLE');
    });

    it('明确保留成功守卫时arm已清空，人工输入使后续播放授权失效，dispose删除作用域', async () => {
      const instance = candidate({ navigation: true, retainGuardAfterConfirmation: true });
      expect(() => instance.retainedGuardScope()).toThrow('CANDIDATE_RETAINED_GUARD_UNAVAILABLE');
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      await instance.navigateOnce(action, courseId, signal());
      const name = instance.retainedGuardScope();
      await expect(instance.assertRetainedGuard(signal())).resolves.toBeUndefined();
      expect(
        await page.evaluate((scopeName) => {
          const scope = (window as unknown as Record<string, { arm: unknown; blocked: boolean }>)[
            scopeName
          ];
          return { arm: scope.arm, blocked: scope.blocked };
        }, name),
      ).toEqual({ arm: null, blocked: false });
      await page.locator('#manual-control').click();
      await expect(instance.assertRetainedGuard(signal())).rejects.toThrow();
      await instance.dispose();
      expect(await page.evaluate((scopeName) => scopeName in window, name)).toBe(false);
      expect(await snapshot()).toMatchObject({ clicks: 1, domClicks: 0, playCalls: 0 });
    });

    it('保留守卫也必须服从Node取消，页面作用域被删除时不授权后续动作', async () => {
      const instance = candidate({ navigation: true, retainGuardAfterConfirmation: true });
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      await instance.navigateOnce(action, courseId, signal());
      const controller = new AbortController();
      controller.abort(new Error('offline cancellation'));
      await expect(instance.assertRetainedGuard(controller.signal)).rejects.toThrow(
        'offline cancellation',
      );
      const name = instance.retainedGuardScope();
      await page.evaluate((scopeName) => {
        delete (window as unknown as Record<string, unknown>)[scopeName];
      }, name);
      await expect(instance.assertRetainedGuard(signal())).rejects.toThrow(
        'CANDIDATE_RETAINED_GUARD_UNAVAILABLE',
      );
    });

    it.each([true, false])('81%%时平台实际完成标记=%s，不能用百分比代替标记', async (completed) => {
      const instance = candidate({ navigation: true, nextVideoAt81Percent: true });
      await sequentialSourceAt(0.79);
      await page.locator('li.video .time_icofinish').evaluate((node) => node.remove());
      const { action, courseId, observed } = await actionFor(instance);
      expect(observed.chapters[0].platformCompleted).toBe(false);
      await sequentialSourceAt(0.81);
      if (completed)
        await page
          .locator('li.video')
          .first()
          .evaluate((row) => {
            const mark = document.createElement('b');
            mark.className = 'time_icofinish';
            row.append(mark);
          });
      if (completed) {
        await instance.prepareNavigation(action, courseId, signal());
        await expect(instance.navigateOnce(action, courseId, signal())).resolves.toMatchObject({
          phase: 'confirmed',
        });
        expect((await snapshot()).clicks).toBe(1);
      } else {
        await expect(instance.prepareNavigation(action, courseId, signal())).rejects.toThrow();
        expect((await snapshot()).clicks).toBe(0);
      }
    });

    it('普通命令已提交但实际pointerdown之前的metadata不算目标加载证据', async () => {
      const instance = candidate();
      const { action, courseId } = await actionFor(instance);
      await page.evaluate(() => {
        (window as unknown as { navFixture: FixtureState }).navFixture.feedback = 'old-media';
      });
      await instance.prepareNavigation(action, courseId, signal());
      const prototype = Object.getPrototypeOf(page.locator('body')) as {
        click(options?: { timeout?: number }): Promise<void>;
      };
      const click = prototype.click;
      let loaded = false;
      vi.spyOn(prototype, 'click').mockImplementation(async function (
        this: typeof prototype,
        options,
      ) {
        if (!loaded) {
          loaded = true;
          await page.locator('video').evaluate(async (node) => {
            const media = node as HTMLVideoElement;
            await new Promise<void>((resolve) => {
              media.addEventListener('loadedmetadata', () => resolve(), { once: true });
              media.load();
            });
          });
        }
        return click.call(this, options);
      });
      const controller = new AbortController();
      const navigating = instance.navigateOnce(action, courseId, controller.signal);
      void navigating.catch(() => undefined);
      await expect.poll(() => instance.diagnostics().loadingSamples).toBeGreaterThanOrEqual(2);
      expect(instance.view().phase).toBe('awaiting-feedback');
      controller.abort();
      await expect(navigating).rejects.toThrow();
      expect(instance.view()).toMatchObject({ phase: 'unknown', dispatchCalls: 1 });
      expect(await snapshot()).toMatchObject({ clicks: 1, playCalls: 0 });
    });

    it('关联通知迟到至confirmed且守卫继续保留时不自取消', async () => {
      const expose = page.exposeBinding.bind(page);
      let release: (() => void) | undefined;
      let delivered: (() => void) | undefined;
      const notified = new Promise<void>((resolve) => {
        delivered = resolve;
      });
      vi.spyOn(page, 'exposeBinding').mockImplementation(async (name, callback) =>
        expose(name, async (source, ...args: unknown[]) => {
          if ((args[0] as { type?: string })?.type === 'candidate-input') {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            const result = await callback(source, ...args);
            delivered?.();
            return result;
          }
          return callback(source, ...args);
        }),
      );
      const instance = candidate({ navigation: true, retainGuardAfterConfirmation: true });
      const { action, courseId } = await actionFor(instance);
      await instance.prepareNavigation(action, courseId, signal());
      await expect(instance.navigateOnce(action, courseId, signal())).resolves.toMatchObject({
        phase: 'confirmed',
      });
      expect(release).toBeTypeOf('function');
      release?.();
      await notified;
      await expect(instance.assertRetainedGuard(signal())).resolves.toBeUndefined();
      expect(await snapshot()).toMatchObject({ clicks: 1, playCalls: 0 });
    });

    it('两个提前切章验收模式不能同时授予', async () => {
      expect(() =>
        candidate({
          navigation: true,
          allowCompletedSourceBeforeEnd: true,
          nextVideoAt81Percent: true,
        }),
      ).toThrow('CANDIDATE_ACCEPTANCE_MODES_CONFLICT');
      expect(await snapshot()).toMatchObject({ clicks: 0, domClicks: 0, playCalls: 0 });
    });

    it('生产真实工厂仍为Restricted，候选不替换同任务动作契约或暴露通用perform', async () => {
      const production = monitorAdapterForPage(page);
      expect(production).toBeInstanceOf(RestrictedZhihuishuSiteAdapter);
      const instance = candidate();
      expect(instance.commitModel).toBe('browser-input-candidate');
      expect('perform' in instance).toBe(false);
      expect('prepare' in instance).toBe(false);
      expect((await production.observe()).course.confidence).toBe('uncertain');
      const { action, courseId } = await actionFor(instance);
      await expect(production.perform(action, courseId, signal())).rejects.toThrow(
        'SITE_AUTOMATION_RESTRICTED',
      );
      expect((await snapshot()).clicks).toBe(0);
    });
  },
);
