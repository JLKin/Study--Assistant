/**
 * 弹层识别与处置。
 * 真实站点播放页上会出现的层：
 *  - .el-dialog__wrapper（学前必读 / 课程提醒 / 异常行为提示 等 Element 弹窗）
 *  - div.dialog > .aberrant（平台锁定提示）
 *  - .vjs-modal-dialog（video.js 自带弹层）
 *  - AI 助教小智弹题（ai-* 容器，含“单判断题/正确答案/选项”）
 * 判定一律基于「可见 + 有文字 + 尺寸像弹层」，并用真实鼠标坐标点击。
 */

const VISION_HELPERS = `
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    if (el.offsetParent === null && s.position !== 'fixed') return false;
    return true;
  };
  const textOf = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  };
`;

const IGNORE_CLASS = /newList|courseMenu|box-right|videotop|appHeader|el-scrollbar__bar|subtitle|progressBar|progressBall/i;
const DIALOG_CLASS = /el-dialog|vjs-modal-dialog|ai-draggable-dialog|dialog|modal|popup|ques|quiz|exam|answer|topic|practice|exercise|mask-box|white-box/i;

/** 列出当前所有像弹窗的层，按面积从小到大（小 = 更内层/更可能是真正的对话框）。 */
export async function listModals(page) {
  return page.evaluate(
    ({ ignoreClass, dialogClass }) => {
      const ignoreRe = new RegExp(ignoreClass, 'i');
      const dialogRe = new RegExp(dialogClass, 'i');
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
        if (el.offsetParent === null && s.position !== 'fixed') return false;
        return true;
      };
      const textOf = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();

      const nodes = [];
      // 这些是 Element 弹窗的内部零件（标题条/关闭按钮），不是弹层本体，选中它们会拿不到按钮
      const PART_CLASS = /__(header|title|title2|body|footer|headerbtn|close)$|-title$|-header$/i;
      for (const el of document.querySelectorAll('body *')) {
        const cls = typeof el.className === 'string' ? el.className : '';
        if (!cls || ignoreRe.test(cls)) continue;
        if (!dialogRe.test(cls) && el.getAttribute('role') !== 'dialog' && el.getAttribute('aria-modal') !== 'true') continue;
        if (PART_CLASS.test(cls.trim())) continue;
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 180 || r.height < 80) continue;
        const text = textOf(el);
        if (text.length < 6) continue;
        // 排除纯遮罩
        if (/^(mask|v-modal|el-loading-mask)$/i.test(cls.trim())) continue;
        nodes.push({
          el,
          className: cls.slice(0, 160),
          role: el.getAttribute('role') ?? '',
          text,
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          area: Math.round(r.width * r.height),
          z: Number(getComputedStyle(el).zIndex) || 0,
        });
      }

      // 去掉包含别的小弹层的“外层包裹”，只保留最内层候选；
      // 但若内层是死的（没有选项也没有按钮，比如学前必读内部的 studyExam-div），
      // 就必须保留外层——按钮在外层 wrapper 上。
      const words = ['关闭', '确定', '确认', '我知道了', '知道了', '好的', '提交', '继续学习', '继续', '取消', '下次再说', '不再提示', '已绑定', '下次再看'];
      const isCloseBtn = (node) => /el-dialog__headerbtn|el-dialog__close|el-message-box__close|(^|[\s-])close([\s-]|$)|icon-close|guanbi/i.test(typeof node.className === 'string' ? node.className : '');
      const hasAction = (node) => {
        const scope = node.el.closest('.el-dialog__wrapper, .el-message-box__wrapper, .ai-draggable-dialog') ?? node.el;
        const clickable = [...scope.querySelectorAll('button, a, div, span, i, p, li, label')].some((child) => {
          if (!vis(child)) return false;
          const box = child.getBoundingClientRect();
          if (box.width < 14 || box.height < 12 || box.width > 420) return false;
          const text = textOf(child);
          if (text && text.length <= 14 && words.some((word) => text.includes(word))) return true;
          if (isCloseBtn(child) && box.width <= 80 && box.height <= 80) return true;
          return /^(?:[A-Da-d][.、．)）:：\s]+|对$|错$|正确$|错误$|是$|否)/.test(text);
        });
        return clickable;
      };
      const filtered = nodes.filter(
        (candidate) =>
          !nodes.some(
            (other) =>
              other !== candidate &&
              candidate.el.contains(other.el) &&
              other.area < candidate.area &&
              (hasAction(other) || !hasAction(candidate)),
          ),
      );

      return filtered
        .sort((a, b) => Number(hasAction(b)) - Number(hasAction(a)) || b.z - a.z || a.area - b.area)
        .slice(0, 6)
        .map(({ el, ...rest }) => {
          const rect = el.getBoundingClientRect();
          const rectCenter = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
          // 选项：A/B/C/D 或 对/错 语义的最小可点击单元
          const optionPattern = /^(?:[A-Da-d][.、．)）:：\s]+|对$|错$|正确$|错误$|是$|否$)/;
          const options = [...el.querySelectorAll('li, div, label, span, p, a, button')]
            .filter((node) => {
              if (!vis(node)) return false;
              const box = node.getBoundingClientRect();
              if (box.width < 30 || box.height < 14 || box.width > 1100) return false;
              const text = textOf(node);
              if (!text || text.length > 80) return false;
              if (!optionPattern.test(text)) return false;
              const inner = [...node.querySelectorAll('li, div, label, span, p, a, button')].filter(
                (child) => child !== node && optionPattern.test(textOf(child)) && textOf(child) !== text,
              );
              return inner.length === 0;
            })
            .slice(0, 10)
            .map((node) => {
              const box = node.getBoundingClientRect();
              return {
                text: textOf(node).slice(0, 60),
                x: Math.round(box.x + box.width / 2),
                y: Math.round(box.y + box.height / 2),
                w: Math.round(box.width),
                h: Math.round(box.height),
              };
            });
          // 按钮：优先在本层找，找不到就看外层 Element 弹窗（关闭按钮常在 __header 里）
          const scope = el.closest('.el-dialog__wrapper, .el-message-box__wrapper, .ai-draggable-dialog') ?? el;
          const buttons = [...scope.querySelectorAll('button, a, div, span, i, p')]
            .filter((node) => {
              if (!vis(node)) return false;
              const box = node.getBoundingClientRect();
              if (box.width < 14 || box.height < 12 || box.width > 420) return false;
              const text = textOf(node);
              const byWord = text && text.length <= 14 && words.some((word) => text.includes(word));
              const byClose = isCloseBtn(node) && box.width <= 80 && box.height <= 80;
              if (!byWord && !byClose && !/^[×✕x]$/.test(text)) return false;
              const inner = [...node.querySelectorAll('button, a, div, span, i, p')].filter(
                (child) => child !== node && words.some((word) => textOf(child).includes(word)),
              );
              return inner.length === 0;
            })
            .slice(0, 10)
            .map((node) => {
              const box = node.getBoundingClientRect();
              return {
                text: textOf(node).slice(0, 20),
                cls: (typeof node.className === 'string' ? node.className : '').slice(0, 60),
                x: Math.round(box.x + box.width / 2),
                y: Math.round(box.y + box.height / 2),
                w: Math.round(box.width),
                h: Math.round(box.height),
              };
            });
          return { ...rest, center: rectCenter, options, buttons, html: el.outerHTML.slice(0, 4000) };
        });
    },
    { ignoreClass: IGNORE_CLASS.source, dialogClass: DIALOG_CLASS.source },
  );
}

