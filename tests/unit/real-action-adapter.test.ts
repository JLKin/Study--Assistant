import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import {
  ZhihuishuMonitorSiteAdapter,
  zhihuishuCatalogueKey,
  zhihuishuChapterId,
  zhihuishuCourseId,
} from '../../packages/site-adapter/src/zhihuishu';
import type {
  ZhihuishuDomAction,
  ZhihuishuDomSample,
} from '../../packages/site-adapter/src/zhihuishu-dom';

const data: ZhihuishuDomSample = {
  route: 'synthetic-real-action-course',
  title: '合成动作课程',
  catalogue: [
    { ordinal: '1.1', title: '一', seconds: 5 },
    { ordinal: '1.2', title: '二', seconds: 5 },
  ],
  completion: [
    { ordinal: '1.1', completed: true },
    { ordinal: '1.2', completed: false },
  ],
  currentOrdinal: '1.1',
  authenticated: true,
  graded: false,
  popup: 'none',
  rates: [],
  player: {
    currentTime: 1,
    duration: 5,
    playbackRate: 1.25,
    paused: false,
    ended: false,
    buffering: true,
  },
};

function harness() {
  const pageEvents = new EventEmitter();
  const context = new EventEmitter();
  const frame = {};
  const sample = structuredClone(data);
  const bindingDisposes = vi.fn(async () => undefined);
  let authorize: ((source: { page: Page; frame: unknown }, key: string) => unknown) | undefined;
  let actionHook: ((request: ZhihuishuDomAction) => Promise<unknown>) | undefined;
  const page = Object.assign(pageEvents, {
    isClosed: () => false,
    url: () => `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${data.route}`,
    mainFrame: () => frame,
    context: () => context,
    evaluate: vi.fn(async (_read: unknown, request?: ZhihuishuDomAction) =>
      request && actionHook ? actionHook(request) : structuredClone(sample),
    ),
    exposeBinding: vi.fn(async (_name, callback) => {
      authorize = callback;
      return { dispose: bindingDisposes };
    }),
  }) as unknown as Page;
  const adapter = new ZhihuishuMonitorSiteAdapter(page, [
    {
      courseId: zhihuishuCourseId(data.route),
      catalogue: zhihuishuCatalogueKey(data),
      completionMarkers: 'finish-half-v1',
    },
  ]);
  const chapter = zhihuishuChapterId(
    zhihuishuCourseId(data.route),
    zhihuishuCatalogueKey(data),
    '1.1',
  );
  return {
    page,
    pageEvents,
    frame,
    sample,
    adapter,
    bindingDisposes,
    course: zhihuishuCourseId(data.route),
    action: { type: 'recover-play', chapterId: chapter } as const,
    hook: (callback: NonNullable<typeof actionHook>) => {
      actionHook = callback;
    },
    authorized: (key: string, other = false) =>
      authorize!({ page: other ? ({} as Page) : page, frame }, key),
  };
}

afterEach(() => vi.useRealTimers());
describe('真实动作适配器取消与单次授权（仅合成 Page）', () => {
  it('set-rate 和 refresh 在任何页面读取前拒绝', async () => {
    const h = harness();
    for (const method of ['prepare', 'perform'] as const) {
      await expect(
        h.adapter[method](
          { type: 'set-rate', rate: 1.5, chapterId: 'old' },
          h.course,
          new AbortController().signal,
        ),
      ).rejects.toThrow('手动设置倍速');
      await expect(
        h.adapter[method](
          { type: 'refresh', chapterId: 'old' },
          h.course,
          new AbortController().signal,
        ),
      ).rejects.toThrow('拒绝动作');
    }
    expect(h.page.evaluate).not.toHaveBeenCalled();
    expect(h.page.exposeBinding).not.toHaveBeenCalled();
  });
  it('授权只允许当前 page/frame 的准确 token 一次，完成后释放 binding', async () => {
    const h = harness();
    h.hook(async (request) => {
      expect(await h.authorized(request.permit, true)).toBe(false);
      expect(await h.authorized('wrong-token')).toBe(false);
      expect(await h.authorized(request.permit)).toBe(true);
      expect(await h.authorized(request.permit)).toBe(false);
      return structuredClone(h.sample);
    });
    await h.adapter.perform(h.action, h.course, new AbortController().signal);
    expect(h.bindingDisposes).toHaveBeenCalledTimes(1);
    expect(h.pageEvents.listenerCount('dialog')).toBe(0);
  });
  it('最后授权前取消拒绝 token 并释放 binding，不重试动作', async () => {
    const h = harness();
    const controller = new AbortController();
    h.hook(async (request) => {
      controller.abort(new Error('manual pause'));
      expect(await h.authorized(request.permit)).toBe(false);
      throw new Error('动作已取消');
    });
    await expect(h.adapter.perform(h.action, h.course, controller.signal)).rejects.toThrow();
    expect(h.page.exposeBinding).toHaveBeenCalledTimes(1);
    expect(h.bindingDisposes).toHaveBeenCalledTimes(1);
    expect(h.pageEvents.listenerCount('dialog')).toBe(0);
  });
  it('永不返回的页面读取在3秒停止并永久失效，迟到结果不复活', async () => {
    vi.useFakeTimers();
    const h = harness();
    let finish!: (value: ZhihuishuDomSample) => void;
    vi.mocked(h.page.evaluate).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = h.adapter.observe();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).course.confidence).toBe('uncertain');
    finish(structuredClone(data));
    await Promise.resolve();
    expect((await h.adapter.observe()).course.confidence).toBe('uncertain');
    expect(h.page.evaluate).toHaveBeenCalledTimes(1);
    expect(h.pageEvents.listenerCount('dialog')).toBe(0);
  });
  it('原生dialog立即终止挂起读取，不接受或关闭对话框，后续动作拒绝', async () => {
    const h = harness();
    const accept = vi.fn();
    const dismiss = vi.fn();
    vi.mocked(h.page.evaluate).mockImplementationOnce(() => new Promise(() => undefined));
    const result = h.adapter.observe();
    h.pageEvents.emit('dialog', { accept, dismiss });
    expect((await result).course.confidence).toBe('uncertain');
    expect(accept).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    await expect(
      h.adapter.perform(h.action, h.course, new AbortController().signal),
    ).rejects.toThrow();
    expect(h.page.evaluate).toHaveBeenCalledTimes(1);
    expect(h.pageEvents.listenerCount('dialog')).toBe(0);
  });
});
