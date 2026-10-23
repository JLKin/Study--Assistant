import electron from 'electron';
import { _electron, chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { serveStage2Fixture } from './stage2-fixture.mjs';
import { closeApp } from './smoke-lib.mjs';

const appPath = resolve('work', `stage2-desktop-${randomUUID()}`);
await mkdir(appPath, { recursive: true });
await cp('dist', join(appPath, 'dist'), { recursive: true });
await writeFile(
  join(appPath, 'package.json'),
  JSON.stringify({ name: 'study-stage2-smoke', version: '0.2.0', main: 'dist/main.cjs' }),
);
const fixture = await serveStage2Fixture();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let browser;
let session;
const report = {
  checkedAt: new Date().toISOString(),
  scope: '本机真实桌面和可控视频；待真实环境人工验收',
  cases: [],
};
const record = (id, details) => {
  report.cases.push({ id, status: 'pass', details });
  console.log(`PASS ${id}`);
};
try {
  app = await _electron.launch({ executablePath: electron, args: [appPath], env, timeout: 30000 });
  const ui = await app.firstWindow();
  await ui.waitForFunction(
    () => window.study && document.querySelector('#task-state').textContent !== '初始化',
  );
  assert.equal(await ui.locator('#rate').count(), 0);
  assert.match(await ui.locator('#manual-rate-note').textContent(), /网页播放器中手动设置/);
  record('stage2.manualRateSettings', '偏好设置移除目标倍速控件，明确由用户在网页手动设置');
  const opened = await ui.evaluate(() => window.study.openBrowser());
  assert.equal(opened.ok, true);
  session = JSON.parse(await readFile(join(appPath, 'data/browser-session.json'), 'utf8'));
  browser = await chromium.connectOverCDP(`ws://127.0.0.1:${session.port}${session.browserPath}`);
  const videoPage = browser.contexts()[0].pages().at(-1);
  await videoPage.goto(fixture.url);
  let inspected;
  const inspectionDeadline = Date.now() + 3000;
  // 两条 CDP 连接的导航通知可能晚于 goto 返回；仅重复只读检查，不启动动作。
  do {
    inspected = await ui.evaluate(() => window.study.inspectCourse());
    if (inspected.code === 'AMBIGUOUS_MONITOR_PAGE') throw new Error(inspected.message);
    if (inspected.data?.source === 'fixture') break;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < inspectionDeadline);
  assert.equal(inspected.data.source, 'fixture');
  assert.equal(inspected.ok, true);
  await ui.waitForFunction(() =>
    document.querySelector('#course-title').textContent.includes('本机'),
  );
  assert.equal(await ui.locator('#course-confirm').isEnabled(), true);
  record('stage2.courseDisplayed', '真实IPC显示本机课程与人工确认按钮');
  await ui.waitForFunction(() =>
    document.querySelector('#current-chapter').textContent.includes('章节一'),
  );
  assert.match(await ui.locator('#current-chapter').textContent(), /目录第 1 \/ 2 项/);
  assert.match(await ui.locator('#player-state').textContent(), /秒 · 当前视频 .*% · 1×/);
  assert.match(await ui.locator('#platform-progress').textContent(), /完成 0 · 未完成 2 · 未知 0/);
  assert.match(await ui.locator('#progress-source').textContent(), /本地模拟页/);
  assert.match(await ui.locator('#chapter-sample-note').textContent(), /历史采样与核验记录/);
  assert.match(await ui.locator('#progress-sample').textContent(), /未持续监测|非实时进度/);
  assert.equal(await ui.locator('#video-progress').isVisible(), true);
  record(
    'stage2.progressSummary',
    '真实IPC展示当前章节、目录位置、秒数、视频百分比、平台标记统计和非实时样本边界',
  );
  const denied = await ui.evaluate(() => window.study.start());
  assert.equal(denied.ok, false);
  record('stage2.confirmationGate', '未确认课程不能启动');
  await ui.locator('#course-confirm').click();
  await ui.waitForFunction(
    () => document.querySelector('#task-state').textContent === '等待确认课程',
  );
  await ui.locator('#start').click();
  await ui.waitForFunction(() => document.querySelector('#task-state').textContent === '监测中');
  assert.equal(await videoPage.locator('#stage2-video').evaluate((video) => video.playbackRate), 1);
  assert.equal(
    (await ui.evaluate(() => window.study.status())).data.monitor.observation.player.playbackRate,
    1,
  );
  assert.equal(
    await videoPage.evaluate(
      () => window.stage2Fixture.actions().filter((action) => action.type === 'set-rate').length,
    ),
    0,
  );
  record('stage2.player', '开始任务只观察本地video原有1倍速，不自动调速');
  await ui.waitForFunction(() => document.querySelectorAll('#chapter-rows tr').length === 2);
  // 先等真实IPC操作完成，再暂停后读磁盘；Windows上的外部readFile可能和原子rename竞争。
  await ui.waitForFunction(
    () =>
      !document.querySelector('#start').disabled &&
      document.querySelector('#feedback').textContent.includes('TASK_STARTED'),
  );
  assert.equal((await ui.evaluate(() => window.study.pause())).ok, true);
  const snapshot = JSON.parse(await readFile(join(appPath, 'data/state/snapshot.json'), 'utf8'));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.chapterId, 'chapter-001');
  assert.equal(
    snapshot.pendingOperations.some((operation) => operation.kind === 'playback-rate'),
    false,
  );
  record('stage2.persistence', '兼容schema1快照，开始监测未新增playback-rate操作记录');
  assert.equal((await ui.evaluate(() => window.study.resume())).ok, true);
  assert.equal(await videoPage.locator('#stage2-video').evaluate((video) => video.playbackRate), 1);
  await videoPage.locator('#manual-rate-150').click();
  await ui.waitForFunction(() => document.querySelector('#task-state').textContent === '已暂停');
  assert.equal(
    await videoPage.locator('#stage2-video').evaluate((video) => video.playbackRate),
    1.5,
  );
  assert.equal((await ui.evaluate(() => window.study.resume())).ok, true);
  await ui.waitForTimeout(3200);
  const manualRate = await ui.evaluate(() => window.study.status());
  assert.equal(manualRate.data.task.state, 'MONITORING');
  assert.equal(manualRate.data.monitor.observation.player.playbackRate, 1.5);
  assert.equal(
    await videoPage.locator('#stage2-video').evaluate((video) => video.playbackRate),
    1.5,
  );
  assert.equal(
    await videoPage.evaluate(
      () => window.stage2Fixture.actions().filter((action) => action.type === 'set-rate').length,
    ),
    0,
  );
  assert.equal((await ui.evaluate(() => window.study.pause())).ok, true);
  const afterManualRate = JSON.parse(
    await readFile(join(appPath, 'data/state/snapshot.json'), 'utf8'),
  );
  assert.equal(
    afterManualRate.pendingOperations.some((operation) => operation.kind === 'playback-rate'),
    false,
  );
  record(
    'stage2.manualPlaybackRate',
    '网站手动设1.5倍速后安全暂停，继续及默认轮询保留1.5读数且没有自动调速记录',
  );
  assert.equal((await ui.evaluate(() => window.study.resume())).ok, true);
  await videoPage.mouse.wheel(0, 150);
  assert.equal((await ui.evaluate(() => window.study.status())).data.task.state, 'MONITORING');
  record('stage2.scroll', '滚动不会触发人工关键操作暂停');
  await videoPage.locator('#manual-pause').click();
  await ui.waitForFunction(() => document.querySelector('#task-state').textContent === '已暂停');
  const actionCount = await videoPage.evaluate(() => window.stage2Fixture.actions().length);
  await videoPage.evaluate(() => window.stage2Fixture.set({ player: { playbackRate: 1 } }));
  await ui.waitForTimeout(3200);
  assert.equal(await videoPage.evaluate(() => window.stage2Fixture.actions().length), actionCount);
  assert.equal(await videoPage.locator('#submission-count').textContent(), '0');
  record('stage2.manualPause', '真实用户点击暂停后不再执行恢复或导航，提交哨兵0');
  await mkdir('docs/evidence/stage2', { recursive: true });
  await ui.screenshot({ path: 'docs/evidence/stage2/console-fixture.png', fullPage: true });
  await closeApp(app);
  app = undefined;
  assert.ok(
    (
      await fetch(`http://127.0.0.1:${session.port}/json/version`, {
        signal: AbortSignal.timeout(3000),
      })
    ).ok,
  );
  record('stage2.edgePreserved', '阶段2助手退出后测试Edge仍保留');
} catch (error) {
  report.cases.push({ id: 'stage2.failure', status: 'fail', details: String(error) });
  throw error;
} finally {
  if (app) await closeApp(app).catch(() => {});
  if (browser) {
    // 仅测试清理：关闭本脚本创建的专用实例，不触及用户 Edge。
    const cdp = await browser.newBrowserCDPSession().catch(() => null);
    await cdp?.send('Browser.close').catch(() => {});
    await browser.close().catch(() => {});
  }
  await new Promise((done) => fixture.server.close(done));
  await mkdir('docs/evidence/stage2', { recursive: true });
  await writeFile(
    'docs/evidence/stage2/desktop-fixture-results.json',
    JSON.stringify(report, null, 2),
  );
}
console.log(`${report.cases.length} stage2 desktop checks passed.`);
