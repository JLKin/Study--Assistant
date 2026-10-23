import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './util.mjs';

// 打包进 Electron（esbuild 打成 cjs）时 import.meta.url 为空，这里做兜底。
const HERE = (() => {
  try {
    const url = import.meta?.url;
    if (url) return dirname(fileURLToPath(url));
  } catch {
    /* 打包环境没有 import.meta.url */
  }
  // 打包环境：源码目录不存在，退到「运行目录」而不是 cwd 的父级，避免算出盘符根目录
  return process.cwd();
})();
export const ROOT = resolve(HERE, '..');
// 打包进 Electron（asar 只读）时，用环境变量把数据/日志/截图目录指到 exe 旁边。
const DATA_ROOT = process.env.ZHS_DATA_DIR ? resolve(process.env.ZHS_DATA_DIR) : join(ROOT, 'data');
const packed = Boolean(process.env.ZHS_DATA_DIR);
export const DATA_DIR = DATA_ROOT;
export const PROFILE_DIR = join(DATA_DIR, 'edge-profile');
export const LOG_DIR = packed || !existsSync(HERE) ? join(DATA_DIR, 'logs') : join(ROOT, 'logs');
export const SHOT_DIR = packed || !existsSync(HERE) ? join(DATA_DIR, 'shots') : join(ROOT, 'shots');
export const STATE_DIR = join(DATA_DIR, 'state');
const OWNER_FILE = join(STATE_DIR, 'profile-owner.json');

/**
 * 浏览器配置属于「这台机器 + 这个系统账号」。
 * 如果整个目录被拷到别人电脑上，Edge 的书签/登录态会跟着暴露，
 * 所以发现 owner 不一致就把 profile 与 session 清掉重来。
 */
function guardProfileOwnership(logger) {
  const now = { host: hostname(), user: userInfo().username };
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(OWNER_FILE, 'utf8'));
  } catch {
    prev = null;
  }
  const mismatch = prev && (prev.host !== now.host || prev.user !== now.user);
  if (mismatch && existsSync(PROFILE_DIR)) {
    logger?.warn?.('检测到其他机器/账号留下的浏览器配置，已重置（需要重新扫码登录）', {
      previous: { host: prev.host, user: prev.user },
      current: now,
    });
    rmSync(PROFILE_DIR, { recursive: true, force: true });
    rmSync(join(STATE_DIR, 'session.json'), { force: true });
  }
  mkdirSync(STATE_DIR, { recursive: true });
  if (!prev || mismatch) {
    writeFileSync(OWNER_FILE, `${JSON.stringify({ ...now, at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }
}

/** 手动重置：删掉 edge-profile + 登录态，下次刷课重新扫码。 */
export function resetBrowserProfile({ logger } = {}) {
  rmSync(PROFILE_DIR, { recursive: true, force: true });
  rmSync(join(STATE_DIR, 'session.json'), { force: true });
  rmSync(join(STATE_DIR, 'edge.pid'), { force: true });
  logger?.warn?.('已重置浏览器配置与登录态，下次刷课需要重新扫码', { profile: PROFILE_DIR });
  return { profile: PROFILE_DIR };
}

export const ZHS_HOSTS = ['onlineweb.zhihuishu.com', 'studyvideoh5.zhihuishu.com', 'login.zhihuishu.com'];

/** 默认配置：独立运行时来自 config.json，打包运行时由主进程写出一份。 */
export const DEFAULT_CONFIG = {
  progressThreshold: 0.81,
  entryUrl: 'https://onlineweb.zhihuishu.com/onlinestuh5',
  startUrl: '',
  cdpPort: 9333,
  pollIntervalMs: 900,
  playStallMs: 25000,
  stallReloadMs: 180000,
  maxPopupActionsPerVideo: 12,
  answerDelayMs: [900, 2000],
  afterCloseDelayMs: [1200, 2200],
  afterSwitchDelayMs: [1500, 3000],
  restartFromZero: true,
  speedPreset: null,
  stopOnDetection: true,
  captchaWaitMs: 900000,
  keepBrowserOpen: true,
  headless: false,
  courses: 'auto',
  onlyCourses: [],
  skipChapterKeywords: ['期末考试', '考试'],
  alertBeep: true,
  alertBringToFront: true,
  useSupervisor: false,
};

export function loadConfig() {
  const file = process.env.ZHS_CONFIG || join(ROOT, 'config.json');
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, 'utf8')) };
}

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

export function edgePath() {
  for (const candidate of EDGE_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

const endpointOf = (config) => `http://127.0.0.1:${config.cdpPort ?? 9333}`;

/** 端口是否已经有浏览器在监听（含别人的进程）。 */
async function portBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}

/** 真正确认「这是我们能连上的 Edge CDP」，别人的服务不算。 */
async function cdpAlive(endpoint) {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const info = await response.json().catch(() => null);
    const browser = String(info?.Browser ?? '');
    return browser === '' || /Edg\//i.test(browser);
  } catch {
    return false;
  }
}

