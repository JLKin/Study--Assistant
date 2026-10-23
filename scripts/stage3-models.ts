import { resolve } from 'node:path';
import { ModelCache } from '../packages/ocr/src/models';
import { bounded } from '../packages/contracts/src/async';

export async function models(args: string[]) {
  if (!args[0] || (args[1] !== undefined && args[1] !== '--download')) {
    throw new Error(
      '用法：npm run ocr:stage3 -- <ocr-cache绝对目录> [--download]。默认只校验；--download才联网下载固定清单。',
    );
  }
  const directory = resolve(args[0]);
  const cache = new ModelCache(directory);
  await bounded(
    (signal) => cache.ensure(signal, args[1] === '--download'),
    new AbortController().signal,
    120000,
  );
  console.log(
    '模型和字典SHA256校验通过。这不是RapidOCR图片推理验收；运行时、真实识别和便携依赖仍待真实环境人工验收。',
  );
}
