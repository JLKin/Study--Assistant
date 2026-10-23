import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import type { SiteAction } from '../../packages/contracts/src/monitor';
import { BrowserBridge } from '../../packages/browser-bridge/src/index';
import {
  monitorAdapterForPage,
  ZhihuishuReadOnlyPreviewSiteAdapter,
} from '../../packages/site-adapter/src/monitor';
import {
  RestrictedZhihuishuSiteAdapter,
  zhihuishuCatalogueKey,
  zhihuishuCourseId,
} from '../../packages/site-adapter/src/zhihuishu';
import type { ZhihuishuDomSample } from '../../packages/site-adapter/src/zhihuishu-dom';

const address =
  'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-preview-course-001';
const sample = (): ZhihuishuDomSample => ({
  route: 'synthetic-preview-course-001',
  title: '离线只读预览课程',
  catalogue: [
    { ordinal: '5.6', title: '已完成章', seconds: 100 },
    { ordinal: '5.7', title: '当前章节', seconds: 480 },
  ],
  completion: [
    { ordinal: '5.6', completed: true },
    { ordinal: '5.7', completed: false },
  ],
  currentOrdinal: '5.7',
  authenticated: true,
  popup: 'none',
  graded: false,
  player: {
    currentTime: 18,
    duration: 480,
    playbackRate: 1,
    paused: true,
    ended: false,
    buffering: false,
  },
  rates: [],
});

function mock(data = sample()) {
  let url = address;
  let closed = false;
  const evaluate = vi.fn().mockImplementation(async () => structuredClone(data));
  const on = vi.fn();
  const off = vi.fn();
  const exposeBinding = vi.fn();
  const locator = vi.fn();
  const context = vi.fn();
  const page = {
    url: () => url,
    isClosed: () => closed,
    evaluate,
    on,
    off,
    exposeBinding,
    locator,
    context,
  } as unknown as Page;
  const evidence = [
    {
      courseId: zhihuishuCourseId(data.route),
      catalogue: zhihuishuCatalogueKey(data),
      completionMarkers: 'finish-half-v1' as const,
    },
  ];
  return {
    page,
    evaluate,
    on,
    off,
    exposeBinding,
    locator,
    context,
    adapter: new ZhihuishuReadOnlyPreviewSiteAdapter(page, evidence),
    setUrl: (value: string) => (url = value),
    close: () => (closed = true),
  };
}

