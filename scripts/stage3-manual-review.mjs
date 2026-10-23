import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = join('work/stage3-manual-review', `tool-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const outfile = join(directory, 'review.mjs');
await build({
  entryPoints: ['scripts/stage3-manual-review-tool.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
});
try {
  const { review } = await import(pathToFileURL(resolve(outfile)).href);
  await review(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MANUAL_REVIEW_FAILED');
  process.exitCode = 1;
}
