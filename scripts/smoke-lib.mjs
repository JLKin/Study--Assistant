import { _electron, chromium } from 'playwright';
import { access, cp, readFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

export async function closeApp(application) {
  const child = application.process();
  const exited = new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(
      () => reject(new Error('Electron did not exit within 6 seconds')),
      6000,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await application.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
  // Windows may retain inherited harness pipe handles in the surviving Edge. The process
  // exit event above proves Electron is gone; release only the harness's stream readers.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export async function desktopSmoke({
  executablePath,
  appPath,
  restrictedPath = false,
  prefix,
  expectedStage = 2,
}) {
  const source = resolve(appPath ?? dirname(executablePath));
  const workspaceRelative = relative(resolve('work'), source);
  assert.ok(
    workspaceRelative && !workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative),
    'Lifecycle smoke may only use an application copy inside this workspace work directory',
  );
  // 保证恢复流程实际覆盖中文目录，即使维护者从纯英文路径运行 smoke。
  if (!/[\u4e00-\u9fff]/u.test(source)) {
    const localized = join(dirname(source), `中文生命周期-${prefix}-${randomUUID()}`);
    await cp(source, localized, {
      recursive: true,
      filter: (path) => path !== join(source, 'data'),
    });
    if (appPath) appPath = localized;
    else executablePath = join(localized, basename(executablePath));
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (restrictedPath)
    env.Path = env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const launch = () =>
    _electron.launch({ executablePath, args: appPath ? [appPath] : [], env, timeout: 30000 });
  const dataDir = join(appPath ?? resolve(executablePath, '..'), 'data');
  const report = { checkedAt: new Date().toISOString(), executablePath, restrictedPath, cases: [] };
  const record = (id, details) => {
    report.cases.push({ id, status: 'pass', details });
    console.log(`PASS ${id}`);
  };
  let first;
  let second;
  let session;
  let independentlyStarted;
  let independentEndpoint;
  try {
    first = await launch();
    const page = await first.firstWindow();
    await page.waitForSelector('#phase-pill');
    await page.waitForFunction(
      () => window.study && document.querySelector('#phase-pill').textContent !== '初始化',
    );
    const dashboard = await page.evaluate(async () => (await window.study.status()).data);
    assert.equal(dashboard.stage, expectedStage);
    assert.ok(dashboard.dataLocation.endsWith('data'));
    record('desktop.launch', '中文操作台与真实 preload/IPC 正常，首次生成 data');
    const security = await page.evaluate(() => ({
      node: typeof window.require,
      process: typeof window.process,
      methods: Object.keys(window.study),
    }));
    assert.equal(security.node, 'undefined');
    assert.equal(security.process, 'undefined');
    assert.ok(!security.methods.includes('invoke'));
    record('desktop.isolation', 'Renderer 无 require/process/通用 invoke');
    const preferences = await first.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    );
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);
    record('desktop.sandbox', '真实 BrowserWindow 安全配置');
    const invalid = await page.evaluate(() =>
      window.study.updateSettings({ password: 'test-sentinel' }),
    );
    assert.equal(invalid.code, 'INVALID_COMMAND');
    const afterInvalid = await page.evaluate(() => window.study.status());
    assert.ok(!JSON.stringify(afterInvalid.data.logs).includes('test-sentinel'));
    record('desktop.ipcReject', '真实 IPC 拒绝未知配置字段且日志不回显');
    const subframe = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 2000);
          document.addEventListener(
            'securitypolicyviolation',
            (event) => {
              if (event.effectiveDirective === 'frame-src') {
                clearTimeout(timer);
                resolve(event.effectiveDirective);
              }
            },
            { once: true },
          );
          const frame = document.createElement('iframe');
          frame.src = 'https://example.com';
          document.body.append(frame);
          setTimeout(() => frame.remove(), 100);
        }),
    );
    assert.equal(subframe, 'frame-src');
    record('desktop.csp', '收到真实 frame-src CSP 拦截事件');
    const unconfirmed = await page.evaluate(() => window.study.start());
    assert.equal(unconfirmed.ok, false);
    record('desktop.startDenied', unconfirmed.code);
    const notBackedUp = await page.evaluate(() => window.study.createBackup());
    assert.equal(notBackedUp.code, 'STAGE_UNAVAILABLE');
    record('desktop.backupPlaceholder', '备份占位返回失败');
    const settings = await page.evaluate(() =>
      window.study.updateSettings({ pollIntervalMs: 4000, targetPlaybackRate: 1.25 }),
    );
    assert.equal(settings.ok, true);
    assert.equal(settings.data.config.pollIntervalMs, 4000);
    record('desktop.settings', '通过安全 IPC 保存有效自定义配置');
    const opened = await page.evaluate(() => window.study.openBrowser());
    assert.equal(opened.ok, true, JSON.stringify(opened));
    session = JSON.parse(await readFile(join(dataDir, 'browser-session.json'), 'utf8'));
    assert.equal(session.profilePath, join(dataDir, 'browser-profile'));
    record('edge.isolation', '真实有界面 Edge 使用测试应用 data/browser-profile');
    const observed = await page.evaluate(() => window.study.inspectCourse());
    assert.equal(observed.data.source, 'real-unverified');
    assert.equal(observed.data.platformCompleted, null);
    const confirm = await page.evaluate(() => window.study.confirmCourse('invented-course'));
    assert.equal(confirm.ok, false);
    record('desktop.courseGate', '无可靠课程ID不能确认；未访问真实课程');
    const paused = await page.evaluate(() => window.study.pause());
    assert.equal(paused.data.state, 'PAUSED');
    const stopped = await page.evaluate(() => window.study.stop());
    assert.equal(stopped.data.state, 'IDLE');
    record('desktop.control', '暂停/停止实际经过 TaskEngine');
    await mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: `output/playwright/${prefix}-console.png`, fullPage: true });
    await closeApp(first);
    first = undefined;
    const endpoint = `http://127.0.0.1:${session.port}/json/version`;
    const after = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    assert.ok(after.ok);
    record('edge.survivesExit', 'Electron 进程退出后，原 Edge CDP 仍可达');
    process.kill(session.pid, 0);
    second = await launch();
    const secondPage = await second.firstWindow();
    await secondPage.waitForFunction(
      () => window.study && document.querySelector('#phase-pill').textContent !== '初始化',
    );
    const restart = await secondPage.evaluate(() => window.study.status());
    assert.notEqual(restart.data.task.state, 'MONITORING');
    assert.equal(restart.data.settings.config.pollIntervalMs, 4000);
    const reconnected = await secondPage.evaluate(() => window.study.reopenBrowser());
    assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
    const sessionAgain = JSON.parse(await readFile(join(dataDir, 'browser-session.json'), 'utf8'));
    assert.equal(sessionAgain.pid, session.pid);
    assert.equal(sessionAgain.browserPath, session.browserPath);
    record('edge.reconnect', '重启 Electron 后连接同一 Edge PID/端点，不自动续跑');
    const temporary = await chromium.connectOverCDP(
      `ws://127.0.0.1:${session.port}${session.browserPath}`,
    );
    const closeSession = await temporary.newBrowserCDPSession();
    await closeSession.send('Browser.close').catch(() => {});
    await temporary.close().catch(() => {});
    await secondPage.waitForFunction(async () => {
      const result = await window.study.status();
      return result.data.browser.state === 'DISCONNECTED' && result.data.task.state === 'PAUSED';
    });
    record('edge.unexpectedDisconnect', '关闭仅测试 Edge 后，操作台安全暂停，不自动重启');
    const exitDeadline = Date.now() + 5000;
    let browserExited = false;
    while (Date.now() < exitDeadline) {
      try {
        process.kill(session.pid, 0);
      } catch {
        browserExited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(browserExited, 'Closed test Edge must finish its asynchronous process shutdown');
    const reopened = await secondPage.evaluate(() => window.study.reopenBrowser());
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    session = JSON.parse(await readFile(join(dataDir, 'browser-session.json'), 'utf8'));
    assert.equal(session.profileId, sessionAgain.profileId);
    assert.notEqual(session.browserPath, sessionAgain.browserPath);
    const afterReopen = await secondPage.evaluate(() => window.study.status());
    assert.equal(afterReopen.data.task.state, 'PAUSED');
    record('edge.explicitReopen', '用户明确重开新 Edge，复用同一 profile，保持暂停');
    await closeApp(second);
    second = undefined;
    assert.ok(
      (
        await fetch(`http://127.0.0.1:${session.port}/json/version`, {
          signal: AbortSignal.timeout(3000),
        })
      ).ok,
    );
    record('edge.secondExit', '第二次退出后 Edge 仍存活');

    // 只删除本 smoke 新建应用里的身份记录，保留仍运行的专用 Edge 与 profile。
    assert.match(dataDir, /[\u4e00-\u9fff]/u);
    const sessionPath = join(dataDir, 'browser-session.json');
    const missingBefore = { ...session };
    await unlink(sessionPath);
    second = await launch();
    const missingPage = await second.firstWindow();
    await missingPage.waitForFunction(
      () => window.study && document.querySelector('#phase-pill').textContent !== '初始化',
    );
    assert.notEqual(
      (await missingPage.evaluate(() => window.study.status())).data.task.state,
      'MONITORING',
    );
    const missingRecovered = await missingPage.evaluate(() => window.study.reopenBrowser());
    assert.equal(missingRecovered.ok, true, JSON.stringify(missingRecovered));
    session = JSON.parse(await readFile(sessionPath, 'utf8'));
    assert.equal(session.pid, missingBefore.pid);
    assert.equal(session.port, missingBefore.port);
    assert.equal(session.browserPath, missingBefore.browserPath);
    assert.equal(session.profileId, missingBefore.profileId);
    assert.equal(session.profilePath, missingBefore.profilePath);
    const missingStatus = await missingPage.evaluate(() => window.study.status());
    assert.equal(missingStatus.data.browser.state, 'CONNECTED');
    assert.notEqual(missingStatus.data.task.state, 'MONITORING');
    record(
      'edge.missingSessionChinesePath',
      '中文路径中删除测试身份记录后，重新启动助手并明确重连，自动验证同一 Edge/PID/端点且不续跑',
    );
    await closeApp(second);
    second = undefined;

    // 助手离线时，仅重启本 smoke 的专用 Edge；故意保留旧身份记录。
    const stale = { ...session };
    const staleRaw = await readFile(sessionPath, 'utf8');
    const beforeIndependentRestart = await chromium.connectOverCDP(
      `ws://127.0.0.1:${stale.port}${stale.browserPath}`,
    );
    const restartCdp = await beforeIndependentRestart.newBrowserCDPSession();
    await restartCdp.send('Browser.close').catch(() => {});
    await beforeIndependentRestart.close().catch(() => {});
    const shutdownDeadline = Date.now() + 6000;
    let originalExited = false;
    while (Date.now() < shutdownDeadline) {
      try {
        process.kill(stale.pid, 0);
      } catch {
        originalExited = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(originalExited, 'Only the smoke-created Edge must exit before its profile is reused');
    const candidates = [
      process.env['ProgramFiles(x86)'],
      process.env.ProgramFiles,
      process.env.LOCALAPPDATA,
    ]
      .filter(Boolean)
      .map((base) => join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    let edgePath;
    for (const candidate of candidates) {
      try {
        await access(candidate);
        edgePath = candidate;
        break;
      } catch {
        /* 仅标准 Edge 路径。 */
      }
    }
    assert.ok(
      edgePath,
      'Recovery smoke requires the same standard-installed Edge used by BrowserBridge',
    );
    independentlyStarted = spawn(
      edgePath,
      [
        `--user-data-dir=${stale.profilePath}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-mode',
        '--new-window',
        'about:blank',
      ],
      { detached: true, stdio: 'ignore', windowsHide: true, shell: false },
    );
    let independentSpawnError;
    independentlyStarted.once('error', (error) => {
      independentSpawnError = error;
    });
    independentlyStarted.unref();
    assert.ok(independentlyStarted.pid);
    const independentDeadline = Date.now() + 10000;
    let independentReady = false;
    while (Date.now() < independentDeadline) {
      if (independentSpawnError) throw independentSpawnError;
      assert.equal(
        independentlyStarted.exitCode,
        null,
        'Independently restarted test Edge exited early',
      );
      try {
        const [portText, browserPath] = (
          await readFile(join(stale.profilePath, 'DevToolsActivePort'), 'utf8')
        )
          .trim()
          .split(/\r?\n/);
        const port = Number(portText);
        if (
          Number.isInteger(port) &&
          port > 0 &&
          port <= 65535 &&
          /^\/devtools\/browser\/[a-zA-Z0-9-]{8,128}$/.test(browserPath) &&
          browserPath !== stale.browserPath
        ) {
          // 在断言/重连失败时，finally也只能关闭本次spawn证明属于本测试的端点。
          independentEndpoint = { port, browserPath };
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(750),
            redirect: 'error',
          });
          const version = await response.json();
          if (
            response.ok &&
            version.webSocketDebuggerUrl === `ws://127.0.0.1:${port}${browserPath}`
          ) {
            independentReady = true;
            break;
          }
        }
      } catch {
        /* 等待新测试 Edge 写完 DevToolsActivePort，最长10秒。 */
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(
      independentReady && independentEndpoint,
      'Independently restarted test Edge must expose a fresh endpoint',
    );
    assert.equal(
      await readFile(sessionPath, 'utf8'),
      staleRaw,
      'Harness must retain the stale identity until the application validates recovery',
    );
    second = await launch();
    const stalePage = await second.firstWindow();
    await stalePage.waitForFunction(
      () => window.study && document.querySelector('#phase-pill').textContent !== '初始化',
    );
    assert.notEqual(
      (await stalePage.evaluate(() => window.study.status())).data.task.state,
      'MONITORING',
    );
    const staleRecovered = await stalePage.evaluate(() => window.study.reopenBrowser());
    assert.equal(staleRecovered.ok, true, JSON.stringify(staleRecovered));
    session = JSON.parse(await readFile(sessionPath, 'utf8'));
    assert.equal(session.pid, independentlyStarted.pid);
    assert.notEqual(session.pid, stale.pid);
    assert.equal(session.port, independentEndpoint.port);
    assert.equal(session.browserPath, independentEndpoint.browserPath);
    assert.notEqual(session.browserPath, stale.browserPath);
    assert.equal(session.profileId, stale.profileId);
    assert.equal(session.profilePath, stale.profilePath);
    const staleStatus = await stalePage.evaluate(() => window.study.status());
    assert.equal(staleStatus.data.browser.state, 'CONNECTED');
    assert.notEqual(staleStatus.data.task.state, 'MONITORING');
    record(
      'edge.staleSessionAfterOfflineRestart',
      '助手离线时同一专用profile的 Edge 独立重启，保留旧身份记录后重连自动验证新PID/端点，不自动续跑',
    );
    await closeApp(second);
    second = undefined;

    // 第三种恢复边界：身份文件和端口文件都有效但属于两个已关闭的测试 Edge。
    const lastClosed = { ...session };
    const beforeStaleFiles = await chromium.connectOverCDP(
      `ws://127.0.0.1:${lastClosed.port}${lastClosed.browserPath}`,
    );
    const staleFilesCdp = await beforeStaleFiles.newBrowserCDPSession();
    await staleFilesCdp.send('Browser.close').catch(() => {});
    await beforeStaleFiles.close().catch(() => {});
    const staleFilesDeadline = Date.now() + 6000;
    let lastClosedExited = false;
    while (Date.now() < staleFilesDeadline) {
      try {
        process.kill(lastClosed.pid, 0);
      } catch {
        lastClosedExited = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(lastClosedExited, 'Test Edge must fully exit before modifying its test port file');
    for (const closedEndpoint of [stale, lastClosed]) {
      const reachable = await fetch(`http://127.0.0.1:${closedEndpoint.port}/json/version`, {
        signal: AbortSignal.timeout(750),
        redirect: 'error',
      }).then(
        () => true,
        () => false,
      );
      assert.equal(reachable, false, 'Both stale test endpoints must be unreachable');
    }
    await writeFile(
      join(lastClosed.profilePath, 'DevToolsActivePort'),
      `${stale.port}\n${stale.browserPath}\n`,
      'utf8',
    );
    assert.deepEqual(JSON.parse(await readFile(sessionPath, 'utf8')), lastClosed);
    second = await launch();
    const staleFilesPage = await second.firstWindow();
    await staleFilesPage.waitForFunction(
      () => window.study && document.querySelector('#phase-pill').textContent !== '初始化',
    );
    const staleFilesOpened = await staleFilesPage.evaluate(() => window.study.openBrowser());
    assert.equal(staleFilesOpened.ok, true, JSON.stringify(staleFilesOpened));
    session = JSON.parse(await readFile(sessionPath, 'utf8'));
    assert.equal(session.profileId, lastClosed.profileId);
    assert.equal(session.profilePath, lastClosed.profilePath);
    assert.notEqual(session.browserPath, lastClosed.browserPath);
    assert.notEqual(session.browserPath, stale.browserPath);
    const staleFilesStatus = await staleFilesPage.evaluate(() => window.study.status());
    assert.equal(staleFilesStatus.data.browser.state, 'CONNECTED');
    assert.notEqual(staleFilesStatus.data.task.state, 'MONITORING');
    record(
      'edge.closedStaleSessionAndPortFile',
      'session与DevToolsActivePort分别指向已关闭的测试端点，用户明确打开可重建同profile新 Edge，任务不续跑',
    );
    await closeApp(second);
    second = undefined;
    return report;
  } catch (error) {
    report.cases.push({ id: 'desktop.failure', status: 'fail', details: String(error) });
    throw error;
  } finally {
    if (first) await closeApp(first).catch(() => {});
    if (second) await closeApp(second).catch(() => {});
    // Test teardown only: close exactly the browser endpoint created by this smoke run.
    const cleanupEndpoints = [independentEndpoint, session].filter(Boolean);
    const visited = new Set();
    for (const endpoint of cleanupEndpoints) {
      const endpointUrl = `ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`;
      if (visited.has(endpointUrl)) continue;
      visited.add(endpointUrl);
      try {
        const browser = await chromium.connectOverCDP(endpointUrl, { timeout: 3000 });
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send('Browser.close').catch(() => {});
        await browser.close().catch(() => {});
      } catch {
        /* Already closed by user / failed launch. Never kill other Edge processes. */
      }
    }
    await mkdir('work/logs', { recursive: true });
    await writeFile(`work/logs/${prefix}-results.json`, JSON.stringify(report, null, 2));
  }
}
