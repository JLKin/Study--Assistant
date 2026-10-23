import { packager } from '@electron/packager';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** 优先用本机缓存的 Electron 压缩包，避免打包时访问 github。 */
function findElectronZipDir(version) {
  const root = join(process.env.LOCALAPPDATA ?? '', 'electron', 'Cache');
  if (!existsSync(root)) return undefined;
  const wanted = `electron-v${version}-win32-x64.zip`;
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir);
    try {
      if (readdirSync(candidate).includes(wanted)) return candidate;
    } catch {
      /* 目录不可读就跳过 */
    }
  }
  return undefined;
}

const source = resolve('work', `package-input-${randomUUID()}`);
const output = resolve('release', `stage2-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(join(source, 'node_modules'), { recursive: true });
await cp('dist', join(source, 'dist'), { recursive: true });
for (const name of ['playwright', 'playwright-core']) {
  await cp(join('node_modules', name), join(source, 'node_modules', name), { recursive: true });
}
const root = JSON.parse(await readFile('package.json', 'utf8'));
const productName = '智慧树学习助手 · 测试版 v0.1';
const exeBaseName = '智慧树学习助手-测试版v0.1';
await writeFile(
  join(source, 'package.json'),
  JSON.stringify({
    name: root.name,
    productName,
    version: root.version,
    main: 'dist/main.cjs',
    description: root.description,
    dependencies: root.dependencies,
  }),
);
const packaged = await packager({
  dir: source,
  out: output,
  name: exeBaseName,
  executableName: exeBaseName,
  icon: resolve('apps', 'desktop', 'icon.ico'),
  platform: 'win32',
  arch: 'x64',
  electronVersion: root.devDependencies.electron,
  electronZipDir: findElectronZipDir(root.devDependencies.electron),
  asar: true,
  prune: false,
  overwrite: false,
  // Reuse the already verified Electron runtime installed by setup:electron.
  electronDist: resolve('node_modules/electron/dist'),
});
const appDir = packaged[0];
// 打包目录里绝不能带运行数据（浏览器配置、登录态、日志），否则连同书签一起发给别人。
rmSync(join(appDir, 'data'), { recursive: true, force: true });
const archive = resolve(output, '智慧树学习助手-测试版v0.1-win-x64.zip');
const compressed = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    resolve('scripts/zip.ps1'),
    '-Source',
    appDir,
    '-Destination',
    archive,
  ],
  { windowsHide: true, encoding: 'utf8', timeout: 120000 },
);
if (compressed.status !== 0) throw new Error(`ZIP creation failed: ${compressed.stderr}`);
const digest = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex');
await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
await mkdir('work/logs', { recursive: true });
await writeFile(
  'work/logs/package-location.json',
  JSON.stringify(
    { appDir, archive, sha256: digest, version: root.version, executableName: `${exeBaseName}.exe` },
    null,
    2,
  ),
);
console.log(`Stage 2 test package: ${appDir}\nZIP: ${archive}\nSHA-256: ${digest}`);
