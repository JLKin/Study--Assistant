import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const archive = resolve('release/stage1-2026-10-17T06-28-39-649Z/智慧树学习助手-阶段1-win-x64.zip');
const expectedSha = '436ae17cfcff7dac39a380f476803f29daa1cf2f1b2c7f2276802d17a9061a79';
const testRoot = resolve('work', `stage1-recovery-${randomUUID()}`);
const appDir = join(testRoot, 'StudyAssistant-Stage1-win32-x64');
const executable = join(appDir, '智慧树学习助手-阶段1.exe');
const dataDir = join(appDir, 'data');
const configDir = join(dataDir, 'config');
const evidence = resolve('docs/evidence/stage1/recovery-checks.json');
const report = {
  checkedAt: new Date().toISOString(),
  packageSha256: expectedSha,
  scope: 'Original stage 1 ZIP, freshly extracted isolated data; no Edge or course opened.',
  cases: [],
};
let application;
let failed = false;

async function start() {
  application = await _electron.launch({ executablePath: executable, timeout: 30000 });
  const page = await application.firstWindow();
  await page.waitForFunction(
    () => window.study && document.querySelector('#task-state')?.textContent !== '初始化',
  );
  const status = (await page.evaluate(() => window.study.status())).data;
  assert.equal(status.stage, 1);
  assert.equal(resolve(status.dataLocation), dataDir);
  assert.equal(status.browser.state, 'CLOSED');
  return page;
}

