import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { it, expect } from 'vitest';
import { findEdge } from '../../packages/browser-bridge/src/index';
import { VerifiedZhihuishuPracticeAdapter } from '../../packages/site-adapter/src/practice-native';
import { zhihuishuCourseId } from '../../packages/site-adapter/src/zhihuishu';
import { createVerifiedPracticeGrant } from '../../packages/task-engine/src/practice-grant';
import { TaskEngine } from '../../packages/task-engine/src/index';
import { RapidOcrWorker } from '../../packages/ocr/src/index';
import { ModelCache } from '../../packages/ocr/src/models';
import { parseOcrQuestion, validateQuestion } from '../../packages/practice/src/question';
import { parseNativeQuestion } from '../../packages/practice/src/native-question';
import { memory } from '../helpers/stage3';

it.each(['boolean', 'boolean-click-svg-footer', 'single', 'single-joined', 'single-svg-footer'])(
  '原生%s派生排版截图→真实RapidOCR→独立版式解析精确匹配DOM；全部请求拦截，非真实平台验收',
  async (variant) => {
    const python = process.env.STAGE3_OCR_PYTHON ?? '',
      models = process.env.STAGE3_OCR_MODELS ?? '';
    if (!isAbsolute(python) || !isAbsolute(models))
      throw new Error('SET_ABSOLUTE_STAGE3_OCR_PYTHON_AND_STAGE3_OCR_MODELS');
    const folder = await mkdtemp(join(tmpdir(), 'stage3-native-ocr-'));
    const edge = await findEdge();
    if (!edge) throw new Error('NATIVE_OCR_REQUIRES_EDGE');
    const browser = await chromium.launch({ executablePath: edge, headless: true });
    let adapter: VerifiedZhihuishuPracticeAdapter | undefined;
    try {
      const html = await readFile(
        new URL('../fixtures/local-site/stage3-native.html', import.meta.url),
      );
      const media = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
      const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
      await page.route('**/*', (route) =>
        route.fulfill(
          route.request().url().endsWith('/media.webm')
            ? { contentType: 'video/webm', body: media }
            : { contentType: 'text/html; charset=utf-8', body: html },
        ),
      );
      await page.goto(
        'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=native-synthetic-course-001',
      );
      await page.waitForFunction(() => document.querySelector('video')!.readyState >= 2);
      const grant = createVerifiedPracticeGrant(
        join(folder, 'acceptance'),
        zhihuishuCourseId('native-synthetic-course-001'),
        true,
      );
      adapter = await VerifiedZhihuishuPracticeAdapter.arm(
        page,
        grant,
        new AbortController().signal,
        new TaskEngine({ store: memory().store }),
      );
      await page.evaluate((variant) => {
        const fixture = (
          window as unknown as {
            nativeFixture: {
              show(): void;
              showBooleanClick(): void;
              showSingle(mode: string, joined: boolean): void;
              decorateSingleWithSvg(): void;
            };
          }
        ).nativeFixture;
        if (variant === 'boolean') fixture.show();
        else if (variant === 'boolean-click-svg-footer') fixture.showBooleanClick();
        else fixture.showSingle('correct', variant === 'single-joined');
        if (variant === 'single-svg-footer' || variant === 'boolean-click-svg-footer')
          fixture.decorateSingleWithSvg();
      }, variant);
      const s = new AbortController().signal,
        question = await adapter.question(s);
      expect(validateQuestion(question)).toBe(true);
      const bytes = await adapter.capture(s);
      const result = await new RapidOcrWorker(
        python,
        fileURLToPath(new URL('../../packages/ocr/rapidocr_worker.py', import.meta.url)),
        new ModelCache(models),
      ).recognize(bytes, s);
      if (process.env.STAGE3_SYNTHETIC_OCR_TRACE === '1')
        console.log(
          JSON.stringify({
            syntheticOnly: true,
            variant,
            text: result.text,
            confidence: result.confidence,
          }),
        );
      expect(parseOcrQuestion(result.text)).toBeNull();
      expect(adapter.parseCapturedQuestion(result.text)).toEqual(question);
    } finally {
      await adapter?.dispose();
      await browser.close();
      const target = resolve(folder);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('stage3-native-ocr-')
      )
        throw new Error('REFUSE_OUTSIDE_TEST_TEMP');
      await rm(target, { recursive: true, force: true });
    }
  },
  20000,
);

it('粘连标签的合成四项截图：先实际OCR，再校验完整DOM文字；只读、不发动作', async () => {
  const python = process.env.STAGE3_OCR_PYTHON ?? '',
    models = process.env.STAGE3_OCR_MODELS ?? '';
  if (!isAbsolute(python) || !isAbsolute(models))
    throw new Error('SET_ABSOLUTE_STAGE3_OCR_PYTHON_AND_STAGE3_OCR_MODELS');
  const edge = await findEdge();
  if (!edge) throw new Error('NATIVE_OCR_REQUIRES_EDGE');
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  try {
    const html = await readFile(
      new URL('../fixtures/local-site/stage3-native.html', import.meta.url),
    );
    const media = await readFile(new URL('../fixtures/local-site/stage2.webm', import.meta.url));
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    await page.route('**/*', (route) =>
      route.fulfill(
        route.request().url().endsWith('/media.webm')
          ? { contentType: 'video/webm', body: media }
          : { contentType: 'text/html; charset=utf-8', body: html },
      ),
    );
    await page.goto(
      'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=native-synthetic-course-001',
    );
    await page.evaluate(() =>
      (
        window as unknown as { nativeFixture: { showSingle(mode: string, joined: boolean): void } }
      ).nativeFixture.showSingle('correct', true),
    );
    const image = await page.locator('.el-dialog__body').screenshot({ timeout: 3000 });
    const result = await new RapidOcrWorker(
      python,
      fileURLToPath(new URL('../../packages/ocr/rapidocr_worker.py', import.meta.url)),
      new ModelCache(models),
    ).recognize(image, new AbortController().signal);
    if (process.env.STAGE3_SYNTHETIC_OCR_TRACE === '1')
      console.log(
        JSON.stringify({ syntheticOnly: true, text: result.text, confidence: result.confidence }),
      );
    const expected = {
      type: 'single' as const,
      stem: '植物光合作用示意图中请从四种颜色选择蓝色',
      complete: true,
      options: ['红色', '蓝色', '绿色', '白色'].map((text, i) => ({
        id: String.fromCharCode(65 + i),
        text,
      })),
    };
    const parsed = parseNativeQuestion(result.text, {
      kind: 'zhihuishu-dialog-v1',
      type: 'single',
      ordinal: 1,
      fullyVisible: true,
      unanswered: true,
      optionIds: ['A', 'B', 'C', 'D'],
      expectedStem: expected.stem,
      expectedOptionTexts: expected.options.map((o) => o.text),
    });
    // Only synthetic text may appear in an assertion diff. Never run against a user profile.
    expect({ recognizedSyntheticOnly: result.text, parsed }).toMatchObject({ parsed: expected });
  } finally {
    await browser.close();
  }
}, 20000);
