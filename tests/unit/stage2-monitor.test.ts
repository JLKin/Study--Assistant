import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../packages/contracts/src/config';
import type {
  SiteAction,
  SiteObservation,
  SiteSignal,
  MonitorSiteAdapter,
} from '../../packages/contracts/src/monitor';
import { TaskEngine } from '../../packages/task-engine/src/index';
import type { SnapshotInput, SnapshotStore } from '../../packages/persistence/src/index';
import { MonitorSession } from '../../packages/monitor/src/index';
import { PlayerMonitor } from '../../packages/player/src/index';
import { ChapterTracker } from '../../packages/chapters/src/index';

export function observation(): SiteObservation {
  const at = new Date().toISOString();
  return {
    course: {
      courseId: 'fixture-course',
      title: '模拟课程',
      observedAt: at,
      source: 'fixture',
      confidence: 'verified',
      authenticated: true,
      pageKind: 'course',
      platformCompleted: false,
      evidence: ['fixture'],
    },
    player: {
      chapterId: 'chapter-1',
      currentTime: 0,
      duration: 100,
      playbackRate: 1.5,
      paused: false,
      buffering: false,
      ended: false,
      observedAt: at,
      confidence: 'verified',
    },
    chapters: ['chapter-1', 'chapter-2'].map((chapterId) => ({
      chapterId,
      title: chapterId,
      platformCompleted: false,
      observedAt: at,
      confidence: 'verified',
    })),
    currentChapterId: 'chapter-1',
    supportedRates: [1, 1.25, 1.5],
    popup: 'none',
    safeToRefresh: true,
  };
}

