import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import { StateStore, type SnapshotInput } from '../../packages/persistence/src/index';
import { TaskEngine } from '../../packages/task-engine/src/index';
import type { SiteAction } from '../../packages/contracts/src/monitor';
import { BrowserNavigationPlaybackCandidate } from '../../packages/site-adapter/src/browser-navigation-playback-candidate';
import {
  ZhihuishuMonitorSiteAdapter,
  zhihuishuCatalogueKey,
  zhihuishuCourseId,
} from '../../packages/site-adapter/src/zhihuishu';
import { readZhihuishuDom } from '../../packages/site-adapter/src/zhihuishu-dom';
import { monitorAdapterForPage } from '../../packages/site-adapter/src/monitor';
import { BrowserContinuousInputGuard } from '../../packages/site-adapter/src/browser-continuous-input-guard';

const address =
  'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-navigation-playback-001';
type Navigation = Extract<SiteAction, { type: 'navigate' }>;
interface FixtureState {
  clicks: number;
  plays: number;
  autoPlay: boolean;
  rejectPlay: boolean;
  frozenPlay: boolean;
  replaceOnPlay: boolean;
  reloadOnPlay: boolean;
  jumpOnPlay: boolean;
  regressOnPlay: boolean;
  blockNavigation: boolean;
  nodeGap: boolean;
}
const fixtureScript = `<script>
window.chainFixture={clicks:0,plays:0,autoPlay:false,rejectPlay:false,frozenPlay:false,replaceOnPlay:false,reloadOnPlay:false,jumpOnPlay:false,regressOnPlay:false,blockNavigation:false,nodeGap:false};
const rows=document.querySelectorAll('li.video');
rows[1].querySelector('.catalogue_title').addEventListener('click',()=>{
 const state=window.chainFixture;state.clicks++;
 if(state.blockNavigation){const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.textContent='离线阻挡';document.body.append(dialog);return;}
 rows[0].classList.remove('current_play');rows[1].classList.add('current_play');
 document.querySelector('#lessonOrder').textContent='1.2、合成章节二';
 const old=document.querySelector('video');const video=old.cloneNode(true);
 const savedRate=old.playbackRate;video.playbackRate=savedRate;
 if(state.nodeGap){old.remove();window.restoreChainTarget=()=>{document.querySelector('#vjs_container').prepend(video);video.addEventListener('loadedmetadata',()=>{video.playbackRate=savedRate},{once:true});video.load()};}
 else old.replaceWith(video);
 const play=video.play.bind(video);
 video.play=()=>{state.plays++;
  if(state.rejectPlay)return Promise.reject(new DOMException('fixture denied','NotAllowedError'));
  if(state.frozenPlay){Object.defineProperty(video,'paused',{configurable:true,value:false});return Promise.resolve();}
  if(state.replaceOnPlay){video.replaceWith(video.cloneNode(true));return Promise.resolve();}
  if(state.reloadOnPlay){video.load();return Promise.resolve();}
  if(state.jumpOnPlay||state.regressOnPlay){
   Object.defineProperty(video,'paused',{configurable:true,value:false});
   Object.defineProperty(video,'currentTime',{configurable:true,writable:true,value:state.jumpOnPlay?2:0.12});
   if(state.regressOnPlay)setTimeout(()=>video.currentTime=0.04,80);
   return Promise.resolve();
  }
  return play();
 };
 if(state.autoPlay)video.addEventListener('loadedmetadata',()=>void play(),{once:true});
});
</script>`;

