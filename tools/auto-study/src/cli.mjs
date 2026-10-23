#!/usr/bin/env node
/**
 * 命令行入口。所有命令共用一个常驻 Edge（独立 profile + CDP 端口），登录一次长期有效。
 *
 *   node tools/auto-study/src/cli.mjs hall                  # 列出学堂里的课程
 *   node tools/auto-study/src/cli.mjs open <序号>            # 进入第 N 门课并保存页面结构
 *   node tools/auto-study/src/cli.mjs probe [url]           # 探测当前/指定页面结构
 *   node tools/auto-study/src/cli.mjs watch [--course N]    # 自动刷课
 *   node tools/auto-study/src/cli.mjs stop                  # 请求停止
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from './log.mjs';
import {
  ensureBrowser,
  ensurePage,
  loadConfig,
  isLoggedIn,
  waitForLogin,
  saveSession,
  shutdownBrowser,
  LOG_DIR,
  SHOT_DIR,
  STATE_DIR,
} from './browser.mjs';
import { readHallState, readStudyState } from './site.mjs';
import { isMooc, readMoocState } from './mooc.mjs';
import { clearHallOverlays, collectQueue, openCourse } from './hall.mjs';
import { sleep, short } from './util.mjs';

const [command = 'hall', ...rest] = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] ?? true : fallback;
};
const positional = rest.filter((value, index) => !value.startsWith('--') && !(rest[index - 1] ?? '').startsWith('--'));

const config = loadConfig();
const logger = new Logger(LOG_DIR, command);
mkdirSync(SHOT_DIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function dump(page, tag) {
  const name = `${tag}-${stamp()}`;
  const htmlPath = join(SHOT_DIR, `${name}.html`);
  const pngPath = join(SHOT_DIR, `${name}.png`);
  writeFileSync(htmlPath, await page.content(), 'utf8');
  await page.screenshot({ path: pngPath, fullPage: false }).catch(() => {});
  logger.info('已保存页面', { htmlPath, pngPath, url: page.url() });
  return { htmlPath, pngPath };
}

/** 拿到学堂页（必要时等登录）。 */
async function hallPage({ login = true } = {}) {
  const { context, detach } = await ensureBrowser(config, { logger, url: config.entryUrl });
  const page = await ensurePage(context, { url: config.entryUrl, match: (u) => /onlineweb\.zhihuishu\.com/.test(u), logger });
  await sleep(2500);
  if (!(await isLoggedIn(page))) {
    if (!login) throw new Error('未登录');
    logger.warn('未登录：请在 Edge 窗口完成登录（30 分钟内有效）');
    await waitForLogin(page, { timeoutMs: 1800000, logger });
    await page.goto(config.entryUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(4000);
  }
  await saveSession(context, logger);
  return { page, context, detach };
}

const main = async () => {
  if (command === 'stop') {
    writeFileSync(join(STATE_DIR, 'stop'), new Date().toISOString(), 'utf8');
    logger.info('已写入停止标记');
    return;
  }
  if (command === 'shutdown') {
    const killed = shutdownBrowser(config);
    logger.info('关闭浏览器进程', { killed });
    return;
  }
  rmSync(join(STATE_DIR, 'stop'), { force: true });

  const { page, context, detach } = await hallPage();

  if (command === 'hall') {
    const hall = await readHallState(page);
    logger.step('学堂课程', { url: hall.url, count: hall.cards.length });
    hall.cards.forEach((card, index) => {
      console.log(`${index + 1}. ${short(card.text, 100)}  [${card.percent ?? '-'}]`);
    });
    await detach();
    return;
  }

  if (command === 'open') {
    const index = Math.max(0, (Number(positional[0] ?? 1) || 1) - 1);
    const study = await openCourse(page, { index, tab: flag('tab'), config, logger });
    const state = await readStudyState(study);
    logger.step('播放页结构', {
      url: state.url,
      title: state.title,
      courseName: state.courseName,
      rowSelector: state.rowSelector,
      items: state.items.length,
      currentIndex: state.currentIndex,
      video: state.video,
      sample: state.items.slice(0, 8).map((item) => ({ i: item.index, cur: item.isCurrent, t: short(item.title, 30) })),
    });
    await dump(study, 'study');
    await detach();
    return;
  }

  if (command === 'probe') {
    const target = positional[0] ?? page.url();
    const probePage = /stuStudy|studyvideoh5|wisdom-mooc/.test(target) ? (await openCourse(page, { index: Number(flag('course', 0)) || 0, config, logger })) : page;
    await dump(probePage, 'probe');
    const state = await readStudyState(probePage);
    logger.step('探测结果', state);
    await detach();
    return;
  }

  if (command === 'queue') {
    // 只列队列，不刷课：确认所有 tab 里的课都能被发现
    const queue = await collectQueue(page, { config, logger });
    logger.step('待刷课程队列', { total: queue.length });
    queue.forEach((item, index) => console.log(`${index + 1}. [${item.tabName}] ${item.name}  ${item.percent ?? '-'}`));
    await detach();
    return;
  }

  if (command === 'watch') {
    const { Watcher } = await import('./engine.mjs');
    const only = flag('course');
    const tabFilter = flag('tab');
    const queue = await collectQueue(page, { tabFilter, config, logger });
    const filtered = only == null ? queue : queue.filter((item) => item.name.includes(only) || String(queue.indexOf(item)) === String(only));
    const todo = filtered.filter((item) => {
      const done = typeof item.percent === 'string' && /^100(\.0+)?\s*%?$/.test(item.percent.trim());
      if (done) logger.info('跳过（进度已 100%）', { course: item.name, percent: item.percent });
      return !done;
    });
    logger.step('开始自动刷课', { total: todo.length, queue: todo.map((item) => `${item.tabName}/${item.name}`) });
    const summary = [];
    for (const item of todo) {
      const study = await openCourse(page, { name: item.name, tab: item.tab, config, logger });
      const state = isMooc(study.url()) ? await readMoocState(study) : await readStudyState(study);
      const course = {
        key: item.name.replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 20) || 'course',
        title: state.courseName || item.name,
        url: study.url(),
      };
      logger.info('课程结构', {
        title: course.title,
        videos: state.items.length,
        finished: state.finishedCount,
        unfinished: state.items.length - state.finishedCount,
        chapterTests: state.hasChapterTest,
      });
      const watcher = new Watcher({ page: study, config, logger, course });
      await watcher.run();
      logger.step('本课程结束', {
        course: course.title,
        switches: watcher.switches,
        answers: watcher.answers,
        done: watcher.done,
        failed: Boolean(watcher.failed),
      });
      const entry = {
        course: course.title,
        tab: item.tabName,
        switches: watcher.switches,
        answers: watcher.answers,
        done: watcher.done,
        failed: Boolean(watcher.failed),
        aborted: Boolean(watcher.aborted),
        abortReason: watcher.abortReason ?? null,
        stopped: Boolean(watcher.stopRequested),
      };
      summary.push(entry);
      writeFileSync(join(STATE_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      if (watcher.stopRequested) {
        logger.warn('收到停止指令，本门课已收尾', { course: course.title });
        break;
      }
      if (watcher.aborted) {
        logger.error('已中止（平台异常标记），不再继续下一门课', { course: course.title, reason: watcher.abortReason });
        break;
      }
      // 回到学堂：同一标签页就导航回去，新标签页就关掉
      if (study !== page) {
        await study.close().catch(() => {});
        await page.bringToFront().catch(() => {});
      } else {
        await page.goto(config.entryUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      await sleep(3500);
    }
    logger.step('全部课程处理完成', { count: todo.length, summary });
    await detach();
    return;
  }

  if (command === 'quiz') {
    // 模块二：章节测试自动作答（用户手动开启）
    const { expandCatalog, readChapterTests } = await import('./site.mjs');
    const { runQuiz } = await import('./quiz.mjs');
    const only = flag('course');
    const testFilter = flag('test');
    const limit = Number(flag('limit', 0)) || 0;
    const submit = !rest.includes('--no-submit') && config.quizSubmit !== false;
    const quizConfig = { ...config, quizSubmit: submit };

    let queue = await collectQueue(page, { config, logger });
    if (only != null) queue = queue.filter((item) => item.name.includes(only) || String(queue.indexOf(item)) === String(only));
    logger.step('章节测试任务', { courses: queue.map((item) => item.name), submit, limit: limit || 'all' });

    const results = [];
    for (const item of queue) {
      const study = await openCourse(page, { name: item.name, tab: item.tab, config, logger });
      await expandCatalog(study, { maxRounds: 8 });
      await sleep(1200);
      let tests = await readChapterTests(study);
      if (testFilter) {
        // --test 支持：章节名片段（生涯觉醒）、测试名（平时测试）、或 1-based 序号（3）
        const asIndex = Number(testFilter);
        tests = Number.isInteger(asIndex) && asIndex > 0 && String(asIndex) === testFilter
          ? tests.slice(asIndex - 1, asIndex)
          : tests.filter((t, i) => `${t.chapter}${t.name}`.includes(testFilter) || String(i + 1) === testFilter);
      }
      if (limit) tests = tests.slice(0, limit);
      logger.step('待作答测试', { course: item.name, count: tests.length, tests: tests.map((t) => `${short(t.chapter, 12)}/${t.name}`) });
      for (const test of tests) {
        const point = await study.evaluate((domIndex) => {
          const el = document.querySelectorAll('.chapterScrollbar li')[domIndex];
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const nameEl = el.querySelector('.name') ?? el;
          const r = nameEl.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }, test.domIndex);
        if (!point) {
          logger.warn('测试项不可见，跳过', { test: test.name });
          continue;
        }
        await sleep(700);
        const before = new Set(context.pages());
        await study.mouse.move(point.x, point.y, { steps: 8 });
        await sleep(200);
        await study.mouse.down();
        await sleep(60);
        await study.mouse.up();

        const isQuiz = (p) => /onlineexamh5|stuExamWeb/.test(p.url());
        const deadline = Date.now() + 30000;
        let quizPage = null;
        while (Date.now() < deadline && !quizPage) {
          await sleep(1000);
          quizPage = context.pages().find((p) => !before.has(p) && isQuiz(p)) ?? (isQuiz(study) ? study : null);
        }
        if (!quizPage) {
          logger.warn('没有打开测试页，跳过', { test: test.name, url: study.url() });
          continue;
        }
        await quizPage.bringToFront().catch(() => {});
        await quizPage.waitForLoadState('domcontentloaded').catch(() => {});
        await sleep(4000);
        const result = await runQuiz(quizPage, { logger, config: quizConfig, course: `${item.name}/${test.name}` });
        results.push({ course: item.name, test: `${short(test.chapter, 20)}/${test.name}`, ...result });
        writeFileSync(join(STATE_DIR, 'quiz-summary.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
        if (quizPage !== study) await quizPage.close().catch(() => {});
        await study.bringToFront().catch(() => {});
        await sleep(2500);
      }
      if (study !== page) {
        await study.close().catch(() => {});
        await page.bringToFront().catch(() => {});
      } else {
        await page.goto(config.entryUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      await sleep(3000);
    }
    logger.step('章节测试全部结束', { count: results.length, results });
    await detach();
    return;
  }

  logger.error('未知命令', { command });
  await detach();
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('命令失败', { command, message: String(error?.stack ?? error).slice(0, 800) });
    process.exit(1);
  });
