import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

await build({
  entryPoints: ['scripts/stage3-models.ts'],
  outfile: 'work/stage3/models.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
});
try {
  const { models } = await import(pathToFileURL(resolve('work/stage3/models.mjs')).href);
  await models(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'OCR_MODEL_CHECK_FAILED');
  process.exitCode = 1;
}
