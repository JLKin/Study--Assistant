/**
 * 智慧课程（wisdom-mooc.zhihuishu.com）播放页适配器。
 *
 * 与 studyvideoh5 完全不同的一套 UI（Element-UI + video.js）：
 * - 目录：`.el-collapse` > `.el-collapse-item`（每章）> `.el-collapse-item__content`
 *         > `.chapter-content` > `.chapter-item`（每个小节）
 *   小节内 `.item-num`(1.1) / `.item-name`(可计算思想) / `.progress-div > .el-progress[aria-valuenow]`(观看百分比)
 *   当前项 class 带 `current`
 * - 测试项：章内容里的 `div.test-box > span(测试)` —— 不是视频，必须跳过
 * - 视频：`video#vjs_container_html5_api`（真 video.js，控件 `.vjs-big-play-button` / `.vjs-play-control`）
 * - 完成判定：行内出现 `img.finish-icon`（实测 1.1 播到 81% 切走后立即出现）；
 *   未完成时才显示 `.progress-div` 的百分比圆环（aria-valuenow）
 */
import { sleep } from './util.mjs';

const VIS = `
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
`;

export function isMooc(url) {
  return /wisdom-mooc/.test(url ?? '');
}

/** 把折叠面板全部展开（否则点击目录项点不到）。 */
export async function expandMoocCatalog(page, { rounds = 3 } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    const n = await page
      .evaluate(() =>
        [...document.querySelectorAll('.el-collapse-item__header')].filter(
          (h) => h.getAttribute('aria-expanded') === 'false' && h.getBoundingClientRect().height > 0,
        ).length,
      )
      .catch(() => 0);
    if (!n) return true;
    await page
      .evaluate(() => {
        document.querySelectorAll('.el-collapse-item__header[aria-expanded="false"]').forEach((h) => h.click());
      })
      .catch(() => {});
    await sleep(1200);
  }
  return true;
}

/** 读取播放页状态，字段与 site.mjs 的 readStudyState 保持一致。 */
export async function readMoocState(page) {
  return page.evaluate(`
    (() => {
      ${VIS}
      const T = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
      const items = [];
      const chapters = [...document.querySelectorAll('.el-collapse-item')];
      chapters.forEach((chapter, ci) => {
        const head = chapter.querySelector('.el-collapse-item__header');
        const chapterName = T(head).replace(/^第.+?章[:：]?\\s*/, '').slice(0, 40) || T(head).slice(0, 20);
        const rows = [...chapter.querySelectorAll('.chapter-item')];
        rows.forEach((row) => {
          const num = T(row.querySelector('.item-num'));
          const title = T(row.querySelector('.item-name'));
          const bar = row.querySelector('.el-progress[role="progressbar"]');
          const percent = bar ? Number(bar.getAttribute('aria-valuenow') ?? 0) : 0;
          const box = row.querySelector('.item-box') ?? row;
          const r = box.getBoundingClientRect();
          const isCurrent = /(^|\\s)current(\\s|$)/.test(String(row.className));
          items.push({
            index: items.length,
            domIndex: items.length,
            chapterIndex: ci,
            hour: num,
            title: title || num,
            duration: null,
            finished:
              !!row.querySelector('.finish-icon') ||
              percent >= 99 ||
              /(^|\\s)(finish|finished|complete|completed|done)(\\s|$)/i.test(String(row.className)),
            half: percent > 0 && percent < 99,
            percent,
            isCurrent,
            chapter: chapterName,
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            visible: vis(box),
          });
        });
      });
      const currentIndex = items.findIndex((item) => item.isCurrent);
      const video = document.querySelector('video#vjs_container_html5_api') ?? document.querySelector('video');
      const vr = video ? video.getBoundingClientRect() : null;
      const titleEl = document.querySelector('.chapter-item.current .item-name');
      return {
        url: location.href,
        title: document.title,
        courseName: T(document.querySelector('.course-name, .courseName, header .title')).slice(0, 40),
        rowSelector: '.chapter-content .chapter-item',
        kind: 'mooc',
        items,
        currentIndex,
        finishedCount: items.filter((item) => item.finished).length,
        hasChapterTest: !!document.querySelector('.test-box'),
        currentTitle: T(titleEl).slice(0, 40),
        video: video
          ? {
              duration: video.duration || 0,
              currentTime: video.currentTime || 0,
              paused: video.paused,
              ended: video.ended,
              readyState: video.readyState,
              muted: video.muted,
              playbackRate: video.playbackRate,
              rect: vr ? [vr.x, vr.y, vr.width, vr.height].map(Math.round) : null,
            }
          : null,
      };
    })()
  `);
}

/** 点击第 index 个视频小节（会先展开所属章节）。 */
export async function clickMoocItem(page, index, { force = false } = {}) {
  const target = await page
    .evaluate(`
      ((idx) => {
        ${VIS}
        const rows = [...document.querySelectorAll('.chapter-item')];
        const row = rows[idx];
        if (!row) return { ok: false, reason: 'no-row' };
        const chapter = row.closest('.el-collapse-item');
        const head = chapter?.querySelector('.el-collapse-item__header');
        if (head && head.getAttribute('aria-expanded') === 'false') {
          head.click();
          return { ok: false, reason: 'expanded' };
        }
        const box = row.querySelector('.item-box') ?? row;
        box.scrollIntoView({ block: 'center' });
        const r = box.getBoundingClientRect();
        return { ok: true, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
      })(${Number(index)})
    `)
    .catch(() => ({ ok: false, reason: 'eval-failed' }));

  if (!target?.ok) {
    await sleep(1200);
    if (target?.reason === 'expanded') return clickMoocItem(page, index, { force });
    return { ok: false, reason: target?.reason ?? 'unknown' };
  }
  const [x, y, w, h] = target.rect;
  await page.mouse.move(x + w / 2, y + h / 2, { steps: 8 }).catch(() => {});
  await sleep(250);
  await page.mouse.down().catch(() => {});
  await page.mouse.up().catch(() => {});
  if (force) {
    await page
      .evaluate(
        `
        ((idx) => { const row = document.querySelectorAll('.chapter-item')[idx]; (row?.querySelector('.item-box') ?? row)?.click?.(); })(${Number(index)})
      `,
      )
      .catch(() => {});
  }
  return { ok: true };
}
