import type {
  AppConfig,
  CheckItem,
  Dashboard,
  DesktopApi,
  Result,
  UpdateInfo,
} from '../../../packages/contracts/src/index.js';

declare global {
  interface Window {
    study: DesktopApi;
  }
}

/** 学堂页里实际存在的 6 门课（共享课 5 门 + 智慧课程 1 门），只用于快捷选择。 */
const COURSE_NAMES = [
  '职业生涯规划',
  '大学美育',
  '军事理论-综合版',
  '创新创业基础',
  '劳动教育',
  '人工智能引论',
];

type Level = 'info' | 'warn' | 'err' | 'ok';

interface LogLine {
  at: string;
  level: Level;
  message: string;
}

const el = <T extends Element = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const text = (id: string, value: string) => {
  const node = el(id);
  if (node) node.textContent = value;
};

let autoStatus: Record<string, unknown> = {};
let logs: LogLine[] = [];
let updateInfo: UpdateInfo | null = null;

/* ── 版本与更新 ─────────────────────────────────────── */

function renderUpdate(info: UpdateInfo | null) {
  updateInfo = info;
  const bar = el('update-bar');
  const download = el<HTMLButtonElement>('update-download');
  const dismiss = el<HTMLButtonElement>('update-dismiss');
  const newer = Boolean(info && info.latest && info.latest !== info.current);
  const force = Boolean(info?.force);
  const show = Boolean(info) && (newer || force);

  if (bar) {
    bar.hidden = !show;
    bar.classList.toggle('force', force);
  }
  if (download) download.hidden = !(info?.url && show);
  // 强制更新时不给「稍后」，旧版本作废就是要拦住。
  if (dismiss) dismiss.hidden = force;

  if (show && info) {
    text(
      'update-text',
      force
        ? `当前版本 ${info.current} 已停止支持，必须更新到 ${info.minSupported} 才能继续刷课。`
        : `发现新版本 ${info.latest}（当前 ${info.current}）。${info.notes || '建议更新后再使用。'}`,
    );
  }

  const hint = el('set-version-text');
  if (hint) {
    if (!info) hint.textContent = '当前版本 0.1.0 · 尚未检查更新';
    else if (info.source === 'none' && /未配置/.test(info.error ?? ''))
      hint.textContent = `当前版本 ${info.current} · 未配置更新源（离线可用）`;
    else if (info.error && info.source !== 'network')
      hint.textContent = `当前版本 ${info.current} · 检查更新失败：${info.error}`;
    else if (force) hint.textContent = `当前版本 ${info.current} · 已停止支持，请更新到 ${info.minSupported}`;
    else if (newer) hint.textContent = `当前版本 ${info.current} · 有新版本 ${info.latest}`;
    else hint.textContent = `当前版本 ${info.current} · 已是最新版本`;
  }
  // 版本作废时禁用开始按钮，避免点了才报错。
  const start = el<HTMLButtonElement>('auto-start');
  if (start && force) {
    start.disabled = true;
    start.title = '当前版本已停止支持，请先更新';
  } else if (start && start.disabled && !autoStatus.running) {
    start.disabled = false;
    start.title = '';
  }
}

async function checkUpdateNow(manual = false) {
  if (manual) notify('正在检查更新…');
  try {
    const response = await window.study.updateCheck();
    const info = (response.data ?? null) as UpdateInfo | null;
    renderUpdate(info);
    if (manual) {
      notify(
        info?.force
          ? `当前版本 ${info.current} 已停止支持，请更新到 ${info.minSupported}`
          : info?.latest && info.latest !== info?.current
            ? `发现新版本 ${info.latest}`
            : info?.error
              ? `检查更新失败：${info.error}`
              : '已是最新版本',
        !info?.error,
      );
    }
    return info;
  } catch (error) {
    if (manual) notify(`检查更新失败：${error instanceof Error ? error.message : String(error)}`, false);
    return null;
  }
}

/* ── 通用提示 ───────────────────────────────────────── */

function notify(message: string, ok = true) {
  const node = el('feedback');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('error', !ok);
}

function resultMessage(result: Result) {
  return result.ok ? result.message : `${result.message}（${result.code}）`;
}

/* ── 日志 ───────────────────────────────────────────── */

function lineLevel(raw: unknown, message: string): Level {
  const level = String(raw ?? '').toUpperCase();
  if (level === 'ERROR' || level === 'CRITICAL') return 'err';
  if (level === 'WARNING' || level === 'WARN') return 'warn';
  if (/已开始播放|切换|进入课程|已就绪|完成|登录成功/.test(message)) return 'ok';
  return 'info';
}

