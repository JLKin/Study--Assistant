import { describe, expect, it } from 'vitest';
import { parseOcrQuestion, validateQuestion } from '../../packages/practice/src/question';
import {
  parseNativeQuestion,
  type NativeQuestionLayout,
} from '../../packages/practice/src/native-question';
import { randomOptionIds } from '../../packages/practice/src/random';
import type { PracticeQuestion } from '../../packages/contracts/src/practice';

const question = (texts = ['对', '错']): PracticeQuestion => ({
  type: 'boolean',
  stem: '植物进行光合作用需要二氧化碳吗',
  complete: true,
  options: texts.map((text, i) => ({ id: String.fromCharCode(65 + i), text })),
});
const layout = (): NativeQuestionLayout => ({
  kind: 'zhihuishu-dialog-v1',
  type: 'boolean',
  ordinal: 1,
  fullyVisible: true,
  unanswered: true,
  optionIds: ['A', 'B'],
  expectedStem: question().stem,
  expectedOptionTexts: ['对', '错'],
});
const native = `1\n1.【判断题】植物进行光合作用需要二氧化碳吗\nA.\n对\nB.\n错`;

describe('阶段3现场判断词对：不改变页面标签，仅映射已验证的同义值', () => {
  it.each([
    ['对', '错'],
    ['正确', '错误'],
    ['错', '对'],
  ])('接受完整互斥词对 %j', (...texts) => {
    expect(validateQuestion(question(texts))).toBe(true);
    expect(question(texts).options.map((o) => o.text)).toEqual(texts);
  });
  it('判断词对随机选择稳定ID，不使用答案同义文本', () => {
    expect(randomOptionIds(question(), () => 0)).toEqual(['A']);
    expect(randomOptionIds(question(['错', '对']), () => 1)).toEqual(['B']);
  });
  it.each([
    ['对', '正确'],
    ['对', '错误'],
    ['是', '否'],
    ['对', '对'],
  ])('混合/未核验词对 %j 不猜测', (...texts) => {
    expect(validateQuestion(question(texts))).toBe(false);
    expect(() => randomOptionIds(question(texts), () => 0)).toThrow('QUESTION_INCOMPLETE');
  });
  it('单选保持稳定ID与原标签，不进行语义答案映射', () => {
    const q = { ...question(), type: 'single' as const };
    expect(randomOptionIds(q, () => 1)).toEqual(['B']);
    expect(q.options.map((o) => o.text)).toEqual(['对', '错']);
  });
  it('随机源只接收候选数，不接收题干或选项内容', () => {
    const limits: number[] = [];
    expect(
      randomOptionIds(question(), (upper) => {
        limits.push(upper);
        return 1;
      }),
    ).toEqual(['B']);
    expect(limits).toEqual([2]);
  });
  it('旧严格OCR协议继续保留，并支持已验证词对', () => {
    expect(parseOcrQuestion(`判断\n题干:${question().stem}\nA:对\nB:错\n结束:2`)).toEqual(
      question(),
    );
    expect(parseOcrQuestion(native)).toBeNull();
  });
});

describe('阶段3原生OCR：仅接受已核对的DOM版式边界，不伪造结束标记', () => {
  it.each([native, `【判断题】\n植物进行光合作用\n需要二氧化碳吗\nA. 对\nB. 错`])(
    '原生排版和折行精确对应DOM',
    (text) => {
      expect(parseNativeQuestion(text, layout())).toEqual(question());
    },
  );
  it.each([
    { fullyVisible: false },
    { unanswered: false },
    { type: 'single' },
    { ordinal: 2 },
    { optionIds: ['A', 'A'] },
    { optionIds: ['A', 'C'] },
    { expectedStem: '另一个完全不同的题干' },
    { expectedOptionTexts: ['错', '对'] },
    { kind: 'unknown' },
  ])('版式边界不满足 %j 即拒绝', (patch) => {
    expect(
      parseNativeQuestion(native, { ...layout(), ...patch } as NativeQuestionLayout),
    ).toBeNull();
  });
  it.each([
    native.replace('B.\n错', ''),
    native.replace('B.\n错', 'B.'),
    native + '\nC.是',
    native + '\n提交',
    native.replace('二氧化碳吗', '二氧化'),
    native.replace('判断题', '正式考试'),
  ])('残缺、额外选项/正文和题型不确定零解析', (text) => {
    expect(parseNativeQuestion(text, layout())).toBeNull();
  });
  it('DOM文字缺失时仍须保留可靠题型、选项数量和完整截图边界', () => {
    const hints = { ...layout(), expectedStem: null, expectedOptionTexts: [null, null] };
    expect(parseNativeQuestion(native, hints)).toEqual(question());
    expect(parseNativeQuestion(native, { ...hints, fullyVisible: false })).toBeNull();
  });
});

