import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from 'electron';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { BrowserBridge, BrowserBridgeError } from '../../../packages/browser-bridge/src/index.js';
import { TaskEngine } from '../../../packages/task-engine/src/index.js';
import { StateStore } from '../../../packages/persistence/src/index.js';
import { TaskBackup } from '../../../packages/persistence/src/task-backup.js';
import { MonitorSession } from '../../../packages/monitor/src/index.js';
import { Logger } from '../../../packages/logging/src/index.js';
import { ConfigStore } from '../../../packages/system/src/config-store.js';
import { checkEnvironment } from '../../../packages/system/src/self-check.js';
import type {
  AppEvent,
  CommandEnvelope,
  CourseObservation,
  Dashboard,
  Result,
  SelfCheck,
} from '../../../packages/contracts/src/index.js';
import { COMMAND_CHANNEL, EVENT_CHANNEL, parseCommand, rejected, validateSender } from './ipc.js';
import { AutoKernel } from './kernel.js';

/**
 * 运行数据落在哪里：
 * - 打包后放 `%APPDATA%\智慧树学习助手\data`，**不再放在 exe 旁边**。
 *   否则一旦把整个文件夹（或运行过一次的目录）发给别人，
 *   浏览器配置、登录态、书签都会跟着过去 —— 之前就是踩了这个坑。
 * - 开发态仍放仓库里的 data/。
 * - 老版本在 exe 同目录留下的 data 会一次性迁移过来。
 */
const legacyDataDir = join(dirname(app.getPath('exe')), 'data');
const profileDataDir = join(app.getPath('appData'), '智慧树学习助手', 'data');
const dataDir = app.isPackaged ? profileDataDir : join(app.getAppPath(), 'data');

(function migrateLegacyData() {
  if (!app.isPackaged) return;
  if (!existsSync(legacyDataDir) || existsSync(profileDataDir)) return;
  try {
    mkdirSync(dirname(profileDataDir), { recursive: true });
    renameSync(legacyDataDir, profileDataDir);
  } catch {
    /* 迁移失败就以空 data 启动，不影响使用 */
  }
})();

/** 免责声明：首次启动必须同意，同意后写 data/state/disclaimer.json，之后不再弹。 */
const disclaimerFile = () => join(dataDir, 'state', 'disclaimer.json');
function readDisclaimer() {
  try {
    const parsed = JSON.parse(readFileSync(disclaimerFile(), 'utf8'));
    return { accepted: parsed?.accepted === true, at: parsed?.at ?? null };
  } catch {
    return { accepted: false, at: null };
  }
}
function acceptDisclaimer() {
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(
    disclaimerFile(),
    `${JSON.stringify({ accepted: true, at, version: app.getVersion() }, null, 2)}\n`,
    'utf8',
  );
  return { accepted: true, at };
}

/**
 * 版本限制 / 检测更新。
 * - 更新源写在 data/update.json 的 manifestUrl（也可以用环境变量 ZHS_UPDATE_URL 覆盖）。
 * - manifest 形如 { version, minSupported, notes, url, sha256 }。
 * - minSupported 高于当前版本 → 强制更新（旧版本作废），必须拦住「开始刷课」。
 * - 网络失败时用 data/state/update.json 缓存判定，避免断网绕过限制。
 */
const updateSourceFile = () => join(dataDir, 'update.json');
const updateCacheFile = () => join(dataDir, 'state', 'update.json');