function renderLogs() {
  const pre = el('auto-log');
  if (!pre) return;
  pre.replaceChildren();
  if (logs.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'l-time';
    empty.textContent = '暂无日志。点「开始刷课」后，这里会实时滚动显示内核动作。';
    pre.append(empty);
    return;
  }
  for (const line of [...logs].reverse()) {
    const row = document.createElement('div');
    const time = document.createElement('span');
    time.className = 'l-time';
    time.textContent = `${line.at}  `;
    const body = document.createElement('span');
    body.className = `l-${line.level}`;
    body.textContent = line.message;
    row.append(time, body);
    pre.append(row);
  }
}

function pushLog(level: Level, message: string, at = new Date().toISOString()) {
  const clock = at.length >= 19 ? at.slice(11, 19) : at;
  logs = [{ at: clock, level, message }, ...logs].slice(0, 400);
  renderLogs();
}

/* ── 状态渲染 ───────────────────────────────────────── */

function stateOf(status: Record<string, unknown>): 'idle' | 'running' | 'waiting' | 'error' {
  const phase = String(status.phase ?? '');
  if (status.aborted || phase === '出错') return 'error';
  if (status.running && /等待登录/.test(phase)) return 'waiting';
  if (status.running) return 'running';
  return 'idle';
}

const STATE_TEXT: Record<string, string> = {
  idle: '空闲',
  running: '刷课中',
  waiting: '等待登录',
  error: '已中止',
};

function renderAuto(status: Record<string, unknown>) {
  autoStatus = status ?? {};
  const state = stateOf(autoStatus);
  document.body.dataset.state = state;

  const phase = String(autoStatus.phase ?? '空闲');
  const course = String(autoStatus.course ?? '');
  const title = String(autoStatus.title ?? '');
  const index = Number(autoStatus.index ?? -1);
  const total = Number(autoStatus.total ?? -1);
  const finished = Number(autoStatus.finished ?? -1);
  const percent = Math.max(0, Math.min(100, Math.round(Number(autoStatus.percent ?? 0))));
  const switches = Number(autoStatus.switches ?? 0);
  const answers = Number(autoStatus.answers ?? 0);
  const message = String(autoStatus.message ?? '');

  text('phase-pill', state === 'running' || state === 'waiting' ? phase : STATE_TEXT[state]);
  text('foot-state', STATE_TEXT[state]);
  text('foot-state-2', `${STATE_TEXT[state]}${course ? ` · ${course}` : ''}`);
  text('hero-phase', phase || '未开始');
  text('hero-course', course || '尚未进入课程');

  const headline = message
    ? message
    : state === 'running'
      ? '正在刷课，视频到 81% 会自动切下一个。'
      : '空闲。视频播到 81% 自动切下一个，弹题随机作答后自动续播。';
  text('auto-line', headline);

  const details = [
    title ? `当前视频：${title}` : '',
    autoStatus.browser ? `浏览器：${String(autoStatus.browser)}` : '',
    autoStatus.abortReason ? `中止原因：${String(autoStatus.abortReason)}` : '',
  ].filter(Boolean);
  text('auto-detail', details.join('　·　') || '—');

  text('st-index', index > 0 ? String(index) : '—');
  text('st-total', total > 0 ? `/ ${total}` : '/ —');
  text('st-finished', finished >= 0 ? String(finished) : '—');
  text('st-switch', String(switches));
  text('st-answer', String(answers));

  const bar = el<SVGCircleElement>('ring-bar');
  if (bar) bar.style.strokeDashoffset = String(326.7 * (1 - percent / 100));
  text('ring-value', `${percent}%`);

  const hint = el('start-hint');
  if (hint) {
    hint.textContent =
      state === 'waiting'
        ? '正在等你登录：请在弹出的 Edge 窗口里扫码，登录后自动继续（最长等 25 分钟）。'
        : state === 'running'
          ? '正在刷课：不要同时打开第二个播放页，倍速请自己手点 X 1.5。'
          : state === 'error'
            ? '已中止：处理完提示后重新点「开始刷课」即可从断点继续。'
            : '首次运行会弹出一个独立的 Edge 窗口，如果停在登录页，请在那里扫码登录，控制台会自动等你。';
  }

  const starting = autoStatus.running === true;
  const startBtn = el<HTMLButtonElement>('auto-start');
  const stopBtn = el<HTMLButtonElement>('auto-stop');
  if (startBtn) startBtn.disabled = starting;
  if (stopBtn) stopBtn.disabled = !autoStatus.running;
}

/* ── 说明页信息 ─────────────────────────────────────── */