/** 把还挂在我们 profile 上的 msedge 进程杀掉（它们会占住 user-data-dir，导致新实例不开调试端口）。 */
function killStaleEdgeForProfile(logger) {
  try {
    const script = `
$ErrorActionPreference='SilentlyContinue'
$profile = '${PROFILE_DIR.replace(/'/g, "''")}'
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
    });
    if (result.status === 0) logger?.info?.('已清理占用专用配置的旧 Edge 进程', {});
  } catch {
    /* 清理失败不致命，后面还有端口重试 */
  }
}

/** 找一组可用端口：配置端口 → 它之后的若干随机端口。 */
async function pickPorts(config) {
  const base = Number(config.cdpPort ?? 9333) || 9333;
  const ports = [base];
  for (let offset = 1; ports.length < 5 && offset < 40; offset += 1) {
    const candidate = base + offset * 7;
    if (candidate < 65535) ports.push(candidate);
  }
  const free = [];
  for (const port of ports) if (!(await portBusy(port))) free.push(port);
  return free.length > 0 ? free : ports.slice(1);
}

/**
 * 浏览器以「独立进程 + 固定 CDP 端口 + 独立 profile」方式常驻：
 * 脚本可以随时连上去干活，脚本退出浏览器不会关，登录态长期保留。
 */
export async function ensureBrowser(config, { logger, url } = {}) {
  guardProfileOwnership(logger);
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  let endpoint = endpointOf(config);
  let spawned = false;

  if (!(await cdpAlive(endpoint))) {
    const executablePath = edgePath();
    if (!executablePath) throw new Error('未找到 msedge.exe，请设置 EDGE_PATH 环境变量。');
    // 之前残留的 Edge（同一 user-data-dir）会吃掉单实例锁，导致新进程不开调试端口。
    killStaleEdgeForProfile(logger);
    const ports = await pickPorts(config);
    let lastError = null;
    for (const port of ports) {
      endpoint = `http://127.0.0.1:${port}`;
      const args = [
        `--user-data-dir=${PROFILE_DIR}`,
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-service-autorun',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-features=msImplicitSignin,msEdgeFirstRunExperience',
        '--disable-blink-features=AutomationControlled',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--start-maximized',
        '--window-size=1680,1020',
        url ?? 'about:blank',
      ];
      const child = spawn(executablePath, args, { detached: true, stdio: 'ignore' });
      child.unref();
      writeFileSync(join(STATE_DIR, 'edge.pid'), String(child.pid ?? ''), 'utf8');
      writeFileSync(join(STATE_DIR, 'edge.port'), String(port), 'utf8');
      logger?.info('已启动独立 Edge 进程', { pid: child.pid, profile: PROFILE_DIR, port });
      spawned = true;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline && !(await cdpAlive(endpoint))) await sleep(400);
      if (await cdpAlive(endpoint)) break;
      // 这个端口不行：杀掉再换一个，避免堆一堆没有调试端口的 Edge 窗口。
      try {
        if (child.pid) process.kill(child.pid);
      } catch {
        /* 进程可能已经自己退出 */
      }
      lastError = `端口 ${port} 未就绪`;
      logger?.warn?.('Edge 未在预期端口开启调试端口，换端口重试', { port });
    }
    if (!(await cdpAlive(endpoint))) {
      throw new Error(
        `Edge 已启动但 CDP 端口未就绪（${lastError ?? '未知端口'}）。请关闭所有 Edge 窗口后重试，或允许程序通过防火墙。`,
      );
    }
  } else {
    logger?.info('复用已在运行的 Edge 进程', { endpoint });
  }

  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error('未能取得浏览器上下文。');
  await restoreSession(context, logger);
  return {
    browser,
    context,
    spawned,
    endpoint,
    /** 只断开 Playwright 连接，绝不结束浏览器进程（否则登录态会丢）。 */
    async detach() {
      // 不做 browser.close()：在 CDP 复用的场景下它可能真的把 Edge 关掉。
      // 进程退出由调用方 process.exit 负责。
    },
  };
}

