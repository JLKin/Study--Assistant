import { describe, expect, it } from 'vitest';
import { buildProgressSummary } from '../../apps/desktop/renderer/progress';
import { DEFAULT_CONFIG } from '../../packages/contracts/src/config';
import type { CourseObservation, Dashboard } from '../../packages/contracts/src/index';
import type { PlayerObservation } from '../../packages/contracts/src/monitor';

const now = Date.parse('2026-10-18T00:00:00.000Z');
const timestamp = (offset = 0) => new Date(now + offset).toISOString();

function fixture(): Dashboard {
  const course: CourseObservation = {
    courseId: 'fixture-course',
    title: '本地课程',
    observedAt: timestamp(),
    confidence: 'verified',
    source: 'fixture',
    authenticated: true,
    pageKind: 'course',
    platformCompleted: null,
    evidence: ['本地 fixture'],
  };
  return {
    stage: 2,
    task: {
      state: 'MONITORING',
      taskId: 'test-task',
      reason: '正在观察',
      cancelled: false,
      persistenceHealthy: true,
    },
    browser: { state: 'CONNECTED', isolatedProfile: true, endpointScope: 'loopback' },
    settings: { config: { ...DEFAULT_CONFIG }, issues: [], blocked: false, source: 'default' },
    selfCheck: { checkedAt: timestamp(), canStart: true, items: [] },
    course: { ...course },
    logs: [],
    dataLocation: 'unused-test-data',
    monitor: {
      observation: {
        course,
        player: {
          chapterId: 'chapter-2',
          currentTime: 25,
          duration: 100,
          playbackRate: 1.5,
          paused: false,
          buffering: false,
          ended: false,
          observedAt: timestamp(),
          confidence: 'verified',
        },
        chapters: [
          { chapterId: 'chapter-1', title: '1.1 入门', platformCompleted: true },
          { chapterId: 'chapter-2', title: '5.2 当前视频', platformCompleted: false },
          { chapterId: 'chapter-3', title: '5.7 后续视频', platformCompleted: null },
        ].map((chapter) => ({
          ...chapter,
          observedAt: timestamp(),
          confidence: 'verified',
        })),
        currentChapterId: 'chapter-2',
        supportedRates: [1, 1.5],
        popup: 'none',
        safeToRefresh: false,
      },
      chapters: [],
      nextPollAt: null,
      refreshAttempts: 0,
      reason: '正在核验',
    },
  };
}

