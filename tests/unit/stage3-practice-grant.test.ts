import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it, expect } from 'vitest';
import {
  createVerifiedPracticeGrant,
  validPracticeGrant,
} from '../../packages/task-engine/src/practice-grant';
const directories: string[] = [];
const courseId = 'zhs_c_' + 'a'.repeat(64);
const signal = () => new AbortController().signal;
const folder = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stage3-grant-'));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('stage3-grant-'))
      throw new Error('REFUSE_OUTSIDE_TEST_TEMP');
    await rm(target, { recursive: true, force: true });
  }
});
describe('阶段3单次真实练习授权', () => {
  it('冻结且限定课程与10分钟，持久claim只接受一次', async () => {
    const directory = await folder(),
      grant = createVerifiedPracticeGrant(directory, courseId, true);
    expect(Object.isFrozen(grant)).toBe(true);
    expect(validPracticeGrant(grant)).toBe(true);
    expect(grant.expiresAt - grant.issuedAt).toBe(600000);
    expect(await grant.claim(signal())).toBe(true);
    expect(await grant.claim(signal())).toBe(false);
    expect(
      JSON.parse(await readFile(join(directory, 'practice-claim.json'), 'utf8')).courseId,
    ).toBe(courseId);
  });
  it('两个授权并发争用同一验收目录只有一个成功，重建也不能重放', async () => {
    const directory = await folder();
    const a = createVerifiedPracticeGrant(directory, courseId, true),
      b = createVerifiedPracticeGrant(directory, courseId, true);
    expect(
      (await Promise.all([a.claim(signal()), b.claim(signal())])).filter(Boolean),
    ).toHaveLength(1);
    expect(await createVerifiedPracticeGrant(directory, courseId, true).claim(signal())).toBe(
      false,
    );
  });
  it('既有损坏claim原样保留，不修复为可重放授权', async () => {
    const directory = await folder();
    await writeFile(join(directory, 'practice-claim.json'), 'unknown-original');
    expect(await createVerifiedPracticeGrant(directory, courseId, true).claim(signal())).toBe(
      false,
    );
    expect(await readFile(join(directory, 'practice-claim.json'), 'utf8')).toBe('unknown-original');
  });
  it('已取消不消费claim；未来、过期、错误课程和超长授权均无效', async () => {
    const grant = createVerifiedPracticeGrant(await folder(), courseId, true);
    const controller = new AbortController();
    controller.abort();
    expect(await grant.claim(controller.signal)).toBe(false);
    expect(await grant.claim(signal())).toBe(true);
    for (const patch of [
      { issuedAt: Date.now() + 1000 },
      { expiresAt: Date.now() - 1 },
      { courseId: 'fixture-course' },
      { expiresAt: grant.issuedAt + 600001 },
      { evidence: 'unverified' },
    ])
      expect(validPracticeGrant({ ...grant, ...patch } as typeof grant)).toBe(false);
  });
});
