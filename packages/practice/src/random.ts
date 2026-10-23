import { randomInt } from 'node:crypto';
import type { PracticeQuestion } from '../../contracts/src/practice';
import { validateQuestion } from './question';

/** Select IDs only; no answer lookup, confidence, question upload or persistent payload. */
export function randomOptionIds(
  question: PracticeQuestion,
  randomIndex: (upperExclusive: number) => number = randomInt,
): string[] {
  if (!validateQuestion(question)) throw new Error('QUESTION_INCOMPLETE');
  const count = question.options.length;
  const upper = question.type === 'multiple' ? 2 ** count - 1 : count;
  const index = randomIndex(upper);
  if (!Number.isSafeInteger(index) || index < 0 || index >= upper)
    throw new Error('RANDOM_SELECTION_INVALID');
  if (question.type !== 'multiple') return [question.options[index].id];
  const mask = index + 1;
  return question.options.filter((_, i) => (mask & (1 << i)) !== 0).map((option) => option.id);
}
