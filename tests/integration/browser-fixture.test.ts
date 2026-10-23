import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import { adapterForPage } from '../../packages/site-adapter/src/index';

let server: Server;
let browser: Browser;
let page: Page;
let baseUrl: string;

// 真实 Playwright + 本机 HTTP fixture 集成；浏览器由本测试创建，afterAll 仅关闭该实例。
describe.runIf(process.platform === 'win32')('本机模拟页面只读集成', () => {
  beforeAll(async () => {
    const edgePath = await findEdge();
    if (!edgePath) throw new Error('运行本机页面集成测试需要 Microsoft Edge。');
    const html = await readFile(
      fileURLToPath(new URL('../fixtures/local-site/index.html', import.meta.url)),
      'utf8',
    );
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture 监听失败');
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: edgePath, headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    if (server?.listening) await new Promise<void>((done) => server.close(() => done()));
  });

  it('可重复读取课程，不写回平台状态，不触发表单提交', async () => {
    await page.goto(`${baseUrl}/stage1-fixture`);
    const adapter = adapterForPage(page);
    for (let index = 0; index < 3; index += 1) {
      expect(await adapter.inspect()).toMatchObject({
        source: 'fixture',
        courseId: 'fixture-course-001',
        confidence: 'verified',
        platformCompleted: false,
      });
    }
    expect(await page.locator('#submission-count').textContent()).toBe('0');
    expect(
      JSON.parse((await page.locator('#stage1-observation').textContent()) ?? '{}')
        .platformCompleted,
    ).toBe(false);
  });

  it('计分页面及未知页面观察后自动提交次数始终为零', async () => {
    for (const pageKind of ['graded', 'unknown']) {
      await page.goto(`${baseUrl}/stage1-fixture`);
      await page.locator('#stage1-observation').evaluate((element, kind) => {
        const data = JSON.parse(element.textContent ?? '{}');
        data.pageKind = kind;
        element.textContent = JSON.stringify(data);
      }, pageKind);
      const result = await adapterForPage(page).inspect();
      expect(result).toMatchObject({ pageKind, courseId: null, platformCompleted: null });
      expect(await page.locator('#submission-count').textContent()).toBe('0');
    }
  });

  it('相同 DOM 位于非 fixture 路径时始终标记真实站点未验证', async () => {
    await page.goto(`${baseUrl}/unverified-page`);
    expect(await adapterForPage(page).inspect()).toMatchObject({
      source: 'real-unverified',
      confidence: 'uncertain',
      courseId: null,
      platformCompleted: null,
    });
    expect(await page.locator('#submission-count').textContent()).toBe('0');
  });
});
