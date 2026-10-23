import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import { RapidOcrWorker } from '../../packages/ocr/src/index';
import { ModelCache } from '../../packages/ocr/src/models';
import { StateStore } from '../../packages/persistence/src/index';
import { TaskBackup } from '../../packages/persistence/src/task-backup';
import { PracticeSession } from '../../packages/practice/src/index';
import { FixturePracticeSiteAdapter } from '../../packages/site-adapter/src/practice-fixture';
import { ConfigStore } from '../../packages/system/src/config-store';
import { TaskEngine } from '../../packages/task-engine/src/index';
import { course, legacyOcrOptions as fixedRandom } from '../helpers/stage3';

const workerPath = fileURLToPath(new URL('../../packages/ocr/rapidocr_worker.py', import.meta.url));
let server: Server;
let browser: Browser;
let page: Page;
let url: string;
let python: string;
let cache: ModelCache;
let directory: string;
let engine: TaskEngine;
let store: StateStore;
let running: Promise<unknown> | undefined;
const directories: string[] = [];
const realWorker = (script = workerPath) => new RapidOcrWorker(python, script, cache);
const signal = () => new AbortController().signal;
const counts = () =>
  page.evaluate(() => {
    const state = (
      window as unknown as {
        stage3Fixture: {
          state: { submissions: number; pauses: number; closes: number; restores: number };
        };
      }
    ).stage3Fixture.state;
    return {
      submissions: state.submissions,
      pauses: state.pauses,
      closes: state.closes,
      restores: state.restores,
    };
  });
const paused = () => page.locator('#video').evaluate((e) => (e as HTMLVideoElement).paused);

async function drawQuestion(mode = 'normal') {
  const bytes = await readFile(new URL('../fixtures/ocr-runtime/single.png', import.meta.url));
  await page.evaluate(
    async ({ data, mode }) => {
      (window as unknown as { stage3Fixture: { reset(mode: string): void } }).stage3Fixture.reset(
        mode,
      );
      // Only the synthetic image contains a complete question. DOM extraction must fail closed.
      document.querySelector('#stem')!.textContent = '';
      document.querySelector<HTMLElement>('#practice')!.dataset.complete = 'false';
      const canvas = document.createElement('canvas');
      canvas.id = 'ocr-question';
      canvas.width = 1200;
      canvas.height = 560;
      canvas.style.display = 'block';
      const image = new Image();
      image.src = data;
      await image.decode();
      canvas.getContext('2d')!.drawImage(image, 0, 0);
      document.querySelector('#practice')!.append(canvas);
    },
    { data: `data:image/png;base64,${bytes.toString('base64')}`, mode },
  );
}

async function mutatePixels() {
  await page.locator('#ocr-question').evaluate((e) => {
    const context = (e as HTMLCanvasElement).getContext('2d')!;
    context.fillStyle = 'red';
    context.fillRect(1150, 510, 30, 30);
  });
}

function newEngine() {
  const backup = new TaskBackup(directory);
  return new TaskEngine({
    store: new StateStore(directory),
    stage3FixturePractice: true,
    stage2Capabilities: {
      enabled: true,
      inspect: async () => course(),
      backup: (s) => backup.create(s),
    },
  });
}

beforeAll(async () => {
  python = process.env.STAGE3_OCR_PYTHON ?? '';
  const models = process.env.STAGE3_OCR_MODELS ?? '';
  if (!isAbsolute(python) || !isAbsolute(models))
    throw new Error('SET_ABSOLUTE_STAGE3_OCR_PYTHON_AND_STAGE3_OCR_MODELS');
  await access(python);
  cache = new ModelCache(models);
  await cache.ensure(signal());
  const edge = await findEdge();
  if (!edge) throw new Error('BROWSER_OCR_REQUIRES_EDGE');
  const html = await readFile(new URL('../fixtures/local-site/stage3.html', import.meta.url));
  const media = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
  server = createServer((request, response) => {
    if (!['/stage3-fixture', '/stage2.webm'].includes(request.url ?? '')) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      'content-type',
      request.url === '/stage2.webm' ? 'video/webm' : 'text/html; charset=utf-8',
    );
    response.end(request.url === '/stage2.webm' ? media : html);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_LISTEN');
  url = `http://127.0.0.1:${address.port}/stage3-fixture`;
  browser = await chromium.launch({ executablePath: edge, headless: true });
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stage3-browser-ocr-'));
  directories.push(directory);
  expect((await new ConfigStore(directory).load()).blocked).toBe(false);
  store = new StateStore(directory);
  engine = newEngine();
  await engine.browserConnected();
  await engine.confirmCourse(course(), 'stage3-course');
  expect((await engine.start()).ok).toBe(true);
  page = await browser.newPage({ viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 1 });
  // Browser traffic is confined to the loopback fixture; random selection never requests a search service.
  await page.route('**/*', (route) =>
    route.request().url().startsWith(url.replace('/stage3-fixture', '/'))
      ? route.continue()
      : route.abort(),
  );
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector<HTMLVideoElement>('#video')!.readyState >= 2,
  );
  running = undefined;
});

