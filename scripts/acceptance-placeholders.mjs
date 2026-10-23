import electron from 'electron';
import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const appPath = resolve('work', `acceptance-placeholders-${randomUUID()}`);
const dataDir = join(appPath, 'data');
const evidencePath = resolve('docs/evidence/stage1/placeholders-results.json');
const report = {
  checkedAt: new Date().toISOString(),
  testApp: relative(resolve(), appPath).replaceAll('\\', '/'),
  executable: 'node_modules/electron/dist/electron.exe',
  builtMainSha256: createHash('sha256')
    .update(await readFile('dist/main.cjs'))
    .digest('hex'),
  scope: 'Fresh isolated Electron test copy; no Edge launch or real browser profile access.',
  inventoryPolicy: {
    names: 'All data files and directories, including electron and logs, are compared.',
    contents: 'Hash all files except logs/* and electron/* runtime contents.',
    exclusions:
      'Only normal log and Electron cache content changes; backup/report/diagnostics paths are included.',
  },
  cases: [],
  shutdown: 'not-started',
};

async function inventory() {
  const names = [];
  const hashes = {};
  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink(), 'Fresh test data must not contain symbolic links');
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      names.push(`${entry.isDirectory() ? 'directory' : 'file'}:${name}`);
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else if (!name.startsWith('logs/') && !name.startsWith('electron/')) {
        hashes[name] = createHash('sha256')
          .update(await readFile(join(directory, entry.name)))
          .digest('hex');
      }
    }
  }
  await walk(dataDir);
  return { names: names.sort(), hashes };
}

async function closeOwnApp(application) {
  const child = application.process();
  const exited = new Promise((resolveExit, reject) => {
    if (child.exitCode !== null) {
      resolveExit();
      return;
    }
    const timer = setTimeout(
      () => reject(new Error('Test Electron did not exit within 6 seconds')),
      6000,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  await application.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
  child.stdout?.destroy();
  child.stderr?.destroy();
}

await mkdir(appPath, { recursive: true });
await cp('dist', join(appPath, 'dist'), { recursive: true });
await writeFile(
  join(appPath, 'package.json'),
  JSON.stringify({ name: 'study-stage1-placeholders', version: '0.1.0', main: 'dist/main.cjs' }),
);

let application;
let failed = false;
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: electron,
    args: [appPath],
    env,
    timeout: 30000,
  });
  report.shutdown = 'pending';
  const page = await application.firstWindow();
  await page.waitForFunction(() =>
    document.querySelector('#feedback')?.textContent.includes('阶段 1 已就绪'),
  );
  const status = await page.evaluate(async () => (await window.study.status()).data);
  assert.equal(status.stage, 1);
  assert.equal(resolve(status.dataLocation), dataDir);
  assert.equal(status.browser.state, 'CLOSED');
  // Let the normal startup log flush complete before recording file names.
  await page.waitForTimeout(3500);
  const baseline = await inventory();
  report.baselineEntries = baseline.names.length;
  assert.ok(!baseline.names.includes('file:browser-session.json'));
  assert.ok(!baseline.names.some((name) => name.startsWith('file:browser-profile/')));

  for (const button of ['backup', 'recovery', 'report', 'diagnostics']) {
    await page.locator('#feedback').evaluate((element) => {
      element.textContent = 'Waiting for this test click';
    });
    await page.locator(`#${button}`).click();
    await page.waitForFunction(
      (id) =>
        document.querySelector('#feedback')?.textContent.includes('STAGE_UNAVAILABLE') &&
        !document.querySelector(`#${id}`).disabled,
      button,
    );
    assert.equal(await page.locator('#feedback').getAttribute('class'), 'error');
    const after = await inventory();
    assert.deepEqual(after.names, baseline.names, `${button} must not create/remove data entries`);
    assert.deepEqual(after.hashes, baseline.hashes, `${button} must not alter business files`);
    const browserState = await page.evaluate(
      async () => (await window.study.status()).data.browser.state,
    );
    assert.equal(browserState, 'CLOSED');
    report.cases.push({
      id: `D13.${button}`,
      status: 'pass',
      action: 'Actual button click in isolated headed Electron UI',
      code: 'STAGE_UNAVAILABLE',
      errorShown: true,
      newOrRemovedEntries: [],
      changedBusinessFiles: [],
      browserState,
    });
    console.log(`PASS D13.${button}: STAGE_UNAVAILABLE; no business files generated`);
  }
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/placeholders-console.png', fullPage: true });
  report.screenshot = 'output/playwright/placeholders-console.png';
} catch (error) {
  failed = true;
  report.failure = error instanceof Error ? error.message : 'Placeholder verification failed';
  console.error(report.failure);
} finally {
  if (application) {
    try {
      await closeOwnApp(application);
      report.shutdown = 'pass';
    } catch (error) {
      failed = true;
      report.shutdown = 'fail';
      report.shutdownFailure = error instanceof Error ? error.message : 'Test app exit failed';
      console.error(report.shutdownFailure);
    }
  }
  report.result = failed ? 'fail' : 'pass';
  await mkdir(resolve('docs/evidence/stage1'), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
}
if (failed) process.exitCode = 1;
else console.log(`${report.cases.length}/4 D13 checks passed. Evidence: ${evidencePath}`);
