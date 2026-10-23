// 倍速：只走「真实鼠标点击」这一条路，且默认关闭（config.speedPreset = null）。
// 实测（2026-10-22 18:24 vs 18:35 对照）：
//   JS 赋值 video.playbackRate / 调 .speedTab.click()  → 1 秒内弹「检测到异常脚本」，页面被踢回主页
//   真实鼠标点站点自己的 X 1.5                         → 20 秒无任何提示，进度正常（人工点也一样正常）
// 站点在切换视频时会把 playbackRate 重置回 1，所以每换一条视频需要重新点一次。
import { sleep } from './util.mjs';

const VIDEO_SEL = 'video#vjs_container_html5_api, video';

export async function readSpeed(page) {
  return page
    .evaluate((sel) => document.querySelector(sel)?.playbackRate ?? null, VIDEO_SEL)
    .catch(() => null);
}

async function clickAt(page, x, y) {
  await page.mouse.move(x, y, { steps: 4 });
  await sleep(80);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
}

/** 用真实鼠标把站点倍速调到 want（1.25 / 1.5）。返回 { ok, rate, reason?, skipped? } */
export async function setSpeedByMouse(page, want, { logger } = {}) {
  const cur = await readSpeed(page);
  if (cur == null) return { ok: false, reason: 'no-video', rate: null };
  if (Math.abs(cur - want) < 0.01) return { ok: true, rate: cur, skipped: true };

  const box = await page
    .evaluate((sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    }, VIDEO_SEL)
    .catch(() => null);
  if (!box) return { ok: false, reason: 'no-video-box', rate: cur };
  await page.mouse.move(box.x + 40, box.y + box.height - 6, { steps: 6 });
  await sleep(420);

  const sb = await page
    .evaluate(() => {
      const r = document.querySelector('.speedBox')?.getBoundingClientRect();
      return r && r.width > 5 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    })
    .catch(() => null);
  if (!sb) return { ok: false, reason: 'no-speedbox', rate: cur };
  await clickAt(page, sb.x, sb.y);
  await sleep(380);

  const target = await page
    .evaluate((w) => {
      const el = document.querySelector(`.speedTab[rate="${w}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, String(want))
    .catch(() => null);
  if (!target) return { ok: false, reason: 'no-speed-tab', rate: cur };
  await clickAt(page, target.x, target.y);
  await sleep(650);

  const after = await readSpeed(page);
  const ok = after != null && Math.abs(after - want) < 0.01;
  if (logger && !ok) logger.warn('倍速未生效', { want, after });
  return { ok, rate: after, reason: ok ? undefined : 'not-applied' };
}
