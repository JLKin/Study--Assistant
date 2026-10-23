// 控制台：查看状态 + 启停刷课 + 用户自己开关提醒项
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, LOG_DIR, STATE_DIR, loadConfig } from './browser.mjs';
import { readStatus, readAlert } from './status.mjs';

const CONFIG_FILE = join(ROOT, 'config.json');
const STOP_FILE = join(STATE_DIR, 'stop');
const CHILD_FILE = join(STATE_DIR, 'console-child.pid');
const CLI = join(ROOT, 'src', 'cli.mjs');
const SUPERVISOR = join(ROOT, 'src', 'supervisor.mjs');

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

function saveConfig(config) {
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function lastLogLines(count = 15) {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((name) => name.endsWith('.log'))
      .map((name) => ({ name, mtime: statSync(join(LOG_DIR, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return ['（还没有日志）'];
    const file = join(LOG_DIR, files[0].name);
    const size = statSync(file).size;
    const readBytes = Math.min(size, 8000);
    const buffer = Buffer.alloc(readBytes);
    const fd = openSync(file, 'r');
    readSync(fd, buffer, 0, readBytes, size - readBytes);
    closeSync(fd);
    return buffer.toString('utf8').split('\n').slice(-count);
  } catch (error) {
    return [`读取日志失败：${error}`];
  }
}

function childAlive() {
  if (!existsSync(CHILD_FILE)) return false;
  const pid = Number(readFileSync(CHILD_FILE, 'utf8').trim());
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startRun(config, { course, supervisor }) {
  const args = supervisor ? ['watch'] : ['watch'];
  if (course) args.push('--course', course);
  const target = supervisor ? SUPERVISOR : CLI;
  const out = join(STATE_DIR, 'run.out');
  const fd = openSync(out, 'a');
  const child = spawn(process.execPath, [target, ...args], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  writeFileSync(CHILD_FILE, String(child.pid), 'utf8');
  return { pid: child.pid, supervisor, args, out };
}

async function stopRun() {
  writeFileSync(STOP_FILE, String(Date.now()), 'utf8');
  // 优雅停止：先让脚本自己收尾（当前视频到 81% 会切走再退出），25 秒还没死才强杀
  for (let i = 0; i < 25 && childAlive(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  let killed = false;
  if (existsSync(CHILD_FILE)) {
    const pid = Number(readFileSync(CHILD_FILE, 'utf8').trim());
    try {
      process.kill(pid);
      killed = true;
    } catch {}
  }
  return { killed, note: killed ? '已强制结束进程' : '已优雅停止' };
}

async function browserAlive() {
  try {
    // 端口可能是动态选的（browser.mjs 会把实际端口写进 state/edge.port）
    let port = 9333;
    try {
      const recorded = Number(readFileSync(join(STATE_DIR, 'edge.port'), 'utf8').trim());
      if (Number.isInteger(recorded) && recorded > 0) port = recorded;
    } catch {
      /* 没有记录文件就用默认端口 */
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function render(config, browser) {
  const status = readStatus();
  const alert = readAlert();
  const fresh = status.updatedAt && Date.now() - status.updatedAt < 60000;
  const alive = childAlive() || (status.running === true && fresh);
  const lines = [];
  lines.push(`${C.bold}================= 智慧树自动刷课 · 控制台 =================${C.reset}`);
  const runningText = alive ? `${C.green}运行中${C.reset}` : `${C.dim}未运行${C.reset}`;
  const browserText = browser ? `${C.green}已就绪${C.reset}` : `${C.dim}未启动（首次会自动打开）${C.reset}`;
  lines.push(`进程：${runningText}   看门狗：${config.useSupervisor ? `${C.green}开${C.reset}` : `${C.dim}关${C.reset}`}   浏览器：${browserText}`);
  lines.push(
    `课程：${status.course ?? '-'}   视频：${status.index >= 0 ? status.index + 1 : '-'} / ${status.total >= 0 ? status.total : '-'}   已完成：${status.finished >= 0 ? status.finished : '-'}`,
  );
  const pct = status.duration > 0 ? Math.round((status.currentTime / status.duration) * 100) : -1;
  lines.push(
    `本片：${fmtTime(status.currentTime)} / ${fmtTime(status.duration)}${pct >= 0 ? `（${pct}%）` : ''}   ${status.paused ? `${C.yellow}已暂停${C.reset}` : '播放中'}   切换 ${status.switches ?? 0} 次 / 答题 ${status.answers ?? 0} 次`,
  );
  if (!status.onStudyPage && alive) lines.push(`${C.yellow}⚠ 当前不在播放页${C.reset}`);
  if (status.aborted) lines.push(`${C.red}上次中止：${status.abortReason ?? '未知'}${C.reset}`);
  lines.push(`${C.dim}状态更新时间：${status.updatedAt ? new Date(status.updatedAt).toLocaleTimeString() : '--'}${C.reset}`);
  if (alert.kind) {
    lines.push(`${C.red}${C.bold}⚠ 需要人工：${alert.message}${C.reset}`);
    lines.push(`${C.red}   （在浏览器窗口里点掉验证，脚本会自动继续）${C.reset}`);
  }
  lines.push(`${C.dim}----------------------------------------------------------${C.reset}`);
  lines.push(` ${C.cyan}1${C.reset} 开始刷全部课程`);
  lines.push(` ${C.cyan}2${C.reset} 开始刷单门课程`);
  lines.push(` ${C.cyan}3${C.reset} 停止`);
  lines.push(` ${C.cyan}4${C.reset} 验证提醒音：【${config.alertBeep !== false ? '开' : '关'}】`);
  lines.push(` ${C.cyan}5${C.reset} 验证时窗口置顶：【${config.alertBringToFront !== false ? '开' : '关'}】`);
  lines.push(` ${C.cyan}6${C.reset} 无人值守看门狗：【${config.useSupervisor ? '开' : '关'}】`);
  lines.push(
    ` ${C.cyan}s${C.reset} 自动点 1.5 倍速：【${Number(config.speedPreset ?? 0) > 1 ? `${config.speedPreset}x` : '关（你自己点）'}】`,
  );
  lines.push(` ${C.cyan}7${C.reset} 查看最近日志`);
  lines.push(` ${C.cyan}8${C.reset} 关闭那个独立 Edge`);
  lines.push(` ${C.cyan}9${C.reset} 退出控制台`);
  lines.push(`${C.dim}（直接按 Enter 刷新状态）${C.reset}`);
  return lines.join('\n');
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  let config = loadConfig();
  for (;;) {
    process.stdout.write('\u001b[2J\u001b[H');
    process.stdout.write(`${render(config, await browserAlive())}\n`);
    let answer = '';
    try {
      answer = (await rl.question('选择> ')).trim().toLowerCase();
    } catch {
      break; // stdin 被关闭（例如管道输入结束）时安静退出
    }
    if (answer === '9' || answer === 'q') break;

    if (answer === '1' || answer === '2') {
      let course;
      if (answer === '2') {
        course = (await rl.question('课程名（可留空=全部）> ')).trim() || undefined;
      }
      if (childAlive()) {
        process.stdout.write(`${C.yellow}已有任务在跑，先选 3 停止。${C.reset}\n`);
      } else {
        const run = startRun(config, { course, supervisor: !!config.useSupervisor });
        process.stdout.write(`${C.green}已启动${C.reset} pid=${run.pid} ${run.supervisor ? '（看门狗）' : ''} 输出：${run.out}\n`);
      }
      await rl.question('回车继续');
      continue;
    }

    if (answer === 's') {
      const next = Number(config.speedPreset ?? 0) > 1 ? null : 1.5;
      config.speedPreset = next;
      saveConfig(config);
      process.stdout.write(
        next
          ? `${C.green}已开启：换视频时用真实鼠标点站点 X 1.5${C.reset}\n`
          : `${C.yellow}已关闭：倍速由你自己点${C.reset}\n`,
      );
      await rl.question('回车继续');
      continue;
    }

    if (answer === '3') {
      process.stdout.write(`${C.yellow}正在停止（最多等 25 秒让当前视频收尾）…${C.reset}\n`);
      const res = await stopRun();
      process.stdout.write(`${C.green}${res.note}${C.reset}\n`);
      await rl.question('回车继续');
      continue;
    }

    if (answer === '4') {
      config.alertBeep = config.alertBeep === false;
      saveConfig(config);
      process.stdout.write(`验证提醒音已${config.alertBeep ? '开启' : '关闭'}\n`);
      await rl.question('回车继续');
      continue;
    }

    if (answer === '5') {
      config.alertBringToFront = config.alertBringToFront === false;
      saveConfig(config);
      process.stdout.write(`验证时窗口置顶已${config.alertBringToFront ? '开启' : '关闭'}\n`);
      await rl.question('回车继续');
      continue;
    }

    if (answer === '6') {
      config.useSupervisor = !config.useSupervisor;
      saveConfig(config);
      process.stdout.write(`无人值守看门狗已${config.useSupervisor ? '开启（卡死自动重启）' : '关闭'}\n`);
      await rl.question('回车继续');
      continue;
    }

    if (answer === '7') {
      process.stdout.write(`${C.dim}--- 最近日志 ---${C.reset}\n${lastLogLines(18).join('\n')}\n`);
      await rl.question('回车继续');
      continue;
    }

    if (answer === '8') {
      try {
        const { shutdownBrowser } = await import('./browser.mjs');
        await shutdownBrowser(config);
        process.stdout.write('已尝试关闭独立 Edge\n');
      } catch (error) {
        process.stdout.write(`关闭失败：${error}\n`);
      }
      await rl.question('回车继续');
      continue;
    }

    // 直接回车 → 刷新
  }
  rl.close();
}

main();
