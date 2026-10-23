import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import type { SiteObservation } from '../../packages/contracts/src/monitor';
import { StateStore, type SnapshotInput } from '../../packages/persistence/src/index';
import { TaskEngine } from '../../packages/task-engine/src/index';
import { ContinuousNavigationCandidateSession } from '../../packages/site-adapter/src/browser-continuous-navigation';
import {
  ZhihuishuMonitorSiteAdapter,
  zhihuishuCatalogueKey,
  zhihuishuCourseId,
} from '../../packages/site-adapter/src/zhihuishu';
import { readZhihuishuDom } from '../../packages/site-adapter/src/zhihuishu-dom';

const address =
  'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-continuous-navigation-001';
const mediaAddress = new URL('/continuous-local.webm', address).href;
interface FixtureState {
  clicks: number;
  plays: number;
  domClicks: number;
  trusted: boolean[];
  blockNavigationOn: number;
  holdCompletion: boolean;
}
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:20px;min-height:1800px;font:16px sans-serif}.video-study{width:720px}
.header_userInfo{width:80px;height:24px}#vjs_container{width:320px;height:220px}
video{width:240px;height:140px}.chapterScrollbar{padding:0;list-style:none}
li.video{display:block;width:650px;height:44px;margin:5px 0}
.catalogue_title{display:inline-block;width:260px;height:34px;line-height:34px;cursor:pointer}
.time_icofinish,.time_ico_half{display:inline-block;width:12px;height:12px}
.hour,.time{display:inline-block;margin:0 12px}[role=dialog]{position:fixed;inset:20px;background:white}
</style></head><body><p>纯离线4章节原生媒体测试，非真实平台验收，不代表实际课程进度。</p>
<main class="video-study"><div class="header_userInfo">合成登录</div>
<div class="userLinks"><i class="iconheiyemoshi-anquantuichu"></i></div>
<h1 class="source-name">连续候选离线课程</h1><h2 id="lessonOrder">1.1、离线章节1</h2>
<div id="vjs_container"><video id="vjs_container_html5_api" src="/continuous-local.webm" muted preload="auto"></video>
<button id="manual-control" class="videoArea">人工播放器控件</button></div>
<ul class="chapterScrollbar">${[1, 2, 3, 4]
  .map(
    (index) =>
      `<li class="video${index === 1 ? ' current_play' : ''}"><b class="hour">1.${index}</b><span class="catalogue_title">离线章节${index}</span><i class="time_ico_half"></i><span class="time">00:00:05</span></li>`,
  )
  .join('')}</ul></main><script>
