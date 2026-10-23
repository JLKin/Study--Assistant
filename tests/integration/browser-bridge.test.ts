import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserBridge, type BrowserBridgeOptions } from '../../packages/browser-bridge/src/index';

const connector = vi.hoisted(() => ({ connect: vi.fn() }));
// CDP 连接器替身；文件校验、HTTP 身份获取和 Windows 监听地址核验使用真实系统设施。
vi.mock('playwright', () => ({ chromium: { connectOverCDP: connector.connect } }));

const marker = { schemaVersion: 1, profileId: '12345678-1234-1234-1234-123456789abc' };
const browserPath = '/devtools/browser/01234567-1234-1234-1234-123456789abc';
let dataDir: string;
let server: Server;
let port: number;
let websocketEndpoint: string;
let session: Record<string, unknown>;

function trustedBridge(options: Omit<BrowserBridgeOptions, 'dataDir'> = {}) {
  return new BrowserBridge({
    dataDir,
    processInspector: async (pid) =>
      pid === process.pid
        ? {
            name: 'msedge.exe',
            commandLine: `msedge.exe --user-data-dir="${join(dataDir, 'browser-profile')}" --remote-debugging-address=127.0.0.1 --remote-debugging-port=0`,
          }
        : null,
    ...options,
  });
}

async function unusedPort(): Promise<number> {
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
  const address = closed.address();
  if (!address || typeof address === 'string') throw new Error('未取得测试端口');
  await new Promise<void>((done) => closed.close(() => done()));
  return address.port;
}

function connectionDouble() {
  const events = new EventEmitter();
  let connected = true;
  const connection = {
    on: events.on.bind(events),
    isConnected: () => connected,
    contexts: vi.fn(() => []),
    close: vi.fn(async () => {
      connected = false;
      events.emit('disconnected');
    }),
  };
  return { connection, events };
}

