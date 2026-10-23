import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import { monitorAdapterForPage } from '../../packages/site-adapter/src/monitor';
import { ConfigStore } from '../../packages/system/src/config-store';
import { StateStore } from '../../packages/persistence/src/index';
import { TaskBackup } from '../../packages/persistence/src/task-backup';
import { TaskEngine } from '../../packages/task-engine/src/index';
import { MonitorSession } from '../../packages/monitor/src/index';

let server: Server;
let browser: Browser;
let page: Page;
let url: string;
let monitor: MonitorSession | null = null;
const directories: string[] = [];

describe.runIf(process.platform === 'win32')('阶段2真实Edge + fixture +唯一任务引擎+文件IO', () => {
  beforeAll(async () => {
    const edge = await findEdge();
    if (!edge) throw new Error('需要已安装Microsoft Edge');
    const directory = fileURLToPath(new URL('../fixtures/local-site/', import.meta.url));
    const html = await readFile(join(directory, 'stage2.html'));
    const media = await readFile(join(directory, 'stage2.webm'));
    server = createServer((request, response) => {
      response.writeHead(200, {
        'content-type': request.url === '/stage2.webm' ? 'video/webm' : 'text/html; charset=utf-8',
      });
      response.end(request.url === '/stage2.webm' ? media : html);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('监听失败');
    url = `http://127.0.0.1:${address.port}/stage2-fixture`;
    browser = await chromium.launch({ executablePath: edge, headless: true });
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(
      () => !!(window as unknown as { stage2Fixture?: unknown }).stage2Fixture,
    );
  });
  afterEach(async () => {
    monitor?.dispose();
    monitor = null;
    await page?.context().close();
  });
  afterAll(async () => {
    await browser?.close();
    if (server?.listening) await new Promise<void>((done) => server.close(() => done()));
    for (const directory of directories) {
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('stage2-session-'))
        throw new Error('拒绝越界清理');
      await rm(target, { recursive: true, force: true });
    }
  });

  async function set(patch: Record<string, unknown>) {
    await page.evaluate(
      (value) =>
        (window as unknown as { stage2Fixture: { set(v: unknown): void } }).stage2Fixture.set(
          value,
        ),
      patch,
    );
  }
  async function create() {
    const directory = await mkdtemp(join(tmpdir(), 'stage2-session-'));
    directories.push(directory);
    const config = new ConfigStore(directory);
    await config.load();
    const store = new StateStore(directory);
    const backup = new TaskBackup(directory);
    const adapter = monitorAdapterForPage(page);
    const engine = new TaskEngine({
      store,
      stage2Capabilities: {
        enabled: true,
        inspect: (s) => adapter.inspect(s),
        backup: (s) => backup.create(s),
      },
    });
    monitor = new MonitorSession({ engine, config: () => config.view().config, polling: false });
    await engine.browserConnected();
    await monitor.attach(adapter);
    return { directory, config, engine, adapter, store, monitor };
  }
  async function start() {
    const h = await create();
    const course = await h.adapter.inspect();
    expect((await h.engine.confirmCourse(course, course.courseId!)).ok).toBe(true);
    expect((await h.monitor.start()).ok).toBe(true);
    return h;
  }

  it('未确认拒绝开始；人工确认和真实备份后仅观察速率且快照兼容schema1', async () => {
    const h = await create();
    expect((await h.monitor.start()).code).toBe('COURSE_NOT_CONFIRMED');
    const course = await h.adapter.inspect();
    await h.engine.confirmCourse(course, course.courseId!);
    expect((await h.monitor.start()).ok).toBe(true);
    expect(
      await page.locator('#stage2-video').evaluate((v) => (v as HTMLVideoElement).playbackRate),
    ).toBe(1);
    await h.monitor.tick();
    const snapshot = await h.store.load();
    expect(snapshot!.schemaVersion).toBe(1);
    expect(snapshot!.chapterId).toBe('chapter-001');
    expect(snapshot!.pendingOperations.some((o) => o.kind === 'playback-rate')).toBe(false);
    expect(await actionCount('set-rate')).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain('currentTime');
    expect(await page.locator('#submission-count').textContent()).toBe('0');
  });

  it('网站手动倍速导致安全暂停，继续后保留读数且速率回落也不自动改回', async () => {
    const h = await start();
    await page.locator('#manual-rate-150').click();
    await expect.poll(() => h.engine.view().state).toBe('PAUSED');
    expect((await h.adapter.observe()).player?.playbackRate).toBe(1.5);
    expect((await h.monitor.start(true)).ok).toBe(true);
    await h.monitor.tick();
    await expect.poll(() => h.monitor!.view().observation?.player?.playbackRate).toBe(1.5);
    expect(
      await page.locator('#stage2-video').evaluate((v) => (v as HTMLVideoElement).playbackRate),
    ).toBe(1.5);
    await page.evaluate(() =>
      (
        window as unknown as { stage2Fixture: { scenario(name: string): Promise<void> } }
      ).stage2Fixture.scenario('rate-lost'),
    );
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('MONITORING');
    expect((await h.adapter.observe()).player?.playbackRate).toBe(1);
    expect(await actionCount('set-rate')).toBe(0);
    expect(
      (await h.store.load())!.pendingOperations.some(
        (operation) => operation.kind === 'playback-rate',
      ),
    ).toBe(false);
  });

  it('媒体pause事件不是人工输入，真正点击暂停立即停止自动化且保留视频状态', async () => {
    const h = await start();
    await page.locator('#stage2-video').evaluate((v) => (v as HTMLVideoElement).pause());
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('MONITORING');
    await page.locator('#manual-pause').click();
    await expect.poll(() => h.engine.view().state).toBe('PAUSED');
    const count = await actionCount();
    await set({ player: { playbackRate: 1 } });
    await h.monitor.tick();
    expect(await actionCount()).toBe(count);
    expect(
      await page.locator('#stage2-video').evaluate((v) => (v as HTMLVideoElement).paused),
    ).toBe(true);
  });

  it('滚动不暂停，登录失效则暂停并禁止新动作', async () => {
    const h = await start();
    await page.mouse.wheel(0, 300);
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('MONITORING');
    const count = await actionCount();
    await set({ authenticated: false });
    await h.monitor.tick();
    await expect.poll(() => h.engine.view().state).toBe('PAUSED');
    expect(await actionCount()).toBe(count);
  });

  it('81%只核验；平台迟到完成和视频结束双证据才导航并读取目标章', async () => {
    const h = await start();
    await set({
      player: { currentTime: 5, duration: 6, paused: false, ended: false, playbackRate: 1.5 },
    });
    await h.monitor.tick();
    expect(await actionCount('navigate')).toBe(0);
    await set({
      player: { currentTime: 6, duration: 6, paused: false, ended: true, playbackRate: 1.5 },
    });
    await h.monitor.tick();
    expect(await actionCount('navigate')).toBe(0);
    await set({
      chapters: [
        { chapterId: 'chapter-001', title: '章节一', platformCompleted: true },
        { chapterId: 'chapter-002', title: '章节二', platformCompleted: false },
      ],
    });
    await h.monitor.tick();
    await expect.poll(() => actionCount('navigate')).toBe(1);
    await expect.poll(async () => (await h.adapter.observe()).currentChapterId).toBe('chapter-002');
    await h.monitor.tick();
    await expect.poll(async () => (await h.store.load())!.chapterId).toBe('chapter-002');
    expect(
      (await h.store.load())!.pendingOperations.some(
        (operation) => operation.kind === 'chapter-navigation' && operation.status === 'completed',
      ),
    ).toBe(true);
    expect(
      (await h.store.load())!.pendingOperations.some(
        (operation) => operation.kind === 'playback-rate',
      ),
    ).toBe(false);
    expect(await page.locator('#submission-count').textContent()).toBe('0');
  });

  it('换课与人工导航均清除确认，不自动恢复', async () => {
    const h = await start();
    await set({ courseId: 'another-course' });
    await h.monitor.tick();
    await expect.poll(() => h.engine.view().state).toBe('PAUSED');
    expect(h.engine.confirmedCourse).toBeNull();
    expect((await h.monitor.start(true)).ok).toBe(false);
  });

  async function actionCount(type?: string): Promise<number> {
    return page.evaluate((wanted) => {
      const actions = (
        window as unknown as { stage2Fixture: { actions(): Array<{ type: string }> } }
      ).stage2Fixture.actions();
      return wanted ? actions.filter((a) => a.type === wanted).length : actions.length;
    }, type);
  }
});
