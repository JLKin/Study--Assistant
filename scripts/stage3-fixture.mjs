import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function serveStage3Fixture(port = 0) {
  const html = await readFile(new URL('../tests/fixtures/local-site/stage3.html', import.meta.url));
  const media = await readFile(
    new URL('../tests/fixtures/local-site/stage2.webm', import.meta.url),
  );
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'GET' || !['/stage3-fixture', '/stage2.webm'].includes(path)) {
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
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/stage3-fixture` };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url } = await serveStage3Fixture(4173);
  console.log(
    `阶段3本地模拟页：${url}\n切换场景供人工查看；完整受保护辅助链请运行 npm run demo:stage3。真实站点待真实环境人工验收。Ctrl+C 停止。`,
  );
}
