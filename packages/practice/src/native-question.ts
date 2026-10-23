import type { PracticeQuestion, QuestionType } from '../../contracts/src/practice';
import { normalize, validateQuestion } from './question';

/** Transient evidence from one fully visible, unanswered native dialog capture. Never persist. */
export interface NativeQuestionLayout {
  kind: 'zhihuishu-dialog-v1';
  type: QuestionType;
  ordinal: number;
  fullyVisible: boolean;
  unanswered: boolean;
  optionIds: string[];
  expectedStem: string | null;
  expectedOptionTexts: Array<string | null>;
}

/** Native page text needs trusted layout evidence; the generic strict parser stays unchanged. */
export function parseNativeQuestion(
  text: string,
  layout: NativeQuestionLayout,
): PracticeQuestion | null {
  if (
    !layout ||
    layout.kind !== 'zhihuishu-dialog-v1' ||
    !layout.fullyVisible ||
    !layout.unanswered ||
    !['single', 'multiple', 'boolean'].includes(layout.type) ||
    !Number.isInteger(layout.ordinal) ||
    layout.ordinal < 1 ||
    layout.ordinal > 999 ||
    !Array.isArray(layout.optionIds) ||
    layout.optionIds.length < 2 ||
    layout.optionIds.length > 10 ||
    layout.optionIds.some((id, i) => id !== String.fromCharCode(65 + i)) ||
    !Array.isArray(layout.expectedOptionTexts) ||
    layout.expectedOptionTexts.length !== layout.optionIds.length ||
    (layout.expectedStem !== null &&
      (typeof layout.expectedStem !== 'string' ||
        layout.expectedStem.trim().length < 4 ||
        layout.expectedStem.length > 2000)) ||
    layout.expectedOptionTexts.some(
      (value) =>
        value !== null && (typeof value !== 'string' || !value.trim() || value.length > 500),
    ) ||
    typeof text !== 'string' ||
    text.length > 10000
  )
    return null;
  const lines = text
    .normalize('NFKC')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (/^[<>‹›«»\s]*\d{1,3}[<>‹›«»\s]*$/u.test(lines[0] ?? '')) {
    if (Number(lines.shift()!.replace(/\D/g, '')) !== layout.ordinal) return null;
  }
  const header = lines
    .shift()
    ?.match(/^(?:(\d{1,3})[.、]?\s*)?[【[(]?(单选题|多选题|判断题)[】\])]?[\s]*(.*)$/u);
  const type = ({ 单选题: 'single', 多选题: 'multiple', 判断题: 'boolean' } as const)[
    header?.[2] as '单选题'
  ];
  if (!header || type !== layout.type || (header[1] && Number(header[1]) !== layout.ordinal))
    return null;
  // OCR may merge a label with its text, or place several options on one line.
  // Accept that formatting only when the entire recognized body exactly covers
  // a complete, unique DOM question. No missing characters or extra text is ignored.
  if (layout.expectedStem !== null && layout.expectedOptionTexts.every((value) => value !== null)) {
    const escape = (value: string) => normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern =
      escape(layout.expectedStem) +
      layout.optionIds
        .map((id, i) => escape(id) + '[.。、:)]?' + escape(layout.expectedOptionTexts[i]!))
        .join('');
    const body = normalize([header[3], ...lines].join(''));
    if (new RegExp(`^${pattern}$`, 'u').test(body)) {
      const exact: PracticeQuestion = {
        type: layout.type,
        stem: layout.expectedStem,
        complete: true,
        options: layout.optionIds.map((id, i) => ({ id, text: layout.expectedOptionTexts[i]! })),
      };
      return validateQuestion(exact) ? exact : null;
    }
  }
  const stem: string[] = header[3] ? [header[3]] : [];
  const options: Array<{ id: string; text: string }> = [];
  for (const line of lines) {
    const label = line.match(/^([A-Z])(?:[.、:)]\s*|\s*$|\s+)(.*)$/u);
    if (label) {
      if (label[1] !== layout.optionIds[options.length]) return null;
      options.push({ id: label[1], text: label[2] });
    } else if (!options.length) stem.push(line);
    else options.at(-1)!.text += line;
  }
  const recognizedStem = stem.join('');
  if (
    options.length !== layout.optionIds.length ||
    (layout.expectedStem !== null &&
      normalize(recognizedStem) !== normalize(layout.expectedStem)) ||
    options.some(
      (option, i) =>
        layout.expectedOptionTexts[i] !== null &&
        normalize(option.text) !== normalize(layout.expectedOptionTexts[i]!),
    )
  )
    return null;
  const question: PracticeQuestion = {
    type: layout.type,
    stem: layout.expectedStem ?? recognizedStem,
    complete: true,
    options: options.map((option, i) => ({
      id: option.id,
      text: layout.expectedOptionTexts[i] ?? option.text,
    })),
  };
  return validateQuestion(question) ? question : null;
}
