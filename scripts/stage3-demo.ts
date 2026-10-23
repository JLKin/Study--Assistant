import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findEdge } from '../packages/browser-bridge/src/index';
import { StateStore } from '../packages/persistence/src/index';
import { TaskEngine } from '../packages/task-engine/src/index';
import type { CourseObservation } from '../packages/contracts/src/index';
import { PracticeSession } from '../packages/practice/src/index';
import { FixturePracticeSiteAdapter } from '../packages/site-adapter/src/practice-fixture';

export async function demo(url: string) {
  const executablePath = await findEdge();
  if (!executablePath) throw new Error('EDGE_MISSING');
  const browser = await chromium.launch({ executablePath, headless: true });
  const directory = await mkdtemp(join(tmpdir(), 'study-stage3-demo-'));
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.locator('#video').evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.loop = true;
      return video.play();
    });
    const course = (): CourseObservation => ({
      courseId: 'stage3-course',
      title: '本机模拟课程',
      source: 'fixture',
      authenticated: true,
      confidence: 'verified',
      pageKind: 'course',
      platformCompleted: null,
      evidence: ['stage3-fixture-only'],
      observedAt: new Date().toISOString(),
    });
    const store = new StateStore(directory);
    const engine = new TaskEngine({
      store,
      stage3FixturePractice: true,
      stage2Capabilities: {
        enabled: true,
        inspect: async () => course(),
        backup: async () => true,
      },
    });
    await engine.browserConnected();
    await engine.confirmCourse(course(), 'stage3-course');
    await engine.start();
    const cycles = [];
    for (const mode of ['single', 'wrong', 'boolean']) {
      if (cycles.length) await new Promise((resolve) => setTimeout(resolve, 5100));
      await page.evaluate(
        (mode) =>
          (
            window as unknown as { stage3Fixture: { reset(mode: string): void } }
          ).stage3Fixture.reset(mode),
        mode,
      );
      const result = await new PracticeSession(engine, new FixturePracticeSiteAdapter(page)).run();
      cycles.push(result);
      if (!result.ok) break;
    }
    const result = cycles.at(-1)!;
    const runId = `demo-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
    const evidence = join('docs/evidence/stage3-random', runId);
    await mkdir('docs/evidence/stage3-random', { recursive: true });
    await mkdir(evidence);
    const screenshot = join(evidence, 'fixture.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    const snapshot = await store.load();
    const report = {
      scope: 'local-fixture-only',
      realSite: '待真实环境人工验收',
      recognition: 'dom-only',
      ocrRequired: false,
      strategy: 'offline-random-once',
      cycles,
      completedAllCycles: cycles.length === 3 && cycles.every((result) => result.ok),
      searchRequests: 0,
      result,
      ledger: snapshot?.pendingOperations,
      screenshot: resolve(screenshot),
      temporaryStateDirectory: directory,
    };
    await writeFile(join(evidence, 'demo-result.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(
      JSON.stringify({
        ok: result.ok,
        code: result.code,
        operations: snapshot?.pendingOperations.length,
        cycles: cycles.length,
        temporaryStateDirectory: directory,
        evidenceDirectory: resolve(evidence),
      }),
    );
    if (!result.ok) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
