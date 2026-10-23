import electron from 'electron';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopSmoke } from './smoke-lib.mjs';

const appPath = resolve('work', `desktop-smoke-${randomUUID()}`);
await mkdir(appPath, { recursive: true });
await cp('dist', join(appPath, 'dist'), { recursive: true });
await writeFile(
  join(appPath, 'package.json'),
  JSON.stringify({ name: 'study-stage1-smoke', version: '0.1.0', main: 'dist/main.cjs' }),
);
const report = await desktopSmoke({ executablePath: electron, appPath, prefix: 'desktop' });
console.log(
  `${report.cases.length} desktop/Edge checks passed. Evidence: work/logs/desktop-results.json`,
);
