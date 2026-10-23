import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RapidOcrWorker } from '../../packages/ocr/src/index';
import { ModelCache } from '../../packages/ocr/src/models';
import { parseOcrQuestion } from '../../packages/practice/src/question';
import { PracticeSession } from '../../packages/practice/src/index';
import { PracticeFaultAdapter, legacyOcrOptions as fixedRandom, setup } from '../helpers/stage3';
import fixtures from '../fixtures/ocr-runtime/cases.json';

const fixtureDirectory = fileURLToPath(new URL('../fixtures/ocr-runtime/', import.meta.url));
const workerPath = fileURLToPath(new URL('../../packages/ocr/rapidocr_worker.py', import.meta.url));
let python: string;
let cache: ModelCache;
let directory: string;

beforeAll(async () => {
  python = process.env.STAGE3_OCR_PYTHON ?? '';
  const models = process.env.STAGE3_OCR_MODELS ?? '';
  if (!isAbsolute(python) || !isAbsolute(models))
    throw new Error('SET_ABSOLUTE_STAGE3_OCR_PYTHON_AND_STAGE3_OCR_MODELS');
  await access(python);
  cache = new ModelCache(models);
  await cache.ensure(new AbortController().signal);
  directory = await mkdtemp(join(tmpdir(), 'stage3-real-ocr-'));
});
afterAll(async () => {
  if (!directory) return;
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('stage3-real-ocr-'))
    throw new Error('REFUSE_OUTSIDE_TEST_TEMP');
  await rm(target, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const image = (name: string) => readFile(join(fixtureDirectory, `${name}.png`));
const worker = (script = workerPath, models = cache) => new RapidOcrWorker(python, script, models);

async function wrapper(name: string, code: string): Promise<string> {
  const path = join(directory, name + '.py');
  await writeFile(path, code, 'utf8');
  return path;
}
async function processExited(pid: number) {
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          return true;
        }
      },
      { timeout: 3000, interval: 20 },
    )
    .toBe(true);
}

describe('阶段3真实RapidOCR进程与固定模型（仅合成图片，不代表真实平台验收）', () => {
  it.each(fixtures.cases.filter((item) => item.expected !== null))(
    '真实图片 $id 精确识别并通过严格题型/选项/完整性解析',
    async (item) => {
      const result = await worker().recognize(await image(item.id), signal());
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(parseOcrQuestion(result.text)).toEqual(item.expected);
    },
  );
  it('残缺图片有识别内容也不能作为完整题目', async () => {
    const result = await worker().recognize(await image('incomplete'), signal());
    expect(result.text).toContain('光合作用');
    expect(parseOcrQuestion(result.text)).toBeNull();
  });
  it('DOM缺失时真实OCR接入练习闭环；随机选择与页面动作使用fixture', async () => {
    const { engine, storage } = await setup();
    const adapter = new PracticeFaultAdapter();
    adapter.currentQuestion = null;
    adapter.capture = () => image('single');
    const result = await new PracticeSession(engine, adapter, worker(), fixedRandom()).run();
    expect(result.ok).toBe(true);
    expect(adapter.actions.map((action) => action.type)).toEqual([
      'pause',
      'submit',
      'close',
      'restore',
    ]);
    expect(adapter.submissions()).toHaveLength(1);
    expect(adapter.submissions()[0]).toMatchObject({ optionIds: ['A'] });
    expect(engine.view().state).toBe('MONITORING');
    expect(adapter.currentVideo.paused).toBe(false);
    expect(JSON.stringify(storage.writes)).not.toContain('光合作用');
  });
  it('空白图片不伪造识别结果', async () => {
    const result = await worker().recognize(await image('blank'), signal());
    expect(result).toEqual({ text: '', confidence: 0 });
    expect(parseOcrQuestion(result.text)).toBeNull();
  });
  it('损坏图片显式失败，不回传路径或图像内容', async () => {
    await expect(worker().recognize(Buffer.from('not-an-image'), signal())).rejects.toThrow(
      /^OCR_WORKER_FAILED$/,
    );
  });
  it('损坏模型在进程启动前被校验阻断，保留原文件', async () => {
    const corrupt = join(directory, 'corrupt-models');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(corrupt);
    await writeFile(join(corrupt, 'det.onnx'), 'corrupt');
    await expect(
      worker(workerPath, new ModelCache(corrupt)).recognize(await image('single'), signal()),
    ).rejects.toThrow('MODEL_MISSING_OR_CORRUPT');
    expect(await readFile(join(corrupt, 'det.onnx'), 'utf8')).toBe('corrupt');
  });
  it('Python出站连接和DNS被禁止时仍使用本地模型真实推理', async () => {
    const script = await wrapper(
      'network-blocked',
      `import sys, socket, runpy
def deny(event, args):
    if event in ('socket.connect', 'socket.sendto', 'socket.sendmsg', 'socket.getaddrinfo', 'socket.gethostbyname', 'socket.gethostbyaddr', 'socket.getnameinfo'):
        raise RuntimeError('TEST_NETWORK_BLOCKED')
sys.addaudithook(deny)
def blocked(action):
    try:
        action()
    except RuntimeError:
        return
    raise RuntimeError('NETWORK_BLOCK_NOT_ENFORCED')
blocked(lambda: socket.getaddrinfo('example.invalid', 443))
with socket.socket() as tcp:
    blocked(lambda: tcp.connect(('127.0.0.1', 9)))
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
    blocked(lambda: udp.sendto(b'probe', ('127.0.0.1', 9)))
runpy.run_path(${JSON.stringify(workerPath)}, run_name='__main__')
`,
    );
    const result = await worker(script).recognize(await image('single'), signal());
    expect(parseOcrQuestion(result.text)).toEqual(fixtures.cases[0].expected);
  });
  it('用户取消立即终止已启动的真实Python进程，不等10秒期限', async () => {
    const marker = join(directory, 'cancel.pid');
    const script = await wrapper(
      'cancel',
      `import os, pathlib, runpy
pathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))
runpy.run_path(${JSON.stringify(workerPath)}, run_name='__main__')
`,
    );
    const controller = new AbortController();
    const recognizing = worker(script).recognize(await image('single'), controller.signal);
    const rejected = expect(recognizing).rejects.toThrow(/CANCELLED/);
    await expect
      .poll(async () => readFile(marker, 'utf8').catch(() => ''), { interval: 10 })
      .not.toBe('');
    const pid = Number(await readFile(marker, 'utf8'));
    const started = performance.now();
    controller.abort();
    await rejected;
    expect(performance.now() - started).toBeLessThan(2000);
    await processExited(pid);
  });
  it('挂起的真实Python子进程在10秒超时后终止', async () => {
    const marker = join(directory, 'timeout.pid');
    const script = await wrapper(
      'timeout',
      `import os, pathlib, time
pathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))
time.sleep(30)
`,
    );
    const started = performance.now();
    await expect(worker(script).recognize(await image('single'), signal())).rejects.toThrow(
      'TIMEOUT',
    );
    expect(performance.now() - started).toBeLessThan(14000);
    const pid = Number(await readFile(marker, 'utf8'));
    await processExited(pid);
  });
});
