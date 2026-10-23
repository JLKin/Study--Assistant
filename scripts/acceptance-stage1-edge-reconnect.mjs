import { _electron, chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const archive = resolve('release/stage1-2026-10-17T06-28-39-649Z/智慧树学习助手-阶段1-win-x64.zip');
const expectedSha = '436ae17cfcff7dac39a380f476803f29daa1cf2f1b2c7f2276802d17a9061a79';
const root = resolve('work', `stage1-edge-reconnect-${randomUUID()}`);
const appDir = join(root, 'StudyAssistant-Stage1-win32-x64');
const executable = join(appDir, '智慧树学习助手-阶段1.exe');
const dataDir = join(appDir, 'data');
const evidence = resolve('docs/evidence/stage1/edge-reconnect-check.json');
const report = { checkedAt: new Date().toISOString(), packageSha256: expectedSha, cases: [] };
let application;
let session;
let failed = false;

async function launch() {
  application = await _electron.launch({ executablePath: executable, timeout: 30000 });
  const page = await application.firstWindow();
  await page.waitForFunction(
    () => window.study && document.querySelector('#task-state')?.textContent !== '初始化',
  );
  return page;
}
async function quit(force = false) {
  const child = application.process();
  const exited = new Promise((resolveExit, reject) => {
    if (child.exitCode !== null) return resolveExit();
    const timer = setTimeout(
      () => reject(new Error('Test Electron did not exit within 8 seconds')),
      8000,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  if (force) {
    const main = await application.evaluate(({ app }) => ({
      pid: process.pid,
      executable: app.getPath('exe'),
    }));
    assert.equal(resolve(main.executable), executable);
    assert.ok(Number.isSafeInteger(main.pid) && main.pid > 0 && main.pid !== process.pid);
    report.forcedTermination = {
      mainPid: main.pid,
      wrapperPid: child.pid,
      verifiedTestExecutable: true,
    };
    process.kill(main.pid);
  } else await application.evaluate(({ app }) => app.quit());
  await exited;
  child.stdout?.destroy();
  child.stderr?.destroy();
  application = undefined;
}
function pass(id, detail) {
  report.cases.push({ id, status: 'pass', detail });
  console.log(`PASS ${id}: ${detail}`);
}

try {
  assert.equal(
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
    expectedSha,
  );
  await mkdir(root, { recursive: true });
  const expanded = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      resolve('scripts/unzip.ps1'),
      '-Source',
      archive,
      '-Destination',
      root,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );
  assert.equal(expanded.status, 0, `ZIP extraction failed: ${expanded.stderr}`);
  let page = await launch();
  const opened = await page.evaluate(() => window.study.openBrowser());
  assert.equal(opened.ok, true);
  session = JSON.parse(await readFile(join(dataDir, 'browser-session.json'), 'utf8'));
  assert.equal(session.profilePath, join(dataDir, 'browser-profile'));
  const before = await page.evaluate(() => window.study.status());
  assert.equal(before.data.browser.state, 'CONNECTED');
  assert.equal(before.data.task.state, 'WAIT_LOGIN');
  pass(
    'D02',
    'Dedicated Edge launched from the isolated app and recorded only its own data/browser-profile.',
  );
  await quit();
  const endpoint = `http://127.0.0.1:${session.port}/json/version`;
  assert.ok((await fetch(endpoint, { signal: AbortSignal.timeout(3000) })).ok);
  pass('D08', 'Test-owned dedicated Edge remains reachable after Electron exits.');
  page = await launch();
  const reconnected = await page.evaluate(() => window.study.reopenBrowser());
  assert.equal(reconnected.ok, true);
  const again = JSON.parse(await readFile(join(dataDir, 'browser-session.json'), 'utf8'));
  assert.equal(again.pid, session.pid);
  assert.equal(again.port, session.port);
  const after = (await page.evaluate(() => window.study.status())).data;
  assert.equal(after.browser.state, 'CONNECTED');
  assert.equal(after.task.state, 'PAUSED');
  pass(
    'D09',
    'Restarted Electron reconnects to the same test-owned Edge PID and port; persisted wait-login state safely becomes paused and does not auto-run.',
  );
  await quit(true);
  assert.ok((await fetch(endpoint, { signal: AbortSignal.timeout(3000) })).ok);
  page = await launch();
  const afterForcedReconnect = await page.evaluate(() => window.study.reopenBrowser());
  assert.equal(afterForcedReconnect.ok, true);
  const afterForced = (await page.evaluate(() => window.study.status())).data;
  assert.equal(afterForced.browser.state, 'CONNECTED');
  assert.equal(afterForced.task.state, 'PAUSED');
  pass(
    'D12.connectedEdge',
    'Forced termination of test-owned Electron leaves its Edge alive; restart reconnects and remains paused.',
  );
  await quit();
} catch (error) {
  failed = true;
  report.failure = error instanceof Error ? error.message : String(error);
  console.error(report.failure);
} finally {
  if (application)
    await quit().catch((error) => {
      failed = true;
      report.shutdownFailure = String(error);
    });
  if (session) {
    try {
      const browser = await chromium.connectOverCDP(
        `ws://127.0.0.1:${session.port}${session.browserPath}`,
      );
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close');
      await browser.close();
      report.testOwnedEdgeClosed = true;
    } catch {
      report.testOwnedEdgeClosed = false;
    }
  }
  report.result = failed ? 'fail' : 'pass';
  await mkdir(resolve('docs/evidence/stage1'), { recursive: true });
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
}
if (failed) process.exitCode = 1;
else console.log(`${report.cases.length}/4 checks passed: ${evidence}`);