describe('阶段3单选合成排版：完整DOM对照下的标签粘连和同行选项', () => {
  it.each([true, false])('DOM中的正则符号按原文核对，不作模式扩展：%s', (matches) => {
    const stem = '请选择示意字符串(括号)[符号]+';
    const texts = ['a+b', '[b]', '.net', 'x?'];
    const captured = `【单选题】${stem}A.${matches ? 'a+b' : 'aab'}B.[b]C..netD.x?`;
    const hints: NativeQuestionLayout = {
      kind: 'zhihuishu-dialog-v1',
      type: 'single',
      ordinal: 1,
      fullyVisible: true,
      unanswered: true,
      optionIds: ['A', 'B', 'C', 'D'],
      expectedStem: stem,
      expectedOptionTexts: texts,
    };
    if (matches)
      expect(parseNativeQuestion(captured, hints)?.options.map((o) => o.text)).toEqual(texts);
    else expect(parseNativeQuestion(captured, hints)).toBeNull();
  });
  const single: PracticeQuestion = {
    type: 'single',
    stem: '请从以下四种颜色中选择蓝色',
    complete: true,
    options: ['红色', '蓝色', '绿色', '白色'].map((text, i) => ({
      id: String.fromCharCode(65 + i),
      text,
    })),
  };
  const hints = (): NativeQuestionLayout => ({
    kind: 'zhihuishu-dialog-v1',
    type: 'single',
    ordinal: 1,
    fullyVisible: true,
    unanswered: true,
    optionIds: ['A', 'B', 'C', 'D'],
    expectedStem: single.stem,
    expectedOptionTexts: single.options.map((o) => o.text),
  });
  it.each([
    '【单选题】请从以下四种颜色中选择蓝色\nA红色\nB蓝色\nC绿色\nD白色',
    '1\n【单选题】请从以下四种颜色中选择蓝色\nA.红色 B.蓝色 C.绿色 D.白色',
    '【单选题】请从以下四种\n颜色中选择蓝色A红色B蓝色C绿色D白色',
    '【单选题】请从以下四种颜色中选择蓝色\na红色\nb蓝色\nc绿色\nd白色',
    '【单选题】请从以下四种颜色中选择蓝色\nA。红色\nB.蓝色\nC.绿色\nD.白色',
  ])('仅分隔形式变化，整段文字仍须精确消费：%s', (text) => {
    expect(parseNativeQuestion(text, hints())).toEqual(single);
  });
  it.each([
    'A红色B蓝色C绿色',
    'A红色B蓝C绿色D白色',
    'A红色B蓝色C绿色D白色提交',
    'A红色C绿色B蓝色D白色',
    'A红色B蓝色C绿色D白色E黑色',
    'A红色B蓝色C绿色D白色1',
    'A红。色B蓝色C绿色D白色',
  ])('缺字、额外内容和错序依然拒绝：%s', (options) => {
    expect(parseNativeQuestion(`【单选题】${single.stem}${options}`, hints())).toBeNull();
  });
  it.each([
    { expectedStem: null },
    { expectedOptionTexts: [null, '蓝色', '绿色', '白色'] },
    { fullyVisible: false },
    { unanswered: false },
  ])('粘连格式没有完整可信文字对照时拒绝：%j', (patch) => {
    expect(
      parseNativeQuestion(`【单选题】${single.stem}A红色B蓝色C绿色D白色`, { ...hints(), ...patch }),
    ).toBeNull();
  });
});