/** 兼容旧接口：返回最上层弹层（无则 present:false）。 */
export async function inspectOverlay(page) {
  const modals = await listModals(page);
  if (modals.length === 0) return { present: false, modals: [] };
  const top = modals[0];
  const isQuiz = /单[选题]|多[选题]|判断|正确答案|请选择|选项|回答/.test(top.text) || top.options.length >= 2;
  const isGraded = /考试|计分|测验/.test(top.text);
  const isDetection = /异常|检测|锁定|脚本|插件/.test(top.text);
  // 易盾人机验证：需要人眼点字符/拖滑块，脚本点不动，只能等人来解
  const isCaptcha = /yidun/i.test(top.className) || /请点击(正向|侧向|倒立|横置)的|安全验证|拖动滑块|请完成验证|点击完成验证/.test(top.text);
  return { present: true, ...top, isQuiz, isGraded, isDetection, isCaptcha, modals };
}

/**
 * DOM 级关闭：坐标点击被遮挡或命中了错误节点时，直接调 Element 弹窗的关闭按钮 click()。
 * 实测「学前必读」弹窗里的 studyExam-div 会抢走焦点，只有 headerbtn 才真的能关掉。
 */
export async function closeByDom(page) {
  return page.evaluate(() => {
    const words = ['关闭', '确定', '确认', '我知道了', '知道了', '好的', '下次再说', '不再提示', '已绑定', '下次再看'];
    const txt = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const result = { hit: [], wrappers: 0 };
    const wrappers = [
      ...document.querySelectorAll(
        '.el-dialog__wrapper, .el-message-box__wrapper, .vjs-modal-dialog, .ai-draggable-dialog, .dialog-read, [role="dialog"]',
      ),
    ].filter((el) => vis(el) && txt(el).length > 4);
    result.wrappers = wrappers.length;
    // 内层优先（后出现的先关）
    for (const wrapper of wrappers.reverse()) {
      const byClass = wrapper.querySelector(
        '.el-dialog__headerbtn, .el-dialog__close, .el-message-box__close, [class*="headerbtn"], [class*="icon-close"], [class*="guanbi"], [class*="close"]',
      );
      if (byClass && vis(byClass)) {
        byClass.click();
        result.hit.push(`class:${(byClass.className || '').toString().slice(0, 40)}`);
        continue;
      }
      const byWord = [...wrapper.querySelectorAll('button, a, span, div')].find(
        (el) => vis(el) && words.some((word) => txt(el).includes(word)) && txt(el).length <= 12,
      );
      if (byWord) {
        byWord.click();
        result.hit.push(`text:${txt(byWord).slice(0, 12)}`);
        continue;
      }
      const x = [...wrapper.querySelectorAll('i, span')].find((el) => /^[×✕x]$/.test(txt(el)) && vis(el));
      if (x) {
        x.click();
        result.hit.push('x');
      }
    }
    // 仍有 Element 遮罩残留时，直接移除（只移除 wrapper 的 display，不删节点）
    const leftovers = [...document.querySelectorAll('.el-dialog__wrapper')].filter((el) => vis(el));
    if (leftovers.length) {
      for (const el of leftovers) el.style.display = 'none';
      result.hit.push(`hide:${leftovers.length}`);
    }
    return result;
  });
}

/** 人类化点击：移动 → 按下 → 抬起。 */
export async function humanClick(page, point, { logger, label } = {}) {  if (!point) return false;
  await page.mouse.move(point.x, point.y, { steps: 8 }).catch(() => {});
  await page.mouse.down().catch(() => {});
  await page.mouse.up().catch(() => {});
  logger?.info('点击', { label, at: [point.x, point.y] });
  return true;
}

export function pickRandom(list) {
  if (!list || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}
