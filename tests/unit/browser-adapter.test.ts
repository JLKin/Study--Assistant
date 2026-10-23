import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import {
  adapterForPage,
  FixtureSiteAdapter,
  isLocalFixtureUrl,
  UnverifiedSiteAdapter,
} from '../../packages/site-adapter/src/index';

function fixturePage(value: unknown, url = 'http://127.0.0.1:12345/stage1-fixture') {
  const textContent = vi.fn().mockResolvedValue(JSON.stringify(value));
  const locator = vi.fn().mockReturnValue({ textContent });
  const page = { url: () => url, locator } as unknown as Pick<Page, 'url' | 'locator'>;
  return { page, locator, textContent };
}

const valid = {
  schemaVersion: 1,
  courseId: 'fixture-001',
  title: '本机测试课程',
  authenticated: true,
  pageKind: 'course',
  platformCompleted: false,
};

describe('独立只读 SiteAdapter', () => {
  it('真实站点保持明确未验证，不推断登录/课程/完成', async () => {
    const page = fixturePage(valid, 'https://studyvideoh5.zhihuishu.com/');
    const result = await adapterForPage(page.page).inspect();
    expect(result).toMatchObject({
      source: 'real-unverified',
      confidence: 'uncertain',
      authenticated: 'unknown',
      courseId: null,
      platformCompleted: null,
      pageKind: 'unknown',
    });
    expect(page.locator).not.toHaveBeenCalled();
  });

  it('fixture 仅接受无凭据的本机 HTTP 明确路径', () => {
    for (const url of [
      'http://127.0.0.1:1234/stage1-fixture',
      'http://localhost/stage1-fixture',
      'http://[::1]:1234/stage1-fixture',
    ])
      expect(isLocalFixtureUrl(url)).toBe(true);
    for (const url of [
      'http://127.0.0.1.evil.test/stage1-fixture',
      'http://192.168.1.1/stage1-fixture',
      'https://localhost/stage1-fixture',
      'http://user:secret@localhost/stage1-fixture',
      'http://localhost/actual-course',
      'file:///stage1-fixture',
    ])
      expect(isLocalFixtureUrl(url)).toBe(false);
  });

  it('只读取显式契约，不把未完成推断为已完成', async () => {
    const fixture = fixturePage(valid);
    const result = await new FixtureSiteAdapter(fixture.page).inspect();
    expect(result).toMatchObject({
      source: 'fixture',
      confidence: 'verified',
      courseId: 'fixture-001',
      platformCompleted: false,
    });
    expect(fixture.textContent).toHaveBeenCalledOnce();
  });

  it('计分/未知页面不会暴露可确认课程，也不宣称平台已完成', async () => {
    for (const pageKind of ['graded', 'unknown']) {
      const result = await new FixtureSiteAdapter(
        fixturePage({ ...valid, pageKind, platformCompleted: true }).page,
      ).inspect();
      expect(result).toMatchObject({
        pageKind,
        courseId: null,
        title: null,
        platformCompleted: null,
      });
    }
  });

  it('缺少字段、未知版本及伪造 ID 均返回不确定', async () => {
    for (const value of [
      null,
      {},
      { ...valid, schemaVersion: 2 },
      { ...valid, courseId: 'guessed id' },
      { ...valid, platformCompleted: 'completed' },
      { ...valid, authenticated: 'yes' },
    ]) {
      const result = await new FixtureSiteAdapter(fixturePage(value).page).inspect();
      expect(result.confidence).toBe('uncertain');
      expect(result.platformCompleted).toBeNull();
    }
  });

  it('取消后不发起读取，读取失败不输出原始页面数据', async () => {
    const fixture = fixturePage(valid);
    const controller = new AbortController();
    controller.abort();
    await expect(new FixtureSiteAdapter(fixture.page).inspect(controller.signal)).rejects.toThrow();
    expect(fixture.locator).not.toHaveBeenCalled();
    fixture.textContent.mockRejectedValue(new Error('sensitive-text-must-not-leak'));
    const result = await new FixtureSiteAdapter(fixture.page).inspect();
    expect(JSON.stringify(result)).not.toContain('sensitive');
    await expect(new UnverifiedSiteAdapter().inspect(controller.signal)).rejects.toThrow();
  });

  it('读取迟迟无结果时取消立即完成，不等待页面超时', async () => {
    const fixture = fixturePage(valid);
    fixture.textContent.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const observation = new FixtureSiteAdapter(fixture.page).inspect(controller.signal);
    controller.abort(new Error('用户暂停'));
    await expect(observation).rejects.toThrow('用户暂停');
  });

  it('读取期间切换课程页后丢弃旧页面结果', async () => {
    const fixture = fixturePage(valid);
    let currentUrl = 'http://localhost:1234/stage1-fixture?course=one';
    fixture.page.url = () => currentUrl;
    fixture.textContent.mockImplementation(async () => {
      currentUrl = 'http://localhost:1234/stage1-fixture?course=two';
      return JSON.stringify(valid);
    });
    expect(await new FixtureSiteAdapter(fixture.page).inspect()).toMatchObject({
      confidence: 'uncertain',
      courseId: null,
      platformCompleted: null,
    });
  });
});