afterEach(async () => {
  await engine?.pause();
  await running;
  await page?.context().close();
});

afterAll(async () => {
  await browser?.close();
  if (server?.listening) await new Promise<void>((done) => server.close(() => done()));
  for (const item of directories) {
    const target = resolve(item);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('stage3-browser-ocr-')
    )
      throw new Error('REFUSE_OUTSIDE_TEST_TEMP');
    await rm(target, { recursive: true, force: true });
  }
});

describe('阶段3 Edge截图→真实OCR→引擎→实际文件IO（检索fixture，待真实环境人工验收）', () => {
  it('浏览器截图真实OCR闭环：一次提交、关闭、恢复及schema1快照和任务前备份', async () => {
    await drawQuestion();
    await page.locator('#video').evaluate((e) => (e as HTMLVideoElement).play());
    const adapter = new FixturePracticeSiteAdapter(page);
    const capture = vi.spyOn(adapter, 'capture');
    const ocr = realWorker();
    const recognize = vi.spyOn(ocr, 'recognize');
    const result = await new PracticeSession(engine, adapter, ocr, fixedRandom()).run();
    expect(result.ok).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual({ submissions: 1, pauses: 1, closes: 1, restores: 1 });
    expect(await paused()).toBe(false);
    expect(engine.view().state).toBe('MONITORING');
    const snapshot = await new StateStore(directory).load();
    expect(snapshot!.schemaVersion).toBe(1);
    expect(snapshot!.pendingOperations.map((op) => op.kind)).toEqual([
      'practice-pause',
      'practice-submit',
      'practice-close',
      'practice-restore',
    ]);
    expect(snapshot!.pendingOperations.every((op) => op.status === 'completed')).toBe(true);
    expect(new Set(snapshot!.pendingOperations.map((op) => op.operationId)).size).toBe(4);
    const backups = await readdir(join(directory, 'backups', 'task-before'));
    expect(backups).toHaveLength(1);
    const backup = join(directory, 'backups', 'task-before', backups[0]);
    const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
    expect(manifest.kind).toBe('stage2-task-before');
    for (const name of ['settings.json', 'snapshot.json']) {
      const body = await readFile(join(backup, name), 'utf8');
      expect(createHash('sha256').update(body).digest('hex')).toBe(manifest.files[name]);
      expect(body).not.toMatch(/光合作用|data:image|ocr-question/);
    }
    expect(await readFile(store.snapshotPath, 'utf8')).not.toMatch(
      /光合作用|data:image|ocr-question/,
    );
    const evidence = process.env.STAGE3_BROWSER_OCR_EVIDENCE;
    if (evidence) {
      if (!isAbsolute(evidence)) throw new Error('EVIDENCE_REQUIRES_ABSOLUTE_PATH');
      await writeFile(
        join(evidence, 'synthetic-browser-crop.png'),
        await capture.mock.results[0].value,
        { flag: 'wx' },
      );
      await writeFile(
        join(evidence, 'local-loop.json'),
        JSON.stringify(
          {
            source: 'loopback-fixture',
            realOcr: true,
            realSearchCalls: 0,
            realPlatformActions: 0,
            counts: await counts(),
            snapshotSchema: snapshot!.schemaVersion,
            operationStatuses: snapshot!.pendingOperations.map((op) => ({
              kind: op.kind,
              status: op.status,
            })),
            backupManifestVerified: true,
            readyForNextStage: false,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
    }
  }, 55000);

  it('真实识别完成后仅像素变化：禁止提交、关闭和恢复', async () => {
    await drawQuestion();
    const adapter = new FixturePracticeSiteAdapter(page);
    const before = await adapter.context(signal());
    const ocr = realWorker();
    const result = await new PracticeSession(
      engine,
      adapter,
      {
        recognize: async (bytes, s) => {
          const output = await ocr.recognize(bytes, s);
          await mutatePixels();
          return output;
        },
      },
      fixedRandom(),
    ).run();
    expect(result.ok).toBe(false);
    expect((await adapter.context(signal())).revision).not.toBe(before.revision);
    expect(await counts()).toMatchObject({ submissions: 0, closes: 0, restores: 0 });
    expect(engine.view().state).toBe('PAUSED');
  });

  it('准备完成与最终动作之间改变像素：浏览器同一轮最终校验仍拒绝提交', async () => {
    await drawQuestion();
    const adapter = new FixturePracticeSiteAdapter(page);
    const context = await adapter.context(signal());
    const video = await adapter.video(signal());
    const action = { type: 'submit' as const, optionIds: ['A'], submissionId: 'final-guard-test' };
    await adapter.prepare(action, context, video, signal());
    await mutatePixels();
    await expect(adapter.perform(action, context, video, signal())).rejects.toThrow(
      'PRACTICE_CONTEXT_CHANGED',
    );
    expect((await counts()).submissions).toBe(0);
  });

  it.each(['exam', 'graded', 'unknown'])('%s零截图、零OCR、零随机选择和零提交', async (mode) => {
    await drawQuestion(mode);
    const adapter = new FixturePracticeSiteAdapter(page),
      capture = vi.spyOn(adapter, 'capture'),
      ocr = realWorker(),
      recognize = vi.spyOn(ocr, 'recognize'),
      randomIndex = vi.fn(() => 0);
    expect((await new PracticeSession(engine, adapter, ocr, { randomIndex }).run()).ok).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    expect(randomIndex).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ submissions: 0, pauses: 0, closes: 0, restores: 0 });
  });

  it('真实OCR提交后未知回执保留磁盘账本，重新构造引擎不能重发', async () => {
    await drawQuestion('unknown-feedback');
    const result = await new PracticeSession(
      engine,
      new FixturePracticeSiteAdapter(page),
      realWorker(),
      fixedRandom(),
    ).run();
    expect(result.ok).toBe(false);
    expect(await counts()).toMatchObject({ submissions: 1, closes: 0, restores: 0 });
    const first = await store.load();
    const pending = first!.pendingOperations.filter((op) => op.status === 'awaiting-confirmation');
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('practice-submit');
    const restarted = newEngine();
    await restarted.init();
    expect(restarted.view().state).toBe('PAUSED');
    await restarted.browserConnected();
    await restarted.confirmCourse(course(), 'stage3-course');
    expect((await restarted.start()).code).toBe('UNCONFIRMED_OPERATION');
    expect((await store.load())!.pendingOperations).toEqual(first!.pendingOperations);
    expect((await counts()).submissions).toBe(1);
  });

  it('用户暂停立即取消已启动的真实Python子进程，不提交也不恢复播放', async () => {
    await drawQuestion();
    await page.locator('#video').evaluate((e) => (e as HTMLVideoElement).play());
    const marker = join(directory, 'ocr.pid');
    const script = join(directory, 'cancel.py');
    await writeFile(
      script,
      `import os, pathlib, runpy\npathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))\nrunpy.run_path(${JSON.stringify(workerPath)}, run_name='__main__')\n`,
    );
    const s = engine.signal;
    const result = new PracticeSession(
      engine,
      new FixturePracticeSiteAdapter(page),
      realWorker(script),
      fixedRandom(),
    ).run();
    running = result;
    await expect
      .poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 5000, interval: 10 })
      .not.toBe('');
    const pid = Number(await readFile(marker, 'utf8'));
    const pausing = engine.pause();
    expect(s.aborted).toBe(true);
    expect(engine.view().state).toBe('PAUSED');
    await pausing;
    expect((await result).ok).toBe(false);
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            return true;
          }
        },
        { timeout: 3000, interval: 20 },
      )
      .toBe(true);
    expect(await counts()).toEqual({ submissions: 0, pauses: 1, closes: 0, restores: 0 });
    expect(await paused()).toBe(true);
    expect((await store.load())!.state).toBe('PAUSED');
  });
});

it('实际本地OCR后随机答错也只提交一次，关闭并恢复原播放；无检索或纠错', async () => {
  await drawQuestion('wrong');
  await page.locator('#video').evaluate((e) => (e as HTMLVideoElement).play());
  const result = await new PracticeSession(
    engine,
    new FixturePracticeSiteAdapter(page),
    realWorker(),
    fixedRandom(),
  ).run();
  expect(result).toMatchObject({
    ok: true,
    data: { strategy: 'random', attempts: 1, feedbackStatus: 'incorrect' },
  });
  expect(await counts()).toEqual({ submissions: 1, pauses: 1, closes: 1, restores: 1 });
  expect(await paused()).toBe(false);
  const snapshot = (await store.load())!;
  expect(snapshot.pendingOperations.every((op) => op.status === 'completed')).toBe(true);
  expect(snapshot.pendingOperations.some((op) => op.kind === 'practice-correct')).toBe(false);
  expect(JSON.stringify(snapshot)).not.toMatch(/光合作用|optionIds|correctTexts/);
}, 20000);
