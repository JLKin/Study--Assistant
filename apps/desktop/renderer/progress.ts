import type { Dashboard, TaskState } from '../../../packages/contracts/src/index.js';

export interface ProgressSummary {
  videoPercent: number | null;
  videoSummary: string;
  chapterSummary: string;
  platformSummary: string;
  sampleSummary: string;
  taskSummary: string;
  sourceLabel: string;
  sampleState:
    'monitoring' | 'preview' | 'paused' | 'disconnected' | 'stale' | 'restricted' | 'unavailable';
}

const taskLabels: Record<TaskState, string> = {
  IDLE: '未开始',
  WAIT_LOGIN: '等待手动登录',
  COURSE_CONFIRM: '等待确认课程',
  MONITORING: '监测中',
  PRACTICE_ACTIVE: '练习处理中',
  BUFFER_RECOVERY: '缓冲恢复',
  PAUSED: '已暂停',
  RECOVERING: '等待恢复核验',
  STOPPING: '停止中',
  COMPLETED: '任务已停止 / 结束',
  ERROR: '安全锁止',
};

/** Presentation only: no browser reads, polling, commands, or persisted state. */
export function buildProgressSummary(data: Dashboard, now = Date.now()): ProgressSummary {
  const observation = data.monitor?.observation;
  const source = observation?.course.source ?? data.course?.source;
  const summary: ProgressSummary = {
    videoPercent: null,
    videoSummary: '当前视频进度不可用。',
    chapterSummary: '当前章节尚未可靠识别。',
    platformSummary: '尚无可靠的章节平台标记；视频进度不能代替平台完成。',
    sampleSummary: '尚无可用观察样本。',
    taskSummary: `${taskLabels[data.task.state]} · ${data.task.reason}`,
    sourceLabel:
      source === 'fixture'
        ? '本地模拟页；不代表真实站点验收'
        : source === 'zhihuishu-dom'
          ? '真实 DOM；待真实环境人工验收'
          : '未核验页面',
    sampleState: 'unavailable',
  };
  const restricted = [data.course, observation?.course].some((course) =>
    course?.evidence.some((item) => item.startsWith('SITE_AUTOMATION_RESTRICTED：')),
  );
  if (restricted) {
    summary.sampleState = 'restricted';
    summary.sampleSummary = '真实入口已停用；未读取当前站点进度。';
    return summary;
  }
  if (data.browser.state !== 'CONNECTED') {
    summary.sampleState = 'disconnected';
    summary.sampleSummary = '浏览器未连接；无法确认当前进度。';
    return summary;
  }
  if (!observation || !Number.isFinite(now)) return summary;
  const course = observation.course;
  if (
    !data.course ||
    !course.courseId ||
    data.course.courseId !== course.courseId ||
    data.course.source !== course.source ||
    data.course.confidence !== 'verified' ||
    data.course.authenticated !== true ||
    data.course.pageKind !== 'course' ||
    !['fixture', 'zhihuishu-dom'].includes(course.source) ||
    course.confidence !== 'verified' ||
    course.authenticated !== true ||
    course.pageKind !== 'course'
  ) {
    summary.sampleSummary = '课程身份或观察来源不可信，不能确认当前进度。';
    return summary;
  }
  const age = (timestamp: string) => now - Date.parse(timestamp);
  const fresh = (timestamp: string) => {
    const elapsed = age(timestamp);
    return Number.isFinite(elapsed) && elapsed >= -5000 && elapsed <= 30000;
  };
  if (!fresh(course.observedAt) || !fresh(data.course.observedAt)) {
    summary.sampleState = 'stale';
    summary.sampleSummary = '课程样本已过期或时间无效；请重新检查，不能据此确认当前进度。';
    return summary;
  }
  const catalogue = observation.chapters;
  const unique = new Set(catalogue.map((chapter) => chapter.chapterId));
  const currentIndex = catalogue.findIndex(
    (chapter) => chapter.chapterId === observation.currentChapterId,
  );
  if (
    !catalogue.length ||
    catalogue.length > 10000 ||
    unique.size !== catalogue.length ||
    currentIndex < 0 ||
    catalogue.some((chapter) => !chapter.chapterId)
  ) {
    summary.sampleSummary = '章节清单不完整或当前章节不匹配，不能确认当前进度。';
    return summary;
  }
  const current = catalogue[currentIndex];
  if (current.confidence !== 'verified' || !fresh(current.observedAt)) {
    summary.sampleSummary = '当前章节样本不可信或已过期，不能确认当前进度。';
    return summary;
  }
  summary.chapterSummary = `${current.title} · 目录第 ${currentIndex + 1} / ${catalogue.length} 项`;
  let completed = 0;
  let incomplete = 0;
  let unknown = 0;
  for (const chapter of catalogue) {
    if (chapter.confidence !== 'verified' || !fresh(chapter.observedAt)) unknown++;
    else if (chapter.platformCompleted === true) completed++;
    else if (chapter.platformCompleted === false) incomplete++;
    else unknown++;
  }
  summary.platformSummary = `平台标记：完成 ${completed} · 未完成 ${incomplete} · 未知 ${unknown} · 共 ${catalogue.length} 项。视频进度不能代替平台完成。`;
  const player = observation.player;
  if (
    player &&
    player.confidence === 'verified' &&
    player.chapterId === current.chapterId &&
    fresh(player.observedAt) &&
    Number.isFinite(player.currentTime) &&
    player.currentTime >= 0 &&
    Number.isFinite(player.duration) &&
    player.duration > 0 &&
    player.currentTime <= player.duration &&
    Number.isFinite(player.playbackRate) &&
    player.playbackRate > 0 &&
    typeof player.paused === 'boolean' &&
    typeof player.buffering === 'boolean' &&
    typeof player.ended === 'boolean'
  ) {
    // Do not round a not-yet-finished sample up to 100%.
    summary.videoPercent = Math.floor((player.currentTime / player.duration) * 1000) / 10;
    const state = player.ended
      ? '视频已结束'
      : player.paused
        ? '已暂停播放'
        : player.buffering
          ? '缓冲中'
          : '播放中';
    summary.videoSummary = `${player.currentTime.toFixed(1)} / ${player.duration.toFixed(1)} 秒 · 当前视频 ${summary.videoPercent}% · ${player.playbackRate}× · ${state}`;
  } else {
    summary.videoSummary = '播放器样本缺失、过期或与当前章节不匹配；当前视频进度不可用。';
  }
  const time = new Date(course.observedAt).toLocaleTimeString('zh-CN', { hour12: false });
  const elapsed = Math.floor(Math.max(0, age(course.observedAt)) / 1000);
  if (data.task.state === 'MONITORING' && !data.task.cancelled) {
    summary.sampleState = 'monitoring';
    summary.sampleSummary = `监测中 · 最近观察 ${time}（${elapsed} 秒前）；数值来自最近样本。`;
  } else if (data.task.state === 'COURSE_CONFIRM' || data.monitor?.reason.includes('只读预览')) {
    summary.sampleState = 'preview';
    summary.sampleSummary = `单次只读预览 · 观察于 ${time}（${elapsed} 秒前），未持续监测。`;
  } else {
    summary.sampleState = 'paused';
    summary.sampleSummary = `任务未运行 · 最近历史样本 ${time}（${elapsed} 秒前），非实时进度。`;
  }
  return summary;
}
