import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { checkEnvironment } from '../../packages/system/src/self-check.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
it('关键目录真实写同步与删除通过；网络通知警告不阻断环境', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'study-check-'));
  dirs.push(dir);
  const check = await checkEnvironment({
    dataDir: dir,
    findEdge: async () => 'edge.exe',
    networkCheck: async () => false,
    notificationsSupported: false,
  });
  expect(check.canStart).toBe(true);
  expect(
    check.items.filter((i) => i.id.startsWith('directory.')).every((i) => i.status === 'pass'),
  ).toBe(true);
  expect(check.items.find((i) => i.id === 'network')?.status).toBe('warning');
});
it('缺少Edge与不可写目录阻止开始，不泄露错误原文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'study-check-'));
  dirs.push(dir);
  await writeFile(join(dir, 'blocked'), 'not-directory');
  const check = await checkEnvironment({
    dataDir: join(dir, 'blocked'),
    findEdge: async () => null,
    networkCheck: async () => {
      throw new Error('token=secret');
    },
    notificationsSupported: false,
  });
  expect(check.canStart).toBe(false);
  expect(check.items.filter((i) => i.critical && i.status === 'fail').length).toBeGreaterThan(1);
  expect(JSON.stringify(check)).not.toContain('secret');
});
