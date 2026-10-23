import { describe, expect, it, vi } from 'vitest';
import { randomOptionIds } from '../../packages/practice/src/random';
import type { PracticeQuestion } from '../../packages/contracts/src/practice';
const question = (count = 4, type: PracticeQuestion['type'] = 'single'): PracticeQuestion => ({
  type,
  complete: true,
  stem: '合成练习：请选择任意有效选项',
  options: Array.from({ length: count }, (_, i) => ({
    id: String.fromCharCode(65 + i),
    text: type === 'boolean' ? (i === 0 ? '对' : '错') : `合成选项${i}`,
  })),
});
describe('阶段3离线随机选择：合法ID、非空子集与故障保护', () => {
  it.each([2, 4, 10])('单选%s项覆盖首尾索引，熵源只得到候选数量', (count) => {
    const q = question(count),
      limits: number[] = [];
    expect(
      randomOptionIds(q, (upper) => {
        limits.push(upper);
        return 0;
      }),
    ).toEqual(['A']);
    expect(
      randomOptionIds(q, (upper) => {
        limits.push(upper);
        return upper - 1;
      }),
    ).toEqual([String.fromCharCode(64 + count)]);
    expect(limits).toEqual([count, count]);
  });
  it.each([0, 1])('判断随机索引%s直接选择稳定ID，不预测正确性', (index) =>
    expect(randomOptionIds(question(2, 'boolean'), () => index)).toEqual([index === 0 ? 'A' : 'B']),
  );
  it.each([2, 4, 10])('多选%s项每个合法熵值对应唯一非空子集', (count) => {
    const q = question(count, 'multiple'),
      seen = new Set<string>();
    const total = 2 ** count - 1;
    for (let index = 0; index < total; index++) {
      const ids = randomOptionIds(q, (upper) => {
        expect(upper).toBe(total);
        return index;
      });
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => q.options.some((o) => o.id === id))).toBe(true);
      seen.add(ids.join(','));
    }
    expect(seen.size).toBe(total);
  });
  it.each([-1, 4, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER])(
    '非法熵值%s显式失败，不取模或猜选',
    (value) =>
      expect(() => randomOptionIds(question(), () => value)).toThrow('RANDOM_SELECTION_INVALID'),
  );
  it.each([{ complete: false }, { stem: '' }, { options: [] }, { type: 'unknown' }])(
    '不完整问题%j不调用熵源',
    (patch) => {
      const random = vi.fn(() => 0);
      expect(() =>
        randomOptionIds({ ...question(), ...patch } as PracticeQuestion, random),
      ).toThrow('QUESTION_INCOMPLETE');
      expect(random).not.toHaveBeenCalled();
    },
  );
  it('不修改题目、标签或选项顺序，返回数组独立', () => {
    const q = question(),
      before = structuredClone(q);
    const ids = randomOptionIds(q, () => 1);
    ids.pop();
    expect(q).toEqual(before);
  });
  it('生产默认熵源不需要网络或任何服务凭证', () => {
    const fetch = vi.fn(() => {
      throw Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      for (let i = 0; i < 32; i++)
        expect(['A', 'B', 'C', 'D']).toContain(randomOptionIds(question())[0]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
