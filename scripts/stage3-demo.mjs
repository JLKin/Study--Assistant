import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveStage3Fixture } from './stage3-fixture.mjs';

const bundleDirectory = join('work/stage3-random', `demo-${randomUUID()}`);
await mkdir('work/stage3-random', { recursive: true });
await mkdir(bundleDirectory);
const outfile = join(bundleDirectory, 'demo.mjs');
await build({
  entryPoints: ['scripts/stage3-demo.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['playwright'],
  target: 'node22',
});
const { server, url } = await serveStage3Fixture();
try {
  const { demo } = await import(pathToFileURL(resolve(outfile)).href);
  await demo(url);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
