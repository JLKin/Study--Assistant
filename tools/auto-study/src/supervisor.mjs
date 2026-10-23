// 看门狗：长时间无日志增长就重启 cli，保证无人值守也能自愈
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, LOG_DIR } from './browser.mjs';

const STALL_MS = Number(process.env.SUPERVISOR_STALL_MS ?? 300000);
const MAX_RESTARTS = Number(process.env.SUPERVISOR_MAX_RESTARTS ?? 40);
const args = process.argv.slice(2);
const cli = join(ROOT, 'src', 'cli.mjs');

function newestLogMtime() {
  try {
    const files = readdirSync(LOG_DIR).filter((name) => name.endsWith('.log'));
    if (files.length === 0) return 0;
    return Math.max(...files.map((name) => statSync(join(LOG_DIR, name)).mtimeMs));
  } catch {
    return 0;
  }
}

let child = null;
let restarts = 0;

function start() {
  console.log(`[看门狗] 启动子进程：node cli.mjs ${args.join(' ')}`);
  child = spawn(process.execPath, [cli, ...args], { cwd: ROOT, stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    console.log(`[看门狗] 子进程退出 code=${code} signal=${signal}`);
    if (code === 0) {
      console.log('[看门狗] 任务正常结束，不再重启');
      process.exit(0);
    }
    if (restarts >= MAX_RESTARTS) {
      console.log('[看门狗] 重启次数达上限，退出');
      process.exit(1);
    }
    restarts += 1;
    setTimeout(start, 5000);
  });
}

start();

setInterval(() => {
  const newest = newestLogMtime();
  const idleMs = Date.now() - newest;
  if (idleMs > STALL_MS && child && !child.killed) {
    console.log(`[看门狗] 日志 ${Math.round(idleMs / 1000)}s 无更新，判定卡死，重启`);
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}, 20000);