function renderChecks(items: CheckItem[]) {
  const list = el<HTMLUListElement>('checks');
  if (!list) return;
  list.replaceChildren();
  for (const check of items) {
    const li = document.createElement('li');
    li.className = check.status;
    const label = document.createElement('span');
    label.textContent = check.label;
    const message = document.createElement('span');
    message.className = 'msg';
    message.textContent = check.message;
    li.append(label, message);
    list.append(li);
  }
  const failed = items.filter((item) => item.status === 'fail').length;
  const warned = items.filter((item) => item.status === 'warning').length;
  text(
    'self-check-summary',
    failed
      ? `${failed} 项未通过（不影响刷课，可查看明细）`
      : warned
        ? `${warned} 项提示（其余正常）`
        : `全部通过（${items.length} 项）`,
  );
}

function renderDashboard(data: Dashboard) {
  text('data-location', data.dataLocation);
  renderChecks(data.selfCheck.items);
  if (data.auto) renderAuto(data.auto as Record<string, unknown>);
}

/* ── 数据拉取 ───────────────────────────────────────── */

let refreshing = false;
let queued = false;

async function refresh() {
  if (refreshing) {
    queued = true;
    return;
  }
  refreshing = true;
  try {
    const result = await window.study.status();
    if (result.ok && result.data) renderDashboard(result.data);
    else if (!result.ok) notify(resultMessage(result), false);
  } catch {
    notify('本地服务暂不可用，请查看日志', false);
  } finally {
    refreshing = false;
    if (queued) {
      queued = false;
      void refresh();
    }
  }
}

async function run(button: HTMLButtonElement | null, work: () => Promise<Result>) {
  if (button) button.disabled = true;
  try {
    const result = await work();
    notify(resultMessage(result), result.ok);
  } catch {
    notify('本地服务暂不可用，请查看日志', false);
  } finally {
    if (button) button.disabled = false;
    void refresh();
  }
}

/* ── 交互绑定 ───────────────────────────────────────── */

function bindCoursePicks() {
  const picks = el('course-picks');
  const input = el<HTMLInputElement>('auto-course');
  const list = el<HTMLDataListElement>('course-list');
  if (!picks || !input) return;
  const names = ['全部课程', ...COURSE_NAMES];
  for (const name of names) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-pick';
    chip.textContent = name;
    chip.addEventListener('click', () => {
      input.value = name === '全部课程' ? '' : name;
      picks
        .querySelectorAll('.chip-pick')
        .forEach((node) => node.classList.toggle('on', node === chip));
    });
    picks.append(chip);
  }
  picks.querySelector('.chip-pick')?.classList.add('on');
  if (list) {
    for (const name of COURSE_NAMES) {
      const option = document.createElement('option');
      option.value = name;
      list.append(option);
    }
  }
}

function bindTabs() {
  const titles: Record<string, string> = {
    run: '自动刷课',
    settings: '设置',
    help: '使用说明',
  };
  const subtitles: Record<string, string> = {
    run: '填课程名或留空刷全部，点「开始刷课」；首次需要在弹出的 Edge 里扫码登录。',
    settings: '这些参数写在 data/auto-study/config.json，下次开始刷课时生效。',
    help: '四条铁律 + 它做什么 / 不做什么，出问题先看这里。',
  };
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.tab ?? 'run';
      document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => {
        tab.hidden = tab.id !== target;
      });
      document
        .querySelectorAll('.nav')
        .forEach((nav) => nav.classList.toggle('active', nav === button));
      text('page-title', titles[target] ?? '自动刷课');
      text('feedback', subtitles[target] ?? subtitles.run ?? '');
    });
  });
}

function bindActions() {
  const map: Record<string, () => Promise<Result>> = {
    'auto-start': () => {
      if (updateInfo?.force) {
        notify(`当前版本 ${updateInfo.current} 已停止支持，请先下载新版本`, false);
        return Promise.resolve({ ok: false, code: 'UPDATE_REQUIRED', message: '请先更新版本' } as Result);
      }
      const value = el<HTMLInputElement>('auto-course')?.value.trim() ?? '';
      return window.study.autoStart(value || undefined);
    },
    'auto-stop': () => window.study.autoStop(),
    'browser-open': () => window.study.autoBrowserOpen(),
    'self-check': () => window.study.selfCheck(),
  };
  for (const [id, work] of Object.entries(map)) {
    const button = el<HTMLButtonElement>(id);
    if (button) button.addEventListener('click', () => void run(button, work));
  }
  el<HTMLButtonElement>('clear-log')?.addEventListener('click', () => {
    logs = [];
    renderLogs();
  });
  el<HTMLButtonElement>('update-download')?.addEventListener('click', async () => {
    const url = updateInfo?.url;
    if (!url) {
      notify('这个版本没有提供下载地址', false);
      return;
    }
    const response = await window.study.updateOpen(url);
    notify(resultMessage(response), response.ok);
  });
  el<HTMLButtonElement>('update-dismiss')?.addEventListener('click', () => {
    const bar = el('update-bar');
    if (bar) bar.hidden = true;
  });
  el<HTMLButtonElement>('set-update-check')?.addEventListener('click', () => void checkUpdateNow(true));
}

