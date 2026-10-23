import { spawn, execFile } from 'node:child_process';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright';
import type { BrowserStatus, CourseObservation } from '../../contracts/src/index';
import { adapterForPage } from '../../site-adapter/src/index';
import {
  isStage2FixtureUrl,
  monitorAdapterForPage,
  type MonitorAdapterMode,
} from '../../site-adapter/src/monitor';
import { isZhihuishuStudyUrl } from '../../site-adapter/src/zhihuishu';
import type { MonitorSiteAdapter } from '../../contracts/src/monitor';
import { VerifiedZhihuishuPracticeAdapter } from '../../site-adapter/src/practice-native';
import type { VerifiedPracticeGrant } from '../../task-engine/src/practice-grant';
import type { TaskEngine } from '../../task-engine/src/index';

const execFileAsync = promisify(execFile);
const START_TIMEOUT_MS = 10_000;
const CDP_TIMEOUT_MS = 2500;

export class BrowserBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserBridgeError';
  }
}

interface ProfileMarker {
  schemaVersion: 1;
  profileId: string;
}
interface BrowserSession extends ProfileMarker {
  profilePath: string;
  pid: number;
  port: number;
  browserPath: string;
}

export interface BrowserBridgeOptions {
  dataDir: string;
  edgePath?: string;
  onStatus?: (status: BrowserStatus) => void;
  /** 注入仅用于集成测试；生产环境始终查询 Windows 进程信息。 */
  processInspector?: (pid: number) => Promise<{ name: string; commandLine: string } | null>;
}

export function parseDevToolsActivePort(value: string): { port: number; browserPath: string } {
  const [portText, browserPath] = value.trim().split(/\r?\n/);
  const port = Number(portText);
  if (
    !/^\d{1,5}$/.test(portText ?? '') ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^\/devtools\/browser\/[a-zA-Z0-9-]{8,128}$/.test(browserPath ?? '')
  ) {
    throw new BrowserBridgeError('UNTRUSTED_ENDPOINT', '专用浏览器调试端点记录无效，已拒绝连接。');
  }
  return { port, browserPath };
}

export function validateWebSocketEndpoint(
  endpoint: string,
  port: number,
  browserPath: string,
): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BrowserBridgeError('UNTRUSTED_ENDPOINT', '调试端点格式无效。');
  }
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== String(port) ||
    url.pathname !== browserPath ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new BrowserBridgeError('UNTRUSTED_ENDPOINT', '调试端点不是本机专用浏览器的已知端点。');
  }
}

/** Windows netstat 输出须证明该端口只有环回监听，且属于本次已知 Edge PID。 */
export function validateLoopbackListeners(output: string, port: number, pid: number): void {
  if (loopbackListenerPid(output, port) !== pid) {
    throw new BrowserBridgeError(
      'UNSAFE_LISTENER',
      '无法确认调试端口仅在本机环回监听或进程身份不符。',
    );
  }
}

/** 仅当所有对应监听均为环回地址且属于同一 PID 时，返回该 PID。 */
export function loopbackListenerPid(output: string, port: number): number {
  const listeners = output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!match || !match[1].endsWith(`:${port}`)) return [];
    return [{ address: match[1].slice(0, -String(port).length - 1), pid: Number(match[2]) }];
  });
  const pids = new Set(listeners.map((listener) => listener.pid));
  if (
    listeners.length === 0 ||
    pids.size !== 1 ||
    listeners.some(
      (listener) =>
        !['127.0.0.1', '[::1]'].includes(listener.address) ||
        !Number.isSafeInteger(listener.pid) ||
        listener.pid <= 0,
    )
  ) {
    throw new BrowserBridgeError(
      'UNSAFE_LISTENER',
      '无法确认调试端口仅在本机环回监听且属于唯一进程。',
    );
  }
  return listeners[0]!.pid;
}

export async function findEdge(override?: string): Promise<string | null> {
  const candidates = override
    ? [resolve(override)]
    : [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
        .filter((value): value is string => !!value)
        .map((base) => join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      if ((await lstat(candidate)).isFile()) return candidate;
    } catch {
      /* 尝试下一个标准安装目录；不执行 shell 搜索。 */
    }
  }
  return null;
}

