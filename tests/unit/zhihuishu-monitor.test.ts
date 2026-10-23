import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../packages/contracts/src/config';
import type {
  MonitorSiteAdapter,
  SiteAction,
  SiteCapabilities,
  SiteObservation,
  SiteSignal,
} from '../../packages/contracts/src/monitor';
import { MonitorSession } from '../../packages/monitor/src/index';
import type { SnapshotInput, SnapshotStore } from '../../packages/persistence/src/index';
import { TaskEngine } from '../../packages/task-engine/src/index';

const capabilities = (patch: Partial<SiteCapabilities> = {}): SiteCapabilities => ({
  playbackRate: false,
  recoverPlay: false,
  refresh: false,
  navigation: false,
  completionMarkers: false,
  ...patch,
});

function observation(): SiteObservation {
  const observedAt = new Date().toISOString();
  return {
    course: {
      courseId: 'zhs_course_1',
      title: '脱敏真实 DOM 派生测试课程',
      observedAt,
      source: 'zhihuishu-dom',
      confidence: 'verified',
      authenticated: true,
      pageKind: 'course',
      platformCompleted: null,
      evidence: ['sanitized-dom-fixture'],
    },
    player: {
      chapterId: 'zhs_v1_chapter_1',
      currentTime: 10,
      duration: 100,
      playbackRate: 1.5,
      paused: false,
      buffering: false,
      ended: false,
      observedAt,
      confidence: 'verified',
    },
    chapters: ['zhs_v1_chapter_1', 'zhs_v1_chapter_2'].map((chapterId) => ({
      chapterId,
      title: chapterId,
      platformCompleted: null,
      observedAt,
      confidence: 'verified',
    })),
    currentChapterId: 'zhs_v1_chapter_1',
    supportedRates: [1, 1.25, 1.5],
    popup: 'none',
    safeToRefresh: false,
    capabilities: capabilities(),
  };
}

