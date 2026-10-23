import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '../../packages/contracts/src/index';
import type {
  MonitorSiteAdapter,
  SiteAction,
  SiteObservation,
  SiteSignal,
} from '../../packages/contracts/src/monitor';
import { DEFAULT_CONFIG } from '../../packages/contracts/src/config';
import { MonitorSession } from '../../packages/monitor/src/index';
import { PracticeSession } from '../../packages/practice/src/index';
import { TaskEngine } from '../../packages/task-engine/src/index';
import { course, memory, PracticeFaultAdapter } from '../helpers/stage3';

async function harness(enabled = true) {
  const storage = memory(),
    actions: SiteAction[] = [];
  const at = new Date().toISOString();
  const current: SiteObservation = {
    course: course(),
    currentChapterId: 'chapter-1',
    popup: 'none',
    safeToRefresh: true,
    supportedRates: [1],
    player: {
      chapterId: 'chapter-1',
      currentTime: 10,
      duration: 100,
      playbackRate: 1,
      paused: false,
      ended: false,
      buffering: false,
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
  };
  let listener = (_event: SiteSignal) => {},
    active: PracticeFaultAdapter | null = null,
    calls = 0;
  let custom: (() => Promise<Result>) | undefined;
  const adapter: MonitorSiteAdapter = {
    kind: 'fixture',
    inspect: async () => ({ ...course() }),
    observe: async () => {
      const now = new Date().toISOString();
      current.course.observedAt = current.player!.observedAt = now;
      current.chapters.forEach((chapter) => (chapter.observedAt = now));
      return structuredClone(current);
    },
    subscribe: async (value) => {
      listener = value;
      return () => {
        listener = () => {};
      };
    },
    perform: async (action, _course, signal) => {
      signal.throwIfAborted();
      actions.push(action);
      if (action.type === 'navigate') {
        current.currentChapterId = current.player!.chapterId = action.chapterId;
        current.player!.currentTime = 0;
        current.player!.ended = false;
        current.player!.paused = false;
      }
    },
  };
  const engine = new TaskEngine({
    store: storage.store,
    stage3FixturePractice: true,
    stage2Capabilities: {
      enabled: true,
      inspect: () => adapter.inspect(),
      backup: async () => true,
    },
  });
  const monitor = new MonitorSession({
    engine,
    config: () => DEFAULT_CONFIG,
    polling: false,
    ...(enabled
      ? {
          practice: async () => {
            calls++;
            if (custom) return custom();
            if (!active) throw Error('NO_FIXTURE_PRACTICE');
            return new PracticeSession(engine, active).run();
          },
        }
      : {}),
  });
  await engine.browserConnected();
  await monitor.attach(adapter);
  await engine.confirmCourse(await adapter.inspect(), 'stage3-course');
  expect((await monitor.start()).ok).toBe(true);
  function popup(reply: 'correct' | 'incorrect' | 'unknown' = 'correct') {
    current.popup = 'present';
    current.player!.paused = true;
    const exercise = new PracticeFaultAdapter();
    exercise.current.popupId = `fixture-popup-${calls + 1}`;
    exercise.reply = reply;
    exercise.capture = vi.fn(async () => {
      throw Error('OCR_NOT_INSTALLED');
    });
    const perform = exercise.perform.bind(exercise);
    exercise.perform = async (...args) => {
      await perform(...args);
      if (args[0].type === 'close') current.popup = 'none';
      if (args[0].type === 'restore') {
        current.player!.paused = false;
        current.player!.currentTime += 0.1;
      }
    };
    active = exercise;
    return exercise;
  }
  return {
    engine,
    monitor,
    storage,
    current,
    actions,
    popup,
    emit: (event: SiteSignal) => listener(event),
    setHandler: (value: () => Promise<Result>) => {
      custom = value;
    },
    get calls() {
      return calls;
    },
  };
}
const fakeSuccess = (): Result => ({
  ok: true,
  code: 'FIXTURE_ONLY',
  message: '模拟结果',
  correlationId: 'fixture-only',
});
afterEach(() => vi.useRealTimers());

describe('阶段3 DOM连续衔接（内存fixture，待真实环境人工验收）', () => {
  it('三次新弹题各随机一次、自动关闭恢复，完成标记+结束后按既有规则切章，无模型', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = await harness();
    const exercises: PracticeFaultAdapter[] = [];
    for (const reply of ['correct', 'incorrect'] as const) {
      vi.setSystemTime(Date.now() + 5100);
      const exercise = h.popup(reply);
      exercises.push(exercise);
      await h.monitor.tick();
      await h.monitor.tick();
      expect(h.engine.view().state, h.engine.view().reason).toBe('MONITORING');
      expect(h.current.popup).toBe('none');
      expect(h.current.player!.paused).toBe(false);
    }
    h.current.player!.currentTime = 100;
    h.current.player!.ended = true;
    h.current.chapters[0].platformCompleted = true;
    await h.monitor.tick();
    expect(h.actions).toEqual([
      { type: 'navigate', fromChapterId: 'chapter-1', chapterId: 'chapter-2' },
    ]);
    vi.setSystemTime(Date.now() + 5100);
    exercises.push(h.popup('incorrect'));
    await h.monitor.tick();
    expect(h.calls).toBe(3);
    for (const exercise of exercises) {
      expect(exercise.submissions()).toHaveLength(1);
      expect(exercise.actions.map((a) => a.type)).toEqual(['pause', 'submit', 'close', 'restore']);
      expect(exercise.capture).not.toHaveBeenCalled();
    }
    expect(h.engine.view().state).toBe('MONITORING');
    expect(h.storage.snapshot()!.pendingOperations.every((o) => o.status === 'completed')).toBe(
      true,
    );
    expect(new Set(h.storage.snapshot()!.pendingOperations.map((o) => o.operationId)).size).toBe(
      13,
    );
    h.monitor.dispose();
  });
  it.each(['proceed', 'pause'])('新题自动等候既有5秒冷却，%s时只按实际状态继续', async (kind) => {
    vi.useFakeTimers();
    const h = await harness();
    h.popup();
    await h.monitor.tick();
    const next = h.popup('incorrect'),
      running = h.monitor.tick();
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.calls).toBe(1);
    expect(next.submissions()).toHaveLength(0);
    if (kind === 'pause') {
      await h.engine.pause();
      await running;
      await vi.advanceTimersByTimeAsync(100);
      expect(h.calls).toBe(1);
      expect(next.submissions()).toHaveLength(0);
    } else {
      await vi.advanceTimersByTimeAsync(2);
      await running;
      expect(h.calls).toBe(2);
      expect(next.submissions()).toHaveLength(1);
      expect(h.engine.view().state).toBe('MONITORING');
    }
    h.monitor.dispose();
  });
  it.each(['chapter', 'catalog', 'popup'])('冷却等待期间%s变化，零新增选择并停止', async (kind) => {
    vi.useFakeTimers();
    const h = await harness();
    h.popup();
    await h.monitor.tick();
    const next = h.popup(),
      running = h.monitor.tick();
    await vi.advanceTimersByTimeAsync(1);
    if (kind === 'chapter') h.current.currentChapterId = h.current.player!.chapterId = 'chapter-2';
    if (kind === 'catalog') h.current.chapters.reverse();
    if (kind === 'popup') h.current.popup = 'none';
    await vi.advanceTimersByTimeAsync(5000);
    await running;
    expect(h.calls).toBe(1);
    expect(next.submissions()).toHaveLength(0);
    expect(h.engine.view().state).toBe('PAUSED');
    h.monitor.dispose();
  });
  it.each(['exam', 'graded', 'unknown'] as const)(
    '%s弹窗零提交且停止连续运行',
    async (classification) => {
      const h = await harness(),
        exercise = h.popup();
      exercise.current.classification = classification;
      await h.monitor.tick();
      await h.monitor.tick();
      expect(exercise.submissions()).toHaveLength(0);
      expect(h.actions).toHaveLength(0);
      expect(h.engine.view().state).toBe('PAUSED');
      expect(h.calls).toBe(1);
      h.monitor.dispose();
    },
  );
  it('未知回执只发一次，重复tick不重发、不关闭、旧未知阻止继续', async () => {
    const h = await harness(),
      exercise = h.popup('unknown');
    await h.monitor.tick();
    await h.monitor.tick();
    expect(exercise.submissions()).toHaveLength(1);
    expect(exercise.actions.some((a) => a.type === 'close' || a.type === 'restore')).toBe(false);
    expect(h.storage.snapshot()!.pendingOperations.at(-1)?.status).toBe('awaiting-confirmation');
    expect((await h.engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
    expect(h.calls).toBe(1);
    h.monitor.dispose();
  });
  it('DOM读取等待时人工暂停，迟到结果不能选择或继续', async () => {
    const h = await harness(),
      exercise = h.popup();
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        reached = r;
      }),
      wait = new Promise<void>((r) => {
        release = r;
      });
    const original = exercise.question.bind(exercise);
    exercise.question = async () => {
      reached();
      await wait;
      return original();
    };
    const running = h.monitor.tick();
    await ready;
    h.emit({ type: 'manual', action: 'pause' });
    await running;
    release();
    await Promise.resolve();
    expect(exercise.submissions()).toHaveLength(0);
    expect(h.engine.view().state).toBe('PAUSED');
    h.monitor.dispose();
  });
  it('课程观察不匹配时不进入练习处理器', async () => {
    const h = await harness(),
      exercise = h.popup();
    h.current.course.courseId = 'other-course';
    await h.monitor.tick();
    expect(h.calls).toBe(0);
    expect(exercise.submissions()).toHaveLength(0);
    expect(h.engine.view().state).toBe('PAUSED');
    h.monitor.dispose();
  });
  it.each(['popup-remains', 'chapter-changed'])(
    '处理器声称成功但%s，重新观察后停止',
    async (kind) => {
      const h = await harness();
      h.popup();
      h.setHandler(async () => {
        if (kind === 'chapter-changed') {
          h.current.popup = 'none';
          h.current.currentChapterId = h.current.player!.chapterId = 'chapter-2';
        }
        return fakeSuccess();
      });
      await h.monitor.tick();
      expect(h.engine.view().state).toBe('PAUSED');
      expect(h.actions).toHaveLength(0);
      h.monitor.dispose();
    },
  );
  it.each(['failed', 'thrown'])('处理器%s不会自动继续或切章', async (kind) => {
    const h = await harness();
    h.popup();
    h.setHandler(async () => {
      if (kind === 'thrown') throw Error('FIXTURE_FAILURE');
      return { ...fakeSuccess(), ok: false };
    });
    await h.monitor.tick();
    expect(h.engine.view().state).toBe('PAUSED');
    expect(h.actions).toHaveLength(0);
    h.monitor.dispose();
  });
  it('未显式接入练习时保留原监测弹窗暂停规则', async () => {
    const h = await harness(false),
      exercise = h.popup();
    await h.monitor.tick();
    expect(h.calls).toBe(0);
    expect(exercise.actions).toHaveLength(0);
    expect(h.engine.view().state).toBe('PAUSED');
    h.monitor.dispose();
  });
});
