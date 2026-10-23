import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright';
import { monitorAdapterForPage } from '../../packages/site-adapter/src/monitor';
import type { SiteAction } from '../../packages/contracts/src/monitor';
import { RestrictedZhihuishuSiteAdapter } from '../../packages/site-adapter/src/zhihuishu';

describe('取消调速后平台再次限制时的生产停用边界', () => {
  const mock = (
    url = 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-course-route-001',
  ) => {
    const evaluate = vi.fn().mockResolvedValue(null);
    const exposeBinding = vi.fn();
    const context = vi.fn();
    const locator = vi.fn();
    const bringToFront = vi.fn();
    const page = {
      url: () => url,
      isClosed: () => false,
      evaluate,
      exposeBinding,
      context,
      locator,
      bringToFront,
    } as unknown as Page;
    return {
      adapter: monitorAdapterForPage(page),
      evaluate,
      exposeBinding,
      context,
      locator,
      bringToFront,
    };
  };

  it('严格匹配真实页后返回受限适配器，观察和订阅不注入或读取DOM', async () => {
    const m = mock();
    expect(m.adapter).toBeInstanceOf(RestrictedZhihuishuSiteAdapter);
    const listener = vi.fn();
    const dispose = await m.adapter.subscribe(listener);
    const observed = await m.adapter.observe();
    expect(observed.course).toMatchObject({
      source: 'zhihuishu-dom',
      confidence: 'uncertain',
      courseId: null,
    });
    expect(m.evaluate).not.toHaveBeenCalled();
    expect(observed.course.evidence[0]).toContain('SITE_AUTOMATION_RESTRICTED');
    dispose();
    expect(listener).not.toHaveBeenCalled();
    expect(Object.values(observed.capabilities!)).toEqual([false, false, false, false, false]);
    for (const method of [m.exposeBinding, m.context, m.locator, m.bringToFront])
      expect(method).not.toHaveBeenCalled();
  });

  it.each([1, 1.25, 1.5, 2])(
    '生产真实入口拒绝 %s 自动调速，准备与执行不读取或预备网页控件',
    async (rate) => {
      const m = mock();
      const action = { type: 'set-rate', rate, chapterId: 'chapter' } as const;
      const signal = new AbortController().signal;
      await expect(m.adapter.prepare!(action, 'course', signal)).rejects.toThrow(
        'SITE_AUTOMATION_RESTRICTED',
      );
      await expect(m.adapter.perform(action, 'course', signal)).rejects.toThrow(
        'SITE_AUTOMATION_RESTRICTED',
      );
      for (const method of [m.evaluate, m.exposeBinding, m.context, m.locator, m.bringToFront])
        expect(method).not.toHaveBeenCalled();
    },
  );

  it.each([
    'http://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-course-route-001',
    'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-course-route-001&extra=1',
    'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-course-route-001#unsafe',
    'https://studyvideoh5.zhihuishu.com/exam',
  ])('未知或非精确页面仍不读取DOM：%s', async (url) => {
    const m = mock(url);
    expect((await m.adapter.observe()).course).toMatchObject({
      source: 'real-unverified',
      confidence: 'uncertain',
    });
    expect(m.evaluate).not.toHaveBeenCalled();
  });

  it('取消先于真实DOM读取生效', async () => {
    const m = mock();
    const controller = new AbortController();
    controller.abort();
    await expect(m.adapter.observe(controller.signal)).rejects.toThrow();
    expect(m.evaluate).not.toHaveBeenCalled();
  });

  it('保留受限类供平台再次限制时停用：观察与订阅均不接触页面', async () => {
    const adapter = new RestrictedZhihuishuSiteAdapter();
    const listener = vi.fn();
    const dispose = await adapter.subscribe(listener);
    const observed = await adapter.observe();
    expect(observed.course.evidence[0]).toContain('SITE_AUTOMATION_RESTRICTED');
    expect(Object.values(observed.capabilities!)).toEqual([false, false, false, false, false]);
    dispose();
    expect(listener).not.toHaveBeenCalled();
  });

  it.each<SiteAction>([
    { type: 'set-rate', rate: 1.5, chapterId: 'chapter' },
    { type: 'recover-play', chapterId: 'chapter' },
    { type: 'refresh', chapterId: 'chapter' },
    { type: 'navigate', chapterId: 'chapter2', fromChapterId: 'chapter' },
  ])('保留受限类继续拒绝 $type 准备与执行', async (action) => {
    const adapter = new RestrictedZhihuishuSiteAdapter();
    const signal = new AbortController().signal;
    await expect(adapter.prepare(action, 'course', signal)).rejects.toThrow(
      'SITE_AUTOMATION_RESTRICTED',
    );
    await expect(adapter.perform(action, 'course', signal)).rejects.toThrow(
      'SITE_AUTOMATION_RESTRICTED',
    );
  });
});