export class BrowserBridge {
  readonly profilePath: string;
  private readonly sessionPath: string;
  private browser?: Browser;
  private pending?: Promise<BrowserStatus>;
  private generation = 0;
  private current: BrowserStatus = {
    state: 'CLOSED',
    isolatedProfile: false,
    endpointScope: 'loopback',
  };

  constructor(private readonly options: BrowserBridgeOptions) {
    this.profilePath = join(resolve(options.dataDir), 'browser-profile');
    this.sessionPath = join(resolve(options.dataDir), 'browser-session.json');
  }

  status(): BrowserStatus {
    return { ...this.current };
  }

  async findEdge(): Promise<string | null> {
    return findEdge(this.options.edgePath);
  }

  open(): Promise<BrowserStatus> {
    return this.run(false);
  }
  reconnect(): Promise<BrowserStatus> {
    return this.run(true);
  }

  /** 这里只断开 connectOverCDP 连接；从不关闭 Context/Page，也不发送 Browser.close CDP 命令。 */
  async disconnect(): Promise<void> {
    this.generation += 1;
    const connection = this.browser;
    this.browser = undefined;
    this.setStatus('DISCONNECTED', '连接已断开；独立 Edge 保持运行。');
    if (connection) await connection.close().catch(() => undefined);
  }

  async inspect(): Promise<CourseObservation> {
    if (!this.browser?.isConnected()) {
      throw new BrowserBridgeError('BROWSER_DISCONNECTED', '请先连接专用 Edge。');
    }
    // 仅使用已有默认 Context/Page；不创建页面，不改变焦点，不读取 Cookie/storage。
    const pages = this.browser.contexts().flatMap((context) => context.pages());
    const page = pages.at(-1);
    return adapterForPage(page).inspect();
  }

