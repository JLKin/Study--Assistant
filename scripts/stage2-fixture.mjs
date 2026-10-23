import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** 独立本机演示入口；不访问真实平台，不读取或修改用户 data。 */
export async function serveStage2Fixture(port = 0) {
  const html = await readFile(
    fileURLToPath(new URL('../tests/fixtures/local-site/stage2.html', import.meta.url)),
  );
  const media = await readFile(
    fileURLToPath(new URL('../tests/fixtures/local-site/stage2.webm', import.meta.url)),
  );
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'GET' || !['/stage2-fixture', '/stage2.webm'].includes(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': path === '/stage2.webm' ? 'video/webm' : 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(path === '/stage2.webm' ? media : html);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/stage2-fixture` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url } = await serveStage2Fixture(4172);
  console.log(
    `本机阶段 2 视频模拟页：${url}\n在专用 Edge 中手动打开，倍速通过网页人工设置，助手仅读取当前速率；真实站点待真实环境人工验收。Ctrl+C 停止模拟服务。`,
  );
}
