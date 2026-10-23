/**
 * 站点适配层：只做「读状态」，不含策略。
 * 选择器来自真实页面实测（2026-10-22，studyvideoh5.stuStudy）：
 *   .chapterScrollbar ul.list > li.chapter         章节标题行
 *   .chapterScrollbar ul.list > li.clearfix        小节标题行（.hour = 1.1）
 *   .chapterScrollbar ul.list li.video             视频行（.hour=1.1.1 .catalogue_title .time）
 *   li.video.current_play                          当前播放项
 *   li.video .time_icofinish                       已完成标记（可见＝已完成）
 *   li.video .time_ico_half                        学过一半
 *   li.chapter-test                                章节测试（另一个模块处理）
 *   video#vjs_container_html5_api                  视频元素
 *   #playButton / .controlsBar                     自定义控制条（默认 display:none，需 hover 视频）
 */

export async function readStudyState(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
      return true;
    };
    const textOf = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

    const listRoot = document.querySelector('.chapterScrollbar') ?? document;
    // 每个章节有自己的 ul.list，必须从 .chapterScrollbar 整体取 li，否则只拿到第一章
    const allRows = [...listRoot.querySelectorAll('li')];
    const nameCandidates = [
      '.source-name',
      '.videotop [class*="courseName"]',
      '.topBox [class*="courseName"]',
      '[class*="courseName"]',
      '.video-study [class*="title"]',
    ]
      .map((sel) => textOf(document.querySelector(sel)).slice(0, 80))
      .filter((text) => text && !/温馨提示|建议使用|浏览器|检测到|公告|更多课程/.test(text));
    const courseName = nameCandidates[0] ?? '';

    let currentChapter = '';
    const items = [];
    for (const row of allRows) {
      const cls = typeof row.className === 'string' ? row.className : '';
      if (/chapter-test/.test(cls)) {
        continue;
      }
      if (/(^|\s)chapter(\s|$)/.test(cls)) {
        currentChapter = textOf(row.querySelector('.catalogue_titleweight, .catalogue_title')) || textOf(row);
        continue;
      }
      if (!/(^|\s)video(\s|$)/.test(cls)) continue;
      const finishIcon = row.querySelector('.time_icofinish');
      const halfIcon = row.querySelector('.time_ico_half');
      const timeText = textOf(row.querySelector('.time'));
      const box = row.getBoundingClientRect();
      items.push({
        index: items.length,
        domIndex: allRows.indexOf(row),
        hour: textOf(row.querySelector('.hour')),
        title: (row.querySelector('.catalogue_title')?.getAttribute('title') ?? textOf(row.querySelector('.catalogue_title'))).slice(0, 120),
        duration: timeText,
        finished: Boolean(finishIcon && vis(finishIcon)),
        half: Boolean(halfIcon && vis(halfIcon)),
        isCurrent: /current_play|current|playing|active/i.test(cls),
        chapter: currentChapter,
        rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        visible: vis(row),
      });
    }

    const videoEl = document.querySelector('video');
    const video = videoEl
      ? {
          duration: videoEl.duration,
          currentTime: videoEl.currentTime,
          paused: videoEl.paused,
          ended: videoEl.ended,
          readyState: videoEl.readyState,
          muted: videoEl.muted,
          rect: (() => {
            const r = videoEl.getBoundingClientRect();
            return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
          })(),
        }
      : null;

    return {
      url: location.href,
      title: document.title,
      courseName,
      items,
      currentIndex: items.findIndex((item) => item.isCurrent),
      finishedCount: items.filter((item) => item.finished).length,
      video,
      hasChapterTest: Boolean(document.querySelector('.chapter-test')),
    };
  });
}

/**
 * 把目录完整撑开：目录是懒渲染的，刚进页面时 DOM 里可能只有第一章。
 * 反复把目录容器滚到底，直到 li.video 数量连续两次不变。
 */