  /** Explicit internal single-use acceptance entry; never called by production desktop/IPC. */
  async armVerifiedPractice(
    grant: VerifiedPracticeGrant,
    engine: TaskEngine,
    signal: AbortSignal,
    options: { allowExistingFeedback?: boolean } = {},
  ): Promise<VerifiedZhihuishuPracticeAdapter> {
    signal.throwIfAborted();
    if (!this.browser?.isConnected())
      throw new BrowserBridgeError('BROWSER_DISCONNECTED', '请先连接专用 Edge。');
    const pages = this.browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => !page.isClosed() && isZhihuishuStudyUrl(page.url()));
    if (pages.length !== 1)
      throw new BrowserBridgeError(
        'COURSE_NOT_UNIQUE',
        '请保留唯一课程页，受控入口不会创建或切换页面。',
      );
    return VerifiedZhihuishuPracticeAdapter.arm(pages[0], grant, signal, engine, options);
  }

  /** 显式检查时固定已有 Page；监测期间不跟随其他标签页，不创建或关闭页面。 */
  monitorAdapter(mode: MonitorAdapterMode = 'restricted'): MonitorSiteAdapter {
    if (!this.browser?.isConnected()) {
      throw new BrowserBridgeError('BROWSER_DISCONNECTED', '请先连接专用 Edge。');
    }
    const pages = this.browser.contexts().flatMap((context) => context.pages());
    // Edge 首次启动可能异步打开欢迎标签；只允许唯一明确的模拟或真实课程候选。
    // 模拟和真实课程并存同样存在歧义，不能按标签顺序擅自接管其中一个。
    const candidates = pages.filter(
      (page) =>
        !page.isClosed() && (isStage2FixtureUrl(page.url()) || isZhihuishuStudyUrl(page.url())),
    );
    if (candidates.length > 1) {
      throw new BrowserBridgeError(
        'AMBIGUOUS_MONITOR_PAGE',
        candidates.every((page) => isStage2FixtureUrl(page.url()))
          ? '检测到多个本机模拟课程页，请保留唯一目标后重新检查。'
          : '检测到多个课程页（本机模拟或真实站点），请保留唯一目标后重新检查。',
      );
    }
    return monitorAdapterForPage(candidates.length === 1 ? candidates[0] : undefined, mode);
  }

  private run(reconnectOnly: boolean): Promise<BrowserStatus> {
    if (this.browser?.isConnected()) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.setStatus('CONNECTING');
    this.pending = this.connect(reconnectOnly, generation)
      .catch((error: unknown) => {
        const safeError =
          error instanceof BrowserBridgeError
            ? error
            : new BrowserBridgeError(
                'BROWSER_CONNECT_FAILED',
                '专用 Edge 连接失败；请检查安装、权限及本机安全策略。',
              );
        this.setStatus('DISCONNECTED', safeError.message);
        throw safeError;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async connect(reconnectOnly: boolean, generation: number): Promise<BrowserStatus> {
    if (process.platform !== 'win32') {
      throw new BrowserBridgeError(
        'WINDOWS_REQUIRED',
        '阶段 1 专用 Edge 生命周期当前只支持 Windows。',
      );
    }
    const marker = await this.prepareProfile(!reconnectOnly);
    this.current.isolatedProfile = true;
    const previous = await this.readSession(marker);
    if (previous) {
      const live = await this.knownEndpoint(previous);
      if (live) return this.attach(previous, generation);
    }
    // 缺失记录或合法的旧记录均须重新证明当前端点属于此受标记 profile。
    const recovered = await this.recoverOwnedSession(marker, generation);
    if (recovered) return this.attach(recovered, generation);
    if (reconnectOnly) {
      throw new BrowserBridgeError(
        'BROWSER_NOT_RUNNING',
        '未找到仍在运行的已知专用 Edge，请点击打开专用 Edge。',
      );
    }
    const edgePath = await this.findEdge();
    if (!edgePath)
      throw new BrowserBridgeError('EDGE_NOT_FOUND', '未找到 Microsoft Edge，请安装后重试。');
    const portFile = join(this.profilePath, 'DevToolsActivePort');
    try {
      const existing = parseDevToolsActivePort(await readFile(portFile, 'utf8'));
      if (await this.endpointResponds(existing.port)) {
        throw new BrowserBridgeError(
          'UNKNOWN_PROFILE_BROWSER',
          '隔离目录已有无法确认身份的浏览器；请手动关闭该专用浏览器后重试。',
        );
      }
      await unlink(portFile);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (generation !== this.generation) throw cancelled();
    const child = spawn(
      edgePath,
      [
        `--user-data-dir=${this.profilePath}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-mode',
        '--new-window',
        'about:blank',
      ],
      { detached: true, stdio: 'ignore', windowsHide: false, shell: false },
    );
    let spawnFailed = false;
    child.once('error', () => {
      spawnFailed = true;
    });
    child.unref();
    if (!child.pid) throw new BrowserBridgeError('EDGE_LAUNCH_FAILED', '专用 Edge 无法启动。');
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnFailed) {
        throw new BrowserBridgeError(
          'EDGE_LAUNCH_FAILED',
          '专用 Edge 启动进程已退出；请检查本机策略及隔离目录。',
        );
      }
      let endpoint: ReturnType<typeof parseDevToolsActivePort> | undefined;
      try {
        endpoint = parseDevToolsActivePort(await readFile(portFile, 'utf8'));
      } catch (error) {
        // Edge 可能尚未写完端点文件；只对缺失/暂不完整的文件进行有界等待。
        if (
          !isMissing(error) &&
          !(error instanceof BrowserBridgeError && error.code === 'UNTRUSTED_ENDPOINT')
        ) {
          throw error;
        }
      }
      if (endpoint && (await this.endpointResponds(endpoint.port))) {
        // Edge 的启动进程可能转交给另一个 PID；使用实际监听 PID 完整核验，
        // 验证前不写身份记录，避免把未验证的端点固化成下一次的旧会话。
        const session = await this.recoverOwnedSession(marker, generation);
        if (session) return this.attach(session, generation);
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new BrowserBridgeError(
      'EDGE_START_TIMEOUT',
      '专用 Edge 启动超时；不会关闭浏览器，请手动检查后重试。',
    );
  }

  private async prepareProfile(create: boolean): Promise<ProfileMarker> {
    if (create) await mkdir(this.profilePath, { recursive: true });
    let info;
    try {
      info = await lstat(this.profilePath);
    } catch (error) {
      if (isMissing(error))
        throw new BrowserBridgeError('PROFILE_NOT_FOUND', '尚未建立本应用专用浏览器资料目录。');
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new BrowserBridgeError(
        'UNTRUSTED_PROFILE',
        '专用 browser-profile 必须是独立的本地目录。',
      );
    }
    const path = join(this.profilePath, '.stage1-owned-profile.json');
    try {
      const marker: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isMarker(marker))
        throw new BrowserBridgeError('UNTRUSTED_PROFILE', '专用浏览器目录身份标记无效。');
      return marker;
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create || (await readdir(this.profilePath)).length > 0) {
        throw new BrowserBridgeError(
          'UNTRUSTED_PROFILE',
          '拒绝接管无身份标记的既有浏览器资料目录。',
        );
      }
      const marker: ProfileMarker = { schemaVersion: 1, profileId: randomUUID() };
      await writeFile(path, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
      return marker;
    }
  }

  private async readSession(marker: ProfileMarker): Promise<BrowserSession | null> {
    let session: unknown;
    try {
      session = JSON.parse(await readFile(this.sessionPath, 'utf8'));
    } catch (error) {
      if (isMissing(error)) return null;
      throw new BrowserBridgeError(
        'UNTRUSTED_SESSION',
        '专用浏览器连接记录损坏；已拒绝接管其他浏览器。',
      );
    }
    const value = session as Partial<BrowserSession>;
    if (
      !isMarker(session) ||
      value.profileId !== marker.profileId ||
      value.profilePath !== this.profilePath ||
      !Number.isInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      !Number.isInteger(value.port) ||
      Number(value.port) <= 0 ||
      Number(value.port) > 65535 ||
      typeof value.browserPath !== 'string'
    ) {
      throw new BrowserBridgeError(
        'UNTRUSTED_SESSION',
        '浏览器连接记录与隔离目录不符；已拒绝连接。',
      );
    }
    parseDevToolsActivePort(`${value.port}\n${value.browserPath}`);
    return value as BrowserSession;
  }

  private async knownEndpoint(session: BrowserSession): Promise<boolean> {
    let endpoint;
    try {
      endpoint = parseDevToolsActivePort(
        await readFile(join(this.profilePath, 'DevToolsActivePort'), 'utf8'),
      );
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (endpoint.port !== session.port || endpoint.browserPath !== session.browserPath) {
      // 旧端口可能被普通 HTTP 服务复用；它不是原来的浏览器身份。此处只探测
      // 旧身份是否仍活跃，新候选端点仍必须通过下方所有严格校验。
      const previousVersion = await this.version(session.port).catch(() => null);
      if (previousVersion === `ws://127.0.0.1:${session.port}${session.browserPath}`) {
        throw new BrowserBridgeError(
          'UNTRUSTED_SESSION',
          '旧专用浏览器仍在运行，但资料目录指向另一端点；请先关闭重复的专用浏览器。',
        );
      }
      // Edge 重启后端口与浏览器 UUID 会改变；旧身份已不活跃时允许继续完整
      // 核验当前端点，而不是仅凭 DevToolsActivePort 更新记录。
      return false;
    }
    const version = await this.version(session.port);
    if (!version) return false;
    validateWebSocketEndpoint(version, session.port, session.browserPath);
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'TCP'], {
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
    validateLoopbackListeners(stdout, session.port, session.pid);
    if (!(await this.isOwnedEdgeProcess(session.pid))) {
      throw new BrowserBridgeError('UNKNOWN_PROFILE_BROWSER', '无法核验专用 Edge 的进程身份。');
    }
    return true;
  }

  private async recoverOwnedSession(
    marker: ProfileMarker,
    generation: number,
  ): Promise<BrowserSession | null> {
    let endpoint: ReturnType<typeof parseDevToolsActivePort>;
    try {
      endpoint = parseDevToolsActivePort(
        await readFile(join(this.profilePath, 'DevToolsActivePort'), 'utf8'),
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!(await this.endpointResponds(endpoint.port))) return null;
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'TCP'], {
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const pid = loopbackListenerPid(stdout, endpoint.port);
    const session: BrowserSession = {
      ...marker,
      profilePath: this.profilePath,
      pid,
      ...endpoint,
    };
    if (!(await this.knownEndpoint(session))) return null;
    if (generation !== this.generation) throw cancelled();
    try {
      await this.writeSession(session);
    } catch {
      throw new BrowserBridgeError(
        'BROWSER_IDENTITY_WRITE_FAILED',
        '无法恢复专用浏览器连接身份；已拒绝建立自动化连接。',
      );
    }
    return session;
  }

  private async isOwnedEdgeProcess(pid: number): Promise<boolean> {
    const processInfo = this.options.processInspector
      ? await this.options.processInspector(pid)
      : await this.inspectWindowsProcess(pid);
    if (!processInfo || processInfo.name.toLowerCase() !== 'msedge.exe') return false;
    return edgeCommandUsesProfile(processInfo.commandLine, this.profilePath);
  }

  private async inspectWindowsProcess(
    pid: number,
  ): Promise<{ name: string; commandLine: string } | null> {
    const command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { exit 3 }; [Console]::Out.Write($p.Name + "\`n" + $p.CommandLine)`;
    try {
      const { stdout } = await execFileAsync(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout: 3000, maxBuffer: 2 * 1024 * 1024 },
      );
      const newline = stdout.indexOf('\n');
      if (newline < 1) return null;
      return {
        name: stdout.slice(0, newline).trim(),
        commandLine: stdout.slice(newline + 1).trim(),
      };
    } catch {
      return null;
    }
  }

  private async attach(session: BrowserSession, generation: number): Promise<BrowserStatus> {
    if (generation !== this.generation) throw cancelled();
    const connection = await chromium.connectOverCDP(
      `ws://127.0.0.1:${session.port}${session.browserPath}`,
      {
        timeout: CDP_TIMEOUT_MS,
      },
    );
    if (generation !== this.generation) {
      await connection.close();
      throw cancelled();
    }
    this.browser = connection;
    connection.on('disconnected', () => {
      if (this.browser !== connection) return;
      this.browser = undefined;
      this.setStatus('DISCONNECTED', '专用 Edge 连接意外断开；任务应暂停，重新连接后须手动继续。');
    });
    this.setStatus('CONNECTED');
    return this.status();
  }

  private async endpointResponds(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(750),
        redirect: 'error',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async version(port: number): Promise<string | null> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
        redirect: 'error',
      });
    } catch {
      return null;
    }
    if (!response.ok)
      throw new BrowserBridgeError('UNTRUSTED_ENDPOINT', '本机调试端点返回无效状态。');
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as Record<string, unknown>).webSocketDebuggerUrl !== 'string'
    ) {
      throw new BrowserBridgeError('UNTRUSTED_ENDPOINT', '调试端点身份信息无效。');
    }
    return (body as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  }

  private async writeSession(session: BrowserSession): Promise<void> {
    const temporary = `${this.sessionPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(session, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.sessionPath);
  }

  private setStatus(state: BrowserStatus['state'], reason?: string): void {
    this.current = {
      state,
      isolatedProfile: this.current.isolatedProfile,
      endpointScope: 'loopback',
      ...(reason ? { reason } : {}),
    };
    try {
      this.options.onStatus?.(this.status());
    } catch {
      /* UI 监听器不得干扰浏览器生命周期。 */
    }
  }
}

function isMarker(value: unknown): value is ProfileMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Record<string, unknown>;
  return (
    marker.schemaVersion === 1 &&
    typeof marker.profileId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(marker.profileId)
  );
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function cancelled(): BrowserBridgeError {
  return new BrowserBridgeError(
    'CONNECTION_CANCELLED',
    '连接操作已取消；不会关闭已启动的专用 Edge。',
  );
}

/** Windows 路径不能含双引号；按引号包裹的完整参数匹配，并拒绝重复身份参数。 */
export function edgeCommandUsesProfile(commandLine: string, profilePath: string): boolean {
  if ((commandLine.match(/"/g)?.length ?? 0) % 2 !== 0) return false;
  const args = (commandLine.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((arg) =>
    arg.replaceAll('"', ''),
  );
  const option = (name: string): string | undefined => {
    const values = args.filter((arg) => arg.toLowerCase().startsWith(`${name}=`));
    return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
  };
  const profile = option('--user-data-dir');
  return (
    !!profile &&
    profile.replaceAll('/', '\\').toLowerCase() ===
      profilePath.replaceAll('/', '\\').toLowerCase() &&
    option('--remote-debugging-address') === '127.0.0.1' &&
    option('--remote-debugging-port') === '0' &&
    !args.some((arg) => arg.startsWith('--type='))
  );
}
