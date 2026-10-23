import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { desktopSmoke } from './smoke-lib.mjs';

const {
  appDir,
  archive,
  stage = 1,
  executableName = '智慧树学习助手-阶段1.exe',
} = JSON.parse(await readFile('work/logs/package-location.json', 'utf8'));
const extracted = resolve('work', `package-unzip-${randomUUID()}`);
await mkdir(extracted, { recursive: true });
const expanded = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    resolve('scripts/unzip.ps1'),
    '-Source',
    archive,
    '-Destination',
    extracted,
  ],
  { windowsHide: true, encoding: 'utf8', timeout: 60000 },
);
if (expanded.status !== 0) throw new Error('Stage ZIP extraction failed');
const report = await desktopSmoke({
  executablePath: join(extracted, basename(appDir), executableName),
  restrictedPath: true,
  prefix: 'package',
  expectedStage: stage,
});
console.log(
  `${report.cases.length} packaged desktop/Edge checks passed with PATH excluding Node. This is not a clean Windows machine certification.`,
);
