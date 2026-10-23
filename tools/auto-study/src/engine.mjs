/**
 * 刷课引擎。
 * 规则（来自实测）：
 *  - 视频进度到 progressThreshold（默认 81%）即切下一个视频，平台就会记为完成；
 *  - 中途弹题随机作答 → 关闭 → 视频会暂停 → 再点播放续播；
 *  - 目录里已有 .time_icofinish（可见）的视频跳过；
 *  - 章节测试（li.chapter-test）不属于本模块。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandCatalog, readStudyState } from './site.mjs';
import { clickMoocItem, expandMoocCatalog, isMooc, readMoocState } from './mooc.mjs';
import { inspectOverlay, humanClick, pickRandom, closeByDom } from './overlay.mjs';
import { ratio, short, sleep, sleepRange, withTimeout } from './util.mjs';
import { SHOT_DIR, STATE_DIR } from './browser.mjs';
import { writeStatus } from './status.mjs';
import { raiseAlert, clearAlert } from './alerts.mjs';
import { setSpeedByMouse } from './speed.mjs';
// 倍速由用户手动控制，脚本不再引用 speed.mjs

const STOP_FILE = join(STATE_DIR, 'stop');

export class Watcher {
  constructor({ page, config, logger, course }) {
    this.page = page;
    this.config = config;
    this.logger = logger;
    this.course = course ?? { title: '未命名课程', key: 'course' };
    this.threshold = config.progressThreshold ?? 0.81;
    this.answers = 0;
    this.switches = 0;
    this.badIndexes = new Set();
    this.lastProgress = null;
    this.videoKey = null;
    this.resetKey = null;
    this.speedKey = null;
    this.done = false;
    this.overlaySeen = new Map();
    mkdirSync(STATE_DIR, { recursive: true });
    mkdirSync(SHOT_DIR, { recursive: true });
  }

  get stopRequested() {
    return this.forcedStop === true || existsSync(STOP_FILE);
  }

  /** 供桌面应用/控制台直接停止（不必写 stop 文件）。 */
  requestStop() {
    this.forcedStop = true;
  }

  /** 当前播放页属于哪套站点（studyvideoh5 / wisdom-mooc）。 */
  get siteKind() {
    return isMooc(this.page.url()) ? 'mooc' : 'stu';
  }

  async readState() {
    return this.siteKind === 'mooc' ? readMoocState(this.page) : readStudyState(this.page);
  }

  async clickRowOn(page, index, opts) {
    if (this.siteKind === 'mooc') return clickMoocItem(page, index, opts);
    return this.clickRow(index, opts);
  }

  async run() {
    this.logger.step('开始刷本课程', { title: this.course.title, url: this.course.url ?? this.page.url() });
    const loaded =
      this.siteKind === 'mooc'
        ? await withTimeout(expandMoocCatalog(this.page), 40000, 'expandMoocCatalog').catch(() => -1)
        : await withTimeout(expandCatalog(this.page), 40000, 'expandCatalog').catch(() => -1);
    this.logger.info('目录已展开', { videos: loaded, site: this.siteKind });
    let idle = 0;
    let errors = 0;
    let beats = 0;
    let lastBeat = Date.now();
    while (!this.stopRequested && !this.done && !this.aborted) {
      try {
        const acted = await withTimeout(this.step(), 90000, 'step');
        idle = acted ? 0 : idle + 1;
        errors = 0;
      } catch (error) {
        errors += 1;
        this.logger.error('循环异常（继续）', { message: String(error).slice(0, 300), errors });
        await sleep(2000);
        if (errors >= 5) {
          this.failed = true;
          this.logger.error('连续异常，放弃本课程', { title: this.course.title });
          await this.screenshot('course-failed');
          break;
        }
      }
      // 心跳：让外部看门狗能判断「进程还活着」，也便于定位卡在哪个视频
      beats += 1;
      if (Date.now() - lastBeat > 15000) {
        lastBeat = Date.now();
        const st = this.state;
        const alive = /stuStudy|wisdom-mooc/.test(st?.url ?? '');
        writeStatus({
          running: true,
          course: this.course.title,
          courseUrl: this.course.url,
          onStudyPage: alive,
          index: st?.currentIndex ?? -1,
          title: st?.items?.[st?.currentIndex]?.title ?? '',
          currentTime: st?.video ? Number(st.video.currentTime.toFixed(0)) : -1,
          duration: st?.video ? Number((st.video.duration || 0).toFixed(0)) : -1,
          paused: st?.video?.paused ?? null,
          finished: st ? st.items.filter((item) => item.finished).length : -1,
          total: st?.items?.length ?? -1,
          switches: this.switches,
          answers: this.answers,
          idle,
          done: this.done,
          aborted: this.aborted,
          abortReason: this.abortReason ?? null,
        });
      }
      if (beats % 20 === 0) {
        const st = this.state;
        this.logger.info('心跳', {
          beats,
          url: /wisdom-mooc/.test(st?.url ?? '') ? 'mooc' : /stuStudy/.test(st?.url ?? '') ? 'stuStudy' : String(st?.url ?? '').slice(0, 60),
          cur: st?.currentIndex ?? -1,
          t: st?.video ? Number(st.video.currentTime.toFixed(0)) : -1,
          paused: st?.video?.paused ?? null,
          finished: st ? st.items.filter((item) => item.finished).length : -1,
          idle,
        });
      }
      await sleep(this.config.pollIntervalMs ?? 900);
    }
    if (this.done) this.logger.step('本课程已全部完成', { title: this.course.title, switches: this.switches, answers: this.answers });
    if (this.aborted) this.logger.error('本课程中止', { title: this.course.title, reason: this.abortReason });
    writeStatus({ running: false, course: this.course.title, done: !!this.done, aborted: !!this.aborted, abortReason: this.abortReason ?? null });
  }

  async step() {
    const state = await withTimeout(this.readState(), 15000, 'readState');
    this.state = state;

    if (state.items.length === 0) {
      const offPage = !/stuStudy|studyvideoh5|wisdom-mooc/.test(state.url);
      this.logger.warn('目录为空（页面可能未加载完或不在播放页）', { url: state.url, offPage, lost: this.lostStreak });
      if (offPage) {
        this.lostStreak = (this.lostStreak ?? 0) + 1;
        // 页面被站点踢回学堂时自愈：直接回到本课程的播放地址
        if (this.lostStreak >= 2 && this.course.url) {
          this.logger.warn('播放页丢失，重新打开本课程', { url: this.course.url, attempt: this.lostStreak });
          await this.page.goto(this.course.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(6000);
          this.lostStreak = 0;
          return true;
        }
      } else {
        this.lostStreak = 0;
      }
      await sleep(2500);
      return false;
    }
    this.lostStreak = 0;

    const overlay = await withTimeout(inspectOverlay(this.page), 12000, 'inspectOverlay');
    if (overlay.present) {
      // 人机验证只能人工过：不点、不关，等人解掉后继续
      if (overlay.isCaptcha) {
        this.captchaTicks = (this.captchaTicks ?? 0) + 1;
        if (this.captchaTicks === 1) {
          await this.screenshot('captcha');
          this.alerted = true;
          await raiseAlert({
            kind: 'captcha',
            message: '遇到人机验证，请在浏览器窗口里点掉（解完自动继续）',
            page: this.page,
            logger: this.logger,
            config: this.config,
          });
        }
        const waitMs = this.config.captchaWaitMs ?? 90000;
        if (this.captchaTicks * 3000 > waitMs) {
          // 无人值守策略：先刷新页面碰运气，同一门课连续 2 次都过不去才中止，避免整晚卡死。
          this.captchaAborts = (this.captchaAborts ?? 0) + 1;
          this.logger.error('人机验证长时间未解，尝试刷新重来', {
            waited: this.captchaTicks * 3,
            attempt: this.captchaAborts,
          });
          this.captchaTicks = 0;
          if (this.captchaAborts >= 2) {
            this.aborted = true;
            this.abortReason = 'captcha';
            return false;
          }
          await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(6000);
          return true;
        }
        await sleep(3000);
        return false;
      }
      this.captchaTicks = 0;
      await this.handleOverlay(overlay);
      return true;
    }
    this.captchaTicks = 0;
    if (this.alerted) {
      clearAlert();
      this.logger.info('人机验证已解除，继续刷课');
    }
    this.alerted = false;

    if (!state.video) {
      this.logger.warn('没有视频元素，尝试点击当前目录项挂载播放器');
      if (state.currentIndex >= 0) await this.clickRowOn(this.page, state.currentIndex);
      await sleep(2000);
      return true;
    }

    const progress = ratio(state.video.currentTime, state.video.duration);
    const key = `${state.currentIndex}:${Math.round(state.video.duration || 0)}`;
    if (this.videoKey !== key) {
      this.videoKey = key;
      this.lastProgress = { time: state.video.currentTime, at: Date.now() };
      // 进来就已超过阈值（之前被跳转过、没真正看过）→ 必须播完，否则拿不到完成标记
      this.needFinish = progress >= this.threshold - 0.005;
      this.logger.info('当前视频', {
        idx: state.currentIndex + 1,
        title: short(state.items[state.currentIndex]?.title ?? '', 40),
        duration: Number((state.video.duration || 0).toFixed(1)),
        from: Number(state.video.currentTime.toFixed(1)),
        finishedBefore: state.items.filter((item) => item.finished).length,
        total: state.items.length,
        needFinish: this.needFinish,
      });
    }

    // 已经完成的视频不必再播，直接切到下一个未完成
    const currentItem = state.items[state.currentIndex];
    if (currentItem?.finished) {
      this.logger.info('当前视频已有完成标记，直接切下一个', { idx: state.currentIndex + 1, title: short(currentItem.title ?? '', 30) });
      await this.advance(state);
      return true;
    }

    // 实测结论：平台按「真实观看秒数」记账，从中间接着看只算新增的那段，拿不到完成标记。
    // 所以每个未完成视频都从 0 开始播（向后 seek 是正常的“重看”行为，不会触发异常检测）。
    if (this.config.restartFromZero !== false && this.resetKey !== key && state.video.currentTime > 8) {
      this.resetKey = key;
      const ok = await this.page
        .evaluate(() => {
          const video = document.querySelector('video#vjs_container_html5_api') ?? document.querySelector('video');
          if (!video) return false;
          video.currentTime = 0;
          video.play().catch(() => {});
          return true;
        })
        .catch(() => false);
      this.logger.warn('从 0 重播（平台只计真实观看时长）', { from: Number(state.video.currentTime.toFixed(1)), ok });
      await sleep(1500);
      return true;
    }

    // 倍速：默认完全不碰，用户自己点站点的 X 1.5。
    // 如果 config.speedPreset 设成 1.5，就用「真实鼠标」点站点的倍速按钮（实测人工点不判异常）。
    // 反例（勿再尝试）：JS 赋值 video.playbackRate 或 .speedTab.click() → 1 秒内弹「检测到异常脚本」。
    const speedPreset = Number(this.config.speedPreset ?? 0);
    if (speedPreset > 1 && this.speedKey !== key) {
      this.speedKey = key;
      const res = await withTimeout(setSpeedByMouse(this.page, speedPreset, { logger: this.logger }), 20000, 'speed').catch(
        (err) => ({ ok: false, reason: String(err?.message ?? err) }),
      );
      this.logger.info('设置倍速（真实鼠标点击）', { want: speedPreset, ...res });
    }



    // 平台按「真实观看时长」计分：如果进来时就已经超过阈值（说明之前被跳转过、并未真正观看），
    // 就不能再靠 81% 切走，必须播到结束，否则这条永远拿不到完成标记。
    if (state.video.ended || (progress >= this.threshold && !this.needFinish)) {
      this.logger.info('到达切换点', {
        progress: `${(progress * 100).toFixed(1)}%`,
        title: short(state.items[state.currentIndex]?.title ?? '', 40),
      });
      await this.advance(state);
      return true;
    }

    if (state.video.paused) {
      await this.play('暂停续播');
      return true;
    }

    if (state.video.currentTime > (this.lastProgress?.time ?? 0) + 0.5) {
      this.lastProgress = { time: state.video.currentTime, at: Date.now() };
    } else if (Date.now() - (this.lastProgress?.at ?? Date.now()) > (this.config.playStallMs ?? 25000)) {
      this.logger.warn('进度停滞，尝试自愈播放', {
        t: Number(state.video.currentTime.toFixed(1)),
        readyState: state.video.readyState,
      });
      this.lastProgress = { time: state.video.currentTime, at: Date.now() };
      await this.play('停滞自愈');
    }
    return false;
  }

  /** 悬停视频唤出控制条 → 点 #playButton；失败再退回 video.play()。 */
  async play(reason) {
    const rect = this.state?.video?.rect;
    if (rect) {
      await this.page.mouse.move(rect[0] + rect[2] / 2, rect[1] + rect[3] / 2, { steps: 6 }).catch(() => {});
      await sleep(350);
    }
    const point = await this.page
      .evaluate(() => {
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 6 || r.height < 6) return false;
          const s = getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        };
        for (const selector of ['#playButton .bigPlayButton', '.vjs-big-play-button', '#playButton', '.playButton', '.bigPlayButton']) {
          const el = document.querySelector(selector);
          if (vis(el)) {
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
        }
        return null;
      })
      .catch(() => null);

    let clicked = false;
    if (point) clicked = await humanClick(this.page, point, { logger: this.logger, label: `播放按钮(${reason})` });
    await sleep(700);

    const paused = await this.page.evaluate(() => document.querySelector('video')?.paused ?? true).catch(() => true);
    if (paused && this.siteKind === 'mooc' && rect) {
      // video.js 支持点画面切换播放/暂停
      await humanClick(this.page, { x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] / 2 }, { logger: this.logger, label: '画面点击播放' }).catch(() => {});
      await sleep(700);
    }
    const paused2 = await this.page.evaluate(() => document.querySelector('video')?.paused ?? true).catch(() => true);
    if (paused2) {
      await this.page
        .evaluate(() => {
          const video = document.querySelector('video');
          if (!video) return;
          video.muted = true;
          video.play().catch(() => {});
        })
        .catch(() => {});
      await sleep(600);
    }
    const nowPlaying = await this.page.evaluate(() => !(document.querySelector('video')?.paused ?? true)).catch(() => false);
    this.logger.info(nowPlaying ? '已开始播放' : '播放未生效（下轮重试）', { reason, viaButton: clicked });
    if (!nowPlaying) await this.screenshot('play-failed');
    return nowPlaying;
  }

  /** 弹层处置。 */
  async handleOverlay(overlay) {
    const signature = `${overlay.className}|${overlay.text.slice(0, 80)}`;
    const seenTimes = (this.overlaySeen.get(signature) ?? 0) + 1;
    this.overlaySeen.set(signature, seenTimes);

    this.logger.step('弹层', {
      cls: short(overlay.className, 60),
      quiz: overlay.isQuiz,
      graded: overlay.isGraded,
      detection: overlay.isDetection,
      options: overlay.options.map((option) => option.text),
      buttons: overlay.buttons.map((button) => button.text),
      text: short(overlay.text, 160),
      seenTimes,
    });

    // 平台异常提示：只关闭，不点“查看异常”；并且立刻停手，避免异常记录累积
    if (overlay.isDetection) {
      this.logger.warn('出现平台异常/锁定提示，仅尝试关闭', { text: short(overlay.text, 160) });
      await this.screenshot('detection');
      this.detections = (this.detections ?? 0) + 1;
      if (this.config.stopOnDetection !== false) {
        this.logger.error('检测到平台异常标记，停止本课程（避免加重异常记录）', { detections: this.detections });
        this.aborted = true;
        this.abortReason = 'detection';
        return;
      }
    }

    // 识别成题目却拿不到选项：把 DOM 存下来，便于据实修正选择器
    if (overlay.isQuiz && overlay.options.length === 0 && overlay.html) {
      const file = join(SHOT_DIR, `quiz-nodetect-${Date.now()}.html`);
      writeFileSync(file, overlay.html, 'utf8');
      this.logger.warn('题目未解析出选项，已保存 DOM', { file });
      await this.screenshot('quiz-nodetect');
    }

    if (overlay.isQuiz && overlay.options.length > 0 && !overlay.isDetection) {
      const option = pickRandom(overlay.options);
      await humanClick(this.page, option, { logger: this.logger, label: `选项 ${short(option.text, 24)}` });
      this.answers += 1;
      this.logger.info('已随机作答', { answer: short(option.text, 30), answers: this.answers });
      await sleepRange(this.config.answerDelayMs ?? [900, 2000]);

      const after = await inspectOverlay(this.page);
      if (after.present) {
        const submit = after.buttons.find((button) => /提交|确定|确认/.test(button.text));
        if (submit) {
          await humanClick(this.page, submit, { logger: this.logger, label: `提交 ${submit.text}` });
          await sleep(900);
        }
      }
    }

    const current = await inspectOverlay(this.page);
    if (current.present) {
      const closeButton =
        current.buttons.find((button) => /关闭|×|✕/.test(button.text)) ??
        current.buttons.find((button) => /headerbtn|icon-close|(^|[\s-])close([\s-]|$)/i.test(button.cls ?? '')) ??
        current.buttons.find((button) => /下次再说|下次再看|不再提示|已绑定|知道了|好的|确定|确认|继续/.test(button.text)) ??
        current.buttons[0];
      if (closeButton) {
        await humanClick(this.page, closeButton, { logger: this.logger, label: `关闭「${closeButton.text}」` });
      } else {
        this.logger.warn('弹层没有可用按钮，尝试 ESC');
        await this.page.keyboard.press('Escape').catch(() => {});
      }
      await sleepRange(this.config.afterCloseDelayMs ?? [1200, 2200]);
    }

    let remaining = await inspectOverlay(this.page);
    if (remaining.present) {
      // 坐标点不动时改用 DOM click：直接触发 Element 弹窗的 headerbtn / 关闭按钮
      this.logger.warn('坐标点击无效，改用 DOM 关闭', { text: short(remaining.text, 80) });
      const clicked = await closeByDom(this.page);
      this.logger.info('DOM 关闭结果', clicked);
      await sleep(1200);
      remaining = await inspectOverlay(this.page);
    }

    if (remaining.present) {
      this.logger.warn('弹层仍在', { text: short(remaining.text, 120), seenTimes });
      await this.screenshot('overlay-stuck');
      if (seenTimes >= 4) {
        // 反复关不掉：刷新页面，靠断点续跑恢复
        this.logger.error('弹层反复无法关闭，刷新页面恢复', { url: this.page.url() });
        await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(6000);
        await this.clickRowOn(this.page, this.state?.currentIndex ?? 0);
        await sleep(3000);
        await this.play('刷新后起播');
      }
      return;
    }
    this.logger.info('弹层已关闭，继续播放');
    await this.play('弹层关闭后续播');
  }

  /** 切到下一个未完成视频。 */
  async advance(state) {
    const next = this.pickNext(state);
    if (next == null) {
      // 目录可能还在懒加载：要连续多次确认「确实没有未完成项」才判定课程结束
      const unfinishedIdx = state.items.filter((item) => !item.finished).map((item) => item.index);
      this.logger.warn('没有可切的下一项', {
        unfinished: unfinishedIdx.slice(0, 20),
        unfinishedCount: unfinishedIdx.length,
        bad: [...this.badIndexes].slice(0, 20),
        finished: state.finishedCount,
        total: state.items.length,
      });
      // 黑名单只是「本次没点进去」，清掉重试，避免把整门课误判为完成
      if (this.badIndexes.size > 0) {
        this.logger.info('清空切换失败黑名单后重试', { size: this.badIndexes.size });
        this.badIndexes.clear();
        await sleep(1500);
        return;
      }
      this.emptyStreak = (this.emptyStreak ?? 0) + 1;
      this.lastItemsLength = this.lastItemsLength ?? 0;
      const stable = state.items.length === this.lastItemsLength;
      this.lastItemsLength = state.items.length;
      if (this.emptyStreak < 3 || !stable) {
        this.logger.warn('暂未找到未完成视频，等待目录刷新后再判定', {
          streak: this.emptyStreak,
          items: state.items.length,
          stable,
          finished: state.finishedCount,
        });
        await sleep(3000);
        return;
      }
      // 未完成的项一个都没点进去过，绝不能判完成
      if (unfinishedIdx.length > 0) {
        this.logger.error('仍有未完成视频但切换全部失败，停止本课程而非误判完成', { unfinishedCount: unfinishedIdx.length });
        this.aborted = true;
        this.abortReason = 'switch-failed';
        await this.screenshot('switch-exhausted');
        return;
      }
      this.logger.step('没有未完成的视频了，本课程结束', {
        course: this.course.title,
        finished: state.finishedCount,
        total: state.items.length,
      });
      this.done = true;
      await this.screenshot('course-done');
      return;
    }
    this.emptyStreak = 0;
    const target = state.items[next];
    this.logger.info('切换视频', { from: short(state.items[state.currentIndex]?.title ?? '', 30), to: short(target.title, 30), index: next });

    await this.clickRowOn(this.page, next);
    await sleepRange(this.config.afterSwitchDelayMs ?? [1500, 3000]);
    const after = await this.readState();
    if (after.currentIndex === next) {
      this.switches += 1;
      this.videoKey = null;
      this.lastProgress = null;
      this.logger.info('切换成功', { index: next, switches: this.switches });
      this.saveProgress({ index: next });
      await this.play('切章后起播');
      return;
    }

    this.logger.warn('切换未生效，备用点击', { want: next, saw: after.currentIndex });
    await this.clickRowOn(this.page, next, { force: true });
    await sleep(2500);
    const after2 = await this.readState();
    if (after2.currentIndex === next) {
      this.switches += 1;
      this.videoKey = null;
      this.lastProgress = null;
      this.logger.info('备用点击切换成功', { index: next });
      this.saveProgress({ index: next });
      await this.play('切章后起播');
      return;
    }
    this.logger.error('该条目点不动，跳过', { index: next });
    this.badIndexes.add(next);
    await this.screenshot('switch-failed');
  }

  pickNext(state) {
    const from = Math.max(state.currentIndex, -1);
    const unfinished = (item) => !item.finished && !this.badIndexes.has(item.index);
    for (let index = from + 1; index < state.items.length; index += 1) {
      if (unfinished(state.items[index])) return index;
    }
    for (let index = 0; index < from; index += 1) {
      if (unfinished(state.items[index])) return index;
    }
    return null;
  }

  /** 点击目录第 index 个视频行（真实鼠标）。 */
  async clickRow(index, { force = false } = {}) {
    const point = await this.page
      .evaluate(({ idx }) => {
        const rows = [...document.querySelectorAll('.chapterScrollbar li.video')];
        const row = rows[idx];
        if (!row) return null;
        row.scrollIntoView({ block: 'center', behavior: 'instant' });
        const titleEl = row.querySelector('.catalogue_title') ?? row;
        const r = titleEl.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, { idx: index })
      .catch(() => null);

    if (!point) {
      this.logger.warn('找不到目录项坐标', { index });
      return false;
    }
    await humanClick(this.page, point, { logger: this.logger, label: `目录第 ${index + 1} 个视频` });
    if (force) {
      await this.page
        .evaluate(({ idx }) => {
          const rows = [...document.querySelectorAll('.chapterScrollbar li.video')];
          const row = rows[idx];
          const titleEl = row?.querySelector('.catalogue_title') ?? row;
          titleEl?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }, { idx: index })
        .catch(() => {});
    }
    return true;
  }

  async screenshot(tag) {
    const name = `${tag}-${Date.now()}.png`;
    await this.page.screenshot({ path: join(SHOT_DIR, name) }).catch(() => {});
    this.logger.info('截图', { file: name });
  }

  saveProgress(patch) {
    const key = this.course.key ?? 'course';
    const file = join(STATE_DIR, `course-${key}.json`);
    let previous = {};
    if (existsSync(file)) {
      try {
        previous = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        previous = {};
      }
    }
    writeFileSync(
      file,
      JSON.stringify(
        {
          ...previous,
          title: this.course.title,
          url: this.course.url,
          lastIndex: patch.index ?? previous.lastIndex ?? 0,
          answers: this.answers,
          switches: this.switches,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  }
}