describe.runIf(process.platform === 'win32')('专用连接元数据与本机端点集成', () => {
  beforeEach(async () => {
    connector.connect.mockReset();
    dataDir = await mkdtemp(join(tmpdir(), 'stage1-browser-integration-'));
    await mkdir(join(dataDir, 'browser-profile'));
    await writeFile(
      join(dataDir, 'browser-profile', '.stage1-owned-profile.json'),
      JSON.stringify(marker),
    );
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ webSocketDebuggerUrl: websocketEndpoint }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法监听本机 fixture');
    port = address.port;
    websocketEndpoint = `ws://127.0.0.1:${port}${browserPath}`;
    session = {
      ...marker,
      profilePath: join(dataDir, 'browser-profile'),
      pid: process.pid,
      port,
      browserPath,
    };
    await writeFile(join(dataDir, 'browser-session.json'), JSON.stringify(session));
    await writeFile(
      join(dataDir, 'browser-profile', 'DevToolsActivePort'),
      `${port}\n${browserPath}\n`,
    );
  });

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((done) => server.close(() => done()));
    if (dataDir) {
      const target = resolve(dataDir);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('stage1-browser-integration-')
      ) {
        throw new Error('拒绝清理测试专属临时目录以外的路径');
      }
      await rm(target, { recursive: true, force: true });
    }
  });

  it('核验全部身份后才接入，disconnect 只关闭本连接且不操作页面', async () => {
    const { connection } = connectionDouble();
    connector.connect.mockResolvedValue(connection);
    const bridge = trustedBridge();
    expect(await bridge.reconnect()).toMatchObject({ state: 'CONNECTED', isolatedProfile: true });
    expect(connector.connect).toHaveBeenCalledWith(websocketEndpoint, { timeout: 2500 });
    await bridge.disconnect();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.contexts).not.toHaveBeenCalled();
    expect(bridge.status().state).toBe('DISCONNECTED');
    // HTTP 监听器仍存活，连接关闭未杀死本机端点进程。
    expect((await fetch(`http://127.0.0.1:${port}/json/version`)).ok).toBe(true);
  });

  it('意外断开会发布 DISCONNECTED，不主动发起关闭或重连', async () => {
    const { connection, events } = connectionDouble();
    connector.connect.mockResolvedValue(connection);
    const statuses: string[] = [];
    const bridge = trustedBridge({
      onStatus: (status) => statuses.push(status.state),
    });
    await bridge.reconnect();
    events.emit('disconnected');
    expect(statuses).toEqual(['CONNECTING', 'CONNECTED', 'DISCONNECTED']);
    expect(connection.close).not.toHaveBeenCalled();
    expect(connector.connect).toHaveBeenCalledOnce();
  });

  it('session 与 profile 端点发生变化时拒绝连接', async () => {
    await writeFile(
      join(dataDir, 'browser-profile', 'DevToolsActivePort'),
      `${port}\n/devtools/browser/other-browser-id`,
    );
    await expect(trustedBridge().reconnect()).rejects.toMatchObject({
      code: 'UNTRUSTED_SESSION',
    });
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('HTTP 返回远程 WebSocket 地址时拒绝连接', async () => {
    websocketEndpoint = `ws://192.168.1.2:${port}${browserPath}`;
    await expect(trustedBridge().reconnect()).rejects.toMatchObject({
      code: 'UNTRUSTED_ENDPOINT',
    });
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('PID 不匹配时即使端口、UUID 与 HTTP 均正常也拒绝连接', async () => {
    session.pid = 99999999;
    await writeFile(join(dataDir, 'browser-session.json'), JSON.stringify(session));
    await expect(trustedBridge().reconnect()).rejects.toMatchObject({
      code: 'UNSAFE_LISTENER',
    });
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('已标记 profile 的会话记录缺失时，核验 Edge 进程后可安全恢复', async () => {
    await unlink(join(dataDir, 'browser-session.json'));
    const { connection } = connectionDouble();
    connector.connect.mockResolvedValue(connection);
    const bridge = new BrowserBridge({
      dataDir,
      processInspector: async (pid) =>
        pid === process.pid
          ? {
              name: 'msedge.exe',
              commandLine: `msedge.exe --user-data-dir="${join(dataDir, 'browser-profile')}" --remote-debugging-address=127.0.0.1 --remote-debugging-port=0`,
            }
          : null,
    });

    await expect(bridge.reconnect()).resolves.toMatchObject({ state: 'CONNECTED' });
    expect(JSON.parse(await readFile(join(dataDir, 'browser-session.json'), 'utf8'))).toMatchObject(
      session,
    );
    expect(connector.connect).toHaveBeenCalledWith(websocketEndpoint, { timeout: 2500 });
  });

  it('缺失会话记录但进程命令行不属于本 profile 时拒绝恢复', async () => {
    await unlink(join(dataDir, 'browser-session.json'));
    const bridge = new BrowserBridge({
      dataDir,
      processInspector: async () => ({
        name: 'msedge.exe',
        commandLine: 'msedge.exe --user-data-dir="C:\\unrelated" --remote-debugging-port=0',
      }),
    });

    await expect(bridge.reconnect()).rejects.toMatchObject({ code: 'UNKNOWN_PROFILE_BROWSER' });
    await expect(readFile(join(dataDir, 'browser-session.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('旧端点已经关闭时，完整核验当前同 profile 端点并更新 schema 1 会话', async () => {
    const expected = { ...session };
    session.port = await unusedPort();
    session.pid = 99999999;
    session.browserPath = '/devtools/browser/closed-old-browser';
    await writeFile(join(dataDir, 'browser-session.json'), JSON.stringify(session));
    const { connection } = connectionDouble();
    connector.connect.mockResolvedValue(connection);

    await expect(trustedBridge().reconnect()).resolves.toMatchObject({ state: 'CONNECTED' });
    expect(JSON.parse(await readFile(join(dataDir, 'browser-session.json'), 'utf8'))).toEqual(
      expected,
    );
    expect(connector.connect).toHaveBeenCalledWith(websocketEndpoint, { timeout: 2500 });
  });

  it('旧身份仍活跃时不接管另一个端点，也不改写旧记录', async () => {
    const original = await readFile(join(dataDir, 'browser-session.json'), 'utf8');
    await writeFile(
      join(dataDir, 'browser-profile', 'DevToolsActivePort'),
      `${await unusedPort()}\n/devtools/browser/another-endpoint`,
    );

    await expect(trustedBridge().open()).rejects.toMatchObject({ code: 'UNTRUSTED_SESSION' });
    expect(await readFile(join(dataDir, 'browser-session.json'), 'utf8')).toBe(original);
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'not found'],
    [200, '<html>ordinary service</html>'],
    [200, '{"ordinaryService":true}'],
  ])('旧端口被普通 HTTP 服务复用（%s/%s）时仍可验证新的专用 Edge', async (status, body) => {
    const ordinary = createServer((_request, response) => {
      response.writeHead(Number(status));
      response.end(String(body));
    });
    await new Promise<void>((done) => ordinary.listen(0, '127.0.0.1', done));
    try {
      const address = ordinary.address();
      if (!address || typeof address === 'string') throw new Error('普通服务未就绪');
      session.port = address.port;
      await writeFile(join(dataDir, 'browser-session.json'), JSON.stringify(session));
      const { connection } = connectionDouble();
      connector.connect.mockResolvedValue(connection);

      await expect(trustedBridge().reconnect()).resolves.toMatchObject({ state: 'CONNECTED' });
      expect(JSON.parse(await readFile(join(dataDir, 'browser-session.json'), 'utf8')).port).toBe(
        port,
      );
      expect(connector.connect).toHaveBeenCalledWith(websocketEndpoint, { timeout: 2500 });
    } finally {
      await new Promise<void>((done) => ordinary.close(() => done()));
    }
  });

  it('旧端点已关闭但新端点返回远程 WS 时不覆盖旧记录', async () => {
    session.port = await unusedPort();
    const original = JSON.stringify(session);
    await writeFile(join(dataDir, 'browser-session.json'), original);
    websocketEndpoint = `ws://192.168.1.2:${port}${browserPath}`;

    await expect(trustedBridge().reconnect()).rejects.toMatchObject({ code: 'UNTRUSTED_ENDPOINT' });
    expect(await readFile(join(dataDir, 'browser-session.json'), 'utf8')).toBe(original);
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it.each([
    ['非 Edge 进程', 'node.exe', ''],
    ['另一个 profile', 'msedge.exe', ' --user-data-dir="C:\\unrelated"'],
  ])('旧端点已关闭但当前为%s时不覆盖记录', async (_label, name, commandLine) => {
    session.port = await unusedPort();
    const original = JSON.stringify(session);
    await writeFile(join(dataDir, 'browser-session.json'), original);

    await expect(
      trustedBridge({ processInspector: async () => ({ name, commandLine }) }).reconnect(),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PROFILE_BROWSER' });
    expect(await readFile(join(dataDir, 'browser-session.json'), 'utf8')).toBe(original);
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('已知端点的 PID 数字相同但进程身份已改变时也拒绝连接', async () => {
    await expect(
      trustedBridge({
        processInspector: async () => ({ name: 'node.exe', commandLine: '' }),
      }).reconnect(),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PROFILE_BROWSER' });
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('旧新端点均失效时 reconnect 报未运行并保留记录，供显式 open 重开', async () => {
    session.port = await unusedPort();
    const original = JSON.stringify(session);
    await writeFile(join(dataDir, 'browser-session.json'), original);
    await writeFile(
      join(dataDir, 'browser-profile', 'DevToolsActivePort'),
      `${await unusedPort()}\n/devtools/browser/closed-current-browser`,
    );

    await expect(trustedBridge().reconnect()).rejects.toMatchObject({
      code: 'BROWSER_NOT_RUNNING',
    });
    expect(await readFile(join(dataDir, 'browser-session.json'), 'utf8')).toBe(original);
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('恢复过程中取消连接不会写入新身份或连接 CDP', async () => {
    await unlink(join(dataDir, 'browser-session.json'));
    const bridge = trustedBridge({
      processInspector: async () => {
        await bridge.disconnect();
        return {
          name: 'msedge.exe',
          commandLine: `msedge.exe --user-data-dir="${join(dataDir, 'browser-profile')}" --remote-debugging-address=127.0.0.1 --remote-debugging-port=0`,
        };
      },
    });

    await expect(bridge.reconnect()).rejects.toMatchObject({ code: 'CONNECTION_CANCELLED' });
    await expect(readFile(join(dataDir, 'browser-session.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(connector.connect).not.toHaveBeenCalled();
  });
});
