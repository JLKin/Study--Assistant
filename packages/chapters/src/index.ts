import type { ChapterVerification, SiteObservation } from '../../contracts/src/monitor';

export const CHAPTER_RECHECK_MS = 3000;
export const CHAPTER_RECHECK_LIMIT = 3;
export const VERIFICATION_PROGRESS = 0.81;

interface Conflict {
  retries: number;
  nextAt: number;
}
export class ChapterTracker {
  private readonly conflicts = new Map<string, Conflict>();

  reset(): void {
    this.conflicts.clear();
  }

  inspect(
    observation: SiteObservation,
    now: number,
  ): {
    chapters: ChapterVerification[];
    blocked: boolean;
    waiting: boolean;
    nextChapterId: string | null;
    allCompleted: boolean;
  } {
    let blocked = false;
    let waiting = false;
    const chapters = observation.chapters.map((chapter): ChapterVerification => {
      const current = chapter.chapterId === observation.currentChapterId;
      const player = current ? observation.player : null;
      const progress = player && player.duration > 0 ? player.currentTime / player.duration : null;
      const base = {
        chapterId: chapter.chapterId,
        platformCompleted: chapter.platformCompleted,
        videoProgress: progress,
        verificationTriggered: progress !== null && progress >= VERIFICATION_PROGRESS,
        retries: 0,
      };
      if (
        chapter.confidence !== 'verified' ||
        chapter.platformCompleted === null ||
        (current &&
          (!player || player.confidence !== 'verified' || player.chapterId !== chapter.chapterId))
      ) {
        if (current) blocked = true;
        return { ...base, status: 'unknown' };
      }
      const conflict =
        current &&
        player &&
        ((chapter.platformCompleted === false && player.ended) ||
          (chapter.platformCompleted === true &&
            progress !== null &&
            progress < VERIFICATION_PROGRESS));
      if (conflict) {
        let state = this.conflicts.get(chapter.chapterId);
        if (!state) {
          state = { retries: 0, nextAt: now + CHAPTER_RECHECK_MS };
          this.conflicts.set(chapter.chapterId, state);
        } else if (now >= state.nextAt) {
          state.retries++;
          state.nextAt = now + CHAPTER_RECHECK_MS;
        }
        if (state.retries >= CHAPTER_RECHECK_LIMIT) blocked = true;
        else waiting = true;
        return { ...base, retries: state.retries, status: 'conflict' };
      }
      this.conflicts.delete(chapter.chapterId);
      return { ...base, status: chapter.platformCompleted ? 'confirmed' : 'pending' };
    });
    const currentIndex = chapters.findIndex((c) => c.chapterId === observation.currentChapterId);
    const canNavigate =
      currentIndex >= 0 &&
      chapters[currentIndex].status === 'confirmed' &&
      observation.player?.ended === true &&
      !blocked &&
      !waiting;
    // 从清单首个未完成章继续，绝不跨过未完成章节；未知目标也不导航。
    const target = canNavigate ? chapters.find((c) => c.status !== 'confirmed') : undefined;
    const nextChapterId = target?.status === 'pending' ? target.chapterId : null;
    if (canNavigate && target?.status === 'unknown') blocked = true;
    return {
      chapters,
      blocked,
      waiting,
      nextChapterId,
      allCompleted:
        chapters.length > 0 && chapters.every((c) => c.status === 'confirmed') && canNavigate,
    };
  }
}