window.continuousFixture={clicks:0,plays:0,domClicks:0,trusted:[],blockNavigationOn:0,holdCompletion:false};
const state=window.continuousFixture;
const rows=[...document.querySelectorAll('li.video')];
const nativeClick=HTMLElement.prototype.click;
HTMLElement.prototype.click=function(){if(this.matches('.catalogue_title'))state.domClicks++;return nativeClick.call(this)};
function attachCompletion(video,row){
 const nativePlay=video.play.bind(video);
 video.play=()=>{state.plays++;return nativePlay()};
 video.addEventListener('timeupdate',()=>{
  if(!state.holdCompletion&&video.currentTime/video.duration>0.8&&!row.querySelector('.time_icofinish')){
   const marker=document.createElement('b');marker.className='time_icofinish';row.append(marker);
  }
 });
}
attachCompletion(document.querySelector('video'),rows[0]);
rows.forEach((row,index)=>row.querySelector('.catalogue_title').addEventListener('click',event=>{
 state.clicks++;state.trusted.push(event.isTrusted);
 if(state.blockNavigationOn===state.clicks){const popup=document.createElement('section');popup.setAttribute('role','dialog');popup.textContent='离线练习题；仅人工处理';document.body.append(popup);return;}
 rows.forEach(item=>item.classList.remove('current_play'));row.classList.add('current_play');
 document.querySelector('#lessonOrder').textContent='1.'+(index+1)+'、离线章节'+(index+1);
 const old=document.querySelector('video'),video=document.createElement('video');
 video.id='vjs_container_html5_api';video.muted=true;video.preload='auto';video.playbackRate=old.playbackRate;
 attachCompletion(video,row);old.replaceWith(video);video.src='/continuous-local.webm';video.load();
}));
document.querySelector('#manual-control').addEventListener('click',()=>document.querySelector('video').pause());
</script></body></html>`;

describe.runIf(process.platform === 'win32')(
  '连续相邻切章候选：仅离线原生媒体及真实StateStore',
  () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let media: Buffer;
    let directory: string;
    let store: StateStore;
    let engine: TaskEngine;
    let reader: ZhihuishuMonitorSiteAdapter;
    let evidence: Array<{
      courseId: string;
      catalogue: string;
      completionMarkers: 'finish-half-v1';
    }>;
    let courseId: string;
    let chapterIds: string[];
    let writes: SnapshotInput[];

    beforeAll(async () => {
      const edge = await findEdge();
      if (!edge) throw new Error('连续导航离线测试需要本机Edge');
      media = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
      browser = await chromium.launch({ executablePath: edge, headless: true });
    });
    beforeEach(async () => {
      context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (route) =>
        route.fulfill(
          route.request().url() === mediaAddress
            ? { status: 200, contentType: 'video/webm', body: media }
            : route.request().isNavigationRequest()
              ? { status: 200, contentType: 'text/html; charset=utf-8', body: html }
              : { status: 404, body: '' },
        ),
      );
      page = await context.newPage();
      await page.goto(address);
      await expect
        .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).readyState))
        .toBeGreaterThanOrEqual(2);
      const raw = await page.evaluate(readZhihuishuDom, undefined);
      if (!raw) throw new Error('离线课程壳层应可靠');
      evidence = [
        {
          courseId: zhihuishuCourseId(raw.route),
          catalogue: zhihuishuCatalogueKey(raw),
          completionMarkers: 'finish-half-v1',
        },
      ];
      reader = new ZhihuishuMonitorSiteAdapter(page, evidence);
      const initial = await reader.observe();
      courseId = initial.course.courseId!;
      chapterIds = initial.chapters.map((chapter) => chapter.chapterId);
      directory = await mkdtemp(join(tmpdir(), 'continuous-navigation-candidate-'));
      store = new StateStore(directory);
      writes = [];
      engine = new TaskEngine({
        store: {
          load: () => store.load(),
          write: async (input) => {
            writes.push(structuredClone(input));
            return store.write(input);
          },
        },
        stage2Capabilities: {
          enabled: true,
          inspect: async (signal) => (await reader.observe(signal)).course,
          backup: async () => true,
        },
      });
      await engine.browserConnected();
      expect((await engine.confirmCourse(initial.course, courseId)).ok).toBe(true);
      expect((await engine.start()).ok).toBe(true);
      // Capture the actual running task; browser/confirmation setup snapshots have
      // no task ID yet and are outside the continuous operation under test.
      writes = [];
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await engine?.suspend('离线测试结束');
      await context?.close();
      const absolute = resolve(directory);
      if (
        dirname(absolute) !== resolve(tmpdir()) ||
        !basename(absolute).startsWith('continuous-navigation-candidate-')
      )
        throw new Error('拒绝清理连续候选测试临时目录外的路径');
      await rm(absolute, { recursive: true, force: true });
    });
    afterAll(async () => {
      await browser?.close();
    });

    const fixture = () =>
      page.evaluate(() =>
        structuredClone(
          (window as unknown as { continuousFixture: FixtureState }).continuousFixture,
        ),
      );
    const setFixture = (patch: Partial<FixtureState>) =>
      page.evaluate(
        (value) =>
          Object.assign(
            (window as unknown as { continuousFixture: FixtureState }).continuousFixture,
            value,
          ),
        patch,
      );
    const candidate = (
      options: ConstructorParameters<typeof ContinuousNavigationCandidateSession>[3] = {},
    ) =>
      new ContinuousNavigationCandidateSession(page, engine, evidence, {
        navigation: true,
        startPlayAfterNavigation: true,
        maxTransitions: 3,
        pollIntervalMs: 50,
        totalTimeoutMs: 20000,
        ...options,
      });
    const startSource = async (progress = 0) => {
      await page.locator('video').evaluate(async (node, fraction) => {
        const video = node as HTMLVideoElement;
        if (fraction) {
          // This tiny local WebM has no reliable random-access cues: a native seek
          // can report seeked at zero. Model only this first source's fast fault
          // starting point with an offset; its clock still advances natively.
          // The three-hop success case starts at zero, and all target playback
          // feedback always uses the unmodified native currentTime accessor.
          const nativeTime = Object.getOwnPropertyDescriptor(
            HTMLMediaElement.prototype,
            'currentTime',
          )!.get!;
          const offset = video.duration * fraction;
          Object.defineProperty(video, 'currentTime', {
            configurable: true,
            get: () => (nativeTime.call(video) as number) + offset,
          });
        }
        // User-source equivalent uses native play directly; fixture counter records
        // only the automatic target play calls under test.
        await HTMLMediaElement.prototype.play.call(video);
      }, progress);
    };
    const expectReleased = async () => {
      expect(
        await page.evaluate(() =>
          Object.keys(window).filter((name) =>
            /^(zhsCandidateScope_|zhsPlaybackMedia_|zhsContinuousScope_)/u.test(name),
          ),
        ),
      ).toEqual([]);
    };

    it('自然媒体连续3跳采用6个唯一操作ID和同一task，逐跳导航落盘后才创建播放意图，末次停止不暂停视频', async () => {
      const taskId = engine.view().taskId;
      const observed: Array<{ sample: SiteObservation; completed: number }> = [];
      const instance = candidate({
        onObservation: (sample, completed) => observed.push({ sample, completed }),
      });
      await startSource();
      const result = await instance.run({ courseId, chapterIds });
      expect(result.completedTransitions).toBe(3);
      expect(result.outcomes).toHaveLength(3);
      expect(result.initialTaskId).toBe(taskId);
      expect(result.samples).toBeGreaterThan(3);
      expect(new Set(writes.map((input) => input.taskId))).toEqual(new Set([taskId]));
      const operationIds = result.outcomes.flatMap((outcome) => [
        outcome.navigationOperationId,
        outcome.playbackOperationId,
      ]);
      expect(new Set(operationIds).size).toBe(6);
      for (const outcome of result.outcomes) {
        expect(outcome).toMatchObject({
          navigation: { code: 'OPERATION_COMPLETED' },
          playback: { code: 'OPERATION_COMPLETED' },
          navigationDispatchCalls: 1,
          playbackPerformCalls: 1,
          playbackOutcome: 'confirmed',
        });
        const firstPlay = writes.findIndex((input) =>
          input.pendingOperations.some((row) => row.operationId === outcome.playbackOperationId),
        );
        expect(firstPlay).toBeGreaterThan(0);
        expect(
          writes[firstPlay - 1].pendingOperations.find(
            (row) => row.operationId === outcome.navigationOperationId,
          )?.status,
        ).toBe('completed');
      }
      expect((await store.load())?.pendingOperations).toHaveLength(6);
      expect(
        (await store.load())?.pendingOperations.every((row) => row.status === 'completed'),
      ).toBe(true);
      expect(await fixture()).toMatchObject({
        clicks: 3,
        plays: 3,
        domClicks: 0,
        trusted: [true, true, true],
      });
      expect((await reader.observe()).currentChapterId).toBe(chapterIds[3]);
      expect(
        await page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused),
      ).toBe(false);
      expect(engine.view().state).toBe('PAUSED');
      expect(observed.some((row) => row.completed === 1)).toBe(true);
      expect(observed.some((row) => row.completed === 2)).toBe(true);
      await expectReleased();
      await expect(instance.run({ courseId, chapterIds })).rejects.toThrow();
      expect((await fixture()).clicks).toBe(3);
    }, 25000);

    it('固定计划不相邻时零点击零意图，并释放外层守卫', async () => {
      await startSource();
      const result = await candidate().run({
        courseId,
        chapterIds: [chapterIds[0], chapterIds[2]],
      });
      expect(result.completedTransitions).toBe(0);
      expect(result.stopReason).toBeTruthy();
      expect(await fixture()).toMatchObject({ clicks: 0, plays: 0, domClicks: 0 });
      expect((await store.load())?.pendingOperations).toEqual([]);
      await expectReleased();
    });

    it('第一跳完成后第二跳弹窗留下未知操作，无第三跳或第二次播放', async () => {
      await setFixture({ blockNavigationOn: 2 });
      await startSource(0.82);
      const result = await candidate().run({ courseId, chapterIds });
      expect(result.completedTransitions).toBe(1);
      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes[0].playbackOutcome).toBe('confirmed');
      expect(result.outcomes[1]).toMatchObject({
        navigationDispatchCalls: 1,
        playbackPerformCalls: 0,
        playback: null,
        playbackOutcome: 'not-run',
      });
      expect((await store.load())?.pendingOperations.map((row) => [row.kind, row.status])).toEqual([
        ['chapter-navigation', 'completed'],
        ['playback-start', 'completed'],
        ['chapter-navigation', 'awaiting-confirmation'],
      ]);
      expect(await fixture()).toMatchObject({ clicks: 2, plays: 1, domClicks: 0 });
      await expectReleased();
    });

    it('首跳成功后人工关键控件暂停由连续守卫锁停，余下计划不得自动恢复', async () => {
      let firstCompleted = false;
      const observations: Array<{ completed: number; sample: SiteObservation }> = [];
      const instance = candidate({
        onObservation: (sample, completed) => {
          observations.push({ completed, sample });
          if (completed === 1) firstCompleted = true;
        },
      });
      await startSource(0.82);
      const running = instance.run({ courseId, chapterIds });
      let stopped: Awaited<typeof running> | undefined;
      void running.then((result) => {
        stopped = result;
      });
      // A native target load plus the 0.2s progress proof can exceed Vitest's
      // default one-second poll. This only bounds the test's observation wait.
      try {
        await expect.poll(() => firstCompleted, { timeout: 4000 }).toBe(true);
      } catch (error) {
        const diagnostic = {
          fixture: await fixture(),
          task: engine.view(),
          observed: await reader.observe(),
          recentSamples: observations.slice(-3),
        };
        await engine.suspend('离线测试等待首跳失败，取消未完成会话');
        console.info(
          'CONTINUOUS_FIRST_HOP_DIAGNOSTIC',
          JSON.stringify({ diagnostic, stopped: await running }),
        );
        throw error;
      }
      expect(firstCompleted, JSON.stringify(stopped)).toBe(true);
      await page.locator('#manual-control').click();
      const result = await running;
      expect(result.completedTransitions).toBe(1);
      expect(result.stopReason).toBeTruthy();
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 1, domClicks: 0 });
      expect(
        await page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused),
      ).toBe(true);
      await page.waitForTimeout(200);
      expect((await fixture()).clicks).toBe(1);
      await expectReleased();
    });

    it('首跳后已经观察true的源章完成标记回退false立即停止，不执行第二跳', async () => {
      let firstCompleted = false;
      const instance = candidate({
        onObservation: (_sample, completed) => {
          if (completed === 1) firstCompleted = true;
        },
      });
      await startSource(0.82);
      const running = instance.run({ courseId, chapterIds });
      await expect.poll(() => firstCompleted, { timeout: 4000 }).toBe(true);
      await page
        .locator('li.video')
        .first()
        .evaluate((row) => row.querySelector('.time_icofinish')?.remove());
      const result = await running;
      expect(result.completedTransitions).toBe(1);
      expect(result.stopReason).toBeTruthy();
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 1, domClicks: 0 });
      expect((await store.load())?.pendingOperations.map((row) => [row.kind, row.status])).toEqual([
        ['chapter-navigation', 'completed'],
        ['playback-start', 'completed'],
      ]);
      await expectReleased();
    });

    it('等待期间调用方修改courseId并append额外章节不能扩大原固定一跳计划', async () => {
      let sampled = false;
      const instance = candidate({
        onObservation: () => {
          sampled = true;
        },
      });
      const requestedPlan = { courseId, chapterIds: chapterIds.slice(0, 2) };
      await startSource(0.4);
      const running = instance.run(requestedPlan);
      await expect.poll(() => sampled).toBe(true);
      requestedPlan.courseId = 'caller-mutated-course';
      requestedPlan.chapterIds.push(...chapterIds.slice(2));
      const result = await running;
      expect(result.completedTransitions).toBe(1);
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].playbackOutcome).toBe('confirmed');
      expect((await reader.observe()).currentChapterId).toBe(chapterIds[1]);
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 1, domClicks: 0 });
      expect((await store.load())?.pendingOperations).toHaveLength(2);
      await expectReleased();
    });

    it('媒体超过81%但平台仍false时不点击，直至自然ended安全停止', async () => {
      await setFixture({ holdCompletion: true });
      await startSource();
      const result = await candidate().run({ courseId, chapterIds: chapterIds.slice(0, 2) });
      expect(result.completedTransitions).toBe(0);
      expect(result.stopReason).toBeTruthy();
      expect(result.samples).toBeGreaterThan(0);
      expect(await page.locator('video').evaluate((node) => (node as HTMLVideoElement).ended)).toBe(
        true,
      );
      expect(await fixture()).toMatchObject({ clicks: 0, plays: 0, domClicks: 0 });
      expect((await store.load())?.pendingOperations).toEqual([]);
      await expectReleased();
    });

    it('平台完成标记未知null立即停止，绝不用81%替代标记', async () => {
      await page
        .locator('li.video .time_ico_half')
        .first()
        .evaluate((node) => node.remove());
      await startSource(0.82);
      expect((await reader.observe()).chapters[0].platformCompleted).toBeNull();
      const result = await candidate().run({ courseId, chapterIds: chapterIds.slice(0, 2) });
      expect(result.completedTransitions).toBe(0);
      expect(result.stopReason).toBeTruthy();
      expect(await fixture()).toMatchObject({ clicks: 0, plays: 0, domClicks: 0 });
      expect((await store.load())?.pendingOperations).toEqual([]);
      await expectReleased();
    });

    it('等待期间滚动不误判关键输入，一跳仍可导航并自然播放', async () => {
      let sampled = false;
      const instance = candidate({
        onObservation: () => {
          sampled = true;
        },
      });
      await startSource(0.4);
      const running = instance.run({ courseId, chapterIds: chapterIds.slice(0, 2) });
      await expect.poll(() => sampled).toBe(true);
      await page.mouse.wheel(0, 120);
      const result = await running;
      expect(result.completedTransitions).toBe(1);
      expect(result.outcomes[0].playbackOutcome).toBe('confirmed');
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 1, domClicks: 0 });
      await expectReleased();
    });

    it('等待时取消后没有迟到切章或播放，单实例不能复用', async () => {
      let sampled = false;
      const instance = candidate({
        onObservation: () => {
          sampled = true;
        },
      });
      const controller = new AbortController();
      await startSource();
      const running = instance.run({ courseId, chapterIds }, controller.signal);
      await expect.poll(() => sampled).toBe(true);
      controller.abort(new Error('offline continuous cancel'));
      const result = await running;
      expect(result.completedTransitions).toBe(0);
      expect(result.stopReason).toBeTruthy();
      await page.waitForTimeout(200);
      expect(await fixture()).toMatchObject({ clicks: 0, plays: 0, domClicks: 0 });
      expect((await store.load())?.pendingOperations).toEqual([]);
      await expect(instance.run({ courseId, chapterIds })).rejects.toThrow();
      await expectReleased();
    });

    it('最大3跳的硬限额拒绝4跳计划，零点击零意图', async () => {
      await startSource();
      const result = await candidate().run({
        courseId,
        chapterIds: [...chapterIds, `${chapterIds[3]}-extra`],
      });
      expect(result.completedTransitions).toBe(0);
      expect(result.stopReason).toBeTruthy();
      expect(await fixture()).toMatchObject({ clicks: 0, plays: 0, domClicks: 0 });
      expect((await store.load())?.pendingOperations).toEqual([]);
      await expectReleased();
    });

    it('默认权限不开启连续导航或播放，现有已播放媒体保持原状', async () => {
      await startSource();
      const instance = new ContinuousNavigationCandidateSession(page, engine, evidence);
      const result = await instance.run({ courseId, chapterIds: chapterIds.slice(0, 2) });
      expect(result.completedTransitions).toBe(0);
      expect(result.stopReason).toBeTruthy();
      expect(await fixture()).toMatchObject({ clicks: 0, plays: 0, domClicks: 0 });
      expect((await store.load())?.pendingOperations).toEqual([]);
      expect(
        await page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused),
      ).toBe(false);
      await expectReleased();
    });
  },
);
