import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import { PracticeSession } from '../../packages/practice/src/index';
import {
  FixturePracticeSiteAdapter,
  isStage3FixtureUrl,
  practiceAdapterForPage,
} from '../../packages/site-adapter/src/practice-fixture';
import { monitorAdapterForPage } from '../../packages/site-adapter/src/monitor';
import { fixedRandom, setup } from '../helpers/stage3';

let server: Server;
let browser: Browser;
let page: Page;
let base: string;
interface FixtureState {
  submissions: number;
  closes: number;
  restores: number;
  pauses: number;
  manualRevision: number;
  generation: number;
}
const state = () =>
  page.evaluate(() =>
    structuredClone(
      (window as unknown as { stage3Fixture: { state: FixtureState } }).stage3Fixture.state,
    ),
  );
const reset = (mode: string) =>
  page.evaluate(
    (mode) =>
      (window as unknown as { stage3Fixture: { reset(mode: string): void } }).stage3Fixture.reset(
        mode,
      ),
    mode,
  );
const videoPaused = () =>
  page.locator('#video').evaluate((element) => (element as HTMLVideoElement).paused);

describe.runIf(process.platform === 'win32')(
  '阶段3本机Edge模拟页（不代表真实平台或真实OCR/检索验收）',
  () => {
    beforeAll(async () => {
      const executablePath = await findEdge();
      if (!executablePath) throw new Error('STAGE3_FIXTURE_REQUIRES_EDGE');
      const html = await readFile(new URL('../fixtures/local-site/stage3.html', import.meta.url));
      const media = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
      server = createServer((request, response) => {
        response.setHeader(
          'content-type',
          request.url === '/stage2.webm' ? 'video/webm' : 'text/html; charset=utf-8',
        );
        response.end(request.url === '/stage2.webm' ? media : html);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('FIXTURE_LISTEN');
      base = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ executablePath, headless: true });
      page = await browser.newPage();
    });
    beforeEach(async () => {
      await page.goto(`${base}/stage3-fixture`);
      await expect
        .poll(() =>
          page.locator('#video').evaluate((element) => (element as HTMLVideoElement).readyState),
        )
        .toBeGreaterThanOrEqual(2);
    });
    afterAll(async () => {
      await browser?.close();
      if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    it.each(['exam', 'graded', 'unknown', 'incomplete', 'ambiguous'])(
      '相似外观 %s 页面自动提交0次',
      async (mode) => {
        await reset(mode);
        const { engine } = await setup();
        const adapter = practiceAdapterForPage(page);
        expect(
          (await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok,
        ).toBe(false);
        expect((await state()).submissions).toBe(0);
        expect((await state()).closes).toBe(0);
      },
    );
    it.each(['single', 'multiple', 'boolean'])(
      '本机真实DOM %s 映射、实际反馈与关闭；原先暂停则不抢播',
      async (type) => {
        if (type !== 'single') await reset(type);
        const { engine, storage } = await setup();
        const adapter = new FixturePracticeSiteAdapter(page);
        const output = await new PracticeSession(engine, adapter, undefined, fixedRandom()).run();
        expect(output.ok).toBe(true);
        expect(await state()).toMatchObject({ submissions: 1, closes: 1, restores: 0 });
        expect(await videoPaused()).toBe(true);
        expect(storage.snapshot()!.pendingOperations.every((op) => op.status === 'completed')).toBe(
          true,
        );
      },
    );
    it('原先播放：保存状态、保护暂停、关闭后同媒体恢复真实播放', async () => {
      await page.locator('#video').evaluate((element) => (element as HTMLVideoElement).play());
      const { engine } = await setup();
      const result = await new PracticeSession(
        engine,
        new FixturePracticeSiteAdapter(page),
        undefined,
        fixedRandom(),
      ).run();
      expect(result.ok).toBe(true);
      expect(await state()).toMatchObject({ submissions: 1, pauses: 1, restores: 1 });
      expect(await videoPaused()).toBe(false);
      const before = await page
        .locator('#video')
        .evaluate((element) => (element as HTMLVideoElement).currentTime);
      await expect
        .poll(() =>
          page.locator('#video').evaluate((element) => (element as HTMLVideoElement).currentTime),
        )
        .toBeGreaterThan(before);
    });
    it('错误反馈后直接关闭，只作答一次且没有纠错操作', async () => {
      await reset('wrong');
      const { engine, storage } = await setup();
      const result = await new PracticeSession(
        engine,
        new FixturePracticeSiteAdapter(page),
        undefined,
        fixedRandom(),
      ).run();
      expect(result).toMatchObject({
        ok: true,
        data: { strategy: 'random', attempts: 1, feedbackStatus: 'incorrect' },
      });
      expect(await state()).toMatchObject({ submissions: 1, closes: 1 });
      expect(
        storage
          .snapshot()!
          .pendingOperations.filter((op) =>
            ['practice-submit', 'practice-correct'].includes(op.kind),
          ),
      ).toHaveLength(1);
      expect(
        storage.snapshot()!.pendingOperations.some((op) => op.kind === 'practice-correct'),
      ).toBe(false);
    });
    it('反馈未知不能关闭/重发，重建helper仍受账本锁止', async () => {
      await reset('unknown-feedback');
      const { engine, storage } = await setup();
      const adapter = new FixturePracticeSiteAdapter(page);
      expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
        false,
      );
      expect(await state()).toMatchObject({ submissions: 1, closes: 0, restores: 0 });
      expect(storage.snapshot()!.pendingOperations.at(-1)?.status).toBe('awaiting-confirmation');
      expect((await engine.resume()).ok).toBe(false);
      expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
        false,
      );
      expect((await state()).submissions).toBe(1);
    });
    it.each(['manual', 'replace-media', 'pause'] as const)(
      '题目等待期间%s立即中断，迟到结果不提交',
      async (mode) => {
        const { engine } = await setup();
        const adapter = new FixturePracticeSiteAdapter(page);
        let reached!: () => void, release!: () => void;
        const ready = new Promise<void>((r) => {
            reached = r;
          }),
          wait = new Promise<void>((r) => {
            release = r;
          });
        const question = adapter.question.bind(adapter);
        adapter.question = async (signal) => {
          const q = await question(signal);
          reached();
          await wait;
          return q;
        };
        const running = new PracticeSession(engine, adapter, undefined, fixedRandom()).run();
        await ready;
        if (mode === 'manual') await page.locator('#options input').first().click();
        else if (mode === 'replace-media')
          await page.evaluate(() =>
            (
              window as unknown as { stage3Fixture: { replaceMedia(): void } }
            ).stage3Fixture.replaceMedia(),
          );
        else await engine.pause();
        await expect.poll(() => engine.view().state).toBe('PAUSED');
        expect((await running).ok).toBe(false);
        release();
        expect((await state()).submissions).toBe(0);
        expect((await state()).restores).toBe(0);
      },
    );
    it('题目读取后计分性质变化，零提交', async () => {
      const { engine } = await setup();
      const adapter = new FixturePracticeSiteAdapter(page);
      const question = adapter.question.bind(adapter);
      adapter.question = async (signal) => {
        const q = await question(signal);
        await page.locator('#practice').evaluate((el) => {
          (el as HTMLElement).dataset.classification = 'graded';
        });
        return q;
      };
      expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
        false,
      );
      expect((await state()).submissions).toBe(0);
    });
    it('真实URL即使页面复制fixture也不能取得练习动作能力，原生产监测工厂保持Restricted', async () => {
      for (const url of [
        'https://studyvideoh5.zhihuishu.com/stage3-fixture',
        'http://127.0.0.1.evil.example/stage3-fixture',
        'file:///stage3-fixture',
        'http://localhost/stage2-fixture',
      ])
        expect(isStage3FixtureUrl(url)).toBe(false);
      const fakePage = {
        url: () =>
          'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-course-route-001',
      } as Page;
      const locked = practiceAdapterForPage(fakePage);
      expect(locked.kind).toBe('real-unverified');
      await expect(
        locked.perform(
          { type: 'close' },
          { ...(await locked.context(new AbortController().signal)) },
          { mediaId: '', generation: 0, paused: true, manualRevision: 0 },
          new AbortController().signal,
        ),
      ).rejects.toThrow('PRACTICE_LOCKED');
      expect(monitorAdapterForPage(fakePage).constructor.name).toBe(
        'RestrictedZhihuishuSiteAdapter',
      );
    });
    it('即使Node预检查URL陈旧，页面执行瞬间的路由已变化也零提交', async () => {
      const { engine } = await setup();
      const adapter = new FixturePracticeSiteAdapter(page);
      const context = await adapter.context(engine.signal);
      const video = await adapter.video(engine.signal);
      await page.evaluate(() => history.replaceState(null, '', '/different-page'));
      const staleUrlPage = {
        url: () => `${base}/stage3-fixture`,
        evaluate: page.evaluate.bind(page),
      } as unknown as Page;
      const stale = new FixturePracticeSiteAdapter(staleUrlPage);
      await expect(
        stale.perform(
          { type: 'submit', optionIds: ['A'], submissionId: 'stale-dispatch' },
          context,
          video,
          engine.signal,
        ),
      ).rejects.toThrow('PRACTICE_LOCKED');
      expect((await state()).submissions).toBe(0);
    });
    it('仅滚轮/翻页滚动或Tab聚焦不取消练习，真正关键输入仍由独立用例阻断', async () => {
      const { engine } = await setup();
      const adapter = new FixturePracticeSiteAdapter(page);
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => {
          reached = r;
        }),
        wait = new Promise<void>((r) => {
          release = r;
        });
      const question = adapter.question.bind(adapter);
      adapter.question = async (signal) => {
        const q = await question(signal);
        reached();
        await wait;
        return q;
      };
      const running = new PracticeSession(engine, adapter, undefined, fixedRandom()).run();
      await ready;
      await page.locator('#stem').evaluate((el) => {
        el.setAttribute('tabindex', '0');
        (el as HTMLElement).focus();
      });
      await page.mouse.wheel(0, 20);
      await page.keyboard.press('PageDown');
      await page.keyboard.press('Tab');
      release();
      expect((await running).ok).toBe(true);
      expect((await state()).submissions).toBe(1);
    });
  },
);