export function findPage(context, matcher = () => true) {
  const pages = context.pages().filter((page) => !page.isClosed());
  return pages.find((page) => matcher(page.url())) ?? null;
}

export async function ensurePage(context, { url, match, logger } = {}) {
  const predicate = match ?? (() => false);
  const existing = findPage(context, predicate);
  if (existing) return existing;
  const blank = findPage(context, (u) => u === 'about:blank');
  const page = blank ?? (await context.newPage());
  if (url) {
    logger?.info('导航', { url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((error) => {
      logger?.warn('导航未完成（可能被重定向）', { message: String(error).slice(0, 160) });
    });
  }
  return page;
}

/** 判断当前是否已登录（只看页面自身文本与地址，不做任何凭据操作）。 */
export async function isLoggedIn(page) {
  try {
    const state = await page.evaluate(() => ({
      url: location.href,
      text: (document.body?.innerText ?? '').slice(0, 6000),
    }));
    if (/login\.zhihuishu\.com|passport\./i.test(state.url)) return false;
    if (/扫码登录|密码登录|短信登录|请先登录|登录后查看|统一身份认证|立即登录|账号登录/.test(state.text))
      return false;
    return true;
  } catch {
    return false;
  }
}

export async function waitForLogin(page, { timeoutMs = 600000, logger, interval = 2500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) {
      logger?.info('登录态确认', { url: page.url() });
      await saveSession(page.context(), logger);
      return true;
    }
    if (!announced) {
      logger?.warn('等待登录：请在弹出的 Edge 窗口完成登录（扫码或账号密码），登录后自动继续');
      announced = true;
    }
    await sleep(interval);
  }
  throw new Error('等待登录超时。');
}

const SESSION_FILE = join(STATE_DIR, 'session.json');

/** 登录成功后把 Cookie 落盘：浏览器进程意外退出时可直接恢复登录态。 */
export async function saveSession(context, logger) {
  try {
    const cookies = await context.cookies();
    writeFileSync(SESSION_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 1), 'utf8');
    logger?.info('已保存登录 Cookie', { count: cookies.length, file: SESSION_FILE });
  } catch (error) {
    logger?.warn('保存 Cookie 失败', { message: String(error).slice(0, 160) });
  }
}

/** 启动后先注入上次保存的 Cookie，能省掉一次扫码。 */
export async function restoreSession(context, logger) {
  if (!existsSync(SESSION_FILE)) return 0;
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    const cookies = (data.cookies ?? []).filter((cookie) => cookie?.name && cookie?.domain);
    if (!cookies.length) return 0;
    await context.addCookies(cookies);
    logger?.info('已恢复登录 Cookie', { count: cookies.length, savedAt: data.savedAt });
    return cookies.length;
  } catch (error) {
    logger?.warn('恢复 Cookie 失败', { message: String(error).slice(0, 160) });
    return 0;
  }
}

export function shutdownBrowser(config) {
  const pidFile = join(STATE_DIR, 'edge.pid');
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  rmSync(pidFile, { force: true });
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}