async function harness(initial = observation(), adapterKind = initial.course.source) {
  const actions: SiteAction[] = [];
  const writes: SnapshotInput[] = [];
  let listener: (event: SiteSignal) => void = () => {};
  let reads = 0;
  let beforeRead: ((read: number) => void) | null = null;
  let heldRead: Promise<SiteObservation> | null = null;
  let recoverWorks = true;
  let navigationMode: 'success' | 'unchanged' | 'source-regressed' | 'cancelled' | 'old-ended' =
    'success';
  let preparationFails = false;
  const prepared: SiteAction[] = [];
  const store: SnapshotStore = {
    load: async () => null,
    write: async (value) => {
      writes.push(structuredClone(value));
      return { ...structuredClone(value), integrityDigest: '0'.repeat(64) };
    },
  };
  const adapter: MonitorSiteAdapter = {
    kind: adapterKind,
    inspect: async () => ({ ...initial.course, observedAt: new Date().toISOString() }),
    observe: async () => {
      reads++;
      beforeRead?.(reads);
      if (heldRead) return heldRead;
      const at = new Date().toISOString();
      initial.course.observedAt = at;
      if (initial.player) initial.player.observedAt = at;
      initial.chapters.forEach((chapter) => (chapter.observedAt = at));
      return structuredClone(initial);
    },
    subscribe: async (fn) => {
      listener = fn;
      return () => (listener = () => {});
    },
    prepare: async (action, courseId, signal) => {
      signal.throwIfAborted();
      expect(courseId).toBe(initial.course.courseId);
      prepared.push(action);
      if (preparationFails) throw new Error('MENU_NOT_AVAILABLE');
    },
    perform: async (action, courseId, signal) => {
      signal.throwIfAborted();
      expect(courseId).toBe(initial.course.courseId);
      actions.push(action);
      if (action.type === 'set-rate') initial.player!.playbackRate = action.rate;
      if (action.type === 'recover-play' && recoverWorks) {
        initial.player!.paused = false;
        initial.player!.buffering = false;
        initial.player!.currentTime++;
      }
      if (action.type === 'navigate' && navigationMode !== 'unchanged') {
        initial.currentChapterId = initial.player!.chapterId = action.chapterId;
        initial.player!.currentTime = 0;
        initial.player!.ended = false;
        if (navigationMode === 'old-ended') {
          initial.player!.ended = true;
          initial.player!.currentTime = initial.player!.duration;
        }
        if (navigationMode === 'source-regressed')
          initial.chapters.find(
            (chapter) => chapter.chapterId === action.fromChapterId,
          )!.platformCompleted = false;
        if (navigationMode === 'cancelled') listener({ type: 'manual', action: 'chapter' });
      }
    },
  };
  const engine = new TaskEngine({
    store,
    stage2Capabilities: {
      enabled: true,
      inspect: (signal) => adapter.inspect(signal),
      backup: async () => true,
    },
  });
  const monitor = new MonitorSession({
    engine,
    config: () => ({ ...DEFAULT_CONFIG }),
    polling: false,
  });
  await engine.browserConnected();
  await monitor.attach(adapter);
  expect((await engine.confirmCourse(await adapter.inspect(), initial.course.courseId!)).ok).toBe(
    true,
  );
  const started = await monitor.start();
  return {
    current: initial,
    monitor,
    engine,
    actions,
    writes,
    prepared,
    started,
    reads: () => reads,
    onRead: (fn: (read: number) => void) => (beforeRead = fn),
    emit: (event: SiteSignal) => listener(event),
    hold: (value: Promise<SiteObservation>) => (heldRead = value),
    failRecovery: () => (recoverWorks = false),
    failPreparation: () => (preparationFails = true),
    setNavigationMode: (mode: typeof navigationMode) => (navigationMode = mode),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T08:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('真实 DOM 监测使用显式能力，派生测试不代表现场验收', () => {
  it('完成标记未知时仍观察播放器；达到81%与播放结束均不伪造完成或导航', async () => {
    const h = await harness();
    expect(h.started.ok).toBe(true);
    h.current.player!.currentTime = 81;
    const reads = h.reads();
    await h.monitor.tick();
    expect(h.reads() - reads).toBe(2);
    h.current.player!.currentTime = 100;
    h.current.player!.ended = true;
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('MONITORING');
    expect(h.actions).toHaveLength(0);
    expect(h.monitor.view().chapters.every((chapter) => chapter.platformCompleted === null)).toBe(
      true,
    );
    expect(h.monitor.view().chapters.every((chapter) => chapter.status !== 'confirmed')).toBe(true);
    expect(h.writes.at(-1)!.confirmedPlatformStatuses).toEqual([]);
  });

  it.each(['absent', 'false', 'true'] as const)(
    '%s历史倍速能力始终不授予自动调速，开始与继续保持手动倍速',
    async (state) => {
      for (const rate of [1, 1.25, 1.5]) {
        const o = observation();
        o.player!.playbackRate = rate;
        if (state === 'absent') delete o.capabilities;
        else o.capabilities!.playbackRate = state === 'true';
        const h = await harness(o);
        expect(h.started.ok).toBe(true);
        expect(DEFAULT_CONFIG.targetPlaybackRate).toBe(1.5);
        await h.engine.pause();
        expect((await h.monitor.start(true)).ok).toBe(true);
        await h.monitor.tick();
        expect(h.engine.view().state).toBe('MONITORING');
        expect(h.monitor.view().observation?.player?.playbackRate).toBe(rate);
        expect(h.current.player!.playbackRate).toBe(rate);
        expect(h.prepared).toHaveLength(0);
        expect(h.actions).toHaveLength(0);
        expect(h.writes.every((write) => write.pendingOperations.length === 0)).toBe(true);
        h.monitor.dispose();
      }
    },
  );

  it('内部遗留set-rate请求也立即拒绝，不进入控件准备与执行账本', async () => {
    const o = observation();
    o.capabilities = capabilities({ playbackRate: true });
    o.player!.playbackRate = 1;
    const h = await harness(o);
    const internal = h.monitor as unknown as {
      execute(
        action: SiteAction,
        before: SiteObservation,
        signal: AbortSignal,
      ): Promise<{ ok: boolean; code: string }>;
    };
    expect(
      await internal.execute(
        { type: 'set-rate', rate: 1.5, chapterId: o.currentChapterId! },
        o,
        h.engine.signal,
      ),
    ).toMatchObject({ ok: false, code: 'AUTOMATIC_RATE_DISABLED' });
    expect(h.prepared).toHaveLength(0);
    expect(h.actions).toHaveLength(0);
    expect(h.writes.every((write) => write.pendingOperations.length === 0)).toBe(true);
  });

  it('手动在网站改变倍速会暂停，人工继续后保留该读数且不覆盖', async () => {
    const o = observation();
    o.capabilities = capabilities({ playbackRate: true });
    const h = await harness(o);
    h.emit({ type: 'manual', action: 'rate' });
    h.current.player!.playbackRate = 1.25;
    expect(h.engine.view().state).toBe('PAUSED');
    expect((await h.monitor.start(true)).ok).toBe(true);
    expect(h.monitor.view().observation?.player?.playbackRate).toBe(1.25);
    expect(h.actions).toHaveLength(0);
    expect(h.writes.every((write) => write.pendingOperations.length === 0)).toBe(true);
    expect(h.engine.view().state).toBe('MONITORING');
  });

  it('控件准备失败在意图落盘前暂停，零操作记录、零课程动作', async () => {
    const o = observation();
    o.capabilities = capabilities({ recoverPlay: true });
    const h = await harness(o);
    h.current.player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(DEFAULT_CONFIG.bufferTimeoutMs);
    h.failPreparation();
    await h.monitor.tick();
    expect(h.prepared).toEqual([{ type: 'recover-play', chapterId: 'zhs_v1_chapter_1' }]);
    expect(h.actions).toHaveLength(0);
    expect(h.writes.every((write) => write.pendingOperations.length === 0)).toBe(true);
    expect(h.engine.view()).toMatchObject({ state: 'PAUSED', cancelled: true });
  });

  it.each(['absent', 'revoked'] as const)(
    '准备动作时恢复播放能力%s会取消，不写执行意图且零动作',
    async (change) => {
      const o = observation();
      o.capabilities = capabilities({ recoverPlay: true });
      const h = await harness(o);
      h.current.player!.buffering = true;
      await h.monitor.tick();
      vi.advanceTimersByTime(DEFAULT_CONFIG.bufferTimeoutMs);
      const nextRead = h.reads() + 2;
      h.onRead((read) => {
        if (read === nextRead) {
          if (change === 'absent') delete h.current.capabilities;
          else h.current.capabilities!.recoverPlay = false;
        }
      });
      await h.monitor.tick();
      expect(h.actions).toHaveLength(0);
      expect(h.engine.view().state).toBe('PAUSED');
      expect(h.writes.every((write) => write.pendingOperations.length === 0)).toBe(true);
    },
  );

  it('恢复播放能力未授予时缓冲超时会暂停，不能恢复或刷新', async () => {
    const h = await harness();
    h.current.player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(DEFAULT_CONFIG.bufferTimeoutMs);
    await h.monitor.tick();
    expect(h.actions).toHaveLength(0);
    expect(h.engine.view().state).toBe('PAUSED');
  });

  it('恢复播放能力明确授予后可恢复，成功后不重复恢复', async () => {
    const o = observation();
    o.capabilities = capabilities({ recoverPlay: true });
    const h = await harness(o);
    h.current.player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(DEFAULT_CONFIG.bufferTimeoutMs);
    await h.monitor.tick();
    await h.monitor.tick();
    expect(h.actions.map((action) => action.type)).toEqual(['recover-play']);
    expect(h.engine.view().state).toBe('MONITORING');
  });

  it('即使safeToRefresh为true，真实刷新能力未授予仍不得刷新', async () => {
    const o = observation();
    o.capabilities = capabilities({ recoverPlay: true });
    o.safeToRefresh = true;
    const h = await harness(o);
    h.failRecovery();
    h.current.player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(DEFAULT_CONFIG.bufferTimeoutMs);
    await h.monitor.tick();
    vi.advanceTimersByTime(5000);
    await h.monitor.tick();
    expect(h.actions.map((action) => action.type)).toEqual(['recover-play']);
    expect(h.engine.refreshAttempts).toBe(0);
    expect(h.engine.view().state).toBe('PAUSED');
  });

  it.each([
    { completionMarkers: false, navigation: true },
    { completionMarkers: true, navigation: false },
  ])('导航要求同时授予完成标记和导航能力 %j', async (patch) => {
    const o = observation();
    o.capabilities = capabilities(patch);
    const h = await harness(o);
    h.current.chapters[0].platformCompleted = true;
    h.current.chapters[1].platformCompleted = false;
    h.current.player!.currentTime = 100;
    h.current.player!.ended = true;
    await h.monitor.tick();
    expect(h.actions).toHaveLength(0);
    expect(h.engine.view().state).toBe('MONITORING');
  });

  it('真实当前章变化会暂停并清除人工确认，即使新章节仍在目录中', async () => {
    const h = await harness();
    h.current.currentChapterId = h.current.player!.chapterId = 'zhs_v1_chapter_2';
    await h.monitor.tick();
    expect(h.actions).toHaveLength(0);
    expect(h.engine.view().state).toBe('PAUSED');
    expect(h.engine.confirmedCourse).toBeNull();
    expect(h.engine.confirmedSource).toBeNull();
  });

  it('真实导航反馈完成落盘后推进受保护当前章，后续轮询可继续监测', async () => {
    const o = observation();
    o.capabilities = capabilities({ completionMarkers: true, navigation: true });
    o.chapters.forEach((chapter) => (chapter.platformCompleted = false));
    const h = await harness(o);
    h.current.chapters[0].platformCompleted = true;
    h.current.player!.ended = true;
    h.current.player!.currentTime = 100;
    await h.monitor.tick();
    expect(h.actions).toEqual([
      {
        type: 'navigate',
        chapterId: 'zhs_v1_chapter_2',
        fromChapterId: 'zhs_v1_chapter_1',
      },
    ]);
    expect(h.writes.at(-1)!.pendingOperations[0]).toMatchObject({
      kind: 'chapter-navigation',
      status: 'completed',
    });
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('MONITORING');
    expect(h.engine.confirmedCourse).toBe('zhs_course_1');
    expect(h.monitor.view().observation?.currentChapterId).toBe('zhs_v1_chapter_2');
    expect(h.writes.at(-1)!.chapterId).toBe('zhs_v1_chapter_2');
    expect(h.actions).toHaveLength(1);
    h.current.currentChapterId = h.current.player!.chapterId = 'zhs_v1_chapter_1';
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('PAUSED');
    expect(h.engine.confirmedCourse).toBeNull();
    expect(h.actions).toHaveLength(1);
  });

  it.each(['unchanged', 'source-regressed', 'cancelled', 'old-ended'] as const)(
    '真实导航%s结果不推进受保护当前章，暂停且未知操作不重发',
    async (mode) => {
      const o = observation();
      o.capabilities = capabilities({ completionMarkers: true, navigation: true });
      o.chapters.forEach((chapter) => (chapter.platformCompleted = false));
      const h = await harness(o);
      h.setNavigationMode(mode);
      h.current.chapters[0].platformCompleted = true;
      h.current.player!.ended = true;
      h.current.player!.currentTime = 100;
      await h.monitor.tick();
      expect(h.engine.view().state).toBe('PAUSED');
      expect(h.actions).toHaveLength(1);
      expect(h.writes.at(-1)!.pendingOperations[0].status).toBe('awaiting-confirmation');
      expect((h.monitor as unknown as { realChapterId: string | null }).realChapterId).toBe(
        'zhs_v1_chapter_1',
      );
      await h.monitor.tick();
      expect(h.actions).toHaveLength(1);
      expect((await h.monitor.start(true)).code).toBe('UNCONFIRMED_OPERATION');
    },
  );

  it.each(['authentication', 'unknown-source', 'fixture-source', 'graded'] as const)(
    '%s变化暂停并清除确认，不能因保留相同课程ID继续',
    async (change) => {
      const h = await harness();
      if (change === 'authentication') h.current.course.authenticated = 'unknown';
      if (change === 'unknown-source') h.current.course.source = 'real-unverified';
      if (change === 'fixture-source') h.current.course.source = 'fixture';
      if (change === 'graded') h.current.course.pageKind = 'graded';
      await h.monitor.tick();
      expect(h.actions).toHaveLength(0);
      expect(h.engine.view().state).toBe('PAUSED');
      expect(h.engine.confirmedCourse).toBeNull();
    },
  );

  it('适配器kind与真实来源不一致时首次观察即暂停，不复用fixture授权', async () => {
    const h = await harness(observation(), 'fixture');
    expect(h.started).toMatchObject({ ok: false, code: 'MONITOR_PAUSED' });
    expect(h.actions).toHaveLength(0);
    expect(h.engine.confirmedCourse).toBeNull();
  });

  it('真实练习弹窗导致登录观察未知时，先明确提示手动处理并禁止所有动作', async () => {
    const o = observation();
    const h = await harness(o);
    h.current.popup = 'present';
    h.current.course.authenticated = 'unknown';
    h.current.course.confidence = 'uncertain';
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('PAUSED');
    expect(h.engine.view().reason).toContain('发现页面弹窗');
    expect(h.engine.confirmedCourse).toBeNull();
    expect(h.actions).toEqual([]);
    expect(h.writes.at(-1)!.pendingOperations).toEqual([]);
  });

  it.each(['present', 'unknown'] as const)('弹窗%s立即暂停，禁止恢复动作', async (popup) => {
    const o = observation();
    o.capabilities = capabilities({ recoverPlay: true });
    const h = await harness(o);
    h.current.player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(DEFAULT_CONFIG.bufferTimeoutMs);
    h.current.popup = popup;
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('PAUSED');
    expect(h.actions).toHaveLength(0);
  });

  it('人工关键操作先取消，迟到的恢复播放观察仍不得发动作', async () => {
    const o = observation();
    o.capabilities = capabilities({ recoverPlay: true });
    const h = await harness(o);
    h.current.player!.buffering = true;
    await h.monitor.tick();
    vi.advanceTimersByTime(DEFAULT_CONFIG.bufferTimeoutMs);
    let resolve!: (value: SiteObservation) => void;
    h.hold(new Promise((done) => (resolve = done)));
    const work = h.monitor.tick();
    h.emit({ type: 'manual', action: 'pause' });
    expect(h.engine.signal.aborted).toBe(true);
    resolve(structuredClone(h.current));
    await work;
    expect(h.actions).toHaveLength(0);
    expect(h.engine.view().state).toBe('PAUSED');
  });
});
