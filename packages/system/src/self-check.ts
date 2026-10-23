import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckItem, SelfCheck } from '../../contracts/src/index.js';

export interface CheckOptions {
  dataDir: string;
  findEdge: () => Promise<string | null>;
  notificationsSupported: boolean;
  networkCheck?: () => Promise<boolean>;
}
export async function checkEnvironment(options: CheckOptions): Promise<SelfCheck> {
  const items: CheckItem[] = [];
  let edge: string | null = null;
  try {
    edge = await options.findEdge();
  } catch {
    /* Only fixed summaries leave service layer. */
  }
  items.push({
    id: 'edge',
    label: 'Microsoft Edge',
    status: edge ? 'pass' : 'fail',
    critical: true,
    message: edge ? '找到 Edge，可手动启动专用浏览器' : '未找到 Edge，请安装后重新自检',
  });
  for (const dir of ['config', 'state', 'logs', 'browser-profile', 'backups/task']) {
    const probe = join(options.dataDir, dir, `.probe-${randomUUID()}`);
    try {
      await mkdir(join(options.dataDir, dir), { recursive: true });
      const handle = await open(probe, 'wx', 0o600);
      try {
        await handle.writeFile('write-check');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await unlink(probe);
      items.push({
        id: `directory.${dir}`,
        label: `data/${dir}`,
        status: 'pass',
        critical: true,
        message: '写入与同步检查通过',
      });
    } catch {
      items.push({
        id: `directory.${dir}`,
        label: `data/${dir}`,
        status: 'fail',
        critical: true,
        message: '目录不可可靠写入，禁止开始',
      });
    }
  }
  const dependencies = !!process.versions.node;
  items.push({
    id: 'runtime',
    label: 'Node 运行时',
    status: dependencies ? 'pass' : 'fail',
    critical: true,
    message: dependencies ? '当前进程具备 Node 运行时；便携包包含运行时' : '缺少运行时',
  });
  try {
    const { chromium } = await import('playwright');
    items.push({
      id: 'playwright',
      label: 'Playwright 依赖',
      status: chromium ? 'pass' : 'fail',
      critical: true,
      message: '连接依赖可加载，无需下载测试浏览器',
    });
  } catch {
    items.push({
      id: 'playwright',
      label: 'Playwright 依赖',
      status: 'fail',
      critical: true,
      message: '连接依赖缺失',
    });
  }
  let networkOk = false;
  try {
    networkOk = await (
      options.networkCheck ??
      (async () => {
        // No credentials, body collection, cookies or login requests; one bounded public HEAD.
        const response = await fetch('https://studyvideoh5.zhihuishu.com/', {
          method: 'HEAD',
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
          credentials: 'omit',
        });
        return response.status >= 200 && response.status < 500;
      })
    )();
  } catch {
    /* Network is optional for stage 1 shell. */
  }
  items.push({
    id: 'network',
    label: '公开站点网络',
    status: networkOk ? 'pass' : 'warning',
    critical: false,
    message: networkOk
      ? '公开地址可达，不代表已登录或课程可用'
      : '网络检查未通过，可继续使用本地壳程序',
  });
  items.push({
    id: 'notifications',
    label: '系统通知',
    status: options.notificationsSupported ? 'pass' : 'warning',
    critical: false,
    message: options.notificationsSupported
      ? '通知 API 可用；实际送达待人工核验'
      : '通知不可用，使用界面提示',
  });
  items.push({
    id: 'backup',
    label: '任务前备份',
    status: 'warning',
    critical: false,
    message: '阶段 4 实现；本阶段开始入口保持锁止',
  });
  items.push({
    id: 'ocr',
    label: 'OCR 模型',
    status: 'warning',
    critical: false,
    message: '阶段 3 实现；本阶段不下载模型',
  });
  return {
    checkedAt: new Date().toISOString(),
    canStart: !items.some((i) => i.critical && i.status === 'fail'),
    items,
  };
}
