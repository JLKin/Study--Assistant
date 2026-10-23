// @ts-nocheck
/**
 * 自动刷课内核的 Electron 胶水层。
 *
 * 直接复用 tools/auto-study 里已经在真机验证过的纯 ESM 内核
 * （browser / hall / site / mooc / engine / overlay），把它们装进桌面应用：
 *   - 数据目录、日志、截图全部落在 exe 旁边的 data/ 下（asar 内只读，不能写）
 *   - 内核用的 Edge 仍是「独立进程 + 固定 CDP 端口 + 独立 profile」，
 *     脚本退出浏览器不关，登录态长期保留
 *   - 状态统一通过 onStatus 回调推给主进程 → 渲染进程
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class AutoKernel {
  /** 最近一次对外推送的状态快照（渲染进程读的就是它）。 */
  status: Record<string, any>;

  constructor({ dataDir, onStatus, onLog }) {
    this.dataDir = dataDir;
    this.onStatus = onStatus ?? (() => {});
    this.onLog = onLog ?? (() => {});
    this.running = false;
    this.stopping = false;
    this.course = null;
    this.status = {
      running: false,
      stopped: true,
      phase: '空闲',
      course: '',
      title: '',
      index: -1,
      total: -1,
      finished: -1,
      currentTime: -1,
      duration: -1,
      percent: 0,
      switches: 0,
      answers: 0,
      browser: '未启动',
      message: '',
      updatedAt: Date.now(),
    };
  }

  async modules() {
    if (!this._mods) {
      this._mods = {
        browser: await import('../../../tools/auto-study/src/browser.mjs'),
        hall: await import('../../../tools/auto-study/src/hall.mjs'),
        site: await import('../../../tools/auto-study/src/site.mjs'),
        mooc: await import('../../../tools/auto-study/src/mooc.mjs'),
        engine: await import('../../../tools/auto-study/src/engine.mjs'),
        log: await import('../../../tools/auto-study/src/log.mjs'),
        util: await import('../../../tools/auto-study/src/util.mjs'),
      };
    }
    return this._mods;
  }

  push(patch, message) {
    this.status = { ...this.status, ...patch, message: message ?? this.status.message, updatedAt: Date.now() };
    this.onStatus({ ...this.status });
  }

  /** 首次运行写出一份默认配置，之后用户可以在设置界面里改。 */
  ensureConfig(mods) {
    const file = join(this.dataDir, 'config.json');
    if (!existsSync(file)) {
      writeFileSync(file, `${JSON.stringify(mods.browser.DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    }
    process.env.ZHS_CONFIG = file;
    process.env.ZHS_DATA_DIR = this.dataDir;
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  /** 读取当前刷课参数（缺文件就用 DEFAULT_CONFIG 补齐）。 */
  async readSettings() {
    const mods = await this.modules();
    mkdirSync(this.dataDir, { recursive: true });
    const file = join(this.dataDir, 'config.json');
    if (!existsSync(file)) {
      writeFileSync(file, `${JSON.stringify(mods.browser.DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    }
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  /** 合并写入刷课参数；运行中的任务不受影响，下次开始刷课才生效。 */
  async saveSettings(patch) {
    const current = await this.readSettings();
    const next = { ...current };
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (key === 'progressThreshold' && typeof value === 'number') {
        next[key] = Math.min(0.99, Math.max(0.5, Number(value.toFixed(3))));
        continue;
      }
      if (key === 'captchaWaitMs' && typeof value === 'number') {
        next[key] = Math.round(Math.min(6 * 60 * 60 * 1000, Math.max(60_000, value)));
        continue;
      }
      if (key === 'startUrl') {
        const value2 = typeof value === 'string' ? value.trim() : '';
        next[key] = value2 && /^https?:\/\//i.test(value2) ? value2 : '';
        continue;
      }
      if (Array.isArray(value) && value.length === 2) {
        const [min, max] = value.map((item) => Math.max(0, Math.round(Number(item))));
        next[key] = min <= max ? [min, max] : [max, min];
        continue;
      }
      next[key] = value;
    }
    writeFileSync(join(this.dataDir, 'config.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    this.onLog('INFO', `刷课参数已保存：${Object.keys(patch ?? {}).join(', ')}`);
    return next;
  }

  /** 打开专用浏览器（可指定网址；默认用配置里的 startUrl / entryUrl）。 */
  async openBrowser({ url } = {}) {
    const mods = await this.modules();
    const config = await this.readSettings();
    const target =
      (typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : null) ??
      config.startUrl ??
      config.entryUrl;
    try {
      const logger = {
        info: (message: string, extra?: unknown) =>
          this.onLog('INFO', `${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`),
        warn: (message: string) => this.onLog('WARNING', String(message)),
      };
      const handle = await mods.browser.ensureBrowser(config, { url: target, logger });
      const page = await mods.browser.ensurePage(handle.context, {
        url: target,
        match: (current: string) => current.startsWith('http'),
        logger,
      });
      await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.bringToFront().catch(() => {});
      this.push({ browser: '已就绪', browserUrl: target }, `已打开专用浏览器：${target}`);
      handle.detach?.();
      return { ok: true, url: target };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onLog('ERROR', `打开专用浏览器失败：${message}`);
      return { ok: false, url: target, message };
    }
  }

  async start({ course } = {}) {
    if (this.running) return { ok: false, code: 'ALREADY_RUNNING', message: '已经在刷课了。' };
    this.running = true;
    this.stopping = false;
    this.push({ running: true, stopped: false, phase: '启动中', message: course ? `准备刷「${course}」` : '准备刷全部课程' }, '正在启动');
    this.loop({ course }).catch((error) => {
      this.onLog('ERROR', `刷课异常退出：${String(error).slice(0, 300)}`);
      this.push({ running: false, stopped: true, phase: '出错', message: String(error).slice(0, 160) });
      this.running = false;
    });
    return { ok: true, code: 'AUTO_STARTED', message: '已开始自动刷课。' };
  }

  async stop() {
    if (!this.running) return { ok: true, code: 'NOT_RUNNING', message: '当前没有在刷课。' };
    this.stopping = true;
    this.push({ phase: '停止中', message: '正在停止…' }, '收到停止指令');
    return { ok: true, code: 'AUTO_STOPPING', message: '正在停止，当前视频会收尾。' };
  }

  /** 重置浏览器配置（书签/登录态一起清掉），给别人用的干净副本靠它。 */
  async resetProfile() {
    if (this.running) {
      return { ok: false, code: 'AUTO_RUNNING', message: '刷课进行中，先停止再重置。', profile: null };
    }
    const mods = await this.modules();
    const { profile } = mods.browser.resetBrowserProfile({ logger: null });
    this.onLog('WARNING', '已重置浏览器配置与登录态，下次刷课需要在弹出的 Edge 里重新扫码');
    this.push({ browser: '未启动' }, '浏览器配置已重置');
    return { ok: true, code: 'PROFILE_RESET', message: '已重置，下次刷课请重新扫码登录。', profile };
  }

  async loop({ course }) {    const mods = await this.modules();
    mkdirSync(this.dataDir, { recursive: true });
    const config = this.ensureConfig(mods);
    const { Logger } = mods.log;
    const logger = new Logger(mods.browser.LOG_DIR, 'app');
    const log = (level, text) => {
      this.onLog(level, text);
      try {
        logger[level === 'ERROR' ? 'error' : level === 'WARNING' ? 'warn' : 'info'](text);
      } catch {
        /* 日志失败不影响刷课 */
      }
    };
    this.push({ browser: '连接中', phase: '连接浏览器' }, '正在连接专用 Edge');
    const { context } = await mods.browser.ensureBrowser(config, {
      logger: { info: () => {}, warn: () => {}, error: () => {}, step: () => {} },
    });
    this.push({ browser: '已就绪', phase: '收集课程' }, '浏览器已就绪');
    const page = await mods.browser.ensurePage(context, {
      url: config.entryUrl,
      match: (u) => /onlineweb|onlinestuh5/.test(u),
      logger,
    });

    // 等到学堂页真的出现课程卡片；期间如果停在登录页，就提示用户扫码并一直等。
    const hasCourses = () =>
      page
        .evaluate(() => document.querySelectorAll('.courseName').length > 0)
        .catch(() => false);
    const isLoginPage = async () => {
      try {
        return !(await mods.browser.isLoggedIn(page));
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 25 * 60 * 1000;
    let hintShown = false;
    let ready = false;
    while (Date.now() < deadline && !this.stopping) {
      if (await hasCourses()) {
        ready = true;
        break;
      }
      const onLogin = await isLoginPage();
      if (onLogin) {
        if (!hintShown) {
          await page.bringToFront().catch(() => {});
          this.push(
            { phase: '等待登录', message: '请在打开的 Edge 窗口里扫码登录，登录后自动继续' },
            '等待登录（请在弹出的 Edge 里扫码）',
          );
          log('WARNING', `停在登录页：${page.url().slice(0, 80)}`);
          hintShown = true;
        }
      } else if (hintShown) {
        log('INFO', '检测到登录成功，返回学堂页');
        hintShown = false;
        await mods.browser.saveSession?.(context, logger);
        await page.goto(config.entryUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await mods.util.sleep(3000);
        continue;
      } else if (!/onlinestuh5|onlineweb/.test(page.url())) {
        await page.goto(config.entryUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      await mods.util.sleep(3000);
    }
    if (!ready) {
      if (this.stopping) {
        this.running = false;
        this.stopping = false;
        this.push({ running: false, stopped: true, phase: '已结束', message: '已停止（未开始刷课）' }, '已停止');
        return;
      }
      throw new Error(
        '没有读到课程列表。请在弹出的 Edge 里登录，并打开 https://onlineweb.zhihuishu.com/onlinestuh5 后重新点「开始刷课」。',
      );
    }
    this.push({ phase: '收集课程' }, '课程列表已就绪');

    let queue = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (this.stopping) break;
      queue = await mods.hall.collectQueue(page, { config, logger });
      if (queue.length > 0) break;
      log('WARNING', `课程队列为空（第 ${attempt}/3 次），刷新学堂页重试`);
      this.push({ phase: '收集课程', message: `队列为空，正在重试（${attempt}/3）` });
      await page.goto(config.entryUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await mods.util.sleep(3000);
    }
    if (queue.length === 0) throw new Error('学堂页没有读到任何课程。请确认已登录，并在 Edge 里打开 https://onlineweb.zhihuishu.com/onlinestuh5 看一眼。');
    if (course) queue = queue.filter((item) => item.name.includes(course));
    const todo = queue.filter((item) => {
      const done = typeof item.percent === 'string' && /^100(\.0+)?\s*%?$/.test(item.percent.trim());
      return !done;
    });
    log('INFO', `课程队列：${todo.map((item) => `${item.name}(${item.percent})`).join(' / ') || '空'}`);
    this.push({ phase: '刷课中', message: `共 ${todo.length} 门课` }, `共 ${todo.length} 门课`);

    for (const item of todo) {
      if (this.stopping) break;
      this.push({ phase: '进入课程', course: item.name }, `进入「${item.name}」`);
      let study = null;
      try {
        study = await mods.hall.openCourse(page, { name: item.name, tab: item.tab, config, logger });
      } catch (error) {
        log('ERROR', `进入「${item.name}」失败：${String(error).slice(0, 160)}`);
        continue;
      }
      const isMooc = mods.mooc.isMooc(study.url());
      // 目录是懒渲染的，刚进课程可能还是空的，多试几次再判定
      let state = isMooc ? await mods.mooc.readMoocState(study) : await mods.site.readStudyState(study);
      for (let i = 0; i < 3 && (state.items?.length ?? 0) === 0; i += 1) {
        await mods.util.sleep(4000);
        state = isMooc ? await mods.mooc.readMoocState(study) : await mods.site.readStudyState(study);
      }
      const info = {
        key: item.name.replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 20) || 'course',
        title: item.name || state.courseName,
        url: study.url(),
      };
      this.push({ course: info.title, total: state.items.length, finished: state.finishedCount }, `共 ${state.items.length} 个视频，已完成 ${state.finishedCount}`);
      log('INFO', `课程「${info.title}」：${state.items.length} 个视频，已完成 ${state.finishedCount}${isMooc ? '（智慧课程）' : ''}`);

      const watcher = new mods.engine.Watcher({ page: study, config, logger, course: info });
      this.push({ phase: '刷课中' }, `正在刷「${info.title}」`);
      // 把内核心跳转成 UI 状态
      const timer = setInterval(() => {
        const st = watcher.state;
        if (!st) return;
        const total = st.items?.length ?? -1;
        const finished = st.items ? st.items.filter((i) => i.finished).length : -1;
        const cur = st.video ?? {};
        const percent = cur.duration ? Math.min(100, Math.round((cur.currentTime / cur.duration) * 100)) : 0;
        this.push({
          course: info.title,
          title: st.items?.[st.currentIndex]?.title ?? '',
          index: (st.currentIndex ?? -1) + 1,
          total,
          finished,
          currentTime: Math.round(cur.currentTime ?? -1),
          duration: Math.round(cur.duration ?? -1),
          percent,
          switches: watcher.switches,
          answers: watcher.answers,
        });
      }, 2000);
      if (this.stopping) watcher.requestStop?.();
      const stopper = setInterval(() => {
        if (this.stopping) watcher.requestStop?.();
      }, 1500);
      try {
        await watcher.run();
      } finally {
        clearInterval(timer);
        clearInterval(stopper);
      }
      log('INFO', `「${info.title}」结束：切换 ${watcher.switches} 次，答题 ${watcher.answers} 次${watcher.stopRequested ? '（用户停止）' : ''}`);
      if (watcher.stopRequested) break;
      if (watcher.aborted) {
        log('WARNING', `平台异常标记，停止继续（${watcher.abortReason}）`);
        break;
      }
      if (study !== page) {
        await study.close().catch(() => {});
        await page.bringToFront().catch(() => {});
      } else {
        await page.goto(config.entryUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }

    this.running = false;
    this.stopping = false;
    this.push({ running: false, stopped: true, phase: '已结束', message: this.stopping ? '已停止' : '全部课程刷完' }, '已结束');
    log('INFO', '自动刷课结束');
  }
}