describe('任务进度摘要只使用已有观察，不把样本当真实站点验收', () => {
  it('展示当前章标题和目录位置，视频比例与平台标记分别统计', () => {
    const data = fixture();
    const summary = buildProgressSummary(data, now);
    expect(summary.videoPercent).toBe(25);
    expect(summary.chapterSummary).toContain('5.2 当前视频');
    expect(summary.chapterSummary).toContain('2 / 3');
    expect(summary.platformSummary).toMatch(/完成 1 · 未完成 1 · 未知 1/);
    expect(summary.videoSummary).toContain('25.0 / 100.0 秒');
    expect(summary.sourceLabel).toContain('本地模拟');
    expect(summary.sampleState).toBe('monitoring');
  });

  it('视频结束到100%仍不增加平台完成数，接近结束不提前显示100%', () => {
    const data = fixture();
    const player = data.monitor!.observation!.player!;
    player.currentTime = 99.99;
    expect(buildProgressSummary(data, now).videoPercent).toBe(99.9);
    player.currentTime = 100;
    player.ended = true;
    const summary = buildProgressSummary(data, now);
    expect(summary.videoPercent).toBe(100);
    expect(summary.platformSummary).toMatch(/完成 1 · 未完成 1 · 未知 1/);
    expect(summary.videoSummary).toContain('视频已结束');
  });

  it('真实 DOM 标注来源及待人工验收，保留网站实际手动倍速', () => {
    const data = fixture();
    data.course!.source = 'zhihuishu-dom';
    data.monitor!.observation!.course.source = 'zhihuishu-dom';
    data.monitor!.observation!.player!.playbackRate = 2;
    const summary = buildProgressSummary(data, now);
    expect(summary.sourceLabel).toMatch(/真实 DOM.*待真实环境人工验收/);
    expect(summary.videoSummary).toContain('2×');
    expect(summary.videoPercent).toBe(25);
  });

  it('只读检查和暂停保留样本，但明确不是持续或实时监测', () => {
    const data = fixture();
    data.task.state = 'PAUSED';
    data.task.cancelled = true;
    data.task.reason = '用户手动暂停';
    data.monitor!.reason = '课程只读预览；请人工确认';
    const preview = buildProgressSummary(data, now);
    expect(preview.sampleState).toBe('preview');
    expect(preview.sampleSummary).toContain('未持续监测');
    expect(preview.videoPercent).toBe(25);
    data.monitor!.reason = '正在核验';
    const paused = buildProgressSummary(data, now);
    expect(paused.sampleState).toBe('paused');
    expect(paused.sampleSummary).toContain('非实时');
    expect(paused.taskSummary).toContain('用户手动暂停');
    expect(paused.taskSummary).not.toContain('正在核验');
  });

  it('同一份缓存随展示时钟变旧而过期，不写入或改变原数据', () => {
    const data = fixture();
    const before = structuredClone(data);
    expect(buildProgressSummary(data, now + 30000).videoPercent).toBe(25);
    const stale = buildProgressSummary(data, now + 30001);
    expect(stale.sampleState).toBe('stale');
    expect(stale.videoPercent).toBeNull();
    expect(stale.platformSummary).not.toContain('完成 1');
    expect(data).toEqual(before);
  });

  it.each(['invalid', timestamp(5001), timestamp(-30001)])(
    '课程时间 %s 不可作当前进度',
    (value) => {
      const data = fixture();
      data.monitor!.observation!.course.observedAt = value;
      const summary = buildProgressSummary(data, now);
      expect(summary.sampleState).toBe('stale');
      expect(summary.videoPercent).toBeNull();
    },
  );

  it('时间允许最多5秒的前向误差，但不会显示负样本年龄', () => {
    const data = fixture();
    data.monitor!.observation!.course.observedAt = timestamp(5000);
    const summary = buildProgressSummary(data, now);
    expect(summary.sampleState).toBe('monitoring');
    expect(summary.sampleSummary).toContain('0 秒前');
  });

  it.each(['CLOSED', 'CONNECTING', 'DISCONNECTED'] as const)(
    '%s 时不把保留的观察当作当前进度',
    (state) => {
      const data = fixture();
      data.browser.state = state;
      const summary = buildProgressSummary(data, now);
      expect(summary.sampleState).toBe('disconnected');
      expect(summary.videoPercent).toBeNull();
      expect(summary.chapterSummary).not.toContain('5.2');
      expect(summary.platformSummary).not.toContain('完成 1');
    },
  );

  it('真实入口锁止优先于保留的看似正常样本，不显示旧视频和平台计数', () => {
    const data = fixture();
    data.course!.evidence = ['SITE_AUTOMATION_RESTRICTED：平台已提示限制'];
    const summary = buildProgressSummary(data, now);
    expect(summary.sampleState).toBe('restricted');
    expect(summary.sampleSummary).toContain('未读取');
    expect(summary.videoPercent).toBeNull();
    expect(summary.platformSummary).not.toContain('完成 1');
  });

  it.each([
    (data: Dashboard) => (data.course!.courseId = 'other-course'),
    (data: Dashboard) => (data.course!.source = 'zhihuishu-dom'),
    (data: Dashboard) => (data.course!.confidence = 'uncertain'),
    (data: Dashboard) => (data.monitor!.observation!.course.authenticated = false),
    (data: Dashboard) => (data.monitor!.observation!.course.pageKind = 'graded'),
    (data: Dashboard) => (data.monitor!.observation!.course.source = 'real-unverified'),
    (data: Dashboard) => (data.monitor!.observation!.currentChapterId = 'missing-chapter'),
    (data: Dashboard) =>
      data.monitor!.observation!.chapters.push({
        ...data.monitor!.observation!.chapters[0],
      }),
  ])('身份、来源或目录异常时不生成可靠进度（%#）', (mutate) => {
    const data = fixture();
    mutate(data);
    const summary = buildProgressSummary(data, now);
    expect(summary.sampleState).toBe('unavailable');
    expect(summary.videoPercent).toBeNull();
    expect(summary.platformSummary).not.toContain('完成 1');
  });

  it.each<Partial<PlayerObservation>>([
    { currentTime: -1 },
    { currentTime: 101 },
    { currentTime: Number.NaN },
    { duration: 0 },
    { duration: Number.POSITIVE_INFINITY },
    { playbackRate: 0 },
    { chapterId: 'chapter-1' },
    { confidence: 'uncertain' },
    { observedAt: timestamp(-30001) },
  ])('媒体样本边界 %j 不产生百分比，独立平台标记仍保留', (patch) => {
    const data = fixture();
    Object.assign(data.monitor!.observation!.player!, patch);
    const summary = buildProgressSummary(data, now);
    expect(summary.videoPercent).toBeNull();
    expect(summary.videoSummary).not.toContain('25%');
    expect(summary.platformSummary).toMatch(/完成 1 · 未完成 1 · 未知 1/);
  });

  it('未核验或过期的非当前章平台标记计入未知，不能累计成完成', () => {
    const data = fixture();
    data.monitor!.observation!.chapters[0].observedAt = timestamp(-30001);
    const summary = buildProgressSummary(data, now);
    expect(summary.platformSummary).toMatch(/完成 0 · 未完成 1 · 未知 2/);
    expect(summary.videoPercent).toBe(25);
  });

  it('没有观察或播放器时不会把缺失值格式化成零进度', () => {
    const data = fixture();
    data.monitor!.observation!.player = null;
    expect(buildProgressSummary(data, now).videoPercent).toBeNull();
    data.monitor!.observation = null;
    const summary = buildProgressSummary(data, now);
    expect(summary.sampleState).toBe('unavailable');
    expect(summary.videoPercent).toBeNull();
    expect(summary.videoSummary).not.toContain('0%');
  });
});