describe('显式真实进度单次只读预览（离线；非真实站点验收）', () => {
  it('默认入口仍受限，仅显式预览模式产生预览实例且构造/订阅不读取页面', async () => {
    const m = mock();
    expect(monitorAdapterForPage(m.page)).toBeInstanceOf(RestrictedZhihuishuSiteAdapter);
    const adapter = monitorAdapterForPage(m.page, 'read-only-preview');
    expect(adapter).toBeInstanceOf(ZhihuishuReadOnlyPreviewSiteAdapter);
    const listener = vi.fn();
    (await adapter.subscribe(listener))();
    for (const method of [m.evaluate, m.on, m.exposeBinding, m.context, m.locator])
      expect(method).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('并发观察/检查和后续状态读取共用一次采样，返回独立副本和原时间戳', async () => {
    const m = mock();
    const [first, course, second] = await Promise.all([
      m.adapter.observe(),
      m.adapter.inspect(),
      m.adapter.observe(),
    ]);
    expect(m.evaluate).toHaveBeenCalledTimes(1);
    expect(first.course).toMatchObject({
      title: '离线只读预览课程',
      source: 'zhihuishu-dom',
      confidence: 'verified',
      platformCompleted: false,
    });
    expect(first.course.evidence[0]).toMatch(/^READ_ONLY_PREVIEW：/);
    expect(first.player).toMatchObject({ currentTime: 18, duration: 480, paused: true });
    expect(first.chapters.map((chapter) => chapter.platformCompleted)).toEqual([true, false]);
    expect(first.chapters[1].title).toBe('5.7 当前章节');
    expect(Object.values(first.capabilities!)).toEqual([false, false, false, false, false]);
    expect(first.safeToRefresh).toBe(false);
    expect(second.course.observedAt).toBe(course.observedAt);
    first.course.title = '调用方修改';
    first.chapters.length = 0;
    expect((await m.adapter.observe()).chapters).toHaveLength(2);
    expect((await m.adapter.inspect()).title).toBe('离线只读预览课程');
    expect(m.evaluate).toHaveBeenCalledTimes(1);
    expect(m.exposeBinding).not.toHaveBeenCalled();
    expect(m.context).not.toHaveBeenCalled();
    expect(m.locator).not.toHaveBeenCalled();
    expect(m.on.mock.calls.map(([name]) => name)).toEqual(['dialog']);
    expect(m.off.mock.calls.map(([name]) => name)).toEqual(['dialog']);
  });

  it.each<SiteAction>([
    { type: 'set-rate', rate: 1.5, chapterId: 'chapter' },
    { type: 'start-play', chapterId: 'chapter' },
    { type: 'recover-play', chapterId: 'chapter' },
    { type: 'refresh', chapterId: 'chapter' },
    { type: 'navigate', chapterId: 'chapter2', fromChapterId: 'chapter' },
  ])('预览的 $type 准备与执行均拒绝，不能透过调用者触发底层动作', async (action) => {
    const m = mock();
    const signal = new AbortController().signal;
    await expect(m.adapter.prepare(action, 'course', signal)).rejects.toThrow('READ_ONLY_PREVIEW');
    await expect(m.adapter.perform(action, 'course', signal)).rejects.toThrow('READ_ONLY_PREVIEW');
    for (const method of [m.evaluate, m.on, m.exposeBinding, m.context, m.locator])
      expect(method).not.toHaveBeenCalled();
  });

  it('已取消的首次检查不读取页面', async () => {
    const m = mock();
    const controller = new AbortController();
    controller.abort(new Error('cancelled-preview'));
    await expect(m.adapter.observe(controller.signal)).rejects.toThrow('cancelled-preview');
    expect(m.evaluate).not.toHaveBeenCalled();
  });

  it('读取期间取消后保留失败结果，同一实例不会自动重读', async () => {
    const m = mock();
    let release!: (value: ZhihuishuDomSample) => void;
    m.evaluate.mockImplementation(
      () => new Promise<ZhihuishuDomSample>((resolve) => (release = resolve)),
    );
    const controller = new AbortController();
    const work = m.adapter.observe(controller.signal);
    controller.abort(new Error('cancelled-preview'));
    await expect(work).rejects.toThrow('cancelled-preview');
    await expect(m.adapter.observe()).rejects.toThrow('cancelled-preview');
    release(sample());
    expect(m.evaluate).toHaveBeenCalledTimes(1);
  });

  it('首次读取失败缓存为未知，状态读取不会重试', async () => {
    const m = mock();
    m.evaluate.mockRejectedValue(new Error('page-disappeared'));
    expect((await m.adapter.observe()).course.confidence).toBe('uncertain');
    expect((await m.adapter.observe()).player).toBeNull();
    expect(m.evaluate).toHaveBeenCalledTimes(1);
  });

  it.each([{ popup: 'present' as const }, { authenticated: 'unknown' as const }, { graded: true }])(
    '弹窗或身份/页面状态不明不能呈现可信播放器和目录：%j',
    async (patch) => {
      const m = mock({ ...sample(), ...patch });
      const observed = await m.adapter.observe();
      expect(observed.course.confidence).toBe('uncertain');
      expect(observed.course.evidence[0]).toMatch(/^READ_ONLY_PREVIEW：/);
      expect(observed.player).toBeNull();
      expect(observed.chapters).toEqual([]);
      await m.adapter.observe();
      expect(m.evaluate).toHaveBeenCalledTimes(1);
    },
  );

  it('页面变化永久停用旧采样，返回原页面后仍不再次读取', async () => {
    const m = mock();
    await m.adapter.observe();
    m.setUrl('https://studyvideoh5.zhihuishu.com/exam');
    expect((await m.adapter.observe()).player).toBeNull();
    m.setUrl(address);
    expect((await m.adapter.observe()).course.confidence).toBe('uncertain');
    expect(m.evaluate).toHaveBeenCalledTimes(1);
  });

  it('页面关闭后停用缓存，不读取已关闭页', async () => {
    const m = mock();
    await m.adapter.observe();
    m.close();
    expect((await m.adapter.observe()).chapters).toEqual([]);
    expect(m.evaluate).toHaveBeenCalledTimes(1);
  });

  it('生产显式预览仍只使用固定身份清单，合成课程不被当成真实已核验课程', async () => {
    const m = mock();
    const adapter = monitorAdapterForPage(m.page, 'read-only-preview');
    const observed = await adapter.observe();
    expect(observed.course.confidence).toBe('uncertain');
    expect(observed.player).toBeNull();
    expect(observed.chapters).toEqual([]);
    expect(m.evaluate).toHaveBeenCalledTimes(1);
  });

  it('桥接层只在明确传入模式时选择预览，既有目标歧义保护不变', () => {
    const m = mock();
    const bridge = new BrowserBridge({ dataDir: 'unused-preview-test-data' });
    Object.assign(bridge, {
      browser: { isConnected: () => true, contexts: () => [{ pages: () => [m.page] }] },
    });
    expect(bridge.monitorAdapter()).toBeInstanceOf(RestrictedZhihuishuSiteAdapter);
    expect(bridge.monitorAdapter('read-only-preview')).toBeInstanceOf(
      ZhihuishuReadOnlyPreviewSiteAdapter,
    );
    Object.assign(bridge, {
      browser: { isConnected: () => true, contexts: () => [{ pages: () => [m.page, m.page] }] },
    });
    expect(() => bridge.monitorAdapter('read-only-preview')).toThrow('检测到多个课程页');
    expect(m.evaluate).not.toHaveBeenCalled();
  });
});
