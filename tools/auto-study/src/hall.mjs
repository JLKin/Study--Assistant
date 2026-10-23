/**
 * 学堂页（课程列表页）操作：清理遮挡层、进入某门课、收集课程队列。
 * 抽成独立模块，自动刷课(engine/cli) 与 章节测试(quiz) 共用。
 */
import { HALL_TABS, readHallState, switchHallTab } from './site.mjs';
import { sleep, short } from './util.mjs';

/**
 * 清掉学堂页的全屏遮挡：实测存在「在线学习诚信承诺书」(.el-dialog__wrapper + .agree-btn「确认」)，
 * 不确认的话所有卡片点击都会落在遮罩上（elementFromPoint 拿到的是 div.el-dialog）。
 */
export async function clearHallOverlays(page, { rounds = 6, logger = null } = {}) {
  const PREFER = ['确认', '同意', '我知道了', '知道了', '确定', '关闭', '下次再说', '不再提示'];
  for (let round = 0; round < rounds; round += 1) {
    const found = await page.evaluate((prefer) => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 16 || r.height < 8) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const txt = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const out = [];
      let seq = 0;
      for (const wrap of document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper')) {
        if (!vis(wrap)) continue;
        const buttons = [...wrap.querySelectorAll('button, .el-button, .agree-btn, .el-dialog__headerbtn')].filter(vis);
        let chosen = null;
        for (const word of prefer) {
          chosen = buttons.find((b) => txt(b) === word || txt(b).includes(word));
          if (chosen) break;
        }
        if (!chosen) chosen = wrap.querySelector('.el-dialog__headerbtn');
        if (!vis(chosen)) continue;
        const mark = `dsh-${seq++}`;
        chosen.setAttribute('data-dsh-click', mark);
        out.push({ mark, label: txt(chosen).slice(0, 12) || chosen.className, title: txt(wrap).slice(0, 30) });
      }
      return out;
    }, PREFER);

    if (!found.length) return round;
    for (const item of found) {
      logger?.info?.('关闭学堂遮挡层', item);
      await page
        .locator(`[data-dsh-click="${item.mark}"]`)
        .click({ timeout: 3000, force: true })
        .catch(async () => {
          await page.evaluate((mark) => document.querySelector(`[data-dsh-click="${mark}"]`)?.click(), item.mark).catch(() => {});
        });
      await page.evaluate((mark) => document.querySelector(`[data-dsh-click="${mark}"]`)?.removeAttribute('data-dsh-click'), item.mark).catch(() => {});
      await sleep(1200);
    }
  }
  return rounds;
}

/**
 * 展开被折叠的课程：实测共享课默认只渲染 5 门，第 6 门「人工智能引论」藏在「查看更多」后面，
 * 必须先点它才会出现在 DOM 里（否则 queue 永远只有 5 门）。
 */
export async function revealAllCourses(page, { selector = null, rounds = 5, logger = null } = {}) {
  let clicked = 0;
  for (let i = 0; i < rounds; i += 1) {
    const target = await page
      .evaluate((rootSel) => {
        const T = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const scope = (rootSel ? document.querySelector(rootSel) : null) ?? document.body;
        const el = [...scope.querySelectorAll('*')].find(
          (n) => n.children.length === 0 && /^查看更多$/.test(T(n)) && n.getBoundingClientRect().width > 0,
        );
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
      }, selector)
      .catch(() => null);
    if (!target) break;
    const [x, y, w, h] = target.rect;
    await page.mouse.move(x + w / 2, y + h / 2, { steps: 6 }).catch(() => {});
    await sleep(200);
    await page.mouse.down().catch(() => {});
    await page.mouse.up().catch(() => {});
    clicked += 1;
    await sleep(2200);
  }
  if (clicked) logger?.info?.('展开「查看更多」', { clicked, selector });
  return clicked;
}

/** 在学堂页点击某门课，返回播放页 page（实测点击 .courseName 才会进入）。 */
export async function openCourse(page, { index = null, name = null, tab = null, config, logger }) {
  if (!/onlinestuh5|onlineweb/.test(page.url())) {
    await page.goto(config.entryUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(4000);
  }
  let root = null;
  if (tab) {
    const tabInfo = HALL_TABS.find((item) => item.id === tab);
    if (tabInfo) root = await switchHallTab(page, tabInfo);
  }
  await clearHallOverlays(page, { logger });
  await sleep(1200);
  await revealAllCourses(page, { selector: root, logger });
  let hall = await readHallState(page, { root });
  for (let attempt = 0; !hall.cards.length && attempt < 4; attempt += 1) {
    await sleep(2000);
    await page.mouse.wheel(0, 200).catch(() => {});
    await sleep(800);
    hall = await readHallState(page, { root });
  }
  logger?.info?.('课程卡片', { count: hall.cards.length, items: hall.cards.map((card) => short(card.name, 24)) });
  const card = name ? hall.cards.find((item) => item.name.includes(name)) : hall.cards[index];
  if (!card) throw new Error(`没有找到课程（${name ?? `第 ${(index ?? 0) + 1} 门`}，共 ${hall.cards.length} 门）`);
  logger?.step?.('进入课程', { name: card.name, percent: card.percent, nowCourse: card.nowCourse, tab });

  const beforePages = new Set(page.context().pages());
  const locator = page.locator('ul.datalist .courseName', { hasText: card.name.trim() }).first();
  if ((await locator.count()) === 0) throw new Error(`学堂页找不到课程「${card.name}」`);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(600);
  const box = await locator.boundingBox();
  if (!box) throw new Error(`课程「${card.name}」不可见`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await sleep(250);
  await page.mouse.down();
  await page.mouse.up();

  const isStudy = (p) => /stuStudy|studyvideoh5|wisdom-mooc/.test(p.url());
  const deadline = Date.now() + 30000;
  let study = null;
  while (Date.now() < deadline && !study) {
    await sleep(800);
    if (isStudy(page)) study = page;
    else study = page.context().pages().find((p) => !beforePages.has(p) && isStudy(p)) ?? null;
  }
  if (!study) {
    logger?.warn?.('未捕获到播放页', { url: page.url(), pages: page.context().pages().map((p) => p.url()) });
    throw new Error('进入课程失败：没有出现播放页');
  }
  await study.bringToFront().catch(() => {});
  await sleep(5000);
  return study;
}

/** 遍历学堂各 tab 收集课程队列：[{tab,tabName,name,percent}]。 */
export async function collectQueue(page, { tabFilter = null, config, logger } = {}) {
  const queue = [];
  for (const tab of HALL_TABS) {
    if (tabFilter && tab.id !== tabFilter) continue;
    const root = await switchHallTab(page, tab);
    if (!root) continue;
    await clearHallOverlays(page, { logger });
    await sleep(1500);
    await revealAllCourses(page, { selector: root, logger });
    const hall = await readHallState(page, { root });
    if (!hall.cards.length) continue;
    hall.cards.forEach((card) => queue.push({ tab: tab.id, tabName: tab.name, name: card.name, percent: card.percent }));
  }
  return queue;
}
