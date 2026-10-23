import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import { VerifiedZhihuishuPracticeAdapter } from '../../packages/site-adapter/src/practice-native';
import { practiceAdapterForPage } from '../../packages/site-adapter/src/practice-fixture';
import {
  zhihuishuCourseId,
  zhihuishuCatalogueKey,
  ZhihuishuMonitorSiteAdapter,
} from '../../packages/site-adapter/src/zhihuishu';
import { readZhihuishuDom } from '../../packages/site-adapter/src/zhihuishu-dom';
import { ManualPracticeReviewStore } from '../../packages/persistence/src/manual-practice-review';
import { ManualPracticeReviewAuthorization } from '../../packages/task-engine/src/manual-practice-review';
import { createVerifiedPracticeGrant } from '../../packages/task-engine/src/practice-grant';
import { TaskEngine } from '../../packages/task-engine/src/index';
import { StateStore } from '../../packages/persistence/src/index';
import { TaskBackup } from '../../packages/persistence/src/task-backup';
import { ConfigStore } from '../../packages/system/src/config-store';
import { PracticeSession } from '../../packages/practice/src/index';
import { fixedRandom } from '../helpers/stage3';

const address =
  'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=native-synthetic-course-001';
const courseId = zhihuishuCourseId('native-synthetic-course-001');
const signal = () => new AbortController().signal;
let browser: Browser,
  page: Page,
  folder: string,
  adapter: VerifiedZhihuishuPracticeAdapter,
  engine: TaskEngine,
  store: StateStore;
let running: Promise<unknown> | undefined;
let html: Buffer, media: Buffer;
const directories: string[] = [];
const counts = () =>
  page.evaluate(() => ({
    ...(window as unknown as { nativeFixture: { state: Record<string, unknown> } }).nativeFixture
      .state,
  }));
const show = (mode = 'correct') =>
  page.evaluate(
    (mode) =>
      (window as unknown as { nativeFixture: { show(mode: string): void } }).nativeFixture.show(
        mode,
      ),
    mode,
  );

beforeAll(async () => {
  html = await readFile(new URL('../fixtures/local-site/stage3-native.html', import.meta.url));
  media = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
  const edge = await findEdge();
  if (!edge) throw new Error('NATIVE_FIXTURE_REQUIRES_EDGE');
  browser = await chromium.launch({ executablePath: edge, headless: true });
});
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'stage3-native-'));
  directories.push(folder);
  await new ConfigStore(folder).load();
  store = new StateStore(folder);
  running = undefined;
  page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  await page.route('**/*', (route) =>
    route.fulfill(
      route.request().url().endsWith('/media.webm')
        ? { contentType: 'video/webm', body: media }
        : { contentType: 'text/html; charset=utf-8', body: html },
    ),
  );
  await page.goto(address);
  await page.waitForFunction(() => document.querySelector('video')!.readyState >= 2);
});
afterEach(async () => {
  await engine?.pause();
  await running;
  await adapter?.dispose();
  await page?.context().close();
});
afterAll(async () => {
  await browser?.close();
  for (const directory of directories) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('stage3-native-'))
      throw new Error('REFUSE_OUTSIDE_TEST_TEMP');
    await rm(target, { recursive: true, force: true });
  }
});
async function setup(
  playing = true,
  granted = true,
  armingSignal = signal(),
  allowExistingFeedback = false,
) {
  if (playing) await page.locator('video').evaluate((video) => (video as HTMLVideoElement).play());
  const grant = createVerifiedPracticeGrant(join(folder, 'acceptance'), courseId, true);
  const backup = new TaskBackup(folder);
  engine = new TaskEngine({
    store,
    ...(granted ? { stage3VerifiedPractice: grant } : {}),
    stage2Capabilities: {
      enabled: true,
      inspect: (s) => adapter.inspect(s),
      backup: (s) => backup.create(s),
    },
  });
  adapter = await VerifiedZhihuishuPracticeAdapter.arm(page, grant, armingSignal, engine, {
    allowExistingFeedback,
  });
  await engine.browserConnected();
  await engine.confirmCourse(await adapter.inspect(signal()), courseId);
  expect((await engine.start()).ok).toBe(true);
  return grant;
}
function run(options = fixedRandom()) {
  const result = new PracticeSession(engine, adapter, undefined, options).run();
  running = result;
  return result;
}

