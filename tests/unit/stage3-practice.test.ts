import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PracticeContext, PracticeQuestion } from '../../packages/contracts/src/practice';
import { PracticeSession } from '../../packages/practice/src/index';
import {
  course,
  memory,
  PracticeFaultAdapter,
  fixedRandom,
  sampleQuestion,
  setup,
} from '../helpers/stage3';
import { TaskEngine } from '../../packages/task-engine/src/index';

afterEach(() => vi.useRealTimers());
describe('阶段3保护链：只在明确非计分fixture中辅助', () => {
  it('默认仅DOM：残缺内容也不截图或启动已提供的OCR，零提交', async () => {
    const { engine } = await setup();
    const adapter = new PracticeFaultAdapter();
    adapter.currentQuestion = null;
    const capture = vi.spyOn(adapter, 'capture'),
      recognize = vi.fn(async () => {
        throw Error('MODELS_NOT_INSTALLED');
      });
    expect(
      (await new PracticeSession(engine, adapter, { recognize }, fixedRandom()).run()).code,
    ).toBe('QUESTION_INCOMPLETE');
    expect(capture).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    expect(adapter.submissions()).toHaveLength(0);
  });
  it.each<Partial<PracticeContext>>([
    { classification: 'exam' },
    { classification: 'graded' },
    { classification: 'unknown' },
    { explicitNonGraded: false },
    { source: 'real-unverified' },
    { authenticated: false },
    { courseId: 'other' },
  ])('危险页面 %j 分类前不启动OCR或随机选择', async (patch) => {
    const { engine } = await setup();
    const adapter = new PracticeFaultAdapter();
    Object.assign(adapter.current, patch);
    const ocr = { recognize: vi.fn() },
      randomIndex = vi.fn(() => 0);
    expect((await new PracticeSession(engine, adapter, ocr, { randomIndex }).run()).ok).toBe(false);
    expect(adapter.actions).toEqual([]);
    expect(ocr.recognize).not.toHaveBeenCalled();
    expect(randomIndex).not.toHaveBeenCalled();
    expect(engine.view().state).toBe('PAUSED');
  });
  it.each<Partial<PracticeQuestion>>([
    { complete: false },
    { type: 'unknown' as never },
    { stem: '' },
    {
      options: [
        { id: 'A', text: '正确' },
        { id: 'B', text: '正确' },
      ],
    },
  ])('文本残缺/题型/映射不确定 %j 零提交', async (patch) => {
    const { engine } = await setup();
    const adapter = new PracticeFaultAdapter();
    Object.assign(adapter.currentQuestion!, patch);
    const output = await new PracticeSession(engine, adapter, undefined, fixedRandom()).run();
    expect(output.ok).toBe(false);
    expect(adapter.submissions()).toHaveLength(0);
  });
  it('DOM完整时不调用OCR；提交与关闭/恢复均有独立四步账本，不保存原文', async () => {
    const { engine, storage } = await setup();
    const adapter = new PracticeFaultAdapter();
    const ocr = { recognize: vi.fn() };
    const session = new PracticeSession(engine, adapter, ocr, fixedRandom());
    expect((await session.run()).ok).toBe(true);
    expect(ocr.recognize).not.toHaveBeenCalled();
    expect(adapter.actions.map((action) => action.type)).toEqual([
      'pause',
      'submit',
      'close',
      'restore',
    ]);
    expect(engine.view().state).toBe('MONITORING');
    const operations = storage.snapshot()!.pendingOperations;
    for (const op of operations) {
      const states = storage.writes
        .map(
          (write) =>
            write.pendingOperations.find((entry) => entry.operationId === op.operationId)?.status,
        )
        .filter(Boolean);
      expect([...new Set(states)]).toEqual([
        'pending',
        'executing',
        'awaiting-confirmation',
        'completed',
      ]);
      expect(Object.keys(op).sort()).toEqual([
        'kind',
        'operationId',
        'savedAt',
        'status',
        'taskId',
      ]);
    }
    expect(JSON.stringify(storage.writes)).not.toMatch(/光合作用|正确|错误|optionIds|correctTexts/);
    expect((await session.run()).code).toBe('PRACTICE_SESSION_CONSUMED');
    expect(adapter.submissions()).toHaveLength(1);
  });
  it('原先暂停只随机作答与关闭，不恢复播放', async () => {
    const { engine } = await setup();
    const adapter = new PracticeFaultAdapter();
    adapter.currentVideo.paused = true;
    const output = await new PracticeSession(engine, adapter, undefined, fixedRandom()).run();
    expect(output.ok).toBe(true);
    expect(adapter.actions.map((a) => a.type)).toEqual(['submit', 'close']);
    expect(output.data?.strategy).toBe('random');
  });
  it('明确错误反馈直接关闭恢复，仅一个作答ID且不纠错', async () => {
    const { engine, storage } = await setup();
    const adapter = new PracticeFaultAdapter();
    adapter.reply = 'incorrect';
    const result = await new PracticeSession(engine, adapter, undefined, fixedRandom()).run();
    expect(result).toMatchObject({
      ok: true,
      data: { strategy: 'random', attempts: 1, feedbackStatus: 'incorrect' },
    });
    expect(adapter.actions.map((a) => a.type)).toEqual(['pause', 'submit', 'close', 'restore']);
    expect(adapter.submissions()).toHaveLength(1);
    expect(storage.snapshot()!.pendingOperations.some((op) => op.kind === 'practice-correct')).toBe(
      false,
    );
  });
  it('错误反馈不需要正确答案文本，也不增加第二次作答', async () => {
    const { engine } = await setup();
    const adapter = new PracticeFaultAdapter();
    adapter.reply = 'incorrect';
    adapter.correctTexts = undefined;
    expect((await new PracticeSession(engine, adapter, undefined, fixedRandom(1)).run()).ok).toBe(
      true,
    );
    expect(adapter.submissions()).toHaveLength(1);
    expect(adapter.submissions()[0]).toMatchObject({ optionIds: ['B'] });
  });
  it('错误反馈的receipt不匹配也不能关闭或恢复', async () => {
    const { engine, storage } = await setup();
    const adapter = new PracticeFaultAdapter();
    adapter.reply = 'incorrect';
    adapter.feedback = async () => ({ status: 'incorrect', receipt: 'unrelated' });
    expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
      false,
    );
    expect(adapter.submissions()).toHaveLength(1);
    expect(adapter.actions.some((a) => a.type === 'close' || a.type === 'restore')).toBe(false);
    expect(
      storage
        .snapshot()!
        .pendingOperations.some(
          (op) => op.kind === 'practice-submit' && op.status === 'awaiting-confirmation',
        ),
    ).toBe(true);
  });
  it('结果未知留在等待确认，恢复/重建helper/同ID均不能重复提交', async () => {
    const { engine, storage } = await setup();
    const adapter = new PracticeFaultAdapter();
    adapter.reply = 'unknown';
    // Engine locks and aborts the task as soon as feedback is unknown; the outer wait is cancelled.
    expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
      false,
    );
    const unknown = storage
      .snapshot()!
      .pendingOperations.find((op) => op.kind === 'practice-submit')!;
    expect(unknown.status).toBe('awaiting-confirmation');
    expect((await engine.resume()).code).toBe('UNCONFIRMED_OPERATION');
    expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
      false,
    );
    expect(adapter.submissions()).toHaveLength(1);
    const recovered = new TaskEngine({
      store: storage.store,
      stage3FixturePractice: true,
      stage2Capabilities: {
        enabled: true,
        inspect: async () => course(),
        backup: async () => true,
      },
    });
    await recovered.browserConnected();
    await recovered.confirmCourse(course(), 'stage3-course');
    expect((await recovered.resume()).code).toBe('UNCONFIRMED_OPERATION');
    expect(
      storage.snapshot()!.pendingOperations.find((op) => op.operationId === unknown.operationId)
        ?.status,
    ).toBe('awaiting-confirmation');
  });
  it('关键写入失败或题目读取后分类变化都零提交', async () => {
    const { engine, storage } = await setup();
    const adapter = new PracticeFaultAdapter();
    adapter.currentVideo.paused = true;
    const write = storage.store.write.bind(storage.store);
    storage.store.write = async (input) => {
      if (
        input.pendingOperations.some(
          (op) => op.kind === 'practice-submit' && op.status === 'executing',
        )
      )
        throw Error('disk');
      return write(input);
    };
    expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
      false,
    );
    expect(adapter.submissions()).toHaveLength(0);
    expect(engine.view().persistenceHealthy).toBe(false);
    const next = await setup(),
      changing = new PracticeFaultAdapter(),
      question = changing.question.bind(changing);
    changing.question = async () => {
      const q = await question();
      changing.current.classification = 'graded';
      return q;
    };
    expect(
      (await new PracticeSession(next.engine, changing, undefined, fixedRandom()).run()).ok,
    ).toBe(false);
    expect(changing.submissions()).toHaveLength(0);
  });
  it.each(['question', 'feedback', 'prepare'] as const)(
    '用户暂停取消%s等待，不接受迟到结果',
    async (stage) => {
      const { engine } = await setup();
      const adapter = new PracticeFaultAdapter();
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => {
          reached = r;
        }),
        waiting = new Promise<void>((r) => {
          release = r;
        });
      if (stage === 'question') {
        const question = adapter.question.bind(adapter);
        adapter.question = async () => {
          const result = await question();
          reached();
          await waiting;
          return result;
        };
      }
      if (stage === 'feedback') {
        const feedback = adapter.feedback.bind(adapter);
        adapter.feedback = async () => {
          const value = await feedback();
          reached();
          await waiting;
          return value;
        };
      }
      if (stage === 'prepare') {
        const prepare = adapter.prepare.bind(adapter);
        adapter.prepare = async (...args) => {
          if (args[0].type === 'submit') {
            reached();
            await waiting;
          }
          await prepare(...args);
        };
      }
      const work = new PracticeSession(engine, adapter, undefined, fixedRandom()).run();
      await ready;
      const pausedBefore = adapter.currentVideo.paused;
      const pausing = engine.pause();
      expect(engine.signal.aborted).toBe(true);
      await pausing;
      expect((await work).ok).toBe(false);
      release();
      await Promise.resolve();
      expect(adapter.currentVideo.paused).toBe(pausedBefore);
      expect(adapter.submissions()).toHaveLength(stage === 'feedback' ? 1 : 0);
    },
  );
  it.each(['media', 'manual'] as const)(
    '媒体换代/人工关键操作 %s 后禁止恢复和继续提交',
    async (mode) => {
      const { engine } = await setup();
      const adapter = new PracticeFaultAdapter();
      const verify = adapter.verify.bind(adapter);
      adapter.verify = async () => {
        if (adapter.actions.at(-1)?.type === 'close') {
          if (mode === 'media') adapter.currentVideo.generation++;
          else adapter.currentVideo.manualRevision++;
        }
        return verify();
      };
      expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).ok).toBe(
        false,
      );
      expect(adapter.actions.some((action) => action.type === 'restore')).toBe(false);
    },
  );
  it('默认任务未授予阶段3能力，不能伪装fixture-mutation进入练习', async () => {
    const { engine } = await setup(false);
    const adapter = new PracticeFaultAdapter();
    expect((await new PracticeSession(engine, adapter, undefined, fixedRandom()).run()).code).toBe(
      'PRACTICE_LOCKED',
    );
    expect(adapter.actions).toEqual([]);
  });
  it('历史schema1未知账本不丢失，新增配置不触发自动恢复', async () => {
    const legacy = memory();
    const initial = await setup(true, legacy);
    await initial.engine.pause();
    const snapshot = legacy.snapshot()!;
    snapshot.pendingOperations.push({
      operationId: 'historical-unknown',
      taskId: snapshot.taskId!,
      kind: 'playback-rate',
      status: 'awaiting-confirmation',
      savedAt: new Date().toISOString(),
    });
    const stored = memory(snapshot);
    const engine = new TaskEngine({ store: stored.store, stage3FixturePractice: true });
    await engine.init();
    expect(stored.snapshot()!.pendingOperations).toEqual(snapshot.pendingOperations);
    expect(engine.view().cancelled).toBe(true);
  });
  it('OCR高置信度也不能把残缺文字作为完整题目', async () => {
    const { engine } = await setup();
    const adapter = new PracticeFaultAdapter();
    adapter.currentQuestion = null;
    const recognize = vi.fn(async () => ({ text: '单选\n题干:残缺', confidence: 1 }));
    expect(
      (
        await new PracticeSession(
          engine,
          adapter,
          { recognize },
          { ...fixedRandom(), recognition: 'legacy-ocr' },
        ).run()
      ).code,
    ).toBe('OCR_EXHAUSTED');
    expect(recognize).toHaveBeenCalledTimes(4);
    expect(adapter.submissions()).toHaveLength(0);
  });
  it('单选/多选/判断的随机结果只使用完整题目的稳定ID', async () => {
    for (const type of ['single', 'multiple', 'boolean'] as const) {
      const { engine } = await setup();
      const adapter = new PracticeFaultAdapter();
      adapter.currentQuestion = { ...sampleQuestion(), type };
      const result = await new PracticeSession(engine, adapter, undefined, {
        randomIndex: (upper) => upper - 1,
      }).run();
      expect(result.ok).toBe(true);
      expect(adapter.submissions()[0]).toMatchObject({
        optionIds: type === 'multiple' ? ['A', 'B'] : ['B'],
      });
    }
  });
  it('OCR兜底完整文本才能映射，成功后保留聚合数据而非原文', async () => {
    const { engine, storage } = await setup();
    const adapter = new PracticeFaultAdapter();
    adapter.currentQuestion = null;
    const recognize = vi.fn(async () => ({
      text: '单选\n题干：光合作用需要二氧化碳吗\nA：正确\nB：错误\n结束：2',
      confidence: 0.95,
    }));
    const result = await new PracticeSession(
      engine,
      adapter,
      { recognize },
      { ...fixedRandom(), recognition: 'legacy-ocr' },
    ).run();
    expect(result.ok).toBe(true);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(adapter.submissions()).toHaveLength(1);
    expect(JSON.stringify([result, storage.snapshot()])).not.toContain('光合作用');
  });
  it('同ID绝无第二次提交；纠正未满足前置条件或重复类型不能执行', async () => {
    const { engine } = await setup();
    expect((await engine.beginPractice()).ok).toBe(true);
    const issue = vi.fn(async () => undefined);
    const corrective = {
      operationId: 'correction-without-submit',
      kind: 'practice-correct' as const,
      issue,
      verify: async () => 'confirmed' as const,
    };
    expect((await engine.execute(corrective)).code).toBe('PRACTICE_BUDGET');
    expect(issue).not.toHaveBeenCalled();
    const submit = {
      ...corrective,
      operationId: 'unique-submit',
      kind: 'practice-submit' as const,
    };
    expect((await engine.execute(submit)).ok).toBe(true);
    expect((await engine.execute(submit)).code).toBe('DUPLICATE_OPERATION');
    expect((await engine.execute({ ...submit, operationId: 'second-submit' })).code).toBe(
      'PRACTICE_BUDGET',
    );
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
