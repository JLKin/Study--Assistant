import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserBridge,
  edgeCommandUsesProfile,
  findEdge,
  parseDevToolsActivePort,
  validateLoopbackListeners,
  validateWebSocketEndpoint,
} from '../../packages/browser-bridge/src/index';

const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) {
    const target = resolve(path);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('stage1-browser-unit-')
    ) {
      throw new Error('拒绝清理测试专属临时目录以外的路径');
    }
    await rm(target, { recursive: true, force: true });
  }
});

async function temporaryData(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stage1-browser-unit-'));
  paths.push(path);
  return path;
}

describe('专用 Edge 连接信任边界', () => {
  it('精确识别带中文和空格的 profile 参数，拒绝路径前后缀、嵌套和重复参数', () => {
    const profile = 'D:\\中文目录\\test profile\\browser-profile';
    const flags = '--remote-debugging-address=127.0.0.1 --remote-debugging-port=0';
    for (const arg of [`--user-data-dir="${profile}"`, `"--user-data-dir=${profile}"`]) {
      expect(edgeCommandUsesProfile(`"C:\\Edge\\msedge.exe" ${arg} ${flags}`, profile)).toBe(true);
    }
    for (const arg of [
      `--user-data-dir="${profile}-other"`,
      `--other=--user-data-dir="${profile}"`,
      `--user-data-dir="${profile}" --user-data-dir="C:\\other"`,
      `--user-data-dir="${profile}" --remote-debugging-address=0.0.0.0`,
      `--user-data-dir="${profile}" --type=renderer`,
    ]) {
      expect(edgeCommandUsesProfile(`msedge.exe ${arg} ${flags}`, profile)).toBe(false);
    }
  });

  it('调试端口必须有合法端口和不可猜测的浏览器路径', () => {
    expect(parseDevToolsActivePort('12345\r\n/devtools/browser/01234567-abcd\r\n')).toEqual({
      port: 12345,
      browserPath: '/devtools/browser/01234567-abcd',
    });
    for (const raw of [
      '0\n/devtools/browser/01234567',
      '65536\n/devtools/browser/01234567',
      '1234\nhttp://evil.test/',
      '1234\n/devtools/page/01234567',
      '-1\n/devtools/browser/01234567',
    ]) {
      expect(() => parseDevToolsActivePort(raw)).toThrow();
    }
  });

  it('拒绝远程、其他端口、其他浏览器路径及带认证/查询的 WebSocket 端点', () => {
    const path = '/devtools/browser/01234567-abcd';
    expect(() =>
      validateWebSocketEndpoint(`ws://127.0.0.1:12345${path}`, 12345, path),
    ).not.toThrow();
    for (const endpoint of [
      `ws://192.168.1.2:12345${path}`,
      `ws://127.0.0.1:54321${path}`,
      `ws://localhost:12345${path}`,
      `ws://127.0.0.1:12345${path}?token=private`,
      `ws://user:secret@127.0.0.1:12345${path}`,
      'ws://127.0.0.1:12345/devtools/browser/other-id',
    ]) {
      expect(() => validateWebSocketEndpoint(endpoint, 12345, path)).toThrow();
    }
  });

  it('必须实证监听地址与已知 PID，拒绝任意地址、局域网和 PID 不符', () => {
    expect(() =>
      validateLoopbackListeners('  TCP  127.0.0.1:12345  0.0.0.0:0  LISTENING  4321', 12345, 4321),
    ).not.toThrow();
    expect(() =>
      validateLoopbackListeners('  TCP  [::1]:12345  [::]:0  LISTENING  4321', 12345, 4321),
    ).not.toThrow();
    for (const output of [
      '',
      '  TCP  0.0.0.0:12345  0.0.0.0:0  LISTENING  4321',
      '  TCP  192.168.0.2:12345  0.0.0.0:0  LISTENING  4321',
      '  TCP  127.0.0.1:12345  0.0.0.0:0  LISTENING  9999',
      '  TCP  127.0.0.1:12345  0.0.0.0:0  LISTENING  4321\n  TCP  [::]:12345  [::]:0  LISTENING  4321',
    ]) {
      expect(() => validateLoopbackListeners(output, 12345, 4321)).toThrow();
    }
  });

  it('从未连接时 disconnect 只改变状态，状态副本不能被调用方修改', async () => {
    const bridge = new BrowserBridge({ dataDir: await temporaryData() });
    expect(bridge.status().state).toBe('CLOSED');
    const copy = bridge.status();
    copy.state = 'CONNECTED';
    expect(bridge.status().state).toBe('CLOSED');
    await bridge.disconnect();
    expect(bridge.status().state).toBe('DISCONNECTED');
    await expect(bridge.inspect()).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' });
  });

  it('不接管已有无标记 profile，也不修改其中任何原有资料', async () => {
    if (process.platform !== 'win32') return;
    const dataDir = await temporaryData();
    await mkdir(join(dataDir, 'browser-profile'));
    const sentinel = join(dataDir, 'browser-profile', 'user-data-sentinel.txt');
    await writeFile(sentinel, 'preserve-user-data');
    const bridge = new BrowserBridge({ dataDir });
    await expect(bridge.open()).rejects.toMatchObject({ code: 'UNTRUSTED_PROFILE' });
    expect(await readFile(sentinel, 'utf8')).toBe('preserve-user-data');
  });

  it('损坏的 session 不能重连，也不会被覆盖成新连接', async () => {
    if (process.platform !== 'win32') return;
    const dataDir = await temporaryData();
    await mkdir(join(dataDir, 'browser-profile'));
    await writeFile(
      join(dataDir, 'browser-profile', '.stage1-owned-profile.json'),
      JSON.stringify({
        schemaVersion: 1,
        profileId: '12345678-1234-1234-1234-123456789abc',
      }),
    );
    await writeFile(join(dataDir, 'browser-session.json'), '{broken');
    const bridge = new BrowserBridge({ dataDir });
    await expect(bridge.reconnect()).rejects.toMatchObject({ code: 'UNTRUSTED_SESSION' });
    expect(await readFile(join(dataDir, 'browser-session.json'), 'utf8')).toBe('{broken');
  });

  it('跨 profile 的 session 必须拒绝', async () => {
    if (process.platform !== 'win32') return;
    const dataDir = await temporaryData();
    await mkdir(join(dataDir, 'browser-profile'));
    await writeFile(
      join(dataDir, 'browser-profile', '.stage1-owned-profile.json'),
      JSON.stringify({
        schemaVersion: 1,
        profileId: '12345678-1234-1234-1234-123456789abc',
      }),
    );
    await writeFile(
      join(dataDir, 'browser-session.json'),
      JSON.stringify({
        schemaVersion: 1,
        profileId: '12345678-1234-1234-1234-123456789abd',
        profilePath: join(dataDir, 'browser-profile'),
        pid: 1234,
        port: 12345,
        browserPath: '/devtools/browser/01234567-abcd',
      }),
    );
    await expect(new BrowserBridge({ dataDir }).reconnect()).rejects.toMatchObject({
      code: 'UNTRUSTED_SESSION',
    });
  });

  it('不存在的显式 Edge 路径返回不可用，不执行 shell 搜索', async () => {
    expect(await findEdge(join(await temporaryData(), 'missing-edge.exe'))).toBeNull();
  });
});
