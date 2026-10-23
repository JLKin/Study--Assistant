/**
 * 模块二：章节测试自动作答（用户手动开启）。
 *
 * 站点：https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/...
 * 真实 DOM（2026-10-22 实测）：
 *   .examPaper_subject            一题一个（未显示的是 display:none）
 *     .subject_num                题号
 *     .subject_type               【判断题】/【单选题】/【多选题】 (20分)
 *     .subject_describe           题干
 *     .subject_node .nodeLab      选项（每个 .nodeLab 里：隐藏 input[type=radio|checkbox] +
 *                                 img.flagChecked（选中态靠 src 变：134c9fe… = 选中，e777864… = 未选）+
 *                                 span.mr10 字母 + .node_detail 选项文本）
 *   .switch-btn-box button        上一题 / 下一题
 *   顶部按钮                     提交作业 / 暂存作业
 *
 * 作答策略：按题型随机选项（判断题 2 选 1、单选 1 个、多选 1~n-1 个），
 * 全程用真实鼠标点击（站点校验 event.isTrusted），点完校验选中图标。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SHOT_DIR, STATE_DIR } from './browser.mjs';
import { sleep, sleepRange, pick, withTimeout, short } from './util.mjs';
import { raiseAlert, clearAlert } from './alerts.mjs';

const SELECTED_ICON = '134c9fe';
const UNSELECTED_ICON = 'e777864';

/** 读取测试页当前状态。phase: loading | paper | list | result | unknown */
export async function readQuizState(page) {
  return page.evaluate(
    ({ selectedIcon, unselectedIcon }) => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const T = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const papers = [...document.querySelectorAll('.examPaper_subject')].filter(vis);
      const bodyText = document.body.innerText.replace(/\s+/g, ' ').trim();
      const dialogs = [...document.querySelectorAll('.el-message-box, .el-dialog, .el-message-box__wrapper, .el-dialog__wrapper')]
        .filter(vis)
        .map((el) => ({
          cls: String(el.className).slice(0, 80),
          text: T(el).slice(0, 160),
          buttons: [...el.querySelectorAll('button, .el-button')].filter(vis).map((b) => {
            const r = b.getBoundingClientRect();
            return { text: T(b).slice(0, 10), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }),
        }))
        .filter((d) => d.buttons.length);
      // 注意：测试页里常驻一个隐藏的腾讯验证码 iframe（tcaptcha_iframe_dy），
      // 只有在真的弹出、并且尺寸可见时才算“需要人工验证”。
      const captchaEl = document.querySelector('.yidun--popup, .yidun_popup, .yidun, .tcaptcha-transform, #tcaptcha_iframe_dy, .tcaptcha-mask');
      const sizeOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
      };
      const captchaBox = sizeOf(captchaEl);
      const captcha = Boolean(
        captchaBox &&
          captchaBox.w > 120 &&
          captchaBox.h > 80 &&
          captchaBox.display !== 'none' &&
          captchaBox.visibility !== 'hidden' &&
          Number(captchaBox.opacity) > 0.05,
      );
      const paper = papers[0] ?? null;
      const q = paper
        ? {
            num: T(paper.querySelector('.subject_num')),
            type: (/多选/.test(T(paper.querySelector('.subject_type'))) ? 'multi' : /判断/.test(T(paper.querySelector('.subject_type'))) ? 'judge' : 'single'),
            typeText: T(paper.querySelector('.subject_type')),
            stem: T(paper.querySelector('.subject_describe')).slice(0, 120),
            options: [...paper.querySelectorAll('.nodeLab')].map((lab) => {
              const img = lab.querySelector('img');
              const src = img?.getAttribute('src') ?? '';
              const input = lab.querySelector('input');
              const r = lab.getBoundingClientRect();
              return {
                letter: T(lab.querySelector('.mr10')),
                text: T(lab.querySelector('.node_detail')).slice(0, 40),
                selected: src.includes(selectedIcon),
                icon: src.includes(selectedIcon) ? 'on' : src.includes(unselectedIcon) ? 'off' : 'other',
                inputType: input?.type ?? null,
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              };
            }),
          }
        : null;
      const buttons = [...document.querySelectorAll('.switch-btn-box button')];
      const stat = {
        prev: buttons[0]
          ? { text: T(buttons[0]), disabled: Boolean(buttons[0].disabled), ...(() => { const r = buttons[0].getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })() }
          : null,
        next: buttons[1]
          ? { text: T(buttons[1]), disabled: Boolean(buttons[1].disabled), ...(() => { const r = buttons[1].getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })() }
          : null,
      };
      // 顶部「提交作业」
      let submit = null;
      for (const el of document.querySelectorAll('button, .el-button, [class*=btn]')) {
        if (!vis(el)) continue;
        const t = T(el);
        if (/^提交作业$|^提交$|^交卷$/.test(t)) {
          const r = el.getBoundingClientRect();
          submit = { text: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          break;
        }
      }
      const questionCount = (() => {
        const m = bodyText.match(/题目数\s*(\d+)/) ?? bodyText.match(/总题数[:：]\s*(\d+)/);
        return m ? Number(m[1]) : null;
      })();
      let phase = 'unknown';
      if (paper) phase = 'paper';
      else if (/已提交|已完成|作业已提交|提交成功|得分|成绩/.test(bodyText) && /返回|查看/.test(bodyText)) phase = 'result';
      else if (/作业|考试|测试/.test(bodyText)) phase = 'list';
      if (captcha) phase = 'captcha';
      return {
        url: location.href,
        title: document.title,
        phase,
        captcha,
        captchaBox,
        loading: /正在加载/.test(bodyText),
        questionCount,
        timer: (bodyText.match(/剩余时间\s*[\d天时分秒]+/) ?? [null])[0],
        bodyText: bodyText.slice(0, 800),
        q,
        buttons: stat,
        submit,
        dialogs,
      };
    },
    { selectedIcon: SELECTED_ICON, unselectedIcon: UNSELECTED_ICON },
  );
}

