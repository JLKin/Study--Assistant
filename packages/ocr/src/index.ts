import { spawn } from 'node:child_process';
import { bounded } from '../../contracts/src/async';
import type { ModelCache } from './models';

export interface OcrResult {
  text: string;
  confidence: number;
}
export interface OcrProvider {
  recognize(image: Uint8Array, signal: AbortSignal): Promise<OcrResult>;
}

/** Initial attempt + 3 retries; incompleteness is retryable but never accepted by confidence. */
export async function recognizeQuestion<T>(
  provider: OcrProvider,
  capture: (signal: AbortSignal) => Promise<Uint8Array>,
  parse: (text: string) => T | null,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    signal.throwIfAborted();
    try {
      const result = await bounded(
        async (child) => provider.recognize(await capture(child), child),
        signal,
        10000,
      );
      signal.throwIfAborted();
      if (
        typeof result.text !== 'string' ||
        result.text.length > 10000 ||
        !Number.isFinite(result.confidence)
      )
        continue;
      const value = parse(result.text);
      if (value) return value;
    } catch {
      signal.throwIfAborted();
    }
  }
  throw new Error('OCR_EXHAUSTED');
}

/** Hidden, bounded subprocess. Images and recognized text only cross stdin/stdout, never disk. */
export class RapidOcrWorker implements OcrProvider {
  constructor(
    private readonly python: string,
    private readonly workerPath: string,
    private readonly cache: ModelCache,
    private readonly downloadMissingModels = false,
  ) {}
  async recognize(image: Uint8Array, signal: AbortSignal): Promise<OcrResult> {
    if (!image.length || image.length > 4_000_000) throw new Error('OCR_IMAGE_LIMIT');
    return bounded(
      async (childSignal) => {
        await this.cache.ensure(childSignal, this.downloadMissingModels);
        childSignal.throwIfAborted();
        return new Promise<OcrResult>((resolve, reject) => {
          const child = spawn(this.python, [this.workerPath], {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
          });
          let output = '';
          const kill = () => {
            child.kill();
            reject(new Error('OCR_CANCELLED'));
          };
          childSignal.addEventListener('abort', kill, { once: true });
          child.stdout.on('data', (part: Buffer) => {
            output += part.toString('utf8');
            if (Buffer.byteLength(output) > 64000) {
              child.kill();
              reject(new Error('OCR_OUTPUT_LIMIT'));
            }
          });
          child.stderr.on('data', () => undefined); // Never echo runtime/page text into logs.
          child.stdin.on('error', () => undefined);
          child.on('error', () => {
            childSignal.removeEventListener('abort', kill);
            reject(new Error('OCR_RUNTIME_UNAVAILABLE'));
          });
          child.on('close', (code) => {
            childSignal.removeEventListener('abort', kill);
            if (childSignal.aborted || code !== 0) {
              reject(new Error('OCR_WORKER_FAILED'));
              return;
            }
            try {
              const result = JSON.parse(output) as OcrResult;
              if (
                typeof result.text !== 'string' ||
                !Number.isFinite(result.confidence) ||
                result.confidence < 0 ||
                result.confidence > 1
              )
                throw new Error();
              resolve(result);
            } catch {
              reject(new Error('OCR_PROTOCOL_INVALID'));
            }
          });
          child.stdin.end(
            JSON.stringify({
              image: Buffer.from(image).toString('base64'),
              models: this.cache.directory,
            }),
          );
        });
      },
      signal,
      10000,
    );
  }
}
