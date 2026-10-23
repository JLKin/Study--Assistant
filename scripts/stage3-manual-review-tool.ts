import { resolve } from 'node:path';
import { ManualPracticeReviewStore } from '../packages/persistence/src/manual-practice-review';
import { recordedPracticeChapter } from './stage3-recorded-chapter';

/** Offline operator tool; does not import BrowserBridge, TaskEngine or any website implementation. */
export async function review(args: string[]): Promise<void> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !['--data-dir', '--acknowledge-digest'].includes(key) ||
      values.has(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error(
        '用法：npm run review:stage3 -- --data-dir <原data目录> [--acknowledge-digest <预览摘要>]',
      );
    values.set(key, args[i + 1]);
  }
  const dataDir = values.get('--data-dir');
  if (!dataDir) throw new Error('必须明确指定原data目录；不会自动创建空数据绕过锁止。');
  const store = new ManualPracticeReviewStore(
    resolve(dataDir),
    recordedPracticeChapter(resolve('.')),
  );
  const digest = values.get('--acknowledge-digest');
  if (!digest) {
    console.log(
      JSON.stringify(
        {
          mode: 'preview-only',
          ...(await store.preview()),
          decision: '放弃旧自动尝试，保留未知结果；只允许不同章节的新任务单次复验。',
          sourceModified: false,
          browserActions: 0,
        },
        null,
        2,
      ),
    );
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const receipt = await store.record(
      digest,
      'abandon-old-attempt-allow-one-fresh-task',
      controller.signal,
    );
    console.log(
      JSON.stringify(
        {
          mode: 'manual-decision-recorded',
          receiptId: receipt.id,
          outcome: receipt.outcome,
          sourceModified: false,
          taskStarted: false,
          browserActions: 0,
          message: '旧操作仍待确认。独立备份和人工决定已保存，尚未授予网页作答权限。',
        },
        null,
        2,
      ),
    );
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}
