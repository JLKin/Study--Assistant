import type { AppConfig } from '../../contracts/src/index';
import type { PlayerObservation } from '../../contracts/src/monitor';

export type PlayerDecision = 'none' | 'buffer-timeout' | 'stall-timeout';

/** 只分析真实观察，既不改播放时间也不将播放视为平台完成。 */
export class PlayerMonitor {
  private chapterId: string | null = null;
  private lastTime = 0;
  private progressAt = 0;
  private bufferingAt: number | null = null;

  reset(): void {
    this.chapterId = null;
    this.bufferingAt = null;
  }

  observe(player: PlayerObservation, now: number, config: AppConfig): PlayerDecision {
    if (this.chapterId !== player.chapterId) {
      this.chapterId = player.chapterId;
      this.lastTime = player.currentTime;
      this.progressAt = now;
      this.bufferingAt = null;
    }
    if (player.paused || player.ended) {
      this.progressAt = now;
      this.bufferingAt = null;
      this.lastTime = player.currentTime;
      return 'none';
    }
    if (player.currentTime !== this.lastTime) {
      this.progressAt = now;
      this.lastTime = player.currentTime;
    }
    if (player.buffering) {
      this.bufferingAt ??= now;
      // 缓冲不计为普通卡顿，恢复后重新计算卡顿时长。
      this.progressAt = now;
      return now - this.bufferingAt >= config.bufferTimeoutMs ? 'buffer-timeout' : 'none';
    }
    this.bufferingAt = null;
    return now - this.progressAt >= config.stallTimeoutMs ? 'stall-timeout' : 'none';
  }
}
