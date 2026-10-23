// Explicit test teardown for interrupted smoke runs. Never enumerates or kills Edge processes.
import { readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { chromium } from 'playwright';
const target = resolve(process.argv[2] ?? '');
if (
  !target.startsWith(resolve('work', 'desktop-smoke-')) ||
  !target.startsWith(resolve('work') + sep)
)
  throw new Error('Not a smoke directory');
const session = JSON.parse(await readFile(join(target, 'data/browser-session.json'), 'utf8'));
if (session.profilePath !== join(target, 'data/browser-profile'))
  throw new Error('Unexpected profile');
const browser = await chromium.connectOverCDP(
  `ws://127.0.0.1:${session.port}${session.browserPath}`,
  { timeout: 3000 },
);
const cdp = await browser.newBrowserCDPSession();
await cdp.send('Browser.close').catch(() => {});
await browser.close().catch(() => {});