async function clickAt(page, point, logger, label) {
  await page.mouse.move(point.x, point.y, { steps: 6 });
  await sleep(120);
  await page.mouse.down();
  await sleep(50);
  await page.mouse.up();
  logger?.info?.('点击', { label, at: [point.x, point.y] });
}

/** 作答当前题（随机选项），返回选择的字母数组。 */
export async function answerCurrent(page, { logger, config }) {
  const state = await readQuizState(page);
  if (!state.q) return null;
  const { type, options } = state.q;
  const count = options.length;
  let wanted;
  if (type === 'multi') {
    const max = Math.max(1, Math.min(count - 1, 2));
    const n = 1 + Math.floor(Math.random() * max);
    wanted = [];
    while (wanted.length < n) {
      const o = pick(options);
      if (!wanted.includes(o)) wanted.push(o);
    }
  } else {
    wanted = [pick(options)];
  }
  const chosen = [];
  for (const opt of wanted) {
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
      const ratio = attempt === 0 ? 0.5 : attempt === 1 ? 0.34 : 0.7;
      await clickAt(page, { x: opt.rect.x + Math.round(opt.rect.w * ratio), y: opt.rect.y + Math.round(opt.rect.h / 2) }, logger, `选项${opt.letter}`);
      await sleep(500 + attempt * 300);
      const now = await readQuizState(page);
      const same = now.q?.options.find((o) => o.letter === opt.letter);
      ok = Boolean(same?.selected);
      if (ok) break;
      // 兜底：直接派发事件
      await page
        .evaluate((letter) => {
          const labs = [...document.querySelectorAll('.examPaper_subject .nodeLab')];
          const lab = labs.find((l) => (l.querySelector('.mr10')?.innerText ?? '').trim() === letter);
          lab?.querySelector('.label')?.click();
        }, opt.letter)
        .catch(() => {});
      await sleep(600);
      const after = await readQuizState(page);
      ok = Boolean(after.q?.options.find((o) => o.letter === opt.letter)?.selected);
    }
    if (ok) chosen.push(opt.letter);
    else logger?.warn?.('选项点击未生效', { letter: opt.letter, text: short(opt.text, 20) });
    await sleepRange(config.quizAnswerDelayMs ?? [600, 1200]);
  }
  logger?.info?.('作答', { num: state.q.num, type, picked: chosen.join('') || '(无)' });
  return chosen;
}