export async function expandCatalog(page, { maxRounds = 12 } = {}) {
  let last = -1;
  let stable = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const count = await page.evaluate(() => {
      const box = document.querySelector('.chapterScrollbar');
      if (!box) return 0;
      const scroller = [...box.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 100) ?? box;
      scroller.scrollTop = scroller.scrollHeight;
      box.scrollTop = box.scrollHeight;
      // 触发一次滚动事件，唤醒懒加载
      box.dispatchEvent(new Event('scroll', { bubbles: true }));
      return box.querySelectorAll('li.video').length;
    });
    stable = count === last ? stable + 1 : 0;
    last = count;
    if (stable >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return last;
}

/** 学堂页顶部 tab：li#sharingClass 共享课 / #aiCourse 智慧课程 / #agentCourse AI智课 / #interestingClass 兴趣课 / #flipLesson 翻转课 */
export const HALL_TABS = [
  { id: 'sharingClass', name: '共享课', section: 'sharingClassed' },
  { id: 'aiCourse', name: '智慧课程', section: 'aiCourseed' },
  { id: 'agentCourse', name: 'AI智课', section: 'agentCourseed' },
  { id: 'interestingClass', name: '兴趣课', section: 'interestingClassed' },
  { id: 'flipLesson', name: '翻转课', section: 'flipLessoned' },
];

/** 切换学堂 tab，返回对应列表容器选择器。 */
export async function switchHallTab(page, tab) {
  const locator = page.locator(`li#${tab.id}`).first();
  if ((await locator.count()) === 0) return null;
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ force: true, timeout: 5000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2200));
  return `#${tab.section}`;
}

/** 学堂页课程卡片：ul.datalist > div.hoverList，左半区 .item-left-course，点击 .courseName 进入播放页。 */
export async function readHallState(page, { root = null } = {}) {
  return page.evaluate(({ rootSelector }) => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const textOf = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();

    const scope = rootSelector ? (document.querySelector(rootSelector) ?? document.body) : document.body;
    const rows = [...scope.querySelectorAll('ul.datalist > div, ul.datalist > li')].filter(vis);
    const cards = rows.map((row, index) => {
      const nameEl = row.querySelector('.courseName, [class*="courseName"], [class*="course-name"]');
      const processEl = row.querySelector('.processNum, [class*="processNum"], [class*="progress"]');
      const box = row.getBoundingClientRect();
      const nameBox = (nameEl ?? row).getBoundingClientRect();
      return {
        index,
        name: (textOf(nameEl) || textOf(row)).slice(0, 80),
        teacher: textOf(row.querySelector('.teacherName')).slice(0, 60),
        nowCourse: textOf(row.querySelector('.name')).slice(0, 60),
        percent: (textOf(processEl).match(/(\d+(?:\.\d+)?)%/) ?? [])[1] ?? null,
        text: textOf(row).slice(0, 160),
        clickPoint: {
          x: Math.round(nameBox.x + nameBox.width / 2),
          y: Math.round(nameBox.y + nameBox.height / 2),
        },
        rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
      };
    });
    return { url: location.href, title: document.title, cards, bodyText: textOf(document.body).slice(0, 800) };
  }, { rootSelector: root });
}

/**
 * 读取目录里的「章节测试 / 平时测试」项。
 * 真实结构：.chapterScrollbar li.chapter-test（title="点击测试"）> span.name（文本如「平时测试」或「第一章单元测试」）
 * 返回 [{domIndex, chapter, name, rect, clickPoint}]
 */
export async function readChapterTests(page) {
  return page.evaluate(() => {
    const textOf = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const root = document.querySelector('.chapterScrollbar') ?? document;
    const all = [...root.querySelectorAll('li')];
    const out = [];
    let chapter = '';
    all.forEach((li, domIndex) => {
      const cls = typeof li.className === 'string' ? li.className : '';
      if (/(^|\s)chapter(\s|$)/.test(cls)) {
        chapter = textOf(li.querySelector('.catalogue_titleweight, .catalogue_title')) || textOf(li);
        return;
      }
      if (!/chapter-test/.test(cls)) return;
      const nameEl = li.querySelector('.name') ?? li;
      const r = nameEl.getBoundingClientRect();
      out.push({
        domIndex,
        chapter,
        name: textOf(nameEl).slice(0, 40),
        title: li.getAttribute('title') ?? '',
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        clickPoint: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
        visible: r.width > 2 && r.height > 2,
      });
    });
    return out;
  });
}