function bindEvents() {
  if (!window.study) return () => {};
  const off = window.study.onEvent((event) => {
    if (event.type === 'auto.statusChanged') {
      renderAuto((event.data ?? {}) as Record<string, unknown>);
      return;
    }
    if (event.type === 'auto.log') {
      const payload = (event.data ?? {}) as { level?: string; message?: string; at?: string };
      pushLog(lineLevel(payload.level, payload.message ?? ''), payload.message ?? '', payload.at);
      return;
    }
    if (event.type === 'app.update') {
      renderUpdate((event.data ?? null) as UpdateInfo | null);
      return;
    }
    void refresh();
  });
  return off;
}

/* ── 设置 ───────────────────────────────────────────── */

const DEFAULT_SETTINGS: Record<string, unknown> = {
  progressThreshold: 0.81,
  pollIntervalMs: 900,
  playStallMs: 25000,
  captchaWaitMs: 900000,
  answerDelayMs: [900, 2000],
  afterSwitchDelayMs: [1500, 3000],
  restartFromZero: true,
  stopOnDetection: true,
  alertBeep: true,
  alertBringToFront: true,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readNumber(id: string, fallback: number) {
  const input = el<HTMLInputElement>(id);
  const value = Number(input?.value ?? '');
  return Number.isFinite(value) ? value : fallback;
}

function setNumber(id: string, value: number) {
  const input = el<HTMLInputElement>(id);
  if (input) input.value = String(Math.round(value));
}

function pair(value: unknown, fallback: unknown): [number, number] {
  const source = Array.isArray(value) && value.length === 2 ? value : (fallback as unknown[]);
  const [a, b] = source as [unknown, unknown];
  const min = Number.isFinite(Number(a)) ? Number(a) : 0;
  const max = Number.isFinite(Number(b)) ? Number(b) : min;
  return min <= max ? [min, max] : [max, min];
}

function fillSettings(config: Record<string, unknown>) {
  const threshold = Number(config.progressThreshold ?? DEFAULT_SETTINGS.progressThreshold);
  setNumber('set-threshold', clamp(threshold * 100, 50, 99));
  setNumber('set-poll', clamp(Number(config.pollIntervalMs ?? 900), 300, 5000));
  setNumber('set-stall', clamp(Number(config.playStallMs ?? 25000), 8000, 120000));
  setNumber('set-captcha', clamp(Number(config.captchaWaitMs ?? 900000) / 60000, 1, 360));
  const answer = pair(config.answerDelayMs, DEFAULT_SETTINGS.answerDelayMs);
  setNumber('set-answer-min', answer[0]);
  setNumber('set-answer-max', answer[1]);
  const exchange = pair(config.afterSwitchDelayMs, DEFAULT_SETTINGS.afterSwitchDelayMs);
  setNumber('set-switch-min', exchange[0]);
  setNumber('set-switch-max', exchange[1]);
  const flags: Array<[string, unknown, boolean]> = [
    ['set-restart', config.restartFromZero, true],
    ['set-stopdetect', config.stopOnDetection, true],
    ['set-beep', config.alertBeep, true],
    ['set-front', config.alertBringToFront, true],
  ];
  for (const [id, value, fallback] of flags) {
    const input = el<HTMLInputElement>(id);
    if (input) input.checked = typeof value === 'boolean' ? value : fallback;
  }
  const urlInput = el<HTMLInputElement>('set-start-url');
  if (urlInput) {
    const configured = typeof config.startUrl === 'string' ? config.startUrl : '';
    urlInput.value = configured;
    urlInput.placeholder =
      typeof config.entryUrl === 'string' && config.entryUrl
        ? `留空＝${config.entryUrl}`
        : 'https://onlineweb.zhihuishu.com/onlinestuh5';
  }
}

function collectSettings(): Record<string, unknown> {
  const checked = (id: string) => el<HTMLInputElement>(id)?.checked === true;
  return {
    progressThreshold: clamp(readNumber('set-threshold', 81), 50, 99) / 100,
    pollIntervalMs: clamp(readNumber('set-poll', 900), 300, 5000),
    playStallMs: clamp(readNumber('set-stall', 25000), 8000, 120000),
    captchaWaitMs: Math.round(clamp(readNumber('set-captcha', 15), 1, 360) * 60000),
    answerDelayMs: [
      clamp(readNumber('set-answer-min', 900), 0, 10000),
      clamp(readNumber('set-answer-max', 2000), 0, 20000),
    ],
    afterSwitchDelayMs: [
      clamp(readNumber('set-switch-min', 1500), 0, 20000),
      clamp(readNumber('set-switch-max', 3000), 0, 30000),
    ],
    restartFromZero: checked('set-restart'),
    stopOnDetection: checked('set-stopdetect'),
    alertBeep: checked('set-beep'),
    alertBringToFront: checked('set-front'),
    startUrl: (el<HTMLInputElement>('set-start-url')?.value ?? '').trim(),
  };
}

async function loadSettings() {
  text('settings-state', '读取中…');
  try {
    const res = await window.study.autoConfig();
    if (!res.ok) {
      text('settings-state', '读取失败');
      return;
    }
    fillSettings((res.data ?? {}) as Record<string, unknown>);
    text('settings-state', '已读取');
  } catch {
    text('settings-state', '读取失败');
  }
}

function bindSettings() {
  const form = el<HTMLFormElement>('settings-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    text('settings-state', '保存中…');
    try {
      const res = await window.study.autoConfigSave(collectSettings());
      if (!res.ok) {
        text('settings-state', '保存失败');
        notify(res.message || '参数保存失败', false);
        return;
      }
      fillSettings((res.data ?? {}) as Record<string, unknown>);
      text('settings-state', '已保存');
      notify(res.message || '参数已保存', true);
    } catch {
      text('settings-state', '保存失败');
      notify('参数保存失败', false);
    }
  });

  el<HTMLButtonElement>('set-reset')?.addEventListener('click', async () => {
    fillSettings(DEFAULT_SETTINGS);
    text('settings-state', '已恢复默认值，正在保存…');
    try {
      const res = await window.study.autoConfigSave({ ...DEFAULT_SETTINGS });
      text('settings-state', res.ok ? '已恢复默认' : '保存失败');
      notify(res.message || '已恢复默认参数', res.ok);
    } catch {
      text('settings-state', '保存失败');
    }
  });

  el<HTMLButtonElement>('set-profile-reset')?.addEventListener('click', async () => {
    const button = el<HTMLButtonElement>('set-profile-reset');
    if (button) button.disabled = true;
    try {
      const res = await window.study.autoProfileReset();
      notify(res.message || '已重置浏览器配置', res.ok);
      text('settings-state', res.ok ? '浏览器配置已重置' : '重置失败');
    } catch {
      notify('重置失败', false);
    } finally {
      if (button) button.disabled = false;
    }
  });
}

