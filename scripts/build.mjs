import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist/renderer', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['apps/desktop/main/index.ts'],
    outfile: 'dist/main.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'playwright'],
    sourcemap: true,
  }),
  build({
    entryPoints: ['apps/desktop/preload/index.ts'],
    outfile: 'dist/preload.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    entryPoints: ['apps/desktop/renderer/index.ts'],
    outfile: 'dist/renderer/index.js',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome130',
  }),
  copyFile('apps/desktop/renderer/index.html', 'dist/renderer/index.html'),
  copyFile('apps/desktop/renderer/style.css', 'dist/renderer/style.css'),
  copyFile('apps/desktop/renderer/icon.svg', 'dist/renderer/icon.svg'),
  copyFile('apps/desktop/renderer/icon.png', 'dist/renderer/icon.png'),
]);