async function stop(force = false) {
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
    // Playwright's spawned wrapper PID can differ from Electron's main PID on Windows.
    // Verify the main executable is our fresh test copy before terminating only that PID.
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

async function seed(primary, backup) {
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'settings.json'), primary);
  await writeFile(join(configDir, 'settings.valid.json'), backup);
  await unlink(join(configDir, 'repair-pending.json')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
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
  await mkdir(testRoot, { recursive: true });
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
      testRoot,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );
  assert.equal(expanded.status, 0, `ZIP extraction failed: ${expanded.stderr}`);

  let page = await start();
  const defaults = (await page.evaluate(() => window.study.status())).data.settings.config;
  assert.equal(defaults.schemaVersion, 1);
  await stop();
  const valid = { ...defaults, targetPlaybackRate: 1.25, logRetentionDays: 17 };
  const validText = JSON.stringify(valid);

  await seed(JSON.stringify({ ...valid, logRetentionDays: 'invalid' }), validText);
  page = await start();
  let view = (await page.evaluate(() => window.study.status())).data.settings;
  assert.equal(view.config.logRetentionDays, defaults.logRetentionDays);
  assert.equal(view.config.targetPlaybackRate, 1.25);
  assert.ok(view.issues.some((issue) => issue.key === 'logRetentionDays'));
  assert.match(await page.locator('#config-issues').textContent(), /logRetentionDays/);
  pass(
    'C02',
    'Only the invalid noncritical key fell back; valid customization and UI warning remain.',
  );
  await stop();

  await seed(JSON.stringify({ ...valid, pollIntervalMs: 'invalid' }), validText);
  page = await start();
  view = (await page.evaluate(() => window.study.status())).data.settings;
  assert.equal(view.blocked, true);
  assert.equal(view.config.pollIntervalMs, defaults.pollIntervalMs);
  assert.equal((await page.evaluate(() => window.study.start())).code, 'CONFIG_BLOCKED');
  await stop();
  page = await start();
  assert.equal((await page.evaluate(() => window.study.status())).data.settings.blocked, true);
  assert.equal((await page.evaluate(() => window.study.acknowledgeSettings())).ok, true);
  assert.equal((await page.evaluate(() => window.study.status())).data.settings.blocked, false);
  const afterAck = await page.evaluate(() => window.study.start());
  assert.equal(afterAck.ok, false);
  assert.notEqual(afterAck.code, 'CONFIG_BLOCKED');
  pass(
    'C03',
    `Critical repair blocks start across restart; acknowledgement removes config block, start still rejected (${afterAck.code}).`,
  );
  await stop();

  await seed('{broken', validText);
  page = await start();
  view = (await page.evaluate(() => window.study.status())).data.settings;
  assert.equal(view.source, 'backup');
  assert.equal(view.blocked, true);
  assert.equal(view.config.targetPlaybackRate, 1.25);
  assert.ok(view.issues.some((issue) => issue.key === 'document'));
  assert.match(await page.locator('#config-issues').textContent(), /document/);
  pass(
    'C04',
    'Broken primary falls back to valid backup, reports issue and requires confirmation.',
  );
  await stop();

  await seed('{primary-broken', '{backup-broken');
  page = await start();
  view = (await page.evaluate(() => window.study.status())).data.settings;
  assert.equal(view.blocked, true);
  assert.equal((await page.evaluate(() => window.study.start())).code, 'CONFIG_BLOCKED');
  assert.equal(await readFile(join(configDir, 'settings.json'), 'utf8'), '{primary-broken');
  assert.equal(await readFile(join(configDir, 'settings.valid.json'), 'utf8'), '{backup-broken');
  assert.match(await page.locator('#config-issues').textContent(), /document/);
  pass('C05', 'Both corrupted files remain intact; issue displayed and task start blocked.');
  await stop();

  const future = JSON.stringify({ ...valid, schemaVersion: 99 });
  await seed(future, validText);
  page = await start();
  assert.equal((await page.evaluate(() => window.study.status())).data.settings.blocked, true);
  assert.equal(await readFile(join(configDir, 'settings.json'), 'utf8'), future);
  assert.equal((await page.evaluate(() => window.study.start())).code, 'CONFIG_BLOCKED');
  pass('C06', 'Future schema rejected; original primary preserved and start blocked.');
  await stop();

  await seed(validText, validText);
  page = await start();
  assert.equal((await page.evaluate(() => window.study.pause())).ok, true);
  await stop(true);
  page = await start();
  const restart = (await page.evaluate(() => window.study.status())).data;
  assert.equal(restart.task.state, 'PAUSED');
  assert.equal(restart.task.cancelled, true);
  assert.equal(restart.browser.state, 'CLOSED');
  assert.equal(restart.settings.config.targetPlaybackRate, 1.25);
  assert.equal((await page.evaluate(() => window.study.start())).ok, false);
  pass(
    'D12',
    'Forced termination of test-owned Electron followed by restart remains paused; browser closed and no automatic task.',
  );

  // Within the isolated test copy, make the state path a file so real filesystem
  // operations cannot create the snapshot. Preserve the prior directory by rename.
  await rename(join(dataDir, 'state'), join(dataDir, 'state-before-fault'));
  await writeFile(join(dataDir, 'state'), 'isolated state path fault');
  const paused = await page.evaluate(() => window.study.pause());
  assert.equal(paused.code, 'STATE_WRITE_FAILED');
  const faultStatus = (await page.evaluate(() => window.study.status())).data;
  assert.equal(faultStatus.task.state, 'PAUSED');
  assert.equal(faultStatus.task.persistenceHealthy, false);
  const check = await page.evaluate(() => window.study.selfCheck());
  assert.equal(check.data.canStart, false);
  assert.ok(check.data.items.some((item) => item.critical && item.status === 'fail'));
  assert.equal((await page.evaluate(() => window.study.start())).ok, false);
  assert.equal((await page.evaluate(() => window.study.stop())).ok, false);
  pass(
    'C07',
    'Real state path failure stops persistence and blocks start; pause/stop respond safely. Windows ACL denial remains untested.',
  );
  await stop();
} catch (error) {
  failed = true;
  report.failure = error instanceof Error ? error.message : String(error);
  console.error(report.failure);
} finally {
  if (application) {
    try {
      await stop();
    } catch (error) {
      failed = true;
      report.shutdownFailure = String(error);
    }
  }
  report.result = failed ? 'fail' : 'pass';
  await mkdir(resolve('docs/evidence/stage1'), { recursive: true });
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
}
if (failed) process.exitCode = 1;
else console.log(`${report.cases.length}/7 checks passed: ${evidence}`);