async function harness(options: { polling?: boolean; poll?: number; rate?: number } = {}) {
  let current = observation();
  current.player!.playbackRate = options.rate ?? current.player!.playbackRate;
  const actions: SiteAction[] = [];
  const writes: SnapshotInput[] = [];
  let listener: (event: SiteSignal) => void = () => {};
  let failWrite = false;
  let recoverWorks = true;
  let refreshWorks = true;
  let navigationWorks = true;
  let sourceRegresses = false;
  let afterRefresh = false;
  let heldObservation: Promise<SiteObservation> | null = null;
  let reads = 0;
  const store: SnapshotStore = {
    load: async () => null,
    write: async (value) => {
      if (failWrite) throw new Error('disk');
      writes.push(structuredClone(value));
      return { ...value, integrityDigest: '0'.repeat(64) };
    },
  };
  const adapter: MonitorSiteAdapter = {
    kind: 'fixture',
    inspect: async () => ({ ...current.course, observedAt: new Date().toISOString() }),
    observe: async () => {
      reads++;
      if (heldObservation) return heldObservation;
      const at = new Date().toISOString();
      current.course.observedAt = at;
      current.player!.observedAt = at;
      current.chapters.forEach((c) => (c.observedAt = at));
      if (afterRefresh) current.player!.currentTime++;
      return structuredClone(current);
    },
    subscribe: async (fn) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
    perform: async (action, _courseId, signal) => {
      signal.throwIfAborted();
      actions.push(action);
      const p = current.player!;
      if (action.type === 'set-rate') p.playbackRate = action.rate;
      if (action.type === 'recover-play' && recoverWorks) {
        p.buffering = false;
        p.paused = false;
        p.currentTime++;
      }
      if (action.type === 'refresh') {
        listener({ type: 'navigation', automated: true });
        if (refreshWorks) {
          p.buffering = false;
          p.paused = false;
          p.currentTime = 0;
          afterRefresh = true;
        }
      }
      if (action.type === 'navigate' && navigationWorks) {
        current.currentChapterId = p.chapterId = action.chapterId;
        p.currentTime = 0;
        p.ended = false;
        p.paused = false;
        if (sourceRegresses) current.chapters[0].platformCompleted = false;
      }
    },
  };
  const backup = vi.fn(async () => true);
  const engine = new TaskEngine({
    store,
    stage2Capabilities: { enabled: true, inspect: (s) => adapter.inspect(s), backup },
  });
  const config = {
    ...DEFAULT_CONFIG,
    pollIntervalMs: options.poll ?? DEFAULT_CONFIG.pollIntervalMs,
  };
  const monitor = new MonitorSession({
    engine,
    config: () => config,
    polling: options.polling ?? false,
  });
  await engine.browserConnected();
  await monitor.attach(adapter);
  await engine.confirmCourse(await adapter.inspect(), current.course.courseId!);
  await monitor.start();
  return {
    engine,
    monitor,
    actions,
    writes,
    backup,
    current: () => current,
    reads: () => reads,
    set: (value: SiteObservation) => {
      current = value;
    },
    emit: (event: SiteSignal) => listener(event),
    fail: () => {
      failWrite = true;
    },
    recoverFails: () => {
      recoverWorks = false;
    },
    refreshFails: () => {
      refreshWorks = false;
    },
    navigationFails: () => {
      navigationWorks = false;
    },
    sourceRegresses: () => {
      sourceRegresses = true;
    },
    hold: (value: Promise<SiteObservation>) => {
      heldObservation = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T08:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('阶段 2 播放器与章节纯观察', () => {
  it('30 秒缓冲与 15 秒普通卡顿分开，暂停和结束不计卡顿', () => {
    const monitor = new PlayerMonitor();
    const p = observation().player!;
    expect(monitor.observe(p, 0, DEFAULT_CONFIG)).toBe('none');
    expect(monitor.observe(p, 14999, DEFAULT_CONFIG)).toBe('none');
    expect(monitor.observe(p, 15000, DEFAULT_CONFIG)).toBe('stall-timeout');
    p.buffering = true;
    expect(monitor.observe(p, 15001, DEFAULT_CONFIG)).toBe('none');
    expect(monitor.observe(p, 45000, DEFAULT_CONFIG)).toBe('none');
    expect(monitor.observe(p, 45001, DEFAULT_CONFIG)).toBe('buffer-timeout');
    p.paused = true;
    expect(monitor.observe(p, 90000, DEFAULT_CONFIG)).toBe('none');
    p.paused = false;
    p.ended = true;
    expect(monitor.observe(p, 190000, DEFAULT_CONFIG)).toBe('none');
  });

  it('81% 只触发核验，不把播放器进度/结束冒充平台完成', () => {
    const tracker = new ChapterTracker();
    const o = observation();
    o.player!.currentTime = 81;
    expect(tracker.inspect(o, 0).chapters[0]).toMatchObject({
      verificationTriggered: true,
      status: 'pending',
      platformCompleted: false,
    });
    o.player!.ended = true;
    o.player!.currentTime = 100;
    expect(tracker.inspect(o, 1).chapters[0].status).toBe('conflict');
    expect(tracker.inspect(o, 1).nextChapterId).toBeNull();
  });

  it('冲突每3秒最多额外3次，媒体事件不会提前耗尽复核次数', () => {
    const tracker = new ChapterTracker();
    const o = observation();
    o.player!.currentTime = 100;
    o.player!.ended = true;
    expect(tracker.inspect(o, 0).chapters[0].retries).toBe(0);
    expect(tracker.inspect(o, 2999).chapters[0].retries).toBe(0);
    expect(tracker.inspect(o, 3000).chapters[0].retries).toBe(1);
    expect(tracker.inspect(o, 6000).blocked).toBe(false);
    expect(tracker.inspect(o, 9000).blocked).toBe(true);
    o.chapters[0].platformCompleted = true;
    expect(tracker.inspect(o, 9001).nextChapterId).toBe('chapter-2');
  });

  it('源章已完成但首个未完成目标标记未知时不导航', () => {
    const tracker = new ChapterTracker();
    const o = observation();
    o.player!.currentTime = 100;
    o.player!.ended = true;
    o.chapters[0].platformCompleted = true;
    o.chapters[1].platformCompleted = null;
    expect(tracker.inspect(o, 0)).toMatchObject({ blocked: true, nextChapterId: null });
  });
});

describe('阶段 2 单课程任务协调与安全副作用', () => {
  it('首次达到81%额外读取平台状态一次，但不认定完成或导航', async () => {
    const h = await harness();
    const baseline = h.reads();
    h.current().player!.currentTime = 81;
    await h.monitor.tick();
    expect(h.reads() - baseline).toBe(2);
    const after = h.reads();
    await h.monitor.tick();
    expect(h.reads() - after).toBe(1);
    expect(h.actions).toHaveLength(0);
    expect(h.monitor.view().chapters[0].status).toBe('pending');
  });
  it('清单丢失曾见到的未完成章时暂停，不报告全部完成', async () => {
    const h = await harness();
    const o = h.current();
    o.player!.ended = true;
    o.player!.currentTime = 100;
    o.chapters[0].platformCompleted = true;
    o.chapters.pop();
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('PAUSED');
    expect(h.engine.view().reason).toContain('清单');
    expect(h.actions).toHaveLength(0);
  });
  it('登录失效展示最新状态，解绑后不会重新发布旧已登录课程', async () => {
    const h = await harness();
    h.current().course.authenticated = false;
    await h.monitor.tick();
    expect(h.monitor.view().observation!.course.authenticated).toBe(false);
    h.monitor.dispose();
    expect(h.monitor.view().observation).toBeNull();
  });
  it.each([1, 1.25, 1.5])(
    '历史配置目标1.5不会覆盖手动%s倍速，开始、继续与轮询均只观察',
    async (rate) => {
      const h = await harness({ rate, polling: true });
      expect(DEFAULT_CONFIG.targetPlaybackRate).toBe(1.5);
      expect(h.monitor.view().observation?.player?.playbackRate).toBe(rate);
      await h.engine.pause();
      expect((await h.monitor.start(true)).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.pollIntervalMs * 2);
      expect(h.engine.view().state).toBe('MONITORING');
      expect(h.current().player!.playbackRate).toBe(rate);
      expect(h.actions).toHaveLength(0);
      expect(h.writes.every((write) => write.pendingOperations.length === 0)).toBe(true);
      h.monitor.dispose();
    },
  );

  it('网站倍速菜单缺失或不含历史目标倍速不妨碍只读监测', async () => {
    const h = await harness({ rate: 1.25 });
    h.current().supportedRates = [];
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('MONITORING');
    expect(h.actions).toHaveLength(0);
    expect(h.monitor.view().observation?.player?.playbackRate).toBe(1.25);
  });

  it.each(['login', 'course', 'graded', 'unknown', 'popup', 'player'])(
    '%s 状态异常暂停且零新增网页动作',
    async (kind) => {
      const h = await harness();
      const o = h.current();
      if (kind === 'login') o.course.authenticated = false;
      if (kind === 'course') o.course.courseId = 'different-course';
      if (kind === 'graded') o.course.pageKind = 'graded';
      if (kind === 'unknown') o.chapters[0].platformCompleted = null;
      if (kind === 'popup') o.popup = 'present';
      if (kind === 'player') o.player!.confidence = 'uncertain';
      await h.monitor.tick();
      expect(h.engine.view().state).toBe('PAUSED');
      expect(h.actions).toHaveLength(0);
    },
  );

  it('人工关键操作立即取消，后续媒体事件不动作；媒体事件自身不冒充用户', async () => {
    const h = await harness();
    h.emit({ type: 'media', eventName: 'pause' });
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('MONITORING');
    h.emit({ type: 'manual', action: 'pause' });
    expect(h.engine.signal.aborted).toBe(true);
    h.current().player!.playbackRate = 1;
    h.emit({ type: 'media', eventName: 'ratechange' });
    await h.monitor.tick();
    expect(h.actions).toHaveLength(0);
  });

  it('暂停时迟到的课程读取不能发恢复播放动作', async () => {
    const h = await harness();
    let resolve!: (value: SiteObservation) => void;
    h.current().player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(DEFAULT_CONFIG.bufferTimeoutMs);
    h.hold(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const work = h.monitor.tick();
    await h.engine.pause();
    resolve(h.current());
    await work;
    expect(h.actions).toHaveLength(0);
  });

  it('关键状态写入失败立即锁止新增动作', async () => {
    const h = await harness();
    h.current().player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(DEFAULT_CONFIG.bufferTimeoutMs);
    h.fail();
    await h.monitor.tick();
    expect(h.engine.view().persistenceHealthy).toBe(false);
    expect(h.actions).toHaveLength(0);
  });

  it('成功恢复缓冲后不会立即再次恢复播放', async () => {
    const h = await harness();
    h.current().player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(30000);
    await h.monitor.tick();
    await h.monitor.tick();
    expect(h.actions.map((a) => a.type)).toEqual(['recover-play']);
    expect(h.engine.view().state).toBe('MONITORING');
  });

  it('失败恢复满足保护条件时只刷新一次，刷新后时间从0推进可确认', async () => {
    const h = await harness();
    h.recoverFails();
    h.current().player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(30000);
    await h.monitor.tick();
    vi.advanceTimersByTime(5000);
    const work = h.monitor.tick();
    await vi.advanceTimersByTimeAsync(500);
    await work;
    expect(h.actions.map((a) => a.type)).toEqual(['recover-play', 'refresh']);
    expect(h.monitor.view().refreshAttempts).toBe(1);
    expect(h.engine.refreshAttempts).toBe(1);
    expect(h.engine.view().state).toBe('MONITORING');
    expect(h.writes.at(-1)!.pendingOperations.at(-1)!.kind).toBe('page-refresh');
  });

  it('刷新仍失败暂停，继续后刷新预算不会重置', async () => {
    const h = await harness();
    h.recoverFails();
    h.refreshFails();
    h.current().player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(30000);
    await h.monitor.tick();
    vi.advanceTimersByTime(5000);
    const refreshWork = h.monitor.tick();
    await vi.advanceTimersByTimeAsync(3000);
    await refreshWork;
    expect(h.engine.view().state).toBe('PAUSED');
    expect(h.engine.refreshAttempts).toBe(1);
    await h.monitor.start(true);
    await h.monitor.tick();
    vi.advanceTimersByTime(30000);
    await h.monitor.tick();
    vi.advanceTimersByTime(5000);
    await h.monitor.tick();
    expect(h.actions.filter((a) => a.type === 'refresh')).toHaveLength(1);
    expect(h.engine.view().state).toBe('PAUSED');
  });

  it('刷新条件不可靠时暂停而不刷新', async () => {
    const h = await harness();
    h.recoverFails();
    h.current().safeToRefresh = false;
    h.current().player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(30000);
    await h.monitor.tick();
    vi.advanceTimersByTime(5000);
    await h.monitor.tick();
    expect(h.actions.filter((a) => a.type === 'refresh')).toHaveLength(0);
    expect(h.engine.view().state).toBe('PAUSED');
  });

  it('源章和视频双核验后导航，切章后旧标记回落则未知结果暂停', async () => {
    const h = await harness();
    h.sourceRegresses();
    const o = h.current();
    o.player!.currentTime = 100;
    o.player!.ended = true;
    o.chapters[0].platformCompleted = true;
    await h.monitor.tick();
    expect(h.actions).toHaveLength(1);
    expect(h.engine.view().state).toBe('PAUSED');
    expect(h.writes.at(-1)!.pendingOperations.at(-1)!.status).toBe('awaiting-confirmation');
    expect((await h.monitor.start(true)).code).toBe('UNCONFIRMED_OPERATION');
  });

  it('导航未改变章节时不得重发', async () => {
    const h = await harness();
    h.navigationFails();
    const o = h.current();
    o.player!.currentTime = 100;
    o.player!.ended = true;
    o.chapters[0].platformCompleted = true;
    await h.monitor.tick();
    await h.monitor.tick();
    expect(h.actions).toHaveLength(1);
    expect(h.engine.view().state).toBe('PAUSED');
  });

  it('配置10秒普通轮询时章节冲突仍每3秒复核', async () => {
    const h = await harness({ polling: true, poll: 10000 });
    h.current().player!.ended = true;
    h.current().player!.currentTime = 100;
    await h.monitor.tick();
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.engine.view().state).toBe('PAUSED');
    expect(h.monitor.view().chapters[0].retries).toBe(3);
    h.monitor.dispose();
  });

  it('媒体监听之外默认每3秒轮询，用户导航即时暂停', async () => {
    const h = await harness({ polling: true });
    const baseline = h.reads();
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.reads()).toBe(baseline);
    expect(h.actions).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reads()).toBe(baseline + 1);
    expect(h.actions).toHaveLength(0);
    h.emit({ type: 'navigation' });
    expect(h.engine.signal.aborted).toBe(true);
    h.monitor.dispose();
  });
});
