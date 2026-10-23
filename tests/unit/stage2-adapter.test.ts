import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import {
  FixtureMonitorSiteAdapter,
  isStage2FixtureUrl,
  monitorAdapterForPage,
} from '../../packages/site-adapter/src/monitor';

const valid = {
  schemaVersion: 2,
  courseId: 'fixture-course-001',
  title: '测试课程',
  authenticated: true,
  pageKind: 'course',
  platformCompleted: false,
  chapters: [{ chapterId: 'chapter-001', title: '章节一', platformCompleted: false }],
  currentChapterId: 'chapter-001',
  player: {
    chapterId: 'chapter-001',
    currentTime: 10,
    duration: 100,
    playbackRate: 1,
    paused: false,
    buffering: false,
    ended: false,
  },
  supportedRates: [1, 1.25, 1.5],
  popup: 'none',
  safeToRefresh: true,
};

function fakePage(value: unknown, url = 'http://127.0.0.1:1234/stage2-fixture') {
  const textContent = vi.fn().mockResolvedValue(JSON.stringify(value));
  const locator = vi.fn().mockReturnValue({ textContent });
  const page = { url: () => url, locator } as unknown as Page;
  return { page, locator, textContent };
}

describe('阶段 2 SiteAdapter 契约与真实站点隔离', () => {
  it('仅接受无凭据本机 HTTP /stage2-fixture，不接受阶段 1 路径或真实站点', () => {
    for (const url of [
      'http://localhost/stage2-fixture',
      'http://127.0.0.1:9999/stage2-fixture',
      'http://[::1]/stage2-fixture',
    ])
      expect(isStage2FixtureUrl(url)).toBe(true);
    for (const url of [
      'http://localhost/stage1-fixture',
      'https://localhost/stage2-fixture',
      'http://user:secret@localhost/stage2-fixture',
      'http://localhost.evil.test/stage2-fixture',
      'file:///stage2-fixture',
      'https://studyvideoh5.zhihuishu.com/',
    ])
      expect(isStage2FixtureUrl(url)).toBe(false);
  });

  it('真实站点 observe 不读取 DOM，perform 永久拒绝', async () => {
    const fixture = fakePage(valid, 'https://studyvideoh5.zhihuishu.com/');
    const adapter = monitorAdapterForPage(fixture.page);
    expect(await adapter.observe()).toMatchObject({
      course: { confidence: 'uncertain', source: 'real-unverified', authenticated: 'unknown' },
      player: null,
      chapters: [],
      safeToRefresh: false,
    });
    await expect(
      adapter.perform(
        { type: 'set-rate', rate: 1.5, chapterId: 'chapter-001' },
        'fixture-course-001',
        new AbortController().signal,
      ),
    ).rejects.toThrow('待真实环境人工验收');
    expect(fixture.locator).not.toHaveBeenCalled();
  });

  it('规范化独立平台标记、播放器状态与每章时间戳，不根据播放进度宣布完成', async () => {
    const fixture = fakePage({
      ...valid,
      player: { ...valid.player, currentTime: 99, ended: true },
    });
    const result = await monitorAdapterForPage(fixture.page).observe();
    expect(result).toMatchObject({
      course: { platformCompleted: false, confidence: 'verified' },
      player: { currentTime: 99, ended: true, confidence: 'verified' },
      chapters: [{ platformCompleted: false }],
    });
    expect(result.player?.observedAt).toBe(result.course.observedAt);
    expect(result.chapters[0].observedAt).toBe(result.course.observedAt);
    expect(result.capabilities?.playbackRate).toBe(false);
  });

  it.each([1, 1.25, 1.5])('fixture 拒绝自动调速到 %s，准备与执行均不读取页面', async (rate) => {
    const fixture = fakePage(valid);
    const adapter = new FixtureMonitorSiteAdapter(fixture.page);
    const action = { type: 'set-rate', rate, chapterId: 'chapter-001' } as const;
    const signal = new AbortController().signal;
    await expect(adapter.prepare(action, valid.courseId, signal)).rejects.toThrow('手动设置倍速');
    await expect(adapter.perform(action, valid.courseId, signal)).rejects.toThrow('手动设置倍速');
    expect(fixture.locator).not.toHaveBeenCalled();
  });

  it('fixture 只读实际倍速，不按旧目标配置推断或改写', async () => {
    const fixture = fakePage({ ...valid, player: { ...valid.player, playbackRate: 1.25 } });
    const observed = await new FixtureMonitorSiteAdapter(fixture.page).observe();
    expect(observed.player?.playbackRate).toBe(1.25);
    expect(observed.capabilities?.playbackRate).toBe(false);
  });

  it('严格拒绝缺失字段、版本错误、重复章节、非法ID、非finite数字和错误boolean/null', async () => {
    const cases = [
      null,
      {},
      { ...valid, schemaVersion: 1 },
      { ...valid, courseId: 'bad id' },
      { ...valid, authenticated: 'true' },
      { ...valid, safeToRefresh: 'true' },
      { ...valid, platformCompleted: 'done' },
      { ...valid, chapters: [...valid.chapters, ...valid.chapters] },
      { ...valid, chapters: [{ ...valid.chapters[0], platformCompleted: undefined }] },
      { ...valid, currentChapterId: 'missing' },
      { ...valid, supportedRates: [1, 1] },
      { ...valid, popup: null },
      ...[NaN, Infinity, -1, 101].map((currentTime) => ({
        ...valid,
        player: { ...valid.player, currentTime },
      })),
      { ...valid, player: { ...valid.player, duration: 0 } },
      { ...valid, player: { ...valid.player, chapterId: 'missing' } },
      { ...valid, player: { ...valid.player, paused: null } },
    ];
    for (const value of cases) {
      const result = await monitorAdapterForPage(fakePage(value).page).observe();
      expect(result.course.confidence).toBe('uncertain');
      expect(result.player).toBeNull();
      expect(result.safeToRefresh).toBe(false);
    }
  });

  it('登录失效、计分/未知页和弹窗不能获准刷新；计分页不暴露可操作章节', async () => {
    for (const patch of [
      { authenticated: false },
      { pageKind: 'graded' },
      { pageKind: 'unknown' },
      { popup: 'present' },
      { popup: 'unknown' },
    ]) {
      const result = await monitorAdapterForPage(fakePage({ ...valid, ...patch }).page).observe();
      expect(result.safeToRefresh).toBe(false);
      if ('pageKind' in patch) {
        expect(result.course.courseId).toBeNull();
        expect(result.player).toBeNull();
        expect(result.chapters).toEqual([]);
      }
    }
  });

  it('预先取消不读取；悬挂读取取消即时返回；读取错误不泄漏页面内容', async () => {
    const fixture = fakePage(valid);
    const adapter = new FixtureMonitorSiteAdapter(fixture.page);
    const aborted = new AbortController();
    aborted.abort();
    await expect(adapter.observe(aborted.signal)).rejects.toThrow();
    await expect(
      adapter.perform(
        { type: 'refresh', chapterId: 'chapter-001' },
        'fixture-course-001',
        aborted.signal,
      ),
    ).rejects.toThrow();
    expect(fixture.locator).not.toHaveBeenCalled();
    fixture.textContent.mockReturnValue(new Promise(() => undefined));
    const pending = new AbortController();
    const read = adapter.observe(pending.signal);
    pending.abort(new Error('暂停'));
    await expect(read).rejects.toThrow('暂停');
    fixture.textContent.mockRejectedValue(new Error('private-page-content'));
    expect(JSON.stringify(await adapter.observe())).not.toContain('private-page-content');
  });

  it('读完发现页面变化时丢弃旧观察，且既有fixture adapter离开可信路径后不读取', async () => {
    const fixture = fakePage(valid);
    let url = 'http://localhost/stage2-fixture';
    fixture.page.url = () => url;
    fixture.textContent.mockImplementation(async () => {
      url = 'http://localhost/elsewhere';
      return JSON.stringify(valid);
    });
    const adapter = new FixtureMonitorSiteAdapter(fixture.page);
    expect((await adapter.observe()).course.confidence).toBe('uncertain');
    fixture.locator.mockClear();
    expect((await adapter.observe()).course.confidence).toBe('uncertain');
    expect(fixture.locator).not.toHaveBeenCalled();
  });

  it('未结束、平台章标记未确认、重复目标章和暂停时刷新均在动作前拒绝', async () => {
    const adapter = new FixtureMonitorSiteAdapter(fakePage(valid).page);
    await expect(
      adapter.perform(
        { type: 'navigate', fromChapterId: 'chapter-001', chapterId: 'chapter-002' },
        valid.courseId,
        new AbortController().signal,
      ),
    ).rejects.toThrow('保护条件');
    await expect(
      adapter.perform(
        { type: 'navigate', fromChapterId: 'chapter-001', chapterId: 'chapter-001' },
        valid.courseId,
        new AbortController().signal,
      ),
    ).rejects.toThrow('契约无效');
    const paused = new FixtureMonitorSiteAdapter(
      fakePage({ ...valid, player: { ...valid.player, paused: true } }).page,
    );
    await expect(
      paused.perform(
        { type: 'refresh', chapterId: 'chapter-001' },
        valid.courseId,
        new AbortController().signal,
      ),
    ).rejects.toThrow('保护条件');
  });
});
