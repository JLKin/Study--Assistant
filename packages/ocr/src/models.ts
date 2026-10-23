import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ModelAsset {
  name: string;
  url: string;
  sha256: string;
}
const root = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/';
/** Fixed upstream v3.10.0 registry; dictionary digest independently measured 2026-10-19. */
export const RAPID_MODELS: readonly ModelAsset[] = Object.freeze([
  {
    name: 'det.onnx',
    url: root + 'onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx',
    sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
  },
  {
    name: 'rec.onnx',
    url: root + 'onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx',
    sha256: '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b',
  },
  {
    name: 'cls.onnx',
    url: root + 'onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx',
    sha256: 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c',
  },
  {
    name: 'keys.txt',
    url: root + 'paddle/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile/ppocr_keys_v1.txt',
    sha256: '28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7',
  },
]);
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Temporary files + SHA256 + atomic rename. A corrupt cache is never considered ready. */
export class ModelCache {
  constructor(
    readonly directory: string,
    private readonly assets = RAPID_MODELS,
    private readonly request: typeof fetch = fetch,
  ) {}
  async ensure(signal: AbortSignal, download = false): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const asset of this.assets) {
      signal.throwIfAborted();
      if (!/^[a-z0-9_.-]+$/i.test(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256))
        throw new Error('MODEL_MANIFEST_INVALID');
      const path = join(this.directory, asset.name);
      try {
        const data = await readFile(path);
        if (digest(data) === asset.sha256) continue;
      } catch {
        /* Missing or unreadable requires an explicit download or manual install. */
      }
      if (!download) throw new Error('MODEL_MISSING_OR_CORRUPT');
      if (new URL(asset.url).protocol !== 'https:') throw new Error('MODEL_SOURCE_UNTRUSTED');
      const response = await this.request(asset.url, { signal, redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('MODEL_DOWNLOAD_FAILED');
      const reader = response.body.getReader();
      const pieces: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const value = await reader.read();
          if (value.done) break;
          size += value.value.length;
          if (size > 32 * 1024 * 1024) throw new Error('MODEL_SIZE_LIMIT');
          pieces.push(value.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const data = Buffer.concat(pieces);
      if (digest(data) !== asset.sha256) throw new Error('MODEL_HASH_MISMATCH');
      const temporary = join(this.directory, `${asset.name}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, data, { flag: 'wx' });
        signal.throwIfAborted();
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
    signal.throwIfAborted();
  }
}