describe('关闭退出动画与主动续播（合成页面，待真实环境人工验收）', () => {
  async function transition(kind: string, existing = false) {
    await page.evaluate(
      ({ kind, existing }) => {
        const popup = document.querySelector<HTMLElement>('.dialog-test')!;
        const footer = document.querySelector<HTMLElement>('.btn')!;
        const video = document.querySelector('video')!;
        const state = (
          window as unknown as {
            nativeFixture: { state: { closes: number; footerClicks: number } };
          }
        ).nativeFixture.state;
        const mask = document.createElement('div');
        mask.className = 'v-modal';
        mask.style.cssText = 'position:fixed;inset:0;pointer-events:none;background:rgba(0,0,0,.1)';
        document.body.append(mask);
        if (existing) {
          const outer = document.createElement('span');
          outer.innerHTML =
            '<span class="right" style="display:block">正确<i class="iconfont iconzhengque1"></i></span>';
          document.querySelector('.topic-title')!.append(outer);
          document.querySelector('.topic-item')!.classList.add('selected');
        }
        const originalPlay = video.play.bind(video);
        const observations = { restores: 0, restoredBeforeGone: false, goneAt: 0 };
        (window as unknown as { transitionProbe: typeof observations }).transitionProbe =
          observations;
        video.play = () => {
          observations.restores++;
          observations.restoredBeforeGone ||= !popup.hidden || mask.isConnected;
          return originalPlay();
        };
        footer.onclick = () => {
          state.footerClicks++;
          state.closes++;
          if (kind === 'never') return;
          if (kind === 'backdrop') popup.hidden = true;
          const hide = () => {
            popup.hidden = true;
          };
          setTimeout(hide, 180);
          setTimeout(
            () => {
              mask.remove();
              observations.goneAt = performance.now();
            },
            kind === 'staggered' ? 360 : 230,
          );
          if (kind === 'new-alert')
            setTimeout(() => {
              const e = document.createElement('div');
              e.setAttribute('role', 'alert');
              e.textContent = '新提示';
              document.body.append(e);
            }, 60);
          if (kind === 'new-dialog')
            setTimeout(() => {
              const e = document.createElement('div');
              e.setAttribute('role', 'dialog');
              e.textContent = '新弹窗';
              document.body.append(e);
            }, 60);
          if (kind === 'new-mask') setTimeout(() => document.body.append(mask.cloneNode(true)), 60);
          if (kind === 'replaced-popup')
            setTimeout(() => popup.replaceWith(popup.cloneNode(true)), 60);
          if (kind === 'lesson-change')
            setTimeout(() => {
              document.querySelector('#lessonOrder')!.textContent = '9.9';
            }, 60);
          if (kind === 'media-change')
            setTimeout(() => video.replaceWith(video.cloneNode(true)), 60);
        };
      },
      { kind, existing },
    );
  }

  it.each(['dialog', 'backdrop', 'staggered'])(
    '延迟关闭%s：只点一次，完全消失后续播',
    async (kind) => {
      await setup();
      await showBooleanClick();
      await transition(kind);
      expect(await run()).toMatchObject({
        ok: true,
        data: { attempts: 1, feedbackStatus: 'correct' },
      });
      expect(await counts()).toMatchObject({ submissions: 1, closes: 1, footerClicks: 1 });
      expect(
        await page.evaluate(
          () => (window as unknown as { transitionProbe: unknown }).transitionProbe,
        ),
      ).toMatchObject({ restores: 1, restoredBeforeGone: false });
      const first = await page
        .locator('video')
        .evaluate((v) => (v as HTMLVideoElement).currentTime);
      await expect
        .poll(() => page.locator('video').evaluate((v) => (v as HTMLVideoElement).currentTime))
        .toBeGreaterThan(first);
      expect((await store.load())!.pendingOperations.map((o) => [o.kind, o.status])).toEqual([
        ['practice-pause', 'completed'],
        ['practice-submit', 'completed'],
        ['practice-close', 'completed'],
        ['practice-restore', 'completed'],
      ]);
    },
  );

  it.each([true, false])('已有反馈且原播放=%s，延迟关闭不重复作答', async (playing) => {
    await setup(playing, true, signal(), true);
    await showBooleanClick();
    await transition('staggered', true);
    expect(await run()).toMatchObject({
      ok: true,
      code: 'PRACTICE_EXISTING_FEEDBACK_CLOSED',
      data: { attempts: 0 },
    });
    expect(await counts()).toMatchObject({ submissions: 0, closes: 1, footerClicks: 1 });
    expect(
      await page.evaluate(
        () => (window as unknown as { transitionProbe: unknown }).transitionProbe,
      ),
    ).toMatchObject({ restores: playing ? 1 : 0, restoredBeforeGone: false });
    expect(await page.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(
      !playing,
    );
  });

  it('新题错误反馈同样在关闭完成后续播', async () => {
    await setup();
    await showSingle('incorrect');
    await transition('backdrop');
    expect(await runSingle()).toMatchObject({
      ok: true,
      data: { attempts: 1, feedbackStatus: 'incorrect' },
    });
    expect(await counts()).toMatchObject({ submissions: 1, closes: 1 });
    expect(
      await page.evaluate(
        () => (window as unknown as { transitionProbe: unknown }).transitionProbe,
      ),
    ).toMatchObject({ restores: 1, restoredBeforeGone: false });
  });

  it.each([
    'never',
    'new-alert',
    'new-dialog',
    'new-mask',
    'replaced-popup',
    'lesson-change',
    'media-change',
  ])('关闭过渡%s停止且不重发或续播', async (kind) => {
    await setup();
    await showBooleanClick();
    await transition(kind);
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({ submissions: 1, closes: 1, footerClicks: 1 });
    expect(
      await page.evaluate(
        () => (window as unknown as { transitionProbe: unknown }).transitionProbe,
      ),
    ).toMatchObject({ restores: 0 });
    expect(
      (await store.load())!.pendingOperations.filter((o) => o.kind === 'practice-close'),
    ).toMatchObject([{ status: 'awaiting-confirmation' }]);
    expect((await store.load())!.pendingOperations.some((o) => o.kind === 'practice-restore')).toBe(
      false,
    );
  });

  it('退出动画期间取消，已发出的关闭不重发且不续播', async () => {
    await setup();
    await showBooleanClick();
    await transition('staggered');
    const result = run();
    await expect.poll(async () => (await counts()).closes).toBe(1);
    await engine.pause();
    expect((await result).ok).toBe(false);
    expect(await counts()).toMatchObject({ closes: 1, footerClicks: 1 });
    expect(
      await page.evaluate(
        () => (window as unknown as { transitionProbe: unknown }).transitionProbe,
      ),
    ).toMatchObject({ restores: 0 });
  });

  it('退出动画期间人工输入停止，不抢回播放', async () => {
    await setup();
    await showBooleanClick();
    await transition('staggered');
    const result = run();
    await expect.poll(async () => (await counts()).closes).toBe(1);
    await page.mouse.click(50, 35);
    expect((await result).ok).toBe(false);
    expect(await counts()).toMatchObject({ closes: 1, footerClicks: 1 });
    expect((await store.load())!.pendingOperations.some((o) => o.kind === 'practice-restore')).toBe(
      false,
    );
  });

  it('关闭确认后播放调用失败，仅调用一次且保留恢复待确认', async () => {
    await setup();
    await showBooleanClick();
    await transition('staggered');
    await page.evaluate(() => {
      const probe = (window as unknown as { transitionProbe: { restores: number } })
        .transitionProbe;
      document.querySelector('video')!.play = () => {
        probe.restores++;
        return Promise.reject(new Error('FIXTURE_PLAY_REFUSED'));
      };
    });
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({ closes: 1, footerClicks: 1 });
    expect(
      await page.evaluate(
        () => (window as unknown as { transitionProbe: unknown }).transitionProbe,
      ),
    ).toMatchObject({ restores: 1 });
    expect(
      (await store.load())!.pendingOperations
        .filter((o) => ['practice-close', 'practice-restore'].includes(o.kind))
        .map((o) => [o.kind, o.status]),
    ).toEqual([
      ['practice-close', 'completed'],
      ['practice-restore', 'awaiting-confirmation'],
    ]);
  });
});

const showSingle = (mode = 'correct') =>
  page.evaluate(
    (mode) =>
      (
        window as unknown as { nativeFixture: { showSingle(mode: string): void } }
      ).nativeFixture.showSingle(mode),
    mode,
  );
const runSingle = (options = fixedRandom(1)) => run(options);

describe('复验许可与自然弹题的原生核验衔接', () => {
  async function reviewSetup() {
    await page.evaluate(() => {
      const media = document.querySelector('video')!;
      const seconds = Math.round(media.duration);
      const duration = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
        .map((n) => String(n).padStart(2, '0'))
        .join(':');
      const list = document.createElement('ul');
      list.className = 'chapterScrollbar';
      list.innerHTML = `<li class="video current_play"><b class="hour">1.1</b><span class="catalogue_title">合成章节</span><i class="time_ico_half"></i><span class="time">${duration}</span></li>`;
      document.querySelector('.video-study')!.appendChild(list);
    });
    const raw = await page.evaluate(readZhihuishuDom, undefined);
    if (!raw) throw new Error('REVIEW_FIXTURE_INVALID');
    const monitor = new ZhihuishuMonitorSiteAdapter(page, [
      { courseId, catalogue: zhihuishuCatalogueKey(raw), completionMarkers: 'finish-half-v1' },
    ]);
    const old = {
      operationId: 'prior-submit',
      taskId: 'prior-task',
      kind: 'practice-submit',
      status: 'awaiting-confirmation' as const,
      savedAt: new Date().toISOString(),
    };
    await store.write({
      schemaVersion: 1,
      taskId: 'prior-task',
      courseId,
      chapterId: 'old-chapter',
      savedAt: new Date().toISOString(),
      state: 'PAUSED',
      pendingOperations: [old],
      confirmedPlatformStatuses: [],
    });
    const reviews = new ManualPracticeReviewStore(folder);
    const receipt = await reviews.record(
      (await reviews.preview()).snapshotDigest,
      'abandon-old-attempt-allow-one-fresh-task',
    );
    await page.locator('video').evaluate((video) => (video as HTMLVideoElement).play());
    let useNative = false;
    const authorization = await ManualPracticeReviewAuthorization.create(
      reviews,
      receipt.id,
      (s) => (useNative ? adapter.observeForReview(monitor, s) : monitor.observe(s)),
      signal(),
    );
    const grant = createVerifiedPracticeGrant(join(folder, 'review-acceptance'), courseId, true);
    const backup = new TaskBackup(folder);
    engine = new TaskEngine({
      store,
      stage3VerifiedPractice: grant,
      stage2Capabilities: {
        enabled: true,
        inspect: (s) => adapter.inspect(s),
        backup: (s) => backup.create(s),
      },
    });
    adapter = await VerifiedZhihuishuPracticeAdapter.arm(page, grant, signal(), engine);
    await engine.browserConnected();
    await engine.confirmCourse(await adapter.inspect(signal()), courseId);
    expect((await engine.startAfterManualPracticeReview(authorization)).ok).toBe(true);
    return {
      monitor,
      authorization,
      old,
      enable: () => {
        useNative = true;
      },
    };
  }
  it.each(['correct', 'incorrect'])(
    '通用观测复现拒绝，原生核验后%s反馈只作答一次并续播',
    async (mode) => {
      const f = await reviewSetup();
      await showSingle(mode);
      expect((await f.monitor.observe()).course.authenticated).toBe('unknown');
      await expect(f.authorization.verify(signal())).rejects.toThrow('REVIEW_CONTEXT_CHANGED');
      f.enable();
      await expect(f.authorization.verify(signal())).resolves.toBeUndefined();
      expect((await f.monitor.observe()).course.authenticated).toBe('unknown');
      const result = await runSingle();
      expect(result).toMatchObject({ ok: true, data: { attempts: 1, feedbackStatus: mode } });
      expect(await counts()).toMatchObject({ selections: 1, closes: 1 });
      const saved = (await store.load())!;
      expect(saved.pendingOperations[0]).toEqual(f.old);
      expect(saved.pendingOperations.slice(1).map((o) => o.status)).toEqual([
        'completed',
        'completed',
        'completed',
        'completed',
      ]);
      expect(
        await page.locator('video').evaluate((video) => (video as HTMLVideoElement).paused),
      ).toBe(false);
    },
  );
  it.each(['other-modal', 'lost-login', 'missing-note'])(
    '%s不获得练习核验，动作和新账本均为零',
    async (fault) => {
      const f = await reviewSetup();
      f.enable();
      await showSingle();
      await page.evaluate((fault) => {
        if (fault === 'lost-login') document.querySelector('.header_userInfo')!.remove();
        if (fault === 'missing-note')
          document.querySelector('.el-dialog__header p')!.textContent = '性质不明';
        if (fault === 'other-modal') {
          const node = document.createElement('div');
          node.setAttribute('role', 'dialog');
          node.textContent = 'another';
          document.body.appendChild(node);
        }
      }, fault);
      await expect(f.authorization.verify(signal())).rejects.toThrow();
      expect(await counts()).toMatchObject({ selections: 0, footerClicks: 0, closes: 0 });
      expect((await store.load())!.pendingOperations).toEqual([f.old]);
    },
  );
  it('两次通用读取间章节变化，原生弹题仍相同也拒绝', async () => {
    const f = await reviewSetup();
    await showSingle();
    let reads = 0;
    await expect(
      adapter.observeForReview(
        {
          observe: async (s) => {
            const sample = await f.monitor.observe(s);
            if (++reads === 2) sample.currentChapterId = 'other';
            return sample;
          },
        },
        signal(),
      ),
    ).rejects.toThrow('REVIEW_PRACTICE_CONTEXT_CHANGED');
    expect((await store.load())!.pendingOperations).toEqual([f.old]);
    expect((await counts()).selections).toBe(0);
  });
  it('无弹窗只返回通用观察，不授予任何原生练习性质', async () => {
    const f = await reviewSetup();
    const sample = await adapter.observeForReview(f.monitor, signal());
    expect(sample.popup).toBe('none');
    expect(sample.course.evidence).not.toContain('internal-single-use-candidate');
    expect((await store.load())!.pendingOperations).toEqual([f.old]);
  });
});
const showBooleanClick = (mode = 'correct') =>
  page.evaluate(
    (value) =>
      (
        window as unknown as { nativeFixture: { showBooleanClick(mode: string): void } }
      ).nativeFixture.showBooleanClick(value),
    mode,
  );
const decorateSingle = () =>
  page.evaluate(() =>
    (
      window as unknown as { nativeFixture: { decorateSingleWithSvg(): void } }
    ).nativeFixture.decorateSingleWithSvg(),
  );

describe('阶段3锁止诊断：原因可区分，停止与零重发门槛保持', () => {
  it('成功路径及正常清理不虚报故障', async () => {
    await setup();
    await showSingle();
    expect((await runSingle()).ok).toBe(true);
    expect(adapter.diagnostics()).toEqual({ stop: null, disposed: true });
  });
  it('子frame导航复现旧通用锁止，但明确记录CHILD_FRAME_NAVIGATED', async () => {
    await setup();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const frame = document.createElement('iframe');
          frame.addEventListener('load', () => resolve(), { once: true });
          frame.srcdoc = '<p>fixture-only-frame</p>';
          document.body.appendChild(frame);
        }),
    );
    await expect.poll(() => adapter.diagnostics().stop?.reason).toBe('CHILD_FRAME_NAVIGATED');
    await expect(adapter.context(signal())).rejects.toThrow('PRACTICE_LOCKED');
    expect((await counts()).submissions).toBe(0);
    expect((await store.load())!.pendingOperations).toHaveLength(0);
  });
  it('主frame导航与关闭分别记录，不吞成同一种未知来源', async () => {
    await setup();
    await page.reload();
    expect(adapter.diagnostics().stop?.reason).toBe('MAIN_FRAME_NAVIGATED');
    await page.close();
    await adapter.dispose();
    expect(adapter.diagnostics().stop?.reason).toBe('MAIN_FRAME_NAVIGATED');
    expect((await store.load())!.pendingOperations).toHaveLength(0);
  });
  it('页面关闭在清理后仍保留PAGE_CLOSED', async () => {
    await setup();
    await page.close();
    await adapter.dispose();
    expect(adapter.diagnostics().stop?.reason).toBe('PAGE_CLOSED');
  });
  it('受信任人工点击导致停止，诊断不保存目标文字', async () => {
    await setup();
    await page.locator('.source-name').click();
    await expect.poll(() => adapter.diagnostics().stop?.reason).toBe('PAGE_INPUT');
    expect(adapter.diagnostics().stop?.origin).toBe('page');
    await expect(adapter.context(signal())).rejects.toThrow('PRACTICE_LOCKED');
    expect((await counts()).submissions).toBe(0);
  });
  it.each([
    ['emptied', 'MEDIA_EMPTIED'],
    ['loadstart', 'MEDIA_LOADSTART'],
    ['ratechange', 'MEDIA_RATECHANGE'],
  ])('媒体%s原因明确，清理/暂停不能覆盖%s', async (event, reason) => {
    await setup();
    await page
      .locator('video')
      .evaluate((video, event) => video.dispatchEvent(new Event(event)), event);
    await expect.poll(() => adapter.diagnostics().stop?.reason).toBe(reason);
    await engine.pause();
    await adapter.dispose();
    expect(adapter.diagnostics().stop?.reason).toBe(reason);
    expect((await store.load())!.pendingOperations).toHaveLength(0);
  });
  it.each(['node', 'source', 'lesson'])('媒体/章节%s变化被区分，且不落盘媒体地址', async (what) => {
    await setup();
    await page.evaluate((what) => {
      const video = document.querySelector('video')!;
      if (what === 'node') video.replaceWith(video.cloneNode(true));
      else if (what === 'source') {
        Object.defineProperty(video, 'currentSrc', { value: 'sensitive-fixture-media-value' });
        document.querySelector('.video-study')!.appendChild(document.createElement('span'));
      } else document.querySelector('#lessonOrder')!.textContent = 'another-fixture-lesson';
    }, what);
    const reason = {
      node: 'MEDIA_NODE_CHANGED',
      source: 'MEDIA_SOURCE_CHANGED',
      lesson: 'LESSON_CHANGED',
    }[what];
    await expect.poll(() => adapter.diagnostics().stop?.reason).toBe(reason);
    expect(JSON.stringify(adapter.diagnostics())).not.toContain('sensitive-fixture-media-value');
    expect((await store.load())!.pendingOperations).toHaveLength(0);
  });
  it.each(['note', 'alert', 'media-count'])('DOM%s拒绝保留具体检查阶段', async (what) => {
    await setup();
    await showSingle();
    await page.evaluate((what) => {
      if (what === 'note')
        document.querySelector('.el-dialog__header p')!.textContent =
          'sensitive-fixture-question-value';
      else if (what === 'alert') {
        const alert = document.createElement('div');
        alert.setAttribute('role', 'alert');
        alert.textContent = 'private-fixture-alert';
        document.body.appendChild(alert);
      } else document.body.appendChild(document.createElement('video'));
    }, what);
    await expect(adapter.context(signal())).rejects.toThrow('NATIVE_PRACTICE_CONTEXT_CHANGED');
    const reason = {
      note: 'DOM_NOTE_CHECK',
      alert: 'DOM_ALERT_CHECK',
      'media-count': 'DOM_MEDIA_CHECK',
    }[what];
    expect(adapter.diagnostics().stop).toMatchObject({ reason, origin: 'dom', phase: 'sample' });
    await engine.pause();
    await adapter.dispose();
    const diagnostic = adapter.diagnostics();
    expect(diagnostic.stop?.reason).toBe(reason);
    expect(JSON.stringify(diagnostic)).not.toMatch(/sensitive-fixture|private-fixture/);
    expect((await counts()).submissions).toBe(0);
  });
  it('取消在前，后续清理保留SIGNAL_ABORTED', async () => {
    const controller = new AbortController();
    await setup(true, true, controller.signal);
    controller.abort();
    await adapter.dispose();
    expect(adapter.diagnostics().stop).toMatchObject({ reason: 'SIGNAL_ABORTED', origin: 'node' });
  });
  it('期限过期与人工输入可区分，不记录异常原文', async () => {
    const grant = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(grant.expiresAt + 1);
    try {
      await expect(adapter.context(signal())).rejects.toThrow('PRACTICE_LOCKED');
      expect(adapter.diagnostics().stop?.reason).toBe('GRANT_EXPIRED');
    } finally {
      vi.useRealTimers();
    }
  });
  it('绑定只接受枚举原因，返回快照不能篡改内部首次原因', async () => {
    await setup();
    await page.evaluate(async () => {
      const binding = Object.getOwnPropertyNames(window).find((name) =>
        /^stage3_[a-f0-9]+_manual$/.test(name),
      )!;
      await (window as unknown as Record<string, (value: unknown) => Promise<void>>)[binding]({
        reason: 'PAGE_INPUT',
        question: 'private-binding-payload',
      });
    });
    const copy = adapter.diagnostics();
    expect(copy.stop?.reason).toBe('PAGE_GUARD_INVALIDATED');
    copy.stop!.reason = 'PAGE_INPUT';
    expect(adapter.diagnostics().stop?.reason).toBe('PAGE_GUARD_INVALIDATED');
    expect(JSON.stringify(adapter.diagnostics())).not.toContain('private-binding-payload');
  });
});

