import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, repairConfig } from '../../packages/contracts/src/config.js';
import { ConfigStore } from '../../packages/system/src/config-store.js';

const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'study-config-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('逐项配置校验', () => {
  it('单个错误仅回退该项，保留有效自定义值', () => {
    const value = repairConfig({
      ...DEFAULT_CONFIG,
      pollIntervalMs: 'bad',
      targetPlaybackRate: 1.25,
      logRetentionDays: 17,
    });
    expect(value.config.pollIntervalMs).toBe(3000);
    expect(value.config.targetPlaybackRate).toBe(1.25);
    expect(value.config.logRetentionDays).toBe(17);
    expect(value.issues.map((i) => i.key)).toEqual(['pollIntervalMs']);
  });
  it.each([NaN, Infinity, -1, 0, 10001, 2.5])('拒绝无效间隔 %s', (value) => {
    expect(repairConfig({ ...DEFAULT_CONFIG, pollIntervalMs: value }).config.pollIntervalMs).toBe(
      3000,
    );
  });
  it('依赖约束只修复冲突的timeout', () => {
    const value = repairConfig({ ...DEFAULT_CONFIG, pollIntervalMs: 10000, stallTimeoutMs: 5000 });
    expect(value.config.pollIntervalMs).toBe(10000);
    expect(value.config.stallTimeoutMs).toBe(15000);
  });
  it('丢弃任意敏感字段且不允许更改固定保护规则', () => {
    const value = repairConfig({
      ...DEFAULT_CONFIG,
      password: 'secret',
      cookie: 'secret',
      recoveryCooldownMs: 0,
      allowGraded: true,
    });
    expect(value.config).toEqual(DEFAULT_CONFIG);
  });
});
describe('配置文件兼容与确认', () => {
  it('首次生成有效配置和副本', async () => {
    const dir = await temp();
    const view = await new ConfigStore(dir).load();
    expect(view.blocked).toBe(false);
    expect(view.source).toBe('default');
    expect(JSON.parse(await readFile(join(dir, 'config/settings.json'), 'utf8'))).toEqual(
      DEFAULT_CONFIG,
    );
  });
  it('关键修复未确认时，重启仍然锁止；确认后才解除', async () => {
    const dir = await temp();
    const store = new ConfigStore(dir);
    await store.load();
    await store.update({ pollIntervalMs: -1, targetPlaybackRate: 1.25 });
    const restarted = new ConfigStore(dir);
    const view = await restarted.load();
    expect(view.blocked).toBe(true);
    expect(view.config.targetPlaybackRate).toBe(1.25);
    await restarted.acknowledge();
    expect((await new ConfigStore(dir).load()).blocked).toBe(false);
  });
  it.each(['{broken', '[]', 'null'])('整体无效 %s 时回退有效副本且须确认', async (text) => {
    const dir = await temp();
    await new ConfigStore(dir).load();
    await writeFile(join(dir, 'config/settings.json'), text);
    const view = await new ConfigStore(dir).load();
    expect(view.source).toBe('backup');
    expect(view.blocked).toBe(true);
  });
  it('所有配置损坏时保留原文并拒绝确认、更新', async () => {
    const dir = await temp();
    await mkdir(join(dir, 'config'));
    await writeFile(join(dir, 'config/settings.json'), 'broken');
    const store = new ConfigStore(dir);
    expect((await store.load()).blocked).toBe(true);
    await expect(store.acknowledge()).rejects.toThrow('CONFIG_BLOCKED');
    await expect(store.update({ pollIntervalMs: 4000 })).rejects.toThrow('CONFIG_BLOCKED');
    expect(await readFile(join(dir, 'config/settings.json'), 'utf8')).toBe('broken');
  });
  it('未知schema不降级、不覆盖', async () => {
    const dir = await temp();
    await new ConfigStore(dir).load();
    const text = JSON.stringify({ schemaVersion: 2 });
    await writeFile(join(dir, 'config/settings.json'), text);
    expect((await new ConfigStore(dir).load()).blocked).toBe(true);
    expect(await readFile(join(dir, 'config/settings.json'), 'utf8')).toBe(text);
  });
  it('并行更新序列化且不丢失有效字段', async () => {
    const dir = await temp();
    const store = new ConfigStore(dir);
    await store.load();
    await Promise.all([
      store.update({ pollIntervalMs: 4000 }),
      store.update({ targetPlaybackRate: 1.25 }),
    ]);
    expect(store.view().config).toMatchObject({ pollIntervalMs: 4000, targetPlaybackRate: 1.25 });
  });
  it('配置保存部分失败时锁止后续更新和确认', async () => {
    const dir = await temp();
    const store = new ConfigStore(dir);
    await store.load();
    // A directory at the fixed target simulates Windows refusing atomic replacement.
    await rm(join(dir, 'config/settings.valid.json'));
    await mkdir(join(dir, 'config/settings.valid.json'));
    await expect(store.update({ pollIntervalMs: 4000 })).rejects.toThrow();
    expect(store.view().blocked).toBe(true);
    await expect(store.acknowledge()).rejects.toThrow('CONFIG_BLOCKED');
    expect(
      JSON.parse(await readFile(join(dir, 'config/settings.json'), 'utf8')).pollIntervalMs,
    ).toBe(4000);
  });
});
