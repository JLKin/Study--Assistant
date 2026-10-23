import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = join('work/stage3-revalidation', 'tool-' + randomUUID());
await mkdir(directory, { recursive: true });
const outfile = join(directory, 'prepare.mjs');
await build({
  entryPoints: ['scripts/stage3-revalidation-tool.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
});
try {
  const { prepareRevalidation } = await import(pathToFileURL(resolve(outfile)).href);
  await prepareRevalidation(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'REVALIDATION_FAILED');
  process.exitCode = 1;
}