/** 提交试卷：处理确认弹窗与可能的人机验证。 */
export async function submitPaper(page, { logger, config }) {
  let state = await readQuizState(page);
  if (!state.submit) {
    logger?.warn?.('页面上找不到「提交作业」按钮');
    return { submitted: false, reason: 'no-submit-button' };
  }
  await clickAt(page, { x: state.submit.x, y: state.submit.y }, logger, '提交作业');
  await sleep(2000);

  // 确认弹窗（「确定提交吗？」）
  for (let round = 0; round < 4; round += 1) {
    state = await readQuizState(page);
    const dialog = state.dialogs?.find((d) => /确定|提交|交卷/.test(d.text));
    if (!dialog) break;
    const ok = dialog.buttons.find((b) => /确定|确认|提交|是$/.test(b.text)) ?? dialog.buttons[0];
    logger?.info?.('确认提交', { text: dialog.text.slice(0, 50), button: ok.text });
    await clickAt(page, { x: ok.x, y: ok.y }, logger, `弹窗-${ok.text}`);
    await sleep(2500);
  }

  // 人机验证：等人解（提醒），最多 quizCaptchaWaitMs
  const waitMs = config.quizCaptchaWaitMs ?? 600000;
  const start = Date.now();
  let alerted = false;
  while (Date.now() - start < waitMs) {
    state = await readQuizState(page);
    if (!state.captcha) break;
    if (!alerted) {
      alerted = true;
      logger?.warn?.('提交时遇到人机验证，请在浏览器窗口里点掉');
      await raiseAlert({ kind: 'quiz-captcha', message: '章节测试提交时出现人机验证，请在浏览器窗口点掉（解完自动继续）', page, logger, config });
      await page.screenshot({ path: join(SHOT_DIR, `quiz-captcha-${Date.now()}.png`) }).catch(() => {});
    }
    await sleep(3000);
  }
  if (alerted) {
    await clearAlert();
    logger?.info?.('人机验证已解除，继续确认提交结果');
  }

  // 等结果
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    state = await readQuizState(page);
    if (!state.dialogs?.length && /已提交|提交成功|得分|成绩|返回/.test(state.bodyText)) break;
    await sleep(1500);
  }
  await page.screenshot({ path: join(SHOT_DIR, `quiz-submitted-${Date.now()}.png`) }).catch(() => {});
  logger?.step?.('提交结果', { phase: state.phase, text: short(state.bodyText, 160) });
  return { submitted: true, phase: state.phase, text: short(state.bodyText, 200), url: state.url };
}

/** 逐题作答直到最后一题（不提交）。 */
export async function answerAll(page, { logger, config }) {
  const log = [];
  let guard = 0;
  let lastNum = null;
  let stuck = 0;
  while (guard < 80) {
    guard += 1;
    let state = await withTimeout(readQuizState(page), 20000, 'quiz-read');
    if (state.phase === 'captcha') {
      logger?.warn?.('作答中出现人机验证，等待解除');
      await raiseAlert({ kind: 'quiz-captcha', message: '章节测试作答时出现人机验证，请点掉（解完自动继续）', page, logger, config });
      const until = Date.now() + (config.quizCaptchaWaitMs ?? 600000);
      while (Date.now() < until) {
        await sleep(3000);
        state = await readQuizState(page);
        if (!state.captcha) break;
      }
      await clearAlert();
      continue;
    }
    if (!state.q) {
      logger?.warn?.('当前没有可作答的题目', { phase: state.phase, text: short(state.bodyText, 100) });
      break;
    }
    const num = state.q.num;
    if (num === lastNum) stuck += 1;
    else stuck = 0;
    if (stuck > 4) {
      logger?.error?.('题目没有推进，停止作答', { num, text: short(state.q.stem, 40) });
      break;
    }
    lastNum = num;
    const picked = await answerCurrent(page, { logger, config });
    log.push({ num, type: state.q.type, stem: short(state.q.stem, 50), picked });

    // 判断是否最后一题：下一题按钮不可点，或题号等于题目总数
    const total = state.questionCount;
    const isLast = (total && Number(num) >= total) || Boolean(state.buttons.next?.disabled);
    if (isLast) {
      logger?.info?.('已到最后一题', { num, total });
      break;
    }
    const next = state.buttons.next;
    if (!next) {
      logger?.warn?.('找不到「下一题」');
      break;
    }
    await clickAt(page, { x: next.x, y: next.y }, logger, '下一题');
    await sleepRange(config.quizNextDelayMs ?? [900, 1600]);
    // 等题号变化
    for (let i = 0; i < 12; i += 1) {
      const now = await readQuizState(page);
      if (now.q?.num && now.q.num !== num) break;
      await sleep(700);
    }
  }
  writeFileSync(join(STATE_DIR, 'quiz-answers.json'), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  return log;
}

/** 完整流程：作答 → （可选）提交。 */
export async function runQuiz(page, { logger, config, course = null }) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const start = await readQuizState(page);
  logger?.step?.('章节测试页状态', {
    course,
    url: start.url,
    phase: start.phase,
    questionCount: start.questionCount,
    timer: start.timer,
    text: short(start.bodyText, 120),
  });
  if (start.phase === 'result' || /已提交|已完成/.test(start.bodyText)) {
    logger?.info?.('该测试已完成，跳过');
    return { skipped: true, reason: 'already-done' };
  }
  if (!start.q) {
    await page.screenshot({ path: join(SHOT_DIR, `quiz-nopaper-${Date.now()}.png`) }).catch(() => {});
    logger?.warn?.('测试页没有题目（可能是列表页/已完成）');
    return { skipped: true, reason: 'no-paper', phase: start.phase };
  }
  const answers = await answerAll(page, { logger, config });
  const submit = config.quizSubmit === false ? { submitted: false, reason: 'disabled' } : await submitPaper(page, { logger, config });
  const result = { answered: answers.length, answers, submit };
  logger?.step?.('章节测试完成', { course, answered: answers.length, submitted: submit.submitted, phase: submit.phase });
  return result;
}
