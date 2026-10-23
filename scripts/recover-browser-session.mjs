import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--data-dir' || !args[1]) {
  throw new Error('用法: node scripts/recover-browser-session.mjs --data-dir <data目录>');
}

// 手动诊断也复用生产桥接层，避免另一套校验逻辑绕过损坏/跨目录会话保护。
// 只重连已经运行且可验证的专用 Edge，不启动、关闭浏览器或读取页面。
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(workspace, 'work', 'browser-recovery');
await mkdir(outputDir, { recursive: true });
const output = join(outputDir, `bridge-${randomUUID()}.cjs`);
await build({
  entryPoints: [join(workspace, 'packages', 'browser-bridge', 'src', 'index.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['playwright'],
});
const { BrowserBridge } = await import(pathToFileURL(output).href);
const bridge = new BrowserBridge({ dataDir: resolve(args[1]) });
try {
  const status = await bridge.reconnect();
  if (status.state !== 'CONNECTED') throw new Error('未建立可信专用 Edge 连接。');
  console.log('专用 Edge 会话核验成功。');
} finally {
  await bridge.disconnect();
}