async function guardDisclaimer() {
  const layer = el('disclaimer');
  if (!layer) return;
  let accepted = false;
  try {
    const res = await window.study.disclaimer();
    accepted = res.ok && res.data?.accepted === true;
  } catch {
    accepted = false;
  }
  if (accepted) {
    layer.hidden = true;
    return;
  }

  layer.hidden = false;
  const accept = el<HTMLButtonElement>('disclaimer-accept');
  const decline = el<HTMLButtonElement>('disclaimer-decline');
  accept?.addEventListener('click', async () => {
    accept.disabled = true;
    try {
      await window.study.acceptDisclaimer();
      layer.hidden = true;
      notify('已确认免责声明，可以开始刷课了', true);
    } catch {
      accept.disabled = false;
      notify('确认失败，请重试', false);
    }
  });
  decline?.addEventListener('click', async () => {
    decline.disabled = true;
    try {
      await window.study.quit();
    } catch {
      window.close();
    }
  });
}

/* ── 启动 ───────────────────────────────────────────── */

if (window.study) {
  bindTabs();
  bindCoursePicks();
  bindActions();
  bindSettings();
  const off = bindEvents();
  renderLogs();
  void guardDisclaimer();
  void loadSettings();
  void checkUpdateNow();
  void refresh().then(() => {
    notify(
      '准备就绪。填课程名或留空刷全部，点「开始刷课」；首次需要在弹出的 Edge 里扫码登录。',
      true,
    );
  });
  window.addEventListener('beforeunload', () => off(), { once: true });
} else {
  notify('安全通信未就绪，所有操作已停用', false);
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
}

export type { AppConfig };