describe.runIf(process.platform === 'win32')(
  '切章后独立单次播放（离线StateStore及原生媒体）',
  () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let html: string;
    let media: Buffer;
    let directory: string;
    let store: StateStore;
    let engine: TaskEngine;
    let evidence: Array<{
      courseId: string;
      catalogue: string;
      completionMarkers: 'finish-half-v1';
    }>;
    let action: Navigation;
    let courseId: string;
    let writes: SnapshotInput[];
    let writeHook: ((input: SnapshotInput) => Promise<void>) | undefined;
    let failWrite: ((input: SnapshotInput) => boolean) | undefined;

    beforeAll(async () => {
      const edge = await findEdge();
      if (!edge) throw new Error('离线播放衔接测试需要本机Edge');
      [html, media] = await Promise.all([
        readFile(new URL('../fixtures/local-site/zhihuishu-derived.html', import.meta.url), 'utf8'),
        readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url)),
      ]);
      html = html
        .replace(
          '</head>',
          '<style>.time_icofinish{display:inline-block;width:12px;height:12px}.catalogue_title{display:inline-block;min-width:150px;min-height:24px}</style></head>',
        )
        .replace('</body>', `${fixtureScript}</body>`);
      browser = await chromium.launch({ executablePath: edge, headless: true });
    });

    beforeEach(async () => {
      context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (route) =>
        route.fulfill(
          route.request().url().endsWith('/synthetic-derived.webm')
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
      const sample = await page.evaluate(readZhihuishuDom, undefined);
      if (!sample) throw new Error('合成课程身份应可靠');
      evidence = [
        {
          courseId: zhihuishuCourseId(sample.route),
          catalogue: zhihuishuCatalogueKey(sample),
          completionMarkers: 'finish-half-v1',
        },
      ];
      const reader = new ZhihuishuMonitorSiteAdapter(page, evidence);
      const observed = await reader.observe();
      courseId = observed.course.courseId!;
      action = {
        type: 'navigate',
        fromChapterId: observed.currentChapterId!,
        chapterId: observed.chapters[1].chapterId,
      };
      await page.locator('video').evaluate((node) => {
        const video = node as HTMLVideoElement;
        video.currentTime = video.duration;
        video.playbackRate = 1.25;
        Object.defineProperty(video, 'ended', { configurable: true, value: true });
      });
      directory = await mkdtemp(join(tmpdir(), 'navigation-playback-candidate-'));
      store = new StateStore(directory);
      writes = [];
      writeHook = undefined;
      failWrite = undefined;
      engine = new TaskEngine({
        store: {
          load: () => store.load(),
          write: async (input) => {
            writes.push(structuredClone(input));
            if (failWrite?.(input)) throw new Error('SYNTHETIC_STATE_WRITE_FAILURE');
            const saved = await store.write(input);
            await writeHook?.(input);
            return saved;
          },
        },
        stage2Capabilities: {
          enabled: true,
          inspect: async (signal) => (await reader.observe(signal)).course,
          backup: async () => true,
        },
      });
      await engine.browserConnected();
      expect((await engine.confirmCourse(observed.course, courseId)).ok).toBe(true);
      expect((await engine.start()).ok).toBe(true);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await context?.close();
      const absolute = resolve(directory);
      if (
        dirname(absolute) !== resolve(tmpdir()) ||
        !basename(absolute).startsWith('navigation-playback-candidate-')
      )
        throw new Error('拒绝清理测试临时目录以外路径');
      await rm(absolute, { recursive: true, force: true });
    });
    afterAll(async () => {
      await browser?.close();
    });
    const fixture = () =>
      page.evaluate(() =>
        structuredClone((window as unknown as { chainFixture: FixtureState }).chainFixture),
      );
    const candidate = (permissions = { navigation: true, startPlayAfterNavigation: true }) =>
      new BrowserNavigationPlaybackCandidate(page, engine, evidence, permissions);
    const setFixture = async (patch: Partial<FixtureState>) =>
      page.evaluate(
        (value) =>
          Object.assign((window as unknown as { chainFixture: FixtureState }).chainFixture, value),
        patch,
      );

    it('节点空窗衔接：真实新视频恢复后导航先落盘，再独立播放一次且自然推进', async () => {
      await setFixture({ nodeGap: true });
      const instance = candidate();
      const running = instance.runOnce(action, courseId);
      await expect.poll(async () => (await fixture()).clicks).toBe(1);
      await expect.poll(() => page.locator('video').count()).toBe(0);
      await page.waitForTimeout(350);
      expect((await store.load())?.pendingOperations.map((row) => [row.kind, row.status])).toEqual([
        ['chapter-navigation', 'executing'],
      ]);
      await page.evaluate(() =>
        (window as unknown as { restoreChainTarget: () => void }).restoreChainTarget(),
      );
      const result = await running;
      expect(result).toMatchObject({
        navigation: { code: 'OPERATION_COMPLETED' },
        playback: { code: 'OPERATION_COMPLETED' },
        playbackOutcome: 'confirmed',
        navigationDispatchCalls: 1,
        playbackPerformCalls: 1,
      });
      expect(result.navigationOperationId).not.toBe(result.playbackOperationId);
      const firstPlay = writes.findIndex((input) =>
        input.pendingOperations.some((row) => row.kind === 'playback-start'),
      );
      expect(firstPlay).toBeGreaterThan(0);
      expect(writes[firstPlay - 1].pendingOperations).toMatchObject([
        { kind: 'chapter-navigation', status: 'completed' },
      ]);
      expect((await store.load())?.pendingOperations.map((row) => [row.kind, row.status])).toEqual([
        ['chapter-navigation', 'completed'],
        ['playback-start', 'completed'],
      ]);
      expect(
        result.navigationDiagnostics.feedbackTrail.some(
          (row) => row.reason === 'media-node-pending',
        ),
      ).toBe(true);
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 1 });
      const first = await page
        .locator('video')
        .evaluate((node) => (node as HTMLVideoElement).currentTime);
      await expect
        .poll(() =>
          page.locator('video').evaluate((node) => (node as HTMLVideoElement).currentTime),
        )
        .toBeGreaterThan(first);
      expect(engine.view().state).toBe('PAUSED');
    });

    it.each(['popup', 'extra-video', 'permanent'] as const)(
      '节点空窗衔接：%s阻断后零播放意图且未知导航不重发',
      async (fault) => {
        await setFixture({ nodeGap: true });
        const instance = candidate();
        const running = instance.runOnce(action, courseId);
        await expect.poll(async () => (await fixture()).clicks).toBe(1);
        await expect.poll(() => page.locator('video').count()).toBe(0);
        await page.waitForTimeout(350);
        await page.evaluate((mode) => {
          if (mode === 'popup') {
            const popup = document.createElement('div');
            popup.setAttribute('role', 'dialog');
            popup.textContent = 'local blocking dialog';
            document.body.append(popup);
          }
          if (mode === 'extra-video') {
            (window as unknown as { restoreChainTarget: () => void }).restoreChainTarget();
            const extra = document.createElement('video');
            extra.hidden = true;
            document.body.append(extra);
          }
        }, fault);
        const result = await running;
        expect(result).toMatchObject({
          navigationDispatchCalls: 1,
          playbackPerformCalls: 0,
          playback: null,
          playbackOutcome: 'not-run',
        });
        expect(result.navigation?.ok).toBe(false);
        expect(result.navigationDiagnostics.feedback).toBe(
          fault === 'popup'
            ? 'blocking-popup'
            : fault === 'extra-video'
              ? 'media-nodes-ambiguous'
              : 'media-node-pending',
        );
        if (fault === 'permanent')
          expect(result.navigationDiagnostics.failure).toBe('CANDIDATE_TARGET_FEEDBACK_TIMEOUT');
        expect((await store.load())?.pendingOperations).toMatchObject([
          { kind: 'chapter-navigation', status: 'awaiting-confirmation' },
        ]);
        expect((await store.load())?.pendingOperations).toHaveLength(1);
        await expect(instance.runOnce(action, courseId)).rejects.toThrow('ALREADY_CONSUMED');
        expect(await fixture()).toMatchObject({ clicks: 1, plays: 0 });
        expect(
          await page.evaluate(() =>
            Object.keys(window).filter((name) =>
              /^zhsCandidateScope_|^zhsPlaybackMedia_/u.test(name),
            ),
          ),
        ).toEqual([]);
      },
    );

    it('导航完成已落盘后才创建独立播放意图，同一任务两个ID及原生时间推进', async () => {
      const instance = candidate();
      const result = await instance.runOnce(action, courseId);
      expect(result.navigation?.code).toBe('OPERATION_COMPLETED');
      expect(result.playback?.code).toBe('OPERATION_COMPLETED');
      expect(result).toMatchObject({
        playbackOutcome: 'confirmed',
        navigationDispatchCalls: 1,
        playbackPerformCalls: 1,
      });
      expect(result.navigationOperationId).not.toBe(result.playbackOperationId);
      const saved = await store.load();
      expect(saved?.schemaVersion).toBe(1);
      expect(saved?.pendingOperations.map((row) => [row.kind, row.status])).toEqual([
        ['chapter-navigation', 'completed'],
        ['playback-start', 'completed'],
      ]);
      expect(new Set(saved?.pendingOperations.map((row) => row.taskId)).size).toBe(1);
      const firstPlay = writes.findIndex((input) =>
        input.pendingOperations.some((row) => row.kind === 'playback-start'),
      );
      expect(writes[firstPlay - 1].pendingOperations).toMatchObject([
        { kind: 'chapter-navigation', status: 'completed' },
      ]);
      const first = await page.locator('video').evaluate((node) => ({
        time: (node as HTMLVideoElement).currentTime,
        paused: (node as HTMLVideoElement).paused,
        rate: (node as HTMLVideoElement).playbackRate,
        muted: (node as HTMLVideoElement).muted,
      }));
      expect(first).toMatchObject({ paused: false, rate: 1.25, muted: true });
      await expect
        .poll(() =>
          page.locator('video').evaluate((node) => (node as HTMLVideoElement).currentTime),
        )
        .toBeGreaterThan(first.time);
      await expect(instance.runOnce(action, courseId)).rejects.toThrow('ALREADY_CONSUMED');
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 1 });
      expect(engine.view().state).toBe('PAUSED');
      expect(
        await page.evaluate(() =>
          Object.keys(window).filter((name) =>
            /^zhsCandidateScope_|^zhsPlaybackMedia_/u.test(name),
          ),
        ),
      ).toEqual([]);
    });

    it.each([undefined, false, 'true', 1])(
      '自动播放许可%s默认不授予，明确导航仍只导航',
      async (grant) => {
        const instance = candidate({
          navigation: true,
          startPlayAfterNavigation: grant as boolean,
        });
        const result = await instance.runOnce(action, courseId);
        expect(result.navigation?.ok).toBe(true);
        expect(result.playback).toBeNull();
        expect(result.playbackPerformCalls).toBe(0);
        expect(await fixture()).toMatchObject({ clicks: 1, plays: 0 });
        expect((await store.load())?.pendingOperations).toHaveLength(1);
      },
    );

    it('默认构造零导航零播放；生产工厂仍锁止', async () => {
      const result = await new BrowserNavigationPlaybackCandidate(page, engine, evidence).runOnce(
        action,
        courseId,
      );
      expect(result.stopReason).toBe('NAVIGATION_PLAYBACK_NOT_GRANTED');
      expect(await fixture()).toMatchObject({ clicks: 0, plays: 0 });
      expect((await monitorAdapterForPage(page).observe()).course.confidence).toBe('uncertain');
    });

    it('网站已自动播放时仅验证自然推进，不补发play或创建播放意图', async () => {
      await setFixture({ autoPlay: true });
      const result = await candidate().runOnce(action, courseId);
      expect(result.navigation?.ok).toBe(true);
      expect(result.playbackOutcome).toBe('already-playing');
      expect(result.playback).toBeNull();
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 0 });
      expect((await store.load())?.pendingOperations).toHaveLength(1);
    });

    it('导航完成写盘失败，零播放意图且不重试导航', async () => {
      failWrite = (input) =>
        input.pendingOperations.some(
          (row) => row.kind === 'chapter-navigation' && row.status === 'completed',
        );
      const result = await candidate().runOnce(action, courseId);
      expect(result.navigation?.ok).toBe(false);
      expect(result.playback).toBeNull();
      expect(
        writes.every((input) =>
          input.pendingOperations.every((row) => row.kind !== 'playback-start'),
        ),
      ).toBe(true);
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 0 });
    });

    it('导航完成与播放之间人工暂停输入取消衔接，零播放意图', async () => {
      writeHook = async (input) => {
        if (
          input.pendingOperations.length === 1 &&
          input.pendingOperations[0].status === 'completed'
        )
          await page.locator('video').click();
      };
      const result = await candidate().runOnce(action, courseId);
      expect(result.playback).toBeNull();
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 0 });
      expect(
        (await store.load())?.pendingOperations.every((row) => row.kind !== 'playback-start'),
      ).toBe(true);
    });

    it('外部取消同步转成任务暂停，不发下一项播放', async () => {
      const controller = new AbortController();
      writeHook = async (input) => {
        if (
          input.pendingOperations.some(
            (row) => row.kind === 'chapter-navigation' && row.status === 'completed',
          )
        )
          controller.abort();
      };
      const result = await candidate().runOnce(action, courseId, controller.signal);
      expect(engine.view().state).toBe('PAUSED');
      expect(result.playback).toBeNull();
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 0 });
    });

    it('导航已发未知时零播放意图，重建任务仍拒绝继续且不重发', async () => {
      await setFixture({ blockNavigation: true });
      const result = await candidate().runOnce(action, courseId);
      expect(result.navigation?.ok).toBe(false);
      expect(result.navigationDiagnostics.failure).toBe('CANDIDATE_TARGET_FEEDBACK_UNSAFE');
      expect(result.playback).toBeNull();
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 0 });
      expect((await store.load())?.pendingOperations).toMatchObject([
        { kind: 'chapter-navigation', status: 'awaiting-confirmation' },
      ]);
      await page.locator('[role="dialog"]').evaluate((node) => node.remove());
      const reader = new ZhihuishuMonitorSiteAdapter(page, evidence);
      const restored = new TaskEngine({
        store: new StateStore(directory),
        stage2Capabilities: {
          enabled: true,
          inspect: async (signal) => (await reader.observe(signal)).course,
          backup: async () => true,
        },
      });
      await restored.browserConnected();
      await restored.confirmCourse((await reader.observe()).course, courseId);
      expect((await restored.resume()).code).toBe('UNCONFIRMED_OPERATION');
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 0 });
    });

    it('导航完成落盘期间同节点重载完成，仍不得创建播放意图', async () => {
      let reloaded = false;
      writeHook = async (input) => {
        if (
          !reloaded &&
          input.pendingOperations.length === 1 &&
          input.pendingOperations[0].status === 'completed'
        ) {
          reloaded = true;
          await page.locator('video').evaluate(async (node) => {
            const media = node as HTMLVideoElement;
            await new Promise<void>((resolve) => {
              media.addEventListener('loadedmetadata', () => resolve(), { once: true });
              media.load();
            });
          });
        }
      };
      const result = await candidate().runOnce(action, courseId);
      expect(result.navigation?.ok).toBe(true);
      expect(result.playback).toBeNull();
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 0 });
      expect((await store.load())?.pendingOperations).toHaveLength(1);
    });

    it('播放完成保存失败时保留待确认，重建后禁止再次启动', async () => {
      failWrite = (input) =>
        input.pendingOperations.some(
          (row) => row.kind === 'playback-start' && row.status === 'completed',
        );
      const result = await candidate().runOnce(action, courseId);
      expect(result.navigation?.ok).toBe(true);
      expect(result.playback?.code).toBe('STATE_WRITE_FAILED');
      expect(result.playbackOutcome).toBe('unknown');
      expect((await store.load())?.pendingOperations).toMatchObject([
        { kind: 'chapter-navigation', status: 'completed' },
        { kind: 'playback-start', status: 'awaiting-confirmation' },
      ]);
      const reader = new ZhihuishuMonitorSiteAdapter(page, evidence);
      const restored = new TaskEngine({
        store: new StateStore(directory),
        stage2Capabilities: {
          enabled: true,
          inspect: async (signal) => (await reader.observe(signal)).course,
          backup: async () => true,
        },
      });
      await restored.browserConnected();
      await restored.confirmCourse((await reader.observe()).course, courseId);
      expect((await restored.resume()).code).toBe('UNCONFIRMED_OPERATION');
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 1 });
    });

    it.each([
      'rejectPlay',
      'frozenPlay',
      'replaceOnPlay',
      'reloadOnPlay',
      'jumpOnPlay',
      'regressOnPlay',
    ] as const)('%s 不得确认播放或重发，保存等待确认', async (mode) => {
      await setFixture({ [mode]: true });
      const instance = candidate();
      const result = await instance.runOnce(action, courseId);
      expect(result.navigation?.ok).toBe(true);
      expect(result.playback?.ok).toBe(false);
      expect(result.playbackOutcome).toBe('unknown');
      expect(engine.view().state).toBe('PAUSED');
      expect(await fixture()).toMatchObject({ clicks: 1, plays: 1 });
      expect((await store.load())?.pendingOperations).toMatchObject([
        { kind: 'chapter-navigation', status: 'completed' },
        { kind: 'playback-start', status: 'awaiting-confirmation' },
      ]);
      await expect(instance.runOnce(action, courseId)).rejects.toThrow('ALREADY_CONSUMED');
    });

    it.each(['blocked', 'media-error', 'registration-mismatch'] as const)(
      '连续外层%s在最后页面任务发生、Node尚未通知时零play',
      async (mode) => {
        const invalidated = vi.fn();
        const guard = new BrowserContinuousInputGuard(page, invalidated);
        await guard.install(engine.signal);
        let injected = false;
        let nodeNotifiedBeforeFinalCheck = false;
        const evaluate = page.evaluate.bind(page);
        vi.spyOn(page, 'evaluate').mockImplementation(async (fn, arg) => {
          const request = arg as
            { action?: { type?: string }; continuousInputGuard?: string } | undefined;
          if (request?.action?.type === 'start-play' && request.continuousInputGuard) {
            nodeNotifiedBeforeFinalCheck =
              guard.signal.aborted || invalidated.mock.calls.length > 0;
            await evaluate(
              ({ name, kind }) => {
                const scope = (
                  window as unknown as Record<
                    string,
                    { blocked: boolean; mediaError: boolean; activeScope: string | null }
                  >
                )[name];
                if (kind === 'blocked') scope.blocked = true;
                else if (kind === 'media-error') scope.mediaError = true;
                else scope.activeScope = null;
                // Intentionally no binding call: the final DOM guard must independently reject.
              },
              { name: request.continuousInputGuard, kind: mode },
            );
            injected = true;
          }
          return evaluate(fn, arg);
        });
        try {
          const result = await new BrowserNavigationPlaybackCandidate(page, engine, evidence, {
            navigation: true,
            startPlayAfterNavigation: true,
            continuousGuard: guard,
          }).runOnce(action, courseId);
          expect(injected).toBe(true);
          expect(nodeNotifiedBeforeFinalCheck).toBe(false);
          expect(result.navigation?.code).toBe('OPERATION_COMPLETED');
          expect(result.playback?.ok).toBe(false);
          expect(await fixture()).toMatchObject({ clicks: 1, plays: 0 });
          expect((await store.load())?.pendingOperations).toMatchObject([
            { kind: 'chapter-navigation', status: 'completed' },
            { kind: 'playback-start', status: 'awaiting-confirmation' },
          ]);
        } finally {
          await guard.dispose();
        }
      },
    );

    it.each(['blocked', 'missing', 'malformed'] as const)(
      '最终同任务%s人工保护不允许调用play',
      async (mode) => {
        // 验证最后页面检查本身；不依赖异步Node人工通知是否赶到。
        const reader = new ZhihuishuMonitorSiteAdapter(page, evidence, {
          startPlay: true,
          criticalInputGuard: mode === 'malformed' ? '' : 'synthetic_guard',
        });
        await page.locator('video').evaluate((node) => {
          delete (node as unknown as { ended?: boolean }).ended;
        });
        if (mode === 'blocked')
          await page.evaluate(() => {
            (window as unknown as Record<string, unknown>).synthetic_guard = { blocked: true };
          });
        const sample = await reader.observe();
        await expect(
          reader.perform(
            { type: 'start-play', chapterId: sample.currentChapterId! },
            courseId,
            new AbortController().signal,
          ),
        ).rejects.toThrow('人工操作保护');
        expect(await fixture()).toMatchObject({ plays: 0 });
      },
    );
  },
);
