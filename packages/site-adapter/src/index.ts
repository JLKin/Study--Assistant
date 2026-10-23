import type { Page } from 'playwright';
import type { CourseObservation, SiteAdapter } from '../../contracts/src/index';

type ObservationPage = Pick<Page, 'url' | 'locator'>;

function unknownObservation(
  source: CourseObservation['source'],
  evidence: string,
): CourseObservation {
  return {
    courseId: null,
    title: null,
    observedAt: new Date().toISOString(),
    confidence: 'uncertain',
    source,
    authenticated: 'unknown',
    pageKind: 'unknown',
    platformCompleted: null,
    evidence: [evidence],
  };
}

function checkCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function cancellableRead<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new Error('观察已取消'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** 真实站点 DOM 尚未人工核验。此适配器不读取账户、页面正文或凭据。 */
export class UnverifiedSiteAdapter implements SiteAdapter {
  readonly kind = 'real-unverified' as const;

  async inspect(signal?: AbortSignal): Promise<CourseObservation> {
    checkCancelled(signal);
    return unknownObservation(
      this.kind,
      '真实站点尚未验证；请手动登录。阶段 1 不执行网页自动动作。',
    );
  }
}

export function isLocalFixtureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      !url.username &&
      !url.password &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.pathname === '/stage1-fixture'
    );
  } catch {
    return false;
  }
}

/** 只用于本仓库可重复模拟页；其选择器不代表智慧树真实 DOM。 */
export class FixtureSiteAdapter implements SiteAdapter {
  readonly kind = 'fixture' as const;

  constructor(private readonly page: ObservationPage) {}

  async inspect(signal?: AbortSignal): Promise<CourseObservation> {
    checkCancelled(signal);
    const observedUrl = this.page.url();
    if (!isLocalFixtureUrl(observedUrl)) {
      return unknownObservation(this.kind, '模拟适配器仅接受本机 /stage1-fixture 页面。');
    }
    try {
      const raw = await cancellableRead(
        this.page
          .locator('script#stage1-observation[type="application/json"]')
          .textContent({ timeout: 1000 }),
        signal,
      );
      checkCancelled(signal);
      // 导航竞争发生时不将前一页面的观察归到当前页面。
      if (this.page.url() !== observedUrl) {
        return unknownObservation(this.kind, '读取期间页面已离开本机模拟页。');
      }
      const value: unknown = JSON.parse(raw ?? 'null');
      if (!isFixtureData(value)) {
        return unknownObservation(this.kind, '模拟页面契约缺失或无效；不推断课程和完成状态。');
      }
      return {
        courseId: value.pageKind === 'course' ? value.courseId : null,
        title: value.pageKind === 'course' ? value.title : null,
        observedAt: new Date().toISOString(),
        confidence: 'verified',
        source: this.kind,
        authenticated: value.authenticated,
        pageKind: value.pageKind,
        platformCompleted: value.pageKind === 'course' ? value.platformCompleted : null,
        evidence: ['仅本机模拟页：stage1-observation 契约 v1；未验证真实站点。'],
      };
    } catch {
      checkCancelled(signal);
      return unknownObservation(this.kind, '模拟页面读取失败；未执行点击、提交或状态写入。');
    }
  }
}

interface FixtureData {
  schemaVersion: 1;
  courseId: string;
  title: string;
  authenticated: boolean;
  pageKind: 'course' | 'graded' | 'unknown';
  platformCompleted: boolean | null;
}

function isFixtureData(value: unknown): value is FixtureData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return (
    data.schemaVersion === 1 &&
    typeof data.courseId === 'string' &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(data.courseId) &&
    typeof data.title === 'string' &&
    data.title.trim().length > 0 &&
    data.title.length <= 200 &&
    typeof data.authenticated === 'boolean' &&
    ['course', 'graded', 'unknown'].includes(String(data.pageKind)) &&
    (typeof data.platformCompleted === 'boolean' || data.platformCompleted === null)
  );
}

export function adapterForPage(page?: ObservationPage): SiteAdapter {
  return page && isLocalFixtureUrl(page.url())
    ? new FixtureSiteAdapter(page)
    : new UnverifiedSiteAdapter();
}
