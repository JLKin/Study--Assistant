import { describe, expect, it } from 'vitest';
import { BrowserBridge } from '../../packages/browser-bridge/src/index';

const realStudyUrl =
  'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-course-route-for-unit-001';

function bridgeWithPages(urls: Array<{ url: string; closed?: boolean }>) {
  const bridge = new BrowserBridge({ dataDir: 'unused-test-data' });
  const pages = urls.map((value) => ({
    url: () => value.url,
    isClosed: () => value.closed ?? false,
  }));
  // 仅注入页面枚举；不创建磁盘、浏览器连接或模拟实际动作成功。
  Object.assign(bridge, {
    browser: { isConnected: () => true, contexts: () => [{ pages: () => pages }] },
  });
  return bridge;
}

describe('阶段2显式检查页面绑定安全边界', () => {
  it('欢迎标签晚于唯一课程页出现时仍绑定明确的本机候选', () => {
    const bridge = bridgeWithPages([
      { url: 'http://127.0.0.1:4172/stage2-fixture' },
      { url: 'edge://newtab/' },
    ]);
    expect(bridge.monitorAdapter().kind).toBe('fixture');
  });
  it('多个本机课程标签拒绝选择，不能猜当前课程', () => {
    const bridge = bridgeWithPages([
      { url: 'http://127.0.0.1:4172/stage2-fixture' },
      { url: 'http://127.0.0.1:4180/stage2-fixture' },
    ]);
    expect(() => bridge.monitorAdapter()).toThrow('多个本机模拟课程页');
  });
  it('唯一真实课程页绑定到真实适配器，不受欢迎标签顺序影响', () => {
    const bridge = bridgeWithPages([
      { url: 'edge://newtab/' },
      { url: realStudyUrl },
      { url: 'about:blank' },
    ]);
    expect(bridge.monitorAdapter().kind).toBe('zhihuishu-dom');
  });
  it('多个真实课程标签即使同一课程也拒绝选择', () => {
    const bridge = bridgeWithPages([{ url: realStudyUrl }, { url: realStudyUrl }]);
    expect(() => bridge.monitorAdapter()).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_MONITOR_PAGE' }),
    );
  });
  it.each([
    [{ url: realStudyUrl }, { url: 'http://127.0.0.1:4172/stage2-fixture' }],
    [{ url: 'http://127.0.0.1:4172/stage2-fixture' }, { url: realStudyUrl }],
  ])('真实课程与本机课程并存时拒绝按标签顺序选择', (...pages) => {
    expect(() => bridgeWithPages(pages).monitorAdapter()).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_MONITOR_PAGE' }),
    );
  });
  it('已关闭的真实课程页不造成唯一模拟课程的歧义', () => {
    const bridge = bridgeWithPages([
      { url: 'http://127.0.0.1:4172/stage2-fixture' },
      { url: realStudyUrl, closed: true },
    ]);
    expect(bridge.monitorAdapter().kind).toBe('fixture');
  });
  it('已关闭的模拟课程页不造成唯一真实课程的歧义', () => {
    const bridge = bridgeWithPages([
      { url: realStudyUrl },
      { url: 'http://127.0.0.1:4172/stage2-fixture', closed: true },
    ]);
    expect(bridge.monitorAdapter().kind).toBe('zhihuishu-dom');
  });
  it.each([
    'https://studyvideoh5.zhihuishu.com/stuStudy',
    'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-course-route-for-unit-001&recruitAndCourseId=synthetic-course-route-for-unit-002',
    'https://studyvideoh5.zhihuishu.com/exam',
    'https://studyvideoh5.zhihuishu.com/stuStudy/exam?recruitAndCourseId=synthetic-course-route-for-unit-001',
    'https://studyvideoh5.zhihuishu.com/stuStudyFake?recruitAndCourseId=synthetic-course-route-for-unit-001',
    'https://studyvideoh5.zhihuishu.com.evil.example/stuStudy?recruitAndCourseId=synthetic-course-route-for-unit-001',
    'http://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=synthetic-course-route-for-unit-001',
  ])('未知、计分或身份歧义路径保持未验证：%s', async (url) => {
    const adapter = bridgeWithPages([{ url }]).monitorAdapter();
    expect(adapter.kind).toBe('real-unverified');
    expect(await adapter.inspect()).toMatchObject({
      confidence: 'uncertain',
      source: 'real-unverified',
    });
  });
  it('已关闭或相似但不受信路径不产生监测适配器', async () => {
    const bridge = bridgeWithPages([
      { url: 'http://127.0.0.1:4172/stage2-fixture', closed: true },
      { url: 'https://studyvideoh5.zhihuishu.com/stage2-fixture' },
    ]);
    expect(await bridge.monitorAdapter().inspect()).toMatchObject({
      confidence: 'uncertain',
      source: 'real-unverified',
    });
  });
});
