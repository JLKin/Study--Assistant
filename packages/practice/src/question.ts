import type { PracticeContext, PracticeQuestion } from '../../contracts/src/practice';

export function eligible(context: PracticeContext, courseId: string | null): boolean {
  return (
    (context.source === 'fixture' || context.source === 'zhihuishu-verified') &&
    context.classification === 'non-graded' &&
    context.explicitNonGraded &&
    context.authenticated &&
    context.courseId === courseId &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(context.popupId) &&
    !!context.revision
  );
}
export const normalize = (value: string) =>
  value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const booleanPairs = [
  ['正确', '错误'],
  ['对', '错'],
] as const;
export function validateQuestion(value: PracticeQuestion | null): value is PracticeQuestion {
  if (
    !value ||
    !value.complete ||
    !['single', 'multiple', 'boolean'].includes(value.type) ||
    typeof value.stem !== 'string' ||
    value.stem.trim().length < 4 ||
    value.stem.length > 2000 ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 10
  )
    return false;
  const options = value.options;
  if (
    !options.every(
      (option) =>
        /^[a-zA-Z0-9_-]{1,32}$/.test(option.id) &&
        typeof option.text === 'string' &&
        option.text.trim() &&
        option.text.length <= 500,
    ) ||
    new Set(options.map((option) => option.id)).size !== options.length ||
    new Set(options.map((option) => normalize(option.text))).size !== options.length
  )
    return false;
  return (
    value.type !== 'boolean' ||
    (options.length === 2 &&
      booleanPairs.some((pair) =>
        pair.every((text) => options.some((option) => normalize(option.text) === text)),
      ))
  );
}

/** OCR text is untrusted: require type, full stem, explicit option IDs and end/count marker. */
export function parseOcrQuestion(text: string): PracticeQuestion | null {
  const lines = text
    .normalize('NFKC')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  const type = ({ 单选: 'single', 多选: 'multiple', 判断: 'boolean' } as const)[lines[0] as '单选'];
  const end = lines.at(-1)?.match(/^结束:(\d+)$/);
  if (!type || !end || !lines[1]?.startsWith('题干:')) return null;
  const options = lines.slice(2, -1).map((line) => {
    const found = line.match(/^([A-Z]):(.+)$/);
    return { id: found?.[1] ?? '', text: found?.[2] ?? '' };
  });
  const question: PracticeQuestion = {
    type,
    stem: lines[1].slice(3),
    options,
    complete: options.length === Number(end[1]),
  };
  return validateQuestion(question) ? question : null;
}
