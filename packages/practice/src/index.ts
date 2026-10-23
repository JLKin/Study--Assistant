import { randomUUID } from 'node:crypto';
import { bounded } from '../../contracts/src/async';
import type { Result } from '../../contracts/src/index';
import type {
  PracticeAction,
  PracticeFeedback,
  PracticeQuestion,
  PracticeSiteAdapter,
  QuestionType,
} from '../../contracts/src/practice';
import type { OcrProvider } from '../../ocr/src/index';
import type { TaskEngine, GuardedOperation } from '../../task-engine/src/index';
import { eligible, parseOcrQuestion, validateQuestion } from './question';
import { randomOptionIds } from './random';

/** Only these aggregate values may be included in reports; no question/answer payload. */
export interface PracticeStatistics {
  questionType: QuestionType | null;
  attempts: number;
  strategy: 'random';
  feedbackStatus: 'correct' | 'incorrect' | null;
  elapsedMs: number;
  completionMode?: 'already-answered';
  existingFeedbackStatus?: 'correct' | 'incorrect';
}
export interface PracticeOptions {
  /** Injectable entropy for deterministic boundary tests; production uses node:crypto. */
  randomIndex?: (upperExclusive: number) => number;
  /** Current automation is DOM-only. Legacy OCR is explicit tooling compatibility. */
  recognition?: 'dom' | 'legacy-ocr';
}

/** One-shot isolated session. Production desktop never constructs or grants this helper. */
export class PracticeSession {
  private used = false;
  constructor(
    private readonly engine: TaskEngine,
    private readonly adapter: PracticeSiteAdapter,
    private readonly ocr?: OcrProvider,
    private readonly options: PracticeOptions = {},
  ) {}

  async run(): Promise<Result<PracticeStatistics>> {
    const stats: PracticeStatistics = {
      questionType: null,
      attempts: 0,
      strategy: 'random',
      feedbackStatus: null,
      elapsedMs: 0,
    };
    const started = Date.now();
    const result = (ok: boolean, code: string): Result<PracticeStatistics> => ({
      ok,
      code,
      message: ok
        ? stats.completionMode === 'already-answered'
          ? '已有反馈弹窗关闭与状态恢复完成；未作答，待真实环境人工验收。'
          : '本地随机作答与关闭完成；待真实环境人工验收。'
        : '练习已安全停止，请人工检查。',
      correlationId: randomUUID(),
      data: { ...stats, elapsedMs: Date.now() - started },
    });
    if (this.used) return result(false, 'PRACTICE_SESSION_CONSUMED');
    this.used = true;
    const signal = this.engine.signal;
    let dispose: (() => Promise<void>) | undefined;
    try {
      return await bounded(
        async (workSignal) => {
          dispose = await this.adapter.watchManual?.(workSignal, () => {
            void this.engine.suspend('人工关键操作或媒体身份变化，练习辅助已暂停。');
          });
          const context = await this.adapter.context(workSignal);
          if (
            this.adapter.kind !== context.source ||
            !eligible(context, this.engine.confirmedCourse)
          )
            throw new Error('PRACTICE_LOCKED');
          const begun = await this.engine.beginPractice(context);
          if (!begun.ok) throw new Error(begun.code);
          const video = await this.adapter.video(workSignal);
          const act = async (
            type: Exclude<PracticeAction['type'], 'correct'>,
            ids: string[] = [],
          ): Promise<PracticeFeedback> => {
            const operationId = randomUUID();
            const action: PracticeAction =
              type === 'submit' ? { type, optionIds: ids, submissionId: operationId } : { type };
            let feedback: PracticeFeedback = { status: 'unknown' };
            const operation: GuardedOperation = {
              operationId,
              kind: `practice-${type}`,
              prepare: (child) =>
                bounded(
                  (inner) => this.adapter.prepare(action, context, video, inner),
                  AbortSignal.any([child, workSignal]),
                  5000,
                ),
              issue: (child) => {
                workSignal.throwIfAborted();
                if (type === 'submit') stats.attempts++;
                return this.adapter.perform(action, context, video, child);
              },
              verify: (child) =>
                bounded(
                  async (inner) => {
                    if (type === 'submit') {
                      feedback = await this.adapter.feedback(inner);
                      return feedback.status !== 'unknown' && feedback.receipt === operationId
                        ? 'confirmed'
                        : 'unknown';
                    }
                    return (await this.adapter.verify(action, video, inner))
                      ? 'confirmed'
                      : 'unknown';
                  },
                  AbortSignal.any([child, workSignal]),
                  5000,
                ),
            };
            const executed = await this.engine.execute(operation);
            if (!executed.ok) throw new Error(executed.code);
            return feedback as PracticeFeedback;
          };
          if (context.existingFeedback) {
            if (!['correct', 'incorrect'].includes(context.existingFeedback))
              throw new Error('PRACTICE_LOCKED');
            stats.completionMode = 'already-answered';
            stats.existingFeedbackStatus = context.existingFeedback;
            await act('close');
            if (!video.paused) await act('restore');
            const ended = await this.engine.endPractice();
            if (!ended.ok) throw new Error(ended.code);
            return result(true, 'PRACTICE_EXISTING_FEEDBACK_CLOSED');
          }
          if (!video.paused) await act('pause');
          let question: PracticeQuestion | null = await this.adapter.question(workSignal);
          if (!validateQuestion(question)) {
            if (this.options.recognition !== 'legacy-ocr' || !this.ocr)
              throw new Error('QUESTION_INCOMPLETE');
            const { recognizeQuestion } = await import('../../ocr/src/index');
            question = await recognizeQuestion(
              this.ocr,
              (child) => this.adapter.capture(child),
              (text) =>
                this.adapter.parseCapturedQuestion
                  ? this.adapter.parseCapturedQuestion(text)
                  : parseOcrQuestion(text),
              workSignal,
            );
          }
          if (!validateQuestion(question)) throw new Error('QUESTION_INCOMPLETE');
          stats.questionType = question.type;
          const ids = randomOptionIds(question, this.options.randomIndex);
          const feedback = await act('submit', ids);
          if (feedback.status === 'unknown') throw new Error('FEEDBACK_UNKNOWN');
          stats.feedbackStatus = feedback.status;
          await act('close');
          if (!video.paused) await act('restore');
          const ended = await this.engine.endPractice();
          if (!ended.ok) throw new Error(ended.code);
          return result(true, 'PRACTICE_COMPLETED');
        },
        signal,
        180000,
      );
    } catch (error) {
      if (!signal.aborted) await this.engine.suspend('练习保护门槛或反馈未通过，请人工处理。');
      const code =
        error instanceof Error && /^[A-Z_]{3,64}$/.test(error.message)
          ? error.message
          : 'PRACTICE_CANCELLED_OR_UNSAFE';
      return result(false, code);
    } finally {
      await dispose?.().catch(() => undefined);
    }
  }
}
