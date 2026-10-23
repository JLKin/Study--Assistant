import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognizeQuestion, RapidOcrWorker } from '../../packages/ocr/src/index';
import { ModelCache, RAPID_MODELS } from '../../packages/ocr/src/models';
import { parseOcrQuestion } from '../../packages/practice/src/question';
import { DEFAULT_CONFIG, repairConfig } from '../../packages/contracts/src/config';

const signal = () => new AbortController().signal;
const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'stage3-ocr-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('阶段3 OCR模型与可取消识别', () => {
  it('完整DOM以外的识别最多额外3次；成功即停止', async () => {
    const recognize = vi
      .fn()
      .mockResolvedValueOnce({ text: '', confidence: 1 })
      .mockResolvedValueOnce({
        text: '单选\n题干:光合作用需要二氧化碳吗\nA:正确\nB:错误\n结束:2',
        confidence: 0.6,
      });
    const question = await recognizeQuestion(
      { recognize },
      async () => new Uint8Array([1]),
      parseOcrQuestion,
      signal(),
    );
    expect(question?.stem).toContain('光合作用');
    expect(recognize).toHaveBeenCalledTimes(2);
    const failed = vi.fn(async () => {
      throw new Error('model unavailable');
    });
    await expect(
      recognizeQuestion(
        { recognize: failed },
        async () => new Uint8Array([1]),
        parseOcrQuestion,
        signal(),
      ),
    ).rejects.toThrow('OCR_EXHAUSTED');
    expect(failed).toHaveBeenCalledTimes(4);
  });
  it('每次OCR限时10秒；暂停不等超时也不再重试', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const recognize = vi.fn(() => new Promise<never>(() => undefined));
    const work = recognizeQuestion(
      { recognize },
      async () => new Uint8Array([1]),
      parseOcrQuestion,
      controller.signal,
    );
    const rejected = expect(work).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const timed = recognizeQuestion(
      { recognize },
      async () => new Uint8Array([1]),
      parseOcrQuestion,
      signal(),
    );
    const exhausted = expect(timed).rejects.toThrow('OCR_EXHAUSTED');
    await vi.advanceTimersByTimeAsync(40001);
    await exhausted;
    expect(recognize).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('首次下载完整校验后启用，离线缓存复用但每次校验', async () => {
    const directory = await temp();
    const data = Buffer.from('fixture-model');
    const asset = {
      name: 'test.onnx',
      url: 'https://models.example/model',
      sha256: createHash('sha256').update(data).digest('hex'),
    };
    const request = vi.fn<typeof fetch>(async () => new Response(data));
    const cache = new ModelCache(directory, [asset], request);
    await expect(cache.ensure(signal())).rejects.toThrow('MODEL_MISSING_OR_CORRUPT');
    await cache.ensure(signal(), true);
    await cache.ensure(signal());
    expect(request).toHaveBeenCalledTimes(1);
    expect(await readFile(join(directory, asset.name), 'utf8')).toBe('fixture-model');
    await writeFile(join(directory, asset.name), 'corrupt');
    await expect(cache.ensure(signal())).rejects.toThrow('CORRUPT');
    expect(await readFile(join(directory, asset.name), 'utf8')).toBe('corrupt');
  });
  it('错误哈希、下载失败、路径越界不启用也不破坏旧文件', async () => {
    const directory = await temp();
    const asset = {
      name: 'test.onnx',
      url: 'https://models.example/model',
      sha256: '0'.repeat(64),
    };
    await writeFile(join(directory, asset.name), 'original-corrupt');
    await expect(
      new ModelCache(directory, [asset], async () => new Response('bad')).ensure(signal(), true),
    ).rejects.toThrow('HASH_MISMATCH');
    expect(await readFile(join(directory, asset.name), 'utf8')).toBe('original-corrupt');
    await expect(
      new ModelCache(directory, [{ ...asset, name: '../escape' }]).ensure(signal(), true),
    ).rejects.toThrow('MANIFEST');
    await expect(
      new ModelCache(directory, [asset], async () => new Response('', { status: 503 })).ensure(
        signal(),
        true,
      ),
    ).rejects.toThrow('DOWNLOAD_FAILED');
    expect(await readdir(directory)).toEqual(['test.onnx']);
  });
  it('固定模型与字典清单各自带版本/完整SHA256；手动补装走同一校验', () => {
    expect(RAPID_MODELS).toHaveLength(4);
    for (const asset of RAPID_MODELS) {
      expect(asset.url).toContain('/v3.10.0/');
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it('真实worker运行时缺失明示失败，不伪装OCR成功（此项不是图片推理验收）', async () => {
    const directory = await temp();
    const worker = new RapidOcrWorker(
      'stage3-nonexistent-python.exe',
      fileURLToPath(new URL('../../packages/ocr/rapidocr_worker.py', import.meta.url)),
      new ModelCache(directory, []),
    );
    await expect(worker.recognize(new Uint8Array([1]), signal())).rejects.toThrow(
      'OCR_RUNTIME_UNAVAILABLE',
    );
  });
  it('旧schema1配置有效值不变，新项缺省不报错；非法新项各自修复', () => {
    const {
      practiceAllowFullText: _full,
      practiceConfidenceThreshold: _threshold,
      ...legacy
    } = DEFAULT_CONFIG;
    const upgraded = repairConfig({ ...legacy, logRetentionDays: 17, targetPlaybackRate: 1.25 });
    expect(upgraded.issues).toEqual([]);
    expect(upgraded.config).toMatchObject({
      logRetentionDays: 17,
      targetPlaybackRate: 1.25,
      practiceAllowFullText: false,
      practiceConfidenceThreshold: 70,
    });
    const invalid = repairConfig({
      ...DEFAULT_CONFIG,
      practiceAllowFullText: 'yes',
      practiceConfidenceThreshold: 200,
      logRetentionDays: 19,
    });
    expect(invalid.config.logRetentionDays).toBe(19);
    expect(invalid.issues.map((issue) => issue.key)).toEqual([
      'practiceAllowFullText',
      'practiceConfidenceThreshold',
    ]);
  });
});