describe('阶段3真实结构派生候选（HTTPS全部拦截，不代表真实站点验收）', () => {
  it.each(['【判断题】【单选题】', '这是判断题吗', '2.【判断题】'])(
    '不完整或矛盾题型标记%s零提交',
    async (marker) => {
      await setup();
      await show();
      await page
        .locator('.title-tit')
        .evaluate((element, text) => (element.textContent = text), marker);
      expect((await run()).ok).toBe(false);
      expect((await counts()).submissions).toBe(0);
    },
  );
  it('反馈延迟只等待原提交，不重发；随后验证关闭和恢复', async () => {
    await setup();
    await show('delayed');
    expect((await run()).ok).toBe(true);
    expect(await counts()).toMatchObject({ submissions: 1, closes: 1 });
  });
  it('已提交后等待反馈时暂停，保留未知且迟到反馈不会关闭或恢复', async () => {
    await setup();
    await show('pending');
    const result = run();
    await expect.poll(async () => (await counts()).submissions).toBe(1);
    const old = engine.signal;
    const pausing = engine.pause();
    expect(old.aborted).toBe(true);
    await pausing;
    expect((await result).ok).toBe(false);
    expect(await counts()).toMatchObject({ submissions: 1, closes: 0 });
    expect(
      (await store.load())!.pendingOperations.some(
        (op) => op.kind === 'practice-submit' && op.status === 'awaiting-confirmation',
      ),
    ).toBe(true);
  });
  it.each(['question', 'scope'])('选项处理器同步改变%s时禁止后续提交', async (what) => {
    await setup();
    await show();
    await page
      .locator('.topic-item')
      .first()
      .evaluate((element, what) => {
        element.addEventListener('click', () => {
          const target = document.querySelector(
            what === 'question' ? '.topic-title > span:last-child' : '.el-dialog__header p',
          )!;
          target.textContent = '选项处理器同步改变的内容';
        });
      }, what);
    expect((await run()).ok).toBe(false);
    expect((await counts()).submissions).toBe(0);
    expect(
      (await store.load())!.pendingOperations.some(
        (op) => op.kind === 'practice-submit' && op.status === 'awaiting-confirmation',
      ),
    ).toBe(true);
  });
  it('默认真实工厂仍锁止', () => {
    expect(practiceAdapterForPage(page).kind).toBe('real-unverified');
  });
  it('真实来源+四步账本完成一次；站点关闭不续播时按原播放状态受控恢复', async () => {
    await setup();
    await show();
    const result = await run();
    expect(result.ok).toBe(true);
    expect(await counts()).toMatchObject({ submissions: 1, closes: 1 });
    expect(
      await page.locator('video').evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(false);
    const snapshot = (await store.load())!;
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.pendingOperations.map((op) => [op.kind, op.status])).toEqual([
      ['practice-pause', 'completed'],
      ['practice-submit', 'completed'],
      ['practice-close', 'completed'],
      ['practice-restore', 'completed'],
    ]);
    expect(new Set(snapshot.pendingOperations.map((op) => op.operationId)).size).toBe(4);
    expect(await readFile(store.snapshotPath, 'utf8')).not.toMatch(
      /植物|optionIds|correctTexts|对|错/,
    );
    expect(
      await page.evaluate(() =>
        Object.keys(window).filter(
          (key) => key.startsWith('stage3_') || key === 'stage3NativePracticeOwner',
        ),
      ),
    ).toEqual([]);
  });
  it('原先暂停不抢播；随机选择保持页面单字原文', async () => {
    await setup(false);
    await show();
    expect((await run()).ok).toBe(true);
    expect((await store.load())!.pendingOperations.map((op) => op.kind)).toEqual([
      'practice-submit',
      'practice-close',
    ]);
    expect(
      await page.locator('video').evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(true);
  });
  it('无真实任务授权则零OCR零随机选择零提交', async () => {
    await setup(true, false);
    await show();
    const selection = fixedRandom(),
      lookup = vi.spyOn(selection, 'randomIndex');
    expect((await run(selection)).ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect((await counts()).submissions).toBe(0);
  });
  it('直接调用适配器不能绕过任务引擎的已落盘issue', async () => {
    await setup();
    await show();
    await expect(
      adapter.perform(
        { type: 'submit', optionIds: ['A'], submissionId: 'unrecorded' },
        await adapter.context(signal()),
        await adapter.video(signal()),
        signal(),
      ),
    ).rejects.toThrow('PRACTICE_LOCKED');
    expect((await counts()).submissions).toBe(0);
  });
  it.each(['正式考试', '计分作业', '未知页面'])('说明替换成%s时零选择零提交', async (text) => {
    await setup();
    await show();
    await page
      .locator('.el-dialog__header p')
      .evaluate((el, text) => (el.textContent = text), text);
    const selection = fixedRandom(),
      lookup = vi.spyOn(selection, 'randomIndex');
    expect((await run(selection)).ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect((await counts()).submissions).toBe(0);
  });
  it('读取题目后题干变化阻断随机提交', async () => {
    await setup();
    await show();
    const question = adapter.question.bind(adapter);
    vi.spyOn(adapter, 'question').mockImplementation(async (signal) => {
      const value = await question(signal);
      await page.locator('.title-tit').evaluate((el) => {
        el.nextElementSibling!.textContent = '运行途中改变的完整题干';
      });
      return value;
    });
    try {
      expect((await run()).ok).toBe(false);
      expect((await counts()).submissions).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('意图保存后最后一刻DOM变化仍零提交并保留未知，不重试', async () => {
    await setup();
    await show();
    const original = store.write.bind(store);
    let changed = false;
    vi.spyOn(store, 'write').mockImplementation(async (input) => {
      const saved = await original(input);
      if (
        !changed &&
        input.pendingOperations.some(
          (op) => op.kind === 'practice-submit' && op.status === 'executing',
        )
      ) {
        changed = true;
        await page
          .locator('.item-topic')
          .first()
          .evaluate((el) => (el.textContent = '未知'));
      }
      return saved;
    });
    expect((await run()).ok).toBe(false);
    expect((await counts()).submissions).toBe(0);
    expect(
      (await store.load())!.pendingOperations.some(
        (op) => op.kind === 'practice-submit' && op.status === 'awaiting-confirmation',
      ),
    ).toBe(true);
  });
  it.each(['unknown', 'invalid-feedback'])(
    '提交后%s反馈不伪造回执或纠正，重建仍锁止',
    async (mode) => {
      const grant = await setup();
      await show(mode);
      expect((await run()).ok).toBe(false);
      expect(await counts()).toMatchObject({ submissions: 1, closes: 0 });
      const snapshot = (await store.load())!;
      expect(
        snapshot.pendingOperations.some(
          (op) => op.kind === 'practice-submit' && op.status === 'awaiting-confirmation',
        ),
      ).toBe(true);
      const restarted = new TaskEngine({
        store: new StateStore(folder),
        stage3VerifiedPractice: grant,
        stage2Capabilities: {
          enabled: true,
          inspect: async () => {
            throw new Error('must not inspect');
          },
          backup: async () => true,
        },
      });
      await restarted.browserConnected();
      await restarted.confirmCourse(
        {
          source: 'zhihuishu-dom',
          courseId,
          title: '合成课程',
          authenticated: true,
          pageKind: 'course',
          confidence: 'verified',
          platformCompleted: null,
          evidence: ['fixture'],
          observedAt: new Date().toISOString(),
        },
        courseId,
      );
      expect((await restarted.start()).code).toBe('UNCONFIRMED_OPERATION');
      expect((await counts()).submissions).toBe(1);
    },
  );
  it('用户关键输入取消题目等待，迟到结果不提交并清理监听', async () => {
    await setup();
    await show();
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        reached = r;
      }),
      wait = new Promise<void>((r) => {
        release = r;
      });
    const question = adapter.question.bind(adapter);
    vi.spyOn(adapter, 'question').mockImplementation(async (signal) => {
      const value = await question(signal);
      reached();
      await wait;
      return value;
    });
    try {
      const result = run();
      await ready;
      await page.mouse.click(50, 35);
      expect((await result).ok).toBe(false);
      release();
      expect(engine.signal.aborted).toBe(true);
      expect((await counts()).submissions).toBe(0);
    } finally {
      release?.();
      vi.restoreAllMocks();
    }
  });
  it('同一授权跨引擎不可复用，exclusive claim保留', async () => {
    const grant = await setup();
    await show();
    expect((await run()).ok).toBe(true);
    expect(await grant.claim(signal())).toBe(false);
    expect(await readFile(join(folder, 'acceptance', 'practice-claim.json'), 'utf8')).not.toMatch(
      /植物|答案|optionIds/,
    );
  });
  it('已出现弹窗时不能推测此前播放状态并补arm', async () => {
    await show();
    const grant = createVerifiedPracticeGrant(join(folder, 'late-arm'), courseId, true);
    const disabled = new TaskEngine({ store });
    await expect(
      VerifiedZhihuishuPracticeAdapter.arm(page, grant, signal(), disabled),
    ).rejects.toThrow();
    expect((await counts()).submissions).toBe(0);
  });
  it('DOM隐藏认证头部也不能继续提交', async () => {
    await setup();
    await show();
    await page.locator('.header_userInfo').evaluate((el) => el.setAttribute('hidden', ''));
    expect((await run()).ok).toBe(false);
    expect((await counts()).submissions).toBe(0);
  });
  it('读取题目后媒体节点替换，不向新媒体恢复或提交', async () => {
    await setup();
    await show();
    const question = adapter.question.bind(adapter);
    vi.spyOn(adapter, 'question').mockImplementation(async (signal) => {
      const value = await question(signal);
      await page.locator('video').evaluate((video) => video.replaceWith(video.cloneNode(true)));
      return value;
    });
    try {
      expect((await run()).ok).toBe(false);
      expect((await counts()).submissions).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('授权在关键落盘等待中过期，最终issue不发网页动作', async () => {
    const grant = await setup();
    await show();
    const original = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (input) => {
      const saved = await original(input);
      if (
        input.pendingOperations.some(
          (op) => op.kind === 'practice-submit' && op.status === 'executing',
        )
      )
        vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt + 1);
      return saved;
    });
    try {
      expect((await run()).ok).toBe(false);
      expect((await counts()).submissions).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('关闭落盘期间用户输入取消，禁止后续恢复抢播', async () => {
    await setup();
    await show();
    const original = store.write.bind(store);
    let manual = false;
    vi.spyOn(store, 'write').mockImplementation(async (input) => {
      const saved = await original(input);
      if (
        !manual &&
        input.pendingOperations.some(
          (op) => op.kind === 'practice-close' && op.status === 'completed',
        )
      ) {
        manual = true;
        await page.mouse.click(50, 35);
      }
      return saved;
    });
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({ submissions: 1, closes: 1 });
    expect(
      (await store.load())!.pendingOperations.some((op) => op.kind === 'practice-restore'),
    ).toBe(false);
    expect(
      await page.locator('video').evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(true);
  });
});

describe('阶段3判断题初始关闭即反馈（合成内容，待真实环境人工验收）', () => {
  it.each(['plain', 'svg', 'full-width-zero-height'])(
    '判断题初始关闭%s：落盘后只点一次，再独立关闭恢复',
    async (variant) => {
      await setup();
      await showBooleanClick();
      if (variant !== 'plain') await decorateSingle();
      if (variant === 'full-width-zero-height')
        await page.locator('.topic-item > div:first-child').evaluateAll((slots) => {
          for (const slot of slots) (slot as HTMLElement).style.width = '100%';
        });
      const perform = adapter.perform.bind(adapter);
      vi.spyOn(adapter, 'perform').mockImplementation(async (action, ...args) => {
        if (action.type === 'submit') {
          const op = (await store.load())!.pendingOperations.at(-1)!;
          expect(op).toMatchObject({
            kind: 'practice-submit',
            status: 'executing',
            operationId: action.submissionId,
          });
          expect(await counts()).toMatchObject({ selections: 0, submissions: 0, footerClicks: 0 });
        }
        await perform(action, ...args);
      });
      try {
        expect((await run()).ok).toBe(true);
        expect(await counts()).toMatchObject({
          selections: 1,
          submissions: 1,
          footerClicks: 1,
          closes: 1,
        });
        expect((await store.load())!.pendingOperations.map((o) => [o.kind, o.status])).toEqual([
          ['practice-pause', 'completed'],
          ['practice-submit', 'completed'],
          ['practice-close', 'completed'],
          ['practice-restore', 'completed'],
        ]);
        expect(await page.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(
          false,
        );
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
  it('判断题初始关闭：原来暂停则不恢复播放', async () => {
    await setup(false);
    await showBooleanClick();
    await decorateSingle();
    expect((await run()).ok).toBe(true);
    expect(await counts()).toMatchObject({ selections: 1, submissions: 1, closes: 1 });
    expect((await store.load())!.pendingOperations.some((o) => o.kind === 'practice-restore')).toBe(
      false,
    );
    expect(await page.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(true);
  });
  it('判断题初始关闭：异步反馈只等待一次选择，不把关闭按钮当提交', async () => {
    await setup();
    await showBooleanClick('delayed');
    await decorateSingle();
    expect((await run()).ok).toBe(true);
    expect(await counts()).toMatchObject({
      selections: 1,
      submissions: 1,
      footerClicks: 1,
      closes: 1,
    });
  });
  it.each(['unknown', 'invalid-feedback'])(
    '判断题初始关闭%s：保留未知且不重发、不关闭、不恢复',
    async (mode) => {
      await setup();
      await showBooleanClick(mode);
      await decorateSingle();
      const result = await run();
      expect(result.ok).toBe(false);
      expect(await counts()).toMatchObject({
        selections: 1,
        submissions: 1,
        footerClicks: 0,
        closes: 0,
      });
      expect(
        (await store.load())!.pendingOperations.some(
          (o) => o.kind === 'practice-submit' && o.status === 'awaiting-confirmation',
        ),
      ).toBe(true);
      expect((await run()).ok).toBe(false);
      expect((await counts()).submissions).toBe(1);
    },
  );
  it.each(['selected', 'feedback', 'unsupported-text', 'unknown-svg', 'visible-svg'])(
    '判断题初始关闭%s：拒绝旧状态或未知结构，零随机选择零点击',
    async (kind) => {
      await setup();
      await showBooleanClick();
      await decorateSingle();
      await page.evaluate((kind) => {
        const first = document.querySelector('.topic-item')!;
        if (kind === 'selected') first.setAttribute('aria-selected', 'true');
        if (kind === 'feedback')
          document
            .querySelector('.topic-title')!
            .append(Object.assign(document.createElement('span'), { className: 'wrong' }));
        if (kind === 'unsupported-text') first.querySelector('.item-topic')!.textContent = '是';
        if (kind === 'unknown-svg')
          first
            .querySelector('use')!
            .setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#iconyixuan');
        if (kind === 'visible-svg')
          (first.firstElementChild as HTMLElement).style.cssText = 'width:20px;height:20px';
      }, kind);
      const selection = fixedRandom(),
        spy = vi.spyOn(selection, 'randomIndex');
      try {
        expect((await run(selection)).ok).toBe(false);
        expect(spy).not.toHaveBeenCalled();
        expect(await counts()).toMatchObject({ selections: 0, submissions: 0, footerClicks: 0 });
      } finally {
        spy.mockRestore();
      }
    },
  );
  it('判断题初始关闭：提交落盘后SVG状态变化，最终issue零点击且未知账本保留', async () => {
    await setup();
    await showBooleanClick();
    await decorateSingle();
    const write = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (input) => {
      const saved = await write(input);
      if (
        input.pendingOperations.some(
          (o) => o.kind === 'practice-submit' && o.status === 'executing',
        )
      )
        await page
          .locator('.topic-item use')
          .first()
          .evaluate((use) =>
            use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#iconyixuan'),
          );
      return saved;
    });
    try {
      expect((await run()).ok).toBe(false);
      expect(await counts()).toMatchObject({ selections: 0, submissions: 0, footerClicks: 0 });
      expect(
        (await store.load())!.pendingOperations.some(
          (o) => o.kind === 'practice-submit' && o.status === 'awaiting-confirmation',
        ),
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('判断题初始关闭：选择后课程说明变化，不接受该反馈或关闭', async () => {
    await setup();
    await showBooleanClick();
    await decorateSingle();
    await page
      .locator('.topic-item')
      .first()
      .evaluate((item) =>
        item.addEventListener('click', () => {
          document.querySelector('.el-dialog__header p')!.textContent = '未知课程规则';
        }),
      );
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({
      selections: 1,
      submissions: 1,
      footerClicks: 0,
      closes: 0,
    });
    expect(
      (await store.load())!.pendingOperations.some(
        (o) => o.kind === 'practice-submit' && o.status === 'awaiting-confirmation',
      ),
    ).toBe(true);
  });
  it('判断题初始关闭：读取等待时人工操作取消，零选择', async () => {
    await setup();
    await showBooleanClick();
    await decorateSingle();
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        reached = r;
      }),
      wait = new Promise<void>((r) => {
        release = r;
      });
    const question = adapter.question.bind(adapter);
    vi.spyOn(adapter, 'question').mockImplementation(async (signal) => {
      const value = await question(signal);
      reached();
      await wait;
      return value;
    });
    try {
      const result = run();
      await ready;
      await page.mouse.click(50, 35);
      expect((await result).ok).toBe(false);
      release();
      expect(await counts()).toMatchObject({ selections: 0, submissions: 0, footerClicks: 0 });
    } finally {
      release?.();
      vi.restoreAllMocks();
    }
  });
});

describe('阶段3普通浏览器点击（合成内容，待真实环境人工验收）', () => {
  it('只接受可信鼠标事件的判断练习：一次作答、错误反馈、独立关闭并续播', async () => {
    await setup();
    await showBooleanClick('incorrect');
    await page.evaluate(() => {
      const fixture = (window as unknown as { nativeFixture: { state: Record<string, number> } })
        .nativeFixture;
      fixture.state.trustedOptions = 0;
      fixture.state.trustedFooters = 0;
      fixture.state.ignoredSyntheticClicks = 0;
      for (const target of document.querySelectorAll<HTMLElement>(
        '.topic-item,.el-dialog__footer .btn',
      )) {
        const original = target.onclick;
        target.onclick = function (event) {
          if (!event.isTrusted) {
            fixture.state.ignoredSyntheticClicks++;
            return;
          }
          if (target.matches('.topic-item')) fixture.state.trustedOptions++;
          else fixture.state.trustedFooters++;
          return original?.call(this, event);
        };
      }
    });
    expect(await run()).toMatchObject({
      ok: true,
      data: { attempts: 1, feedbackStatus: 'incorrect' },
    });
    expect(await counts()).toMatchObject({
      submissions: 1,
      closes: 1,
      trustedOptions: 1,
      trustedFooters: 1,
      ignoredSyntheticClicks: 0,
    });
    expect((await store.load())!.pendingOperations.every((op) => op.status === 'completed')).toBe(
      true,
    );
    expect(await page.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(false);
  });
  it.each(['single', 'boolean', 'legacy-submit'])(
    '浏览器输入%s已落盘且仅一次选项/页脚，无合成点击回退',
    async (mode) => {
      await setup();
      if (mode === 'single') await showSingle();
      else if (mode === 'boolean') await showBooleanClick();
      else await show();
      await page.evaluate(() => {
        const state = (window as unknown as { nativeFixture: { state: Record<string, unknown> } })
          .nativeFixture.state;
        state.inputEvents = [];
        document.addEventListener(
          'click',
          (event) => {
            if (!(event.target instanceof Element) || !event.target.closest('.dialog-test')) return;
            (state.inputEvents as boolean[]).push(event.isTrusted);
          },
          true,
        );
      });
      const issued: string[] = [];
      const original = adapter.perform.bind(adapter);
      vi.spyOn(adapter, 'perform').mockImplementation(async (action, context, video, signal) => {
        if (action.type === 'submit' || action.type === 'close') {
          const snapshot = await store.load();
          expect(snapshot!.pendingOperations.at(-1)).toMatchObject({
            kind: `practice-${action.type}`,
            status: 'executing',
          });
          issued.push(action.type);
        }
        return original(action, context, video, signal);
      });
      try {
        expect((await (mode === 'single' ? runSingle() : run())).ok).toBe(true);
        expect(issued).toEqual(['submit', 'close']);
        expect(await counts()).toMatchObject({
          submissions: 1,
          closes: 1,
          inputEvents: mode === 'legacy-submit' ? [true, true, true] : [true, true],
        });
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
  it.each(['note', 'replace-target'])(
    'pointerdown后%s变化在click处理器前阻断，不选择或关闭',
    async (kind) => {
      await setup();
      await showBooleanClick();
      await page
        .locator('.topic-item')
        .first()
        .evaluate((item, kind) => {
          item.addEventListener(
            'pointerdown',
            () => {
              if (kind === 'note')
                document.querySelector('.el-dialog__header p')!.textContent = '本次练习计入成绩';
              else {
                const replacement = item.cloneNode(true) as HTMLElement;
                replacement.onclick = () => {
                  (window as unknown as { nativeFixture: { state: { selections: number } } })
                    .nativeFixture.state.selections++;
                };
                item.replaceWith(replacement);
              }
            },
            { once: true },
          );
        }, kind);
      expect((await run()).ok).toBe(false);
      expect(await counts()).toMatchObject({ selections: 0, submissions: 0, closes: 0 });
      expect((await store.load())!.pendingOperations.at(-1)?.status).toBe('awaiting-confirmation');
    },
  );
  it.each(['pause', 'manual-key', 'expired', 'grant-timer'])(
    '浏览器等待遮挡期间%s：迟到命令零效果，保留未知且不回退',
    async (kind) => {
      if (kind === 'grant-timer')
        await page.evaluate(() => {
          const original = window.setTimeout;
          window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
            if (typeof handler === 'function' && (delay ?? 0) > 500000)
              (window as unknown as { expirePracticeTest: () => void }).expirePracticeTest =
                handler as () => void;
            return original(handler, delay, ...args);
          }) as typeof window.setTimeout;
        });
      await setup();
      await showBooleanClick();
      await page.evaluate(() => {
        const box = document.createElement('div');
        box.id = 'input-blocker';
        box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent';
        document.body.append(box);
        const root = document.querySelector<HTMLElement>('.video-study')!;
        root.tabIndex = 0;
        root.focus();
      });
      const result = run();
      await page.waitForFunction(() =>
        Object.keys(window).some((key) => {
          if (!/^stage3_/.test(key)) return false;
          const state = (window as unknown as Record<string, { input?: { part?: string } }>)[key];
          return state?.input?.part === 'option';
        }),
      );
      await vi.waitFor(
        () =>
          expect(
            (adapter as unknown as { nativeCommand?: Promise<void> }).nativeCommand,
          ).toBeDefined(),
        { timeout: 1000 },
      );
      if (kind === 'pause') await engine.pause();
      else if (kind === 'manual-key') await page.keyboard.press('Enter');
      else if (kind === 'grant-timer')
        await page.evaluate(() =>
          (window as unknown as { expirePracticeTest: () => void }).expirePracticeTest(),
        );
      else
        await page.evaluate(() => {
          for (const key of Object.keys(window).filter((key) => /^stage3_/.test(key))) {
            const state = (window as unknown as Record<string, { input?: { expiresAt: number } }>)[
              key
            ];
            if (state?.input) state.input.expiresAt = performance.now() - 1;
          }
        });
      await page.locator('#input-blocker').evaluate((e) => e.remove());
      expect((await result).ok).toBe(false);
      await adapter.dispose();
      expect(await counts()).toMatchObject({ selections: 0, submissions: 0, closes: 0 });
      expect((await store.load())!.pendingOperations.at(-1)?.status).toBe('awaiting-confirmation');
    },
  );
});

describe('阶段3随机答错也关闭（合成内容，待真实环境人工验收）', () => {
  it.each(['submit', 'boolean-click', 'single-click'])(
    '已确认错误反馈%s只作答一次并关闭续播，不纠错',
    async (mode) => {
      await setup();
      if (mode === 'single-click') await showSingle('incorrect');
      else if (mode === 'boolean-click') await showBooleanClick('incorrect');
      else await show('incorrect');
      const result = mode === 'single-click' ? await runSingle() : await run();
      expect(result).toMatchObject({
        ok: true,
        data: { strategy: 'random', attempts: 1, feedbackStatus: 'incorrect' },
      });
      expect(await counts()).toMatchObject({ submissions: 1, closes: 1 });
      const operations = (await store.load())!.pendingOperations;
      expect(operations.every((op) => op.status === 'completed')).toBe(true);
      expect(operations.some((op) => op.kind === 'practice-correct')).toBe(false);
      expect(await page.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(
        false,
      );
    },
  );
});

describe('阶段3错误反馈也须精确验证（合成内容，待真实环境人工验收）', () => {
  it.each(['label', 'class', 'hidden', 'duplicate', 'mixed', 'disabled', 'alert'])(
    '错误反馈%s变化仍保留未知，不关闭续播',
    async (kind) => {
      await setup();
      await showSingle('incorrect');
      await page
        .locator('.topic-item')
        .nth(1)
        .evaluate(
          (item, kind) =>
            item.addEventListener('click', () => {
              const icon = document.querySelector('.topic-title i.iconcuowu1')!,
                marker = icon.parentElement!;
              if (kind === 'label') marker.firstChild!.textContent = '未知结果';
              if (kind === 'class') icon.classList.add('unknown');
              if (kind === 'hidden') (icon as HTMLElement).style.visibility = 'hidden';
              if (kind === 'duplicate') marker.append(icon.cloneNode(true));
              if (kind === 'mixed') {
                const known = document.createElement('span');
                known.className = 'right';
                const right = document.createElement('i');
                right.className = 'iconzhengque1';
                known.append(right);
                document.querySelector('.topic-title')!.append(known);
              }
              if (kind === 'disabled')
                document.querySelector('.el-dialog__footer .btn')!.setAttribute('disabled', '');
              if (kind === 'alert') {
                const alert = document.createElement('div');
                alert.setAttribute('role', 'alert');
                alert.textContent = '需要人工检查';
                document.body.append(alert);
              }
            }),
          kind,
        );
      expect((await runSingle()).ok).toBe(false);
      expect(await counts()).toMatchObject({
        selections: 1,
        submissions: 1,
        footerClicks: 0,
        closes: 0,
      });
      expect(
        (await store.load())!.pendingOperations.some(
          (op) => op.kind === 'practice-submit' && op.status === 'awaiting-confirmation',
        ),
      ).toBe(true);
    },
  );
  it('初始已存在已知错误反馈也不能冒充本次作答回执', async () => {
    await setup();
    await showSingle();
    await page.locator('.topic-title').evaluate((title) => {
      const marker = document.createElement('span');
      marker.textContent = '错误';
      const icon = document.createElement('i');
      icon.className = 'iconfont iconcuowu1';
      marker.append(icon);
      title.prepend(marker);
    });
    expect((await runSingle()).ok).toBe(false);
    expect(await counts()).toMatchObject({ selections: 0, submissions: 0, footerClicks: 0 });
  });
});

describe('9.1.1嵌套错误反馈（合成内容，待真实环境人工验收）', () => {
  async function nestedFeedback(kind = 'known', single = false) {
    await setup();
    if (single) await showSingle('incorrect');
    else await showBooleanClick('incorrect');
    await page
      .locator('.topic-item')
      .nth(single ? 1 : 0)
      .evaluate((item, kind) => {
        item.addEventListener('click', () => {
          const icon = document.querySelector('.topic-title i.iconcuowu1')!;
          const outer = icon.parentElement!;
          const inner = document.createElement('span');
          inner.className = 'error';
          inner.style.display = 'block';
          inner.append(...outer.childNodes);
          outer.append(inner);
          if (kind === 'outer-class') outer.className = 'unknown';
          if (kind === 'inner-class') inner.classList.add('unknown');
          if (kind === 'inner-tag') {
            const replacement = document.createElement('div');
            replacement.className = 'error';
            replacement.append(...inner.childNodes);
            inner.replaceWith(replacement);
          }
          if (kind === 'extra-depth') {
            const extra = document.createElement('span');
            extra.append(...inner.childNodes);
            inner.append(extra);
          }
          if (kind === 'duplicate') inner.append(icon.cloneNode(true));
          if (kind === 'outer-text') outer.append('需人工确认');
          if (kind === 'inner-text') inner.prepend('未确认');
          if (kind === 'hidden-inner') inner.style.visibility = 'hidden';
          if (kind === 'hidden-icon') (icon as HTMLElement).style.opacity = '0';
          if (kind === 'extra-child') inner.append(document.createElement('b'));
          if (kind === 'disabled') document.querySelector('.btn')!.setAttribute('disabled', '');
          if (kind === 'loading') {
            const loading = document.createElement('div');
            loading.className = 'el-loading-mask';
            loading.textContent = '加载中';
            document.querySelector('.el-dialog__body')!.append(loading);
          }
          if (kind === 'mixed') {
            const extra = document.createElement('span');
            extra.className = 'right';
            const rightIcon = document.createElement('i');
            rightIcon.className = 'iconzhengque1';
            extra.append(rightIcon);
            document.querySelector('.topic-title')!.append(extra);
          }
        });
      }, kind);
  }

  it.each(['boolean', 'single'])('精确嵌套错误反馈%s只作答一次后关闭续播', async (type) => {
    await nestedFeedback('known', type === 'single');
    const result = type === 'single' ? await runSingle() : await run();
    expect(result).toMatchObject({ ok: true, data: { attempts: 1, feedbackStatus: 'incorrect' } });
    expect(await counts()).toMatchObject({
      selections: 1,
      submissions: 1,
      footerClicks: 1,
      closes: 1,
    });
    expect((await store.load())!.pendingOperations.map((op) => [op.kind, op.status])).toEqual([
      ['practice-pause', 'completed'],
      ['practice-submit', 'completed'],
      ['practice-close', 'completed'],
      ['practice-restore', 'completed'],
    ]);
    expect(
      await page.locator('video').evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(false);
  });

  it.each([
    'outer-class',
    'inner-class',
    'inner-tag',
    'extra-depth',
    'duplicate',
    'outer-text',
    'inner-text',
    'hidden-inner',
    'hidden-icon',
    'extra-child',
    'disabled',
    'loading',
    'mixed',
  ])('嵌套反馈%s仍保留待确认且不关闭', async (kind) => {
    await nestedFeedback(kind);
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({
      selections: 1,
      submissions: 1,
      footerClicks: 0,
      closes: 0,
    });
    expect((await store.load())!.pendingOperations.at(-1)).toMatchObject({
      kind: 'practice-submit',
      status: 'awaiting-confirmation',
    });
  });

  it('已存在嵌套错误反馈不能冒充本次回执', async () => {
    await setup();
    await showBooleanClick('incorrect');
    await page.locator('.topic-title').evaluate((title) => {
      const outer = document.createElement('span'),
        inner = document.createElement('span'),
        icon = document.createElement('i');
      inner.className = 'error';
      inner.style.display = 'block';
      icon.className = 'iconfont iconcuowu1';
      inner.append('错误', icon);
      outer.append(inner);
      title.append(outer);
    });
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({
      selections: 0,
      submissions: 0,
      footerClicks: 0,
      closes: 0,
    });
  });
});

describe('阶段3现场SVG占位与题目截图边界（合成内容，待真实环境人工验收）', () => {
  it('已知零尺寸SVG前缀与body内关闭页脚：仍只选择一次并独立关闭恢复', async () => {
    await setup();
    await showSingle();
    await decorateSingle();
    expect((await runSingle()).ok).toBe(true);
    expect(await counts()).toMatchObject({
      selections: 1,
      submissions: 1,
      footerClicks: 1,
      closes: 1,
    });
  });
  it.each([
    'selected-icon',
    'external-icon',
    'missing-icon',
    'wrapper-text',
    'extra-child',
    'aria-visible',
    'visible-slot',
    'nonzero-invisible-slot',
  ])('未知或有状态的SVG结构%s：零随机选择零选择', async (kind) => {
    await setup();
    await showSingle();
    await decorateSingle();
    await page
      .locator('.topic-item')
      .first()
      .evaluate((item, kind) => {
        const slot = item.firstElementChild as HTMLElement;
        const svg = slot.querySelector('svg')!,
          use = svg.querySelector('use')!;
        if (kind === 'selected-icon')
          use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#iconyixuan');
        if (kind === 'external-icon')
          use.setAttributeNS(
            'http://www.w3.org/1999/xlink',
            'xlink:href',
            'https://icons.example/icon.svg#iconxuan',
          );
        if (kind === 'missing-icon') use.remove();
        if (kind === 'wrapper-text') slot.append('未知状态');
        if (kind === 'extra-child') slot.append(document.createElement('span'));
        if (kind === 'aria-visible') svg.setAttribute('aria-hidden', 'false');
        if (kind === 'visible-slot') slot.style.cssText = 'width:20px;height:20px';
        if (kind === 'nonzero-invisible-slot')
          slot.style.cssText = 'width:20px;height:20px;opacity:0';
      }, kind);
    const selection = fixedRandom(1),
      spy = vi.spyOn(selection, 'randomIndex');
    try {
      expect((await runSingle(selection)).ok).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(await counts()).toMatchObject({ selections: 0, submissions: 0, footerClicks: 0 });
    } finally {
      spy.mockRestore();
    }
  });
  it('提交落盘期间SVG变为未知图标，最终issue零选择', async () => {
    await setup();
    await showSingle();
    await decorateSingle();
    const original = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (input) => {
      const saved = await original(input);
      if (
        input.pendingOperations.some(
          (o) => o.kind === 'practice-submit' && o.status === 'executing',
        )
      )
        await page
          .locator('.topic-item use')
          .first()
          .evaluate((use) =>
            use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#iconyixuan'),
          );
      return saved;
    });
    try {
      expect((await runSingle()).ok).toBe(false);
      expect(await counts()).toMatchObject({ selections: 0, submissions: 0, footerClicks: 0 });
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('关闭页脚覆盖题目并集时拒绝截图，不忽略按钮OCR文字', async () => {
    await setup();
    await showSingle();
    await decorateSingle();
    await page.locator('.btn').evaluate((button) => {
      const title = document.querySelector('.topic-title')!.getBoundingClientRect();
      (button as HTMLElement).style.cssText =
        `position:fixed;left:${title.left}px;top:${title.top}px`;
    });
    await expect(adapter.capture(signal())).rejects.toThrow('QUESTION_IMAGE_UNCERTAIN');
    expect((await counts()).selections).toBe(0);
  });
  it('截图前后只改变几何位置，文字相同仍拒绝旧截图', async () => {
    await setup();
    await showSingle();
    await decorateSingle();
    const original = page.screenshot.bind(page);
    vi.spyOn(page, 'screenshot').mockImplementation(async (options) => {
      const image = await original(options);
      await page.locator('.topic-title').evaluate((title) => {
        (title as HTMLElement).style.transform = 'translateY(4px)';
      });
      return image;
    });
    try {
      await expect(adapter.capture(signal())).rejects.toThrow('QUESTION_IMAGE_UNCERTAIN');
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('题目超出视口时拒绝局部截图，不滚动或扩展截图范围', async () => {
    await setup();
    await showSingle();
    await decorateSingle();
    await page.locator('.dialog-test').evaluate((dialog) => {
      (dialog as HTMLElement).style.top = '1200px';
    });
    await expect(adapter.capture(signal())).rejects.toThrow('QUESTION_IMAGE_UNCERTAIN');
    expect(await page.evaluate(() => scrollY)).toBe(0);
  });
});

describe('阶段3单选四项点击即反馈候选（合成内容，待真实环境人工验收）', () => {
  it('离线随机策略不调用全局fetch，也不需要服务或密钥', async () => {
    await setup();
    await showSingle();
    const fetch = vi.fn(() => {
      throw Error('UNEXPECTED_NETWORK');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await runSingle()).toMatchObject({
        ok: true,
        data: { strategy: 'random', attempts: 1, feedbackStatus: 'correct' },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(await counts()).toMatchObject({
        selections: 1,
        submissions: 1,
        footerClicks: 1,
        closes: 1,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('完整题目没有公共关键词也随机一次，不请求联网授权', async () => {
    await setup();
    await showSingle();
    await page.locator('.title-tit').evaluate((el) => {
      el.nextElementSibling!.textContent = '请从以下四种颜色中选择蓝色';
    });
    expect((await runSingle()).ok).toBe(true);
    expect(await counts()).toMatchObject({
      selections: 1,
      submissions: 1,
      footerClicks: 1,
      closes: 1,
    });
  });
  it('初始关闭不是已作答：单次点击前已落盘，页脚只用于关闭，随后恢复同一媒体', async () => {
    await setup();
    await showSingle();
    expect((await adapter.context(signal())).classification).toBe('non-graded');
    const original = adapter.perform.bind(adapter);
    vi.spyOn(adapter, 'perform').mockImplementation(async (action, ...args) => {
      const entry = (await store.load())!.pendingOperations.at(-1)!;
      expect(entry).toMatchObject({ kind: `practice-${action.type}`, status: 'executing' });
      if ('submissionId' in action) expect(entry.operationId).toBe(action.submissionId);
      await original(action, ...args);
    });
    try {
      expect((await runSingle()).ok).toBe(true);
      expect(await counts()).toMatchObject({
        selections: 1,
        submissions: 1,
        footerClicks: 1,
        closes: 1,
      });
      const snapshot = (await store.load())!;
      expect(snapshot.pendingOperations.map((o) => [o.kind, o.status])).toEqual([
        ['practice-pause', 'completed'],
        ['practice-submit', 'completed'],
        ['practice-close', 'completed'],
        ['practice-restore', 'completed'],
      ]);
      expect(await readFile(store.snapshotPath, 'utf8')).not.toMatch(
        /蓝色|optionIds|请从|correctTexts/,
      );
      expect(await page.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(
        false,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('初始暂停只选一次并关闭，不抢播', async () => {
    await setup(false);
    await showSingle();
    expect((await runSingle()).ok).toBe(true);
    expect(await counts()).toMatchObject({ selections: 1, footerClicks: 1, closes: 1 });
    expect((await store.load())!.pendingOperations.map((o) => o.kind)).toEqual([
      'practice-submit',
      'practice-close',
    ]);
    expect(await page.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(true);
  });
  it('初始与等待时均是关闭，异步反馈仍须等候原点击', async () => {
    await setup();
    await showSingle('delayed');
    expect((await runSingle()).ok).toBe(true);
    expect(await counts()).toMatchObject({
      selections: 1,
      submissions: 1,
      footerClicks: 1,
      closes: 1,
    });
  });
  it('选择后暂停取消等候，不点击关闭、不恢复、不重发', async () => {
    await setup();
    await showSingle('pending');
    const result = runSingle();
    await expect.poll(async () => (await counts()).submissions).toBe(1);
    await engine.pause();
    expect((await result).ok).toBe(false);
    expect(await counts()).toMatchObject({
      selections: 1,
      submissions: 1,
      footerClicks: 0,
      closes: 0,
    });
    expect(
      (await store.load())!.pendingOperations.some(
        (o) => o.kind === 'practice-submit' && o.status === 'awaiting-confirmation',
      ),
    ).toBe(true);
  });
  it.each(['unknown', 'invalid-feedback'])(
    '选择后%s不猜测，未知账本阻断重建',
    async (mode) => {
      const grant = await setup();
      await showSingle(mode);
      expect((await runSingle()).ok).toBe(false);
      expect(await counts()).toMatchObject({
        selections: 1,
        submissions: 1,
        footerClicks: 0,
        closes: 0,
      });
      const snapshot = (await store.load())!;
      expect(
        snapshot.pendingOperations.some(
          (o) => o.kind === 'practice-submit' && o.status === 'awaiting-confirmation',
        ),
      ).toBe(true);
      const next = new TaskEngine({
        store: new StateStore(folder),
        stage3VerifiedPractice: grant,
        stage2Capabilities: {
          enabled: true,
          inspect: async () => {
            throw new Error('must not inspect');
          },
          backup: async () => true,
        },
      });
      await next.browserConnected();
      await next.confirmCourse(
        {
          source: 'zhihuishu-dom',
          courseId,
          title: '合成课程',
          authenticated: true,
          pageKind: 'course',
          confidence: 'verified',
          platformCompleted: null,
          evidence: ['fixture'],
          observedAt: new Date().toISOString(),
        },
        courseId,
      );
      expect((await next.start()).code).toBe('UNCONFIRMED_OPERATION');
      expect((await counts()).selections).toBe(1);
    },
    10000,
  );
  it.each([
    'selected',
    'unknown-state',
    'feedback',
    'multiple',
    'three-options',
    'footer-submit',
    'graded',
  ])('入场%s不符合现场范围，零随机选择零选择', async (kind) => {
    await setup();
    await showSingle();
    await page.evaluate((kind) => {
      if (kind === 'selected') document.querySelector('.topic-item')!.classList.add('selected');
      if (kind === 'unknown-state')
        document.querySelector('.topic-item')!.classList.add('previous-answer');
      if (kind === 'feedback') {
        const region = document.createElement('span');
        region.className = 'right';
        const icon = document.createElement('i');
        icon.className = 'iconzhengque1';
        region.append(icon);
        document.querySelector('.topic-title')!.append(region);
      }
      if (kind === 'multiple') document.querySelector('.title-tit')!.textContent = '【多选题】';
      if (kind === 'three-options') document.querySelector('.topic-item:last-child')!.remove();
      if (kind === 'footer-submit') document.querySelector('.btn')!.textContent = '提交';
      if (kind === 'graded')
        document.querySelector('.el-dialog__header p')!.textContent = '正式计分作业';
    }, kind);
    const selection = fixedRandom(1),
      spy = vi.spyOn(selection, 'randomIndex');
    try {
      expect((await runSingle(selection)).ok).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(await counts()).toMatchObject({ selections: 0, submissions: 0, footerClicks: 0 });
    } finally {
      spy.mockRestore();
    }
  });
  it('点击处理器同步换题，即使出现正确标记也不认作原题回执', async () => {
    await setup();
    await showSingle();
    await page
      .locator('.topic-item')
      .nth(1)
      .evaluate((element) => {
        const item = element as HTMLElement,
          previous = item.onclick;
        item.onclick = function (event) {
          previous?.call(this, event);
          document.querySelector('.title-tit')!.nextElementSibling!.textContent =
            '完全不同的合成题目';
        };
      });
    expect((await runSingle()).ok).toBe(false);
    expect(await counts()).toMatchObject({ selections: 1, footerClicks: 0, closes: 0 });
    expect(
      (await store.load())!.pendingOperations.some(
        (o) => o.kind === 'practice-submit' && o.status === 'awaiting-confirmation',
      ),
    ).toBe(true);
  });
  it('提交意图落盘期间人工输入，单选点击一次也不能发出', async () => {
    await setup();
    await showSingle();
    const original = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (input) => {
      const saved = await original(input);
      if (
        input.pendingOperations.some(
          (o) => o.kind === 'practice-submit' && o.status === 'executing',
        )
      )
        await page.mouse.click(50, 35);
      return saved;
    });
    try {
      expect((await runSingle()).ok).toBe(false);
      expect(await counts()).toMatchObject({ selections: 0, submissions: 0, footerClicks: 0 });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('9.2.1嵌套正确反馈（合成内容，待真实环境人工验收）', () => {
  async function nestedFeedback(kind = 'known', single = false) {
    await setup();
    if (single) await showSingle('correct');
    else await showBooleanClick('correct');
    await page
      .locator('.topic-item')
      .nth(single ? 1 : 0)
      .evaluate((item, kind) => {
        item.addEventListener('click', () => {
          const icon = document.querySelector('.topic-title i.iconzhengque1')!;
          const inner = icon.parentElement!;
          const outer = document.createElement('span');
          inner.replaceWith(outer);
          inner.style.display = 'block';
          icon.className = 'iconfont iconzhengque1';
          inner.prepend('正确');
          outer.append(inner);
          if (kind === 'icon-class') icon.classList.add('unknown');
          if (kind === 'icon-text') icon.textContent = 'unknown';
          if (kind === 'icon-child') icon.append(document.createElement('b'));
          if (kind === 'outer-tag') {
            const replacement = document.createElement('div');
            replacement.append(...outer.childNodes);
            outer.replaceWith(replacement);
          }
          if (kind === 'outer-child') outer.append(document.createElement('span'));
          if (kind === 'hidden-outer') outer.style.opacity = '0';
          if (kind === 'wrong-icon') icon.className = 'iconfont iconcuowu1';
          if (kind === 'aria-disabled')
            document.querySelector('.btn')!.setAttribute('aria-disabled', 'true');
          if (kind === 'outer-class') outer.className = 'unknown';
          if (kind === 'inner-class') inner.classList.add('unknown');
          if (kind === 'inner-tag') {
            const replacement = document.createElement('div');
            replacement.className = 'right';
            replacement.append(...inner.childNodes);
            inner.replaceWith(replacement);
          }
          if (kind === 'extra-depth') {
            const extra = document.createElement('span');
            extra.append(...inner.childNodes);
            inner.append(extra);
          }
          if (kind === 'duplicate') inner.append(icon.cloneNode(true));
          if (kind === 'outer-text') outer.append('需人工确认');
          if (kind === 'inner-text') inner.prepend('未确认');
          if (kind === 'hidden-inner') inner.style.visibility = 'hidden';
          if (kind === 'hidden-icon') (icon as HTMLElement).style.opacity = '0';
          if (kind === 'extra-child') inner.append(document.createElement('b'));
          if (kind === 'disabled') document.querySelector('.btn')!.setAttribute('disabled', '');
          if (kind === 'loading') {
            const loading = document.createElement('div');
            loading.className = 'el-loading-mask';
            loading.textContent = '加载中';
            document.querySelector('.el-dialog__body')!.append(loading);
          }
          if (kind === 'mixed') {
            const extra = document.createElement('span');
            extra.className = 'error';
            const rightIcon = document.createElement('i');
            rightIcon.className = 'iconfont iconcuowu1';
            extra.append(rightIcon);
            document.querySelector('.topic-title')!.append(extra);
          }
        });
      }, kind);
  }

  it.each(['boolean', 'single'])('精确嵌套正确反馈%s只作答一次后关闭续播', async (type) => {
    await nestedFeedback('known', type === 'single');
    const result = type === 'single' ? await runSingle() : await run();
    expect(result).toMatchObject({ ok: true, data: { attempts: 1, feedbackStatus: 'correct' } });
    expect(await counts()).toMatchObject({
      selections: 1,
      submissions: 1,
      footerClicks: 1,
      closes: 1,
    });
    expect((await store.load())!.pendingOperations.map((op) => [op.kind, op.status])).toEqual([
      ['practice-pause', 'completed'],
      ['practice-submit', 'completed'],
      ['practice-close', 'completed'],
      ['practice-restore', 'completed'],
    ]);
    expect(
      await page.locator('video').evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(false);
  });

  it.each([
    'icon-class',
    'icon-text',
    'icon-child',
    'outer-tag',
    'outer-child',
    'hidden-outer',
    'wrong-icon',
    'aria-disabled',
    'outer-class',
    'inner-class',
    'inner-tag',
    'extra-depth',
    'duplicate',
    'outer-text',
    'inner-text',
    'hidden-inner',
    'hidden-icon',
    'extra-child',
    'disabled',
    'loading',
    'mixed',
  ])('嵌套反馈%s仍保留待确认且不关闭', async (kind) => {
    await nestedFeedback(kind);
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({
      selections: 1,
      submissions: 1,
      footerClicks: 0,
      closes: 0,
    });
    expect((await store.load())!.pendingOperations.at(-1)).toMatchObject({
      kind: 'practice-submit',
      status: 'awaiting-confirmation',
    });
  });

  it('已存在嵌套正确反馈不能冒充本次回执', async () => {
    await setup();
    await showBooleanClick('correct');
    await page.locator('.topic-title').evaluate((title) => {
      const outer = document.createElement('span'),
        inner = document.createElement('span'),
        icon = document.createElement('i');
      inner.className = 'right';
      inner.style.display = 'block';
      icon.className = 'iconfont iconzhengque1';
      inner.append('正确', icon);
      outer.append(inner);
      title.append(outer);
    });
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({
      selections: 0,
      submissions: 0,
      footerClicks: 0,
      closes: 0,
    });
  });
});

describe('自然弹出的已有反馈仅关闭（合成内容，待真实环境人工验收）', () => {
  async function addExisting(status: 'correct' | 'incorrect' = 'correct', mutation = '') {
    await page.locator('.topic-title').evaluate(
      (title, { status, mutation }) => {
        const outer = document.createElement('span'),
          inner = document.createElement('span'),
          icon = document.createElement('i');
        inner.className = status === 'correct' ? 'right' : 'error';
        inner.style.display = 'block';
        icon.className = 'iconfont ' + (status === 'correct' ? 'iconzhengque1' : 'iconcuowu1');
        inner.append(status === 'correct' ? '正确' : '错误', icon);
        outer.append(inner);
        title.append(outer);
        document.querySelector('.topic-item')!.classList.add('selected');
        if (mutation === 'hidden') inner.style.opacity = '0';
        if (mutation === 'unknown-class') inner.classList.add('unknown');
        if (mutation === 'extra-text') outer.append('未确认');
        if (mutation === 'duplicate') title.append(outer.cloneNode(true));
        if (mutation === 'mixed') {
          const other = document.createElement('i');
          other.className = 'iconfont iconcuowu1';
          inner.append(other);
        }
        if (mutation === 'disabled') document.querySelector('.btn')!.setAttribute('disabled', '');
        if (mutation === 'loading') {
          const mask = document.createElement('div');
          mask.className = 'el-loading-mask';
          mask.textContent = '加载中';
          document.querySelector('.el-dialog__body')!.append(mask);
        }
        if (mutation === 'graded')
          document.querySelector('.el-dialog__header p')!.textContent = '计分考试';
        if (mutation === 'incomplete') document.querySelector('.item-topic')!.remove();
        if (mutation === 'empty-stem')
          document.querySelector('.title-tit')!.nextElementSibling!.textContent = '';
        if (mutation === 'empty-option') document.querySelector('.item-topic')!.textContent = '';
        if (mutation === 'unknown-boolean')
          document.querySelector('.item-topic')!.textContent = '未知';
        if (mutation === 'offscreen')
          (document.querySelector('.topic-list') as HTMLElement).style.transform =
            'translateY(2000px)';
      },
      { status, mutation },
    );
  }
  it.each([
    ['correct', 'boolean', true],
    ['incorrect', 'boolean', true],
    ['correct', 'single', true],
    ['incorrect', 'single', true],
    ['correct', 'boolean', false],
    ['incorrect', 'boolean', false],
  ] as const)('%s/%s 原播放=%s：零选择零提交，仅关闭和必要恢复', async (status, type, playing) => {
    await setup(playing, true, signal(), true);
    if (type === 'single') await showSingle();
    else await showBooleanClick();
    await addExisting(status);
    const randomIndex = vi.fn(() => {
      throw new Error('MUST_NOT_RANDOMIZE');
    });
    const question = vi.spyOn(adapter, 'question'),
      feedback = vi.spyOn(adapter, 'feedback');
    const session = new PracticeSession(engine, adapter, undefined, { randomIndex });
    const result = await session.run();
    expect(result).toMatchObject({
      ok: true,
      code: 'PRACTICE_EXISTING_FEEDBACK_CLOSED',
      data: {
        attempts: 0,
        questionType: null,
        feedbackStatus: null,
        completionMode: 'already-answered',
        existingFeedbackStatus: status,
      },
    });
    expect(randomIndex).not.toHaveBeenCalled();
    expect(question).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
    expect(await counts()).toMatchObject({
      selections: 0,
      submissions: 0,
      footerClicks: 1,
      closes: 1,
    });
    expect((await store.load())!.pendingOperations.map((o) => [o.kind, o.status])).toEqual(
      playing
        ? [
            ['practice-close', 'completed'],
            ['practice-restore', 'completed'],
          ]
        : [['practice-close', 'completed']],
    );
    expect(await page.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(
      !playing,
    );
    expect((await session.run()).code).toBe('PRACTICE_SESSION_CONSUMED');
    vi.restoreAllMocks();
  });
  it('默认模式仍拒绝已有反馈，不伪造本次回执', async () => {
    await setup();
    await showBooleanClick();
    await addExisting();
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({ selections: 0, submissions: 0, closes: 0 });
  });
  it('允许已有反馈时，新题仍正常随机作答一次', async () => {
    await setup(true, true, signal(), true);
    await showBooleanClick();
    const result = await run();
    expect(result).toMatchObject({ ok: true, data: { attempts: 1, feedbackStatus: 'correct' } });
    expect(result.data).not.toHaveProperty('completionMode');
    expect(await counts()).toMatchObject({ selections: 1, submissions: 1, closes: 1 });
  });
  it('已观察为未答题，再无回执出现反馈时不转成关闭路径', async () => {
    await setup(true, true, signal(), true);
    await showBooleanClick();
    expect((await adapter.context(signal())).existingFeedback).toBeUndefined();
    await addExisting();
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({ selections: 0, submissions: 0, closes: 0 });
  });
  it.each([
    'hidden',
    'unknown-class',
    'extra-text',
    'duplicate',
    'mixed',
    'disabled',
    'loading',
    'graded',
    'incomplete',
    'empty-stem',
    'empty-option',
    'unknown-boolean',
    'offscreen',
  ])('首次已有反馈%s：零关闭零提交', async (mutation) => {
    await setup(true, true, signal(), true);
    await showBooleanClick();
    await addExisting('correct', mutation);
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({
      selections: 0,
      submissions: 0,
      footerClicks: 0,
      closes: 0,
    });
  });
  it('反馈只提供已有状态，不提供提交回执；不能调用submit', async () => {
    await setup(true, true, signal(), true);
    await showBooleanClick();
    await addExisting();
    const context = await adapter.context(signal()),
      video = await adapter.video(signal());
    expect(await adapter.feedback(signal())).toEqual({ status: 'unknown' });
    expect((await engine.beginPractice(context)).ok).toBe(true);
    const action = { type: 'submit' as const, optionIds: ['A'], submissionId: 'forbidden-submit' };
    const result = await engine.execute({
      operationId: 'forbidden-submit',
      kind: 'practice-submit',
      issue: (s) => adapter.perform(action, context, video, s),
      verify: async () => 'confirmed',
    });
    expect(result.ok).toBe(false);
    expect(await counts()).toMatchObject({ selections: 0, submissions: 0, closes: 0 });
  });
  it('启用时已有弹窗仍拒绝，不能猜测原播放状态', async () => {
    await showBooleanClick();
    await addExisting();
    const valid = createVerifiedPracticeGrant(join(folder, 'valid-acceptance'), courseId, true);
    engine = new TaskEngine({ store, stage3VerifiedPractice: valid });
    await expect(
      VerifiedZhihuishuPracticeAdapter.arm(page, valid, signal(), engine, {
        allowExistingFeedback: true,
      }),
    ).rejects.toThrow();
    expect(await counts()).toMatchObject({ selections: 0, submissions: 0, closes: 0 });
  });
  it('已有反馈绑定后类型变化拒绝关闭', async () => {
    await setup(true, true, signal(), true);
    await showBooleanClick();
    await addExisting();
    await adapter.context(signal());
    await page.locator('.topic-title span.right').evaluate((e) => {
      e.setAttribute('class', 'error');
      e.replaceChildren('错误');
      const i = document.createElement('i');
      i.className = 'iconfont iconcuowu1';
      e.append(i);
    });
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({ closes: 0, submissions: 0 });
  });
  it('关闭命令前按钮禁用，零关闭；旧未知保留', async () => {
    await setup(true, true, signal(), true);
    await showBooleanClick();
    await addExisting();
    const original = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (input) => {
      const saved = await original(input);
      if (
        input.pendingOperations.some((o) => o.kind === 'practice-close' && o.status === 'executing')
      )
        await page.locator('.btn').evaluate((e) => e.setAttribute('disabled', ''));
      return saved;
    });
    try {
      expect((await run()).ok).toBe(false);
      expect(await counts()).toMatchObject({ closes: 0, submissions: 0 });
      expect((await store.load())!.pendingOperations.at(-1)?.status).toBe('awaiting-confirmation');
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('关闭点击未消除弹窗，不恢复且不重试', async () => {
    await setup(true, true, signal(), true);
    await showBooleanClick();
    await addExisting();
    await page.locator('.btn').evaluate((e) => {
      (e as HTMLElement).onclick = () => {
        (window as unknown as { nativeFixture: { state: { footerClicks: number } } }).nativeFixture
          .state.footerClicks++;
      };
    });
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({ footerClicks: 1, closes: 0, submissions: 0 });
    expect((await store.load())!.pendingOperations.map((o) => o.kind)).toEqual(['practice-close']);
    expect(await page.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(true);
  });
  it('手动输入后不关闭不恢复', async () => {
    await setup(true, true, signal(), true);
    await showBooleanClick();
    await addExisting();
    await adapter.context(signal());
    await page.mouse.click(50, 35);
    expect((await run()).ok).toBe(false);
    expect(await counts()).toMatchObject({ closes: 0, submissions: 0 });
  });
});