function compareVersion(a: string, b: string): number {
  const pa = String(a ?? '')
    .split(/[.\-+]/)
    .map((piece) => Number.parseInt(piece, 10) || 0);
  const pb = String(b ?? '')
    .split(/[.\-+]/)
    .map((piece) => Number.parseInt(piece, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let index = 0; index < len; index += 1) {
    const left = pa[index] ?? 0;
    const right = pb[index] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

/** 首次运行时生成更新源模板，方便发布者填写。 */
function ensureUpdateSource() {
  if (existsSync(updateSourceFile())) return;
  try {
    mkdirSync(dirname(updateSourceFile()), { recursive: true });
    writeFileSync(updateSourceFile(), `{
  "manifestUrl": "",
  "$comment": "把 manifestUrl 填成你放 version.json 的地址（https）。version.json 形如 {\"version\":\"0.1.1\",\"minSupported\":\"0.1.1\",\"notes\":\"修复说明\",\"url\":\"下载地址\",\"sha256\":\"...\"}；minSupported 高于用户当前版本时，旧版本会被强制停用。"
}\n`, "utf8");
  } catch {
    /* 写不了就当作未配置更新源 */
  }
}

function manifestUrl(): string | null {
  const fromEnv = process.env.ZHS_UPDATE_URL;
  if (typeof fromEnv === 'string' && /^https?:\/\//i.test(fromEnv.trim())) return fromEnv.trim();
  try {
    const parsed = JSON.parse(readFileSync(updateSourceFile(), 'utf8'));
    const url = typeof parsed?.manifestUrl === 'string' ? parsed.manifestUrl.trim() : '';
    return /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

interface UpdateManifest {
  version?: string;
  minSupported?: string;
  notes?: string;
  url?: string;
  sha256?: string;
}

function readUpdateCache(): UpdateManifest | null {
  try {
    return JSON.parse(readFileSync(updateCacheFile(), 'utf8')) as UpdateManifest;
  } catch {
    return null;
  }
}

function saveUpdateCache(manifest: UpdateManifest) {
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(
    updateCacheFile(),
    `${JSON.stringify({ ...manifest, checkedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

function buildUpdateInfo(manifest: UpdateManifest | null, source: 'network' | 'cache' | 'none', error: string | null) {
  const current = app.getVersion();
  const latest = typeof manifest?.version === 'string' ? manifest.version : null;
  const minSupported = typeof manifest?.minSupported === 'string' ? manifest.minSupported : null;
  const force = Boolean(minSupported && compareVersion(current, minSupported) < 0);
  return {
    current,
    latest,
    minSupported,
    force,
    notes: typeof manifest?.notes === 'string' ? manifest.notes : '',
    url: typeof manifest?.url === 'string' ? manifest.url : null,
    checkedAt: new Date().toISOString(),
    source: manifest ? source : 'none',
    error,
  };
}

async function fetchUpdateManifest(): Promise<UpdateManifest | null> {
  const url = manifestUrl();
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = (await response.json()) as UpdateManifest;
    saveUpdateCache(parsed);
    return parsed;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

async function checkUpdate() {
  try {
    const manifest = await fetchUpdateManifest();
    if (manifest) return buildUpdateInfo(manifest, 'network', null);
    // 没配置更新源：不拦人，但把「离线/未配置」说清楚。
    const cached = readUpdateCache();
    return cached
      ? buildUpdateInfo(cached, 'cache', null)
      : { ...buildUpdateInfo(null, 'none', null), error: '未配置更新源（data/update.json 的 manifestUrl）' };
  } catch (error) {
    const cached = readUpdateCache();
    const message = error instanceof Error ? error.message : String(error);
    if (cached) return { ...buildUpdateInfo(cached, 'cache', message), error: message };
    return { ...buildUpdateInfo(null, 'none', message), error: message };
  }
}

try {
  mkdirSync(join(dataDir, 'electron'), { recursive: true });
  app.setPath('userData', join(dataDir, 'electron'));
  if (!app.requestSingleInstanceLock()) app.quit();
  else
    void boot().catch(() => {
      dialog.showErrorBox(
        '智慧树学习助手启动失败',
        '本地服务无法初始化。请检查程序所在目录可写、Edge 与依赖完整；已有数据将保留。',
      );
      app.exit(1);
    });
} catch {
  dialog.showErrorBox('数据目录不可写', '请将阶段 2 程序解压到可写目录后重试；已有数据将保留。');
  app.exit(1);
}

async function boot() {
  await app.whenReady();
  let window: BrowserWindow | null = null;
  let closing = false;
  let quitting = false;
  let course: CourseObservation | null = null;
  let monitor: MonitorSession | null = null;
  let selfCheck: SelfCheck = { checkedAt: new Date().toISOString(), canStart: false, items: [] };
  let configReady = false;
  let logFaultHandled = false;
  const emit = (event: AppEvent) => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(EVENT_CHANNEL, event);
  };
  const logger = new Logger(dataDir, {
    onFailure: () => {
      if (logFaultHandled) return;
      logFaultHandled = true;
      void engine.pause();
      emit({ type: 'system.warning', data: { code: 'LOG_WRITE_FAILED' } });
    },
  });
  const config = new ConfigStore(dataDir);
  const backup = new TaskBackup(dataDir);
  // 自动刷课内核：复用 tools/auto-study 里真机验证过的实现。
  const auto = new AutoKernel({
    dataDir: join(dataDir, 'auto-study'),
    onStatus: (status: Record<string, unknown>) => emit({ type: 'auto.statusChanged', data: status }),
    onLog: (level: string, message: string) => {
      const at = new Date().toISOString();
      // 内核日志单独落盘：Logger 只接收固定文案，这里要保留原始动作描述。
      try {
        const dir = join(dataDir, 'logs');
        mkdirSync(dir, { recursive: true });
        appendFileSync(
          join(dir, `auto-${at.slice(0, 10)}.jsonl`),
          `${JSON.stringify({ at, level, module: 'auto', message })}\n`,
        );
      } catch {
        /* 日志写不进去也不影响刷课本身 */
      }
      emit({ type: 'auto.log', data: { level, message, at } });
    },
  });
  const engine = new TaskEngine({
    store: new StateStore(dataDir),
    logger,
    stage2Capabilities: {
      enabled: true,
      inspect: (signal) => monitor!.inspectCourse(signal),
      backup: (signal) => backup.create(signal),
    },
    onChange: (view) => {
      if (view.cancelled) monitor?.halt();
      emit({ type: 'task.statusChanged', data: view });
    },
  });
  const bridge = new BrowserBridge({
    dataDir,
    onStatus: (status) => {
      emit({ type: 'browser.statusChanged', data: status });
      if (status.state === 'CONNECTED') {
        logger.log('INFO', 'browser', 'BROWSER_OPENED');
        void engine.browserConnected();
      }
      if (status.state === 'DISCONNECTED') {
        course = null;
        monitor?.dispose();
        void engine.browserDisconnected();
        logger.log('WARNING', 'browser', 'BROWSER_DISCONNECTED');
        if (!quitting && config.view().config.notificationsEnabled && Notification.isSupported()) {
          new Notification({
            title: '智慧树学习助手',
            body: '专用 Edge 已断开。请手动重新连接；任务不会自动继续。',
          }).show();
        }
      }
    },
  });
  monitor = new MonitorSession({
    engine,
    config: () => config.view().config,
    onObservation: (view) => {
      course = view.observation?.course ?? null;
      emit({ type: 'site.playerObserved', data: view.observation?.player ?? null });
      emit({ type: 'site.chapterObserved', data: view.chapters });
    },
  });
  const runCheck = async () => {
    selfCheck = await checkEnvironment({
      dataDir,
      findEdge: () => bridge.findEdge(),
      notificationsSupported: Notification.isSupported(),
    });
    logger.log('INFO', 'system', 'SELF_CHECK_COMPLETE');
    return selfCheck;
  };
  try {
    const settings = await config.load();
    configReady = true;
    logger.log(
      settings.blocked ? 'ERROR' : 'INFO',
      'config',
      settings.blocked
        ? 'CONFIG_FAILED'
        : settings.issues.length
          ? 'CONFIG_REPAIRED'
          : 'CONFIG_LOADED',
    );
  } catch {
    logger.log('ERROR', 'config', 'CONFIG_FAILED');
  }
  await engine.init();
  await runCheck();
  logger.log('INFO', 'app', 'APP_STARTED');

  ensureUpdateSource();
  const rendererPath = join(__dirname, 'renderer', 'index.html');
  const rendererUrl = pathToFileURL(rendererPath).href;
  window = new BrowserWindow({
    width: 1180,
    height: 880,
    minWidth: 980,
    minHeight: 680,
    title: '智慧树学习助手',
    backgroundColor: '#f4f7fb',
    icon: join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.url !== rendererUrl) event.preventDefault();
  });
  window.webContents.on('did-finish-load', () => {
    // 每次启动静默检查一次：新版本提示 / 旧版本作废由渲染层横幅呈现。
    void checkUpdate()
      .then((info) => {
        if (info.force || (info.latest && info.latest !== info.current)) {
          window?.webContents.send(EVENT_CHANNEL, { type: 'app.update', data: info });
        }
      })
      .catch(() => {
        /* 检查更新失败不打扰使用者 */
      });
  });
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  const result = (ok: boolean, code: string, message: string, data?: unknown): Result => ({
    ok,
    code,
    message,
    correlationId: randomUUID(),
    ...(data === undefined ? {} : { data }),
  });
  const unavailable = () =>
    result(false, 'STAGE_UNAVAILABLE', '该入口属于后续阶段；阶段 2 尚未实现。');
  const snapshot = (): Dashboard => ({
    stage: 2,
    task: engine.view(),
    browser: bridge.status(),
    settings: config.view(),
    selfCheck,
    course,
    logs: logger.readEntries().filter((entry) => {
      const levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
      return levels.indexOf(entry.level) >= levels.indexOf(config.view().config.logLevel);
    }),
    dataLocation: dataDir,
    monitor: monitor!.view(),
    auto: auto.status,
  });
  const preflight = (): Result | null => {
    if (!configReady || config.view().blocked)
      return result(false, 'CONFIG_BLOCKED', '配置不可用或修复尚未确认，请检查设置。');
    if (!selfCheck.canStart)
      return result(false, 'SELF_CHECK_FAILED', '关键环境自检未通过，禁止开始。');
    if (!logger.healthy)
      return result(false, 'LOG_UNAVAILABLE', '本地日志不可可靠保存，请修复数据目录。');
    return null;
  };
  let browserBusy = false;
  let inspectBusy = false;
  async function dispatch(command: CommandEnvelope): Promise<Result> {
    if (quitting) return result(false, 'APP_CLOSING', '应用正在退出。');
    switch (command.command) {
      case 'app.status':
        return result(true, 'OK', '本地状态已读取', snapshot());
      case 'system.check':
        return result(true, 'SELF_CHECK_COMPLETE', '环境自检已完成', await runCheck());
      case 'settings.get':
        return result(true, 'OK', '配置已读取', config.view());
      case 'settings.update': {
        if (!engine.signal.aborted) await engine.suspend('设置已修改，请核对后手动继续。');
        const view = await config.update(command.payload!);
        logger.log('INFO', 'config', view.issues.length ? 'CONFIG_REPAIRED' : 'CONFIG_LOADED');
        emit({ type: 'settings.changed', data: view });
        return result(true, 'SETTINGS_SAVED', '设置已保存；监测需手动开始或继续。', view);
      }
      case 'settings.acknowledge':
        return result(
          true,
          'SETTINGS_ACKNOWLEDGED',
          '已确认修复后的配置。',
          await config.acknowledge(),
        );
      case 'browser.open':
      case 'browser.reopen': {
        if (browserBusy) return result(false, 'BROWSER_BUSY', '已有浏览器连接操作进行中。');
        const failed = preflight();
        if (failed) return failed;
        browserBusy = true;
        try {
          const status = await bridge.open();
          return result(
            true,
            'BROWSER_CONNECTED',
            '专用 Edge 已连接，请在浏览器中手动登录。',
            status,
          );
        } finally {
          browserBusy = false;
        }
      }
      case 'auto.browser.open': {
        // 界面上的「打开浏览器」用刷课专用浏览器，可打开设置里自定义的网址。
        const payload = (command.payload ?? {}) as { url?: string };
        const opened = await auto.openBrowser({ url: payload.url });
        return result(
          opened.ok,
          opened.ok ? 'BROWSER_CONNECTED' : 'BROWSER_FAILED',
          opened.ok ? `专用浏览器已打开：${opened.url}` : `打开专用浏览器失败：${opened.message}`,
          { url: opened.url },
        );
      }
      case 'course.inspect': {
        if (inspectBusy) return result(false, 'INSPECTION_BUSY', '已有课程检查进行中。');
        if (!engine.signal.aborted) return result(false, 'TASK_BUSY', '请先暂停，再重新检查课程。');
        inspectBusy = true;
        try {
          await engine.suspend('正在重新检查课程，检查后须人工确认。', true);
          await monitor!.attach(bridge.monitorAdapter('read-only-preview'));
          course = await monitor!.inspectCourse();
          const readOnlyPreview = course.evidence.some((item) =>
            item.startsWith('READ_ONLY_PREVIEW：'),
          );
          const platformRestricted = course.evidence.some((item) =>
            item.startsWith('SITE_AUTOMATION_RESTRICTED：'),
          );
          logger.log(
            course.confidence === 'verified' ? 'INFO' : 'WARNING',
            'task',
            platformRestricted
              ? 'SITE_AUTOMATION_RESTRICTED'
              : course.confidence === 'verified'
                ? 'COURSE_OBSERVED'
                : 'COURSE_UNVERIFIED',
          );
          emit({ type: 'site.courseDiscovered', data: course });
          return result(
            course.confidence === 'verified',
            readOnlyPreview
              ? 'READ_ONLY_PREVIEW'
              : platformRestricted
                ? 'SITE_AUTOMATION_RESTRICTED'
                : course.confidence === 'verified'
                  ? 'COURSE_OBSERVED'
                  : 'COURSE_UNVERIFIED',
            readOnlyPreview
              ? '已保存一次真实课程只读采样；界面显示采样时进度，播放与切章保持锁止，待真实环境人工验收。'
              : platformRestricted
                ? '平台已提示脚本限制，真实适配已锁止；请手动使用网站。'
                : course.confidence === 'verified'
                  ? course.source === 'zhihuishu-dom'
                    ? '已读取真实 DOM 课程，请核对课程后人工确认；待真实环境人工验收。'
                    : '已读取本地模拟课程，请核对课程后人工确认。'
                  : '待真实环境人工验收；未发出网页动作。',
            course,
          );
        } finally {
          inspectBusy = false;
        }
      }
      case 'course.confirm': {
        if (!course) return result(false, 'COURSE_UNVERIFIED', '尚无可信课程观察，无法确认。');
        if (course.evidence.some((item) => item.startsWith('READ_ONLY_PREVIEW：')))
          return result(false, 'READ_ONLY_PREVIEW', '当前仅为只读采样；不能确认或启动网页动作。');
        course = await monitor!.inspectCourse();
        return engine.confirmCourse(course, (command.payload as { courseId: string }).courseId);
      }
      case 'task.start':
        return preflight() ?? monitor!.start();
      case 'auto.start': {
        const payload = (command.payload ?? {}) as { course?: string };
        // 版本限制：当前版本低于最小支持版本时，旧版本作废，不允许继续刷课。
        const gate = await checkUpdate();
        if (gate.force) {
          window?.webContents.send(EVENT_CHANNEL, { type: 'app.update', data: gate });
          return result(
            false,
            'UPDATE_REQUIRED',
            `当前版本 ${gate.current} 已停止支持，请先下载 ${gate.minSupported} 或更新版本`,
            { ...auto.status, update: gate },
          );
        }
        const started = await auto.start({ course: payload.course?.trim() || undefined });
        return result(started.ok, started.code, started.message, auto.status);
      }
      case 'auto.stop': {
        const stopped = await auto.stop();
        return result(stopped.ok, stopped.code, stopped.message, auto.status);
      }
      case 'auto.status':
        return result(true, 'OK', '自动刷课状态已读取', auto.status);
      case 'app.disclaimer':
        return result(true, 'OK', '免责声明状态已读取', readDisclaimer());
      case 'app.disclaimer.accept':
        return result(true, 'OK', '已同意免责声明', acceptDisclaimer());
      case 'app.quit':
        setTimeout(() => app.quit(), 120);
        return result(true, 'OK', '正在退出');
      case 'app.update.check': {
        const info = await checkUpdate();
        window?.webContents.send(EVENT_CHANNEL, { type: 'app.update', data: info });
        return result(
          true,
          'OK',
          info.force ? `当前版本已停止支持，请更新到 ${info.minSupported}` : info.error ? '检查更新失败' : '检查更新完成',
          info,
        );
      }
      case 'app.update.open': {
        const payload = (command.payload ?? {}) as { url?: unknown };
        const target = typeof payload.url === 'string' ? payload.url.trim() : '';
        if (!/^https?:\/\//i.test(target)) return result(false, 'INVALID_URL', '下载地址无效');
        await shell.openExternal(target);
        return result(true, 'OK', '已用系统浏览器打开下载地址');
      }
      case 'auto.config':
        return result(true, 'OK', '刷课参数已读取', await auto.readSettings());
      case 'auto.config.save': {
        const saved = await auto.saveSettings((command.payload ?? {}) as Record<string, unknown>);
        return result(
          true,
          'OK',
          auto.status.running ? '已保存，下次开始刷课时生效' : '已保存',
          saved,
        );
      }
      case 'auto.profile.reset': {
        const reset = await auto.resetProfile();
        return result(reset.ok, reset.code, reset.message, { profile: reset.profile });
      }
      case 'task.resume':
        return preflight() ?? monitor!.start(true);
      case 'task.pause':
        return engine.pause();
      case 'task.stop':
        return engine.stop();
      default:
        return unavailable();
    }
  }
  ipcMain.handle(COMMAND_CHANNEL, async (event, input: unknown) => {
    const trusted =
      !!window &&
      validateSender({
        senderId: event.sender.id,
        expectedSenderId: window.webContents.id,
        frameUrl: event.senderFrame?.url ?? '',
        expectedUrl: rendererUrl,
        isMainFrame: event.senderFrame === window.webContents.mainFrame,
      });
    if (!trusted) {
      logger.log('WARNING', 'security', 'COMMAND_REJECTED');
      return rejected('FORBIDDEN');
    }
    const command = parseCommand(input);
    if (!command) {
      logger.log('WARNING', 'security', 'COMMAND_REJECTED');
      return rejected('INVALID_COMMAND');
    }
    try {
      const value = await dispatch(command);
      return { ...value, correlationId: command.correlationId };
    } catch (error) {
      logger.log('ERROR', 'app', 'APP_FAILED');
      return {
        ok: false,
        code: error instanceof BrowserBridgeError ? error.code : 'SERVICE_FAILED',
        message:
          error instanceof BrowserBridgeError
            ? error.message
            : '本地服务操作失败，请检查自检与配置。',
        correlationId: command.correlationId,
      };
    }
  });
  window.on('close', (event) => {
    if (closing || quitting) return;
    if (['MONITORING', 'PRACTICE_ACTIVE', 'BUFFER_RECOVERY'].includes(engine.view().state)) {
      event.preventDefault();
      void dialog
        .showMessageBox(window!, {
          type: 'question',
          message: '任务正在进行。退出助手并保留 Edge？',
          buttons: ['取消', '退出并保留 Edge'],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          if (response === 1) {
            closing = true;
            app.quit();
          }
        });
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    monitor?.dispose();
    void auto.stop().catch(() => {});
    logger.log('INFO', 'app', 'APP_STOPPING');
    const cleanup = Promise.allSettled([engine.pause(), bridge.disconnect(), logger.flush(2500)]);
    // Bound all shutdown work; unflushed ordinary log entries may be lost after forced termination.
    const timer = setTimeout(() => app.exit(0), 3000);
    void cleanup.finally(() => {
      clearTimeout(timer);
      app.quit();
    });
  });
  await window.loadFile(rendererPath);
}
