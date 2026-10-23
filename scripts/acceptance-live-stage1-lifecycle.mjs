import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appDir = resolve('release/stage1-2026-10-17T06-28-39-649Z/StudyAssistant-Stage1-win32-x64');
const executable = join(appDir, '智慧树学习助手-阶段1.exe');
const sessionFile = join(appDir, 'data/browser-session.json');
const evidence = resolve('docs/evidence/stage1/live-lifecycle-check.json');
const report = {
  checkedAt: new Date().toISOString(),
  scope:
    'User-authorized lifecycle check of the installed stage 1 app. No page reads, navigation, credentials, profile contents, or course actions.',
  cases: [],
};
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
async function exit(force = false) {
  const child = application.process();
  const exited = new Promise((resolveExit, reject) => {
    if (child.exitCode !== null) return resolveExit();
    const timer = setTimeout(
      () => reject(new Error('Stage 1 app did not exit within 8 seconds')),
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
    report.forcedMainPid = main.pid;
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
  let page = await launch();
  const open = await page.evaluate(() => window.study.openBrowser());
  assert.equal(open.ok, true);
  session = JSON.parse(await readFile(sessionFile, 'utf8'));
  assert.ok(Number.isInteger(session.pid) && session.pid > 0);
  assert.ok(Number.isInteger(session.port) && session.port > 0);
  const before = (await page.evaluate(() => window.study.status())).data;
  assert.equal(before.browser.state, 'CONNECTED');
  assert.notEqual(before.task.state, 'MONITORING');
  await exit();
  assert.ok(
    (
      await fetch(`http://127.0.0.1:${session.port}/json/version`, {
        signal: AbortSignal.timeout(3000),
      })
    ).ok,
  );
  page = await launch();
  const reconnect = await page.evaluate(() => window.study.reopenBrowser());
  assert.equal(reconnect.ok, true);
  const again = JSON.parse(await readFile(sessionFile, 'utf8'));
  assert.equal(again.pid, session.pid);
  assert.equal(again.port, session.port);
  const afterReconnect = (await page.evaluate(() => window.study.status())).data;
  assert.equal(afterReconnect.browser.state, 'CONNECTED');
  assert.equal(afterReconnect.task.state, 'PAUSED');
  pass(
    'D09.livePid',
    'Same dedicated Edge PID and port reconnected after assistant restart; task paused.',
  );
  await exit(true);
  assert.ok(
    (
      await fetch(`http://127.0.0.1:${session.port}/json/version`, {
        signal: AbortSignal.timeout(3000),
      })
    ).ok,
  );
  page = await launch();
  const reconnectAfterForce = await page.evaluate(() => window.study.reopenBrowser());
  assert.equal(reconnectAfterForce.ok, true);
  const afterForce = (await page.evaluate(() => window.study.status())).data;
  assert.equal(afterForce.browser.state, 'CONNECTED');
  assert.equal(afterForce.task.state, 'PAUSED');
  pass(
    'D12.liveConnectedEdge',
    'Forced app exit retained dedicated Edge; restart reconnected and remained paused.',
  );
  await exit();
  report.dedicatedEdgeLeftRunning = true;
} catch (error) {
  failed = true;
  report.failure = error instanceof Error ? error.message : String(error);
  console.error(report.failure);
} finally {
  if (application)
    await exit().catch((error) => {
      failed = true;
      report.shutdownFailure = String(error);
    });
  report.result = failed ? 'fail' : 'pass';
  await mkdir(resolve('docs/evidence/stage1'), { recursive: true });
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
}
if (failed) process.exitCode = 1;
else console.log(`${report.cases.length}/2 live lifecycle checks passed: ${evidence}`);
