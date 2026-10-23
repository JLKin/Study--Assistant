import { randomUUID } from 'node:crypto';
import type { Disposable, Page } from 'playwright';

interface ChildArm {
  ordinal: string;
  expiresAt: number;
  consumed: boolean;
  blocked: boolean;
}
interface ChildScope {
  arm: ChildArm | null;
  blocked: boolean;
  mediaError?: boolean;
}
interface ContinuousScope {
  blocked: boolean;
  activeScope: string | null;
  mediaError: boolean;
  expectedInputs: number;
  criticalInputs: number;
  trackedMediaCount: number;
  mediaGeneration: number;
  cleanup: () => void;
}
type GuardMessage = { type: 'authorize'; permit: string } | { type: 'invalidated' };

/** A continuous input latch only. It never issues input, changes media or resets child budgets. */
export class BrowserContinuousInputGuard {
  readonly scopeName = `zhsContinuousScope_${randomUUID().replaceAll('-', '')}`;
  private readonly bindingName = `zhsContinuousInput_${randomUUID().replaceAll('-', '')}`;
  private readonly controller = new AbortController();
  private readonly permits = new Set<string>();
  private readonly abortListeners = new Map<AbortSignal, () => void>();
  private binding: Disposable | null = null;
  private installed = false;
  private installing = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private detachEvents: (() => void) | null = null;

  constructor(
    private readonly page: Page,
    private readonly onInvalidated: () => void,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async install(signal: AbortSignal): Promise<void> {
    this.follow(signal);
    this.requireActive(signal);
    if (this.installed || this.installing) throw new Error('CONTINUOUS_GUARD_ALREADY_INSTALLED');
    this.installing = true;
    const changed = () => this.invalidate();
    const navigated = (frame: ReturnType<Page['mainFrame']>) => {
      if (frame === this.page.mainFrame()) changed();
    };
    this.page.on('framenavigated', navigated);
    this.page.on('dialog', changed);
    this.page.on('close', changed);
    this.page.context().on('page', changed);
    this.detachEvents = () => {
      this.page.off('framenavigated', navigated);
      this.page.off('dialog', changed);
      this.page.off('close', changed);
      this.page.context().off('page', changed);
    };
    try {
      const bindingWork = this.page.exposeBinding(
        this.bindingName,
        (source, message: GuardMessage) => {
          if (source.page !== this.page || source.frame !== this.page.mainFrame()) return false;
          if (message?.type === 'authorize') {
            const granted =
              !this.disposed && !this.signal.aborted && this.permits.delete(message.permit);
            return granted;
          }
          if (message?.type === 'invalidated') this.invalidate();
          return false;
        },
      );
      void bindingWork.then(
        (binding) => {
          if (this.disposed || this.signal.aborted) void settle(binding.dispose());
        },
        () => undefined,
      );
      this.binding = await this.bounded(bindingWork, signal);
      await this.authorized(signal, (permit) =>
        this.page.evaluate(installContinuousScope, {
          scopeName: this.scopeName,
          bindingName: this.bindingName,
          permit,
        }),
      );
      this.requireActive(signal);
      this.installed = true;
      await this.assertActive(signal);
    } catch (error) {
      this.invalidate();
      await this.dispose();
      throw error;
    } finally {
      this.installing = false;
    }
  }

  async attachCandidate(childScopeName: string, signal: AbortSignal): Promise<void> {
    try {
      this.requireInstalled(signal);
      if (!/^zhsCandidateScope_[a-f0-9]{32}$/u.test(childScopeName))
        throw new Error('CONTINUOUS_CHILD_SCOPE_INVALID');
      await this.authorized(signal, (permit) =>
        this.page.evaluate(
          async (request) => {
            const scopes = window as unknown as Record<string, unknown>;
            const authorize = scopes[request.bindingName] as
              ((message: GuardMessage) => Promise<boolean>) | undefined;
            if (!authorize || !(await authorize({ type: 'authorize', permit: request.permit })))
              throw new Error('CONTINUOUS_GUARD_AUTHORIZATION_EXPIRED');
            const scope = scopes[request.scopeName] as ContinuousScope | undefined;
            const child = scopes[request.childScopeName] as ChildScope | undefined;
            if (
              !scope ||
              scope.blocked ||
              scope.mediaError ||
              scope.activeScope !== null ||
              !child ||
              child.arm !== null ||
              child.blocked ||
              child.mediaError
            )
              throw new Error('CONTINUOUS_CHILD_ATTACH_UNSAFE');
            scope.activeScope = request.childScopeName;
          },
          { scopeName: this.scopeName, bindingName: this.bindingName, childScopeName, permit },
        ),
      );
      await this.assertActive(signal);
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }

  async releaseCandidate(childScopeName: string): Promise<void> {
    if (this.disposed || !this.installed) throw new Error('CONTINUOUS_GUARD_UNAVAILABLE');
    try {
      await this.bounded(
        this.page.evaluate(
          ({ scopeName, childScopeName }) => {
            const scope = (window as unknown as Record<string, ContinuousScope | undefined>)[
              scopeName
            ];
            if (!scope || scope.activeScope !== childScopeName)
              throw new Error('CONTINUOUS_CHILD_RELEASE_MISMATCH');
            scope.activeScope = null;
          },
          { scopeName: this.scopeName, childScopeName },
        ),
        undefined,
        true,
      );
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }

  async assertActive(signal: AbortSignal): Promise<void> {
    try {
      this.requireInstalled(signal);
      const active = await this.bounded(
        this.page.evaluate((scopeName) => {
          const scope = (window as unknown as Record<string, ContinuousScope | undefined>)[
            scopeName
          ];
          if (!scope || scope.blocked || scope.mediaError) return false;
          if (scope.activeScope === null) return true;
          const child = (window as unknown as Record<string, ChildScope | undefined>)[
            scope.activeScope
          ];
          return !!child && !child.blocked && !child.mediaError;
        }, this.scopeName),
        signal,
      );
      this.requireActive(signal);
      if (!active) throw new Error('CONTINUOUS_GUARD_BLOCKED');
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce();
    return this.disposal;
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    this.installed = false;
    this.permits.clear();
    this.detachEvents?.();
    this.detachEvents = null;
    for (const [signal, listener] of this.abortListeners)
      signal.removeEventListener('abort', listener);
    this.abortListeners.clear();
    if (!this.signal.aborted) this.controller.abort(new Error('CONTINUOUS_GUARD_DISPOSED'));
    const binding = this.binding;
    this.binding = null;
    await Promise.all([
      settle(
        this.page.evaluate((scopeName) => {
          const scopes = window as unknown as Record<string, ContinuousScope | undefined>;
          scopes[scopeName]?.cleanup();
          delete scopes[scopeName];
        }, this.scopeName),
      ),
      binding ? settle(binding.dispose()) : Promise.resolve(),
    ]);
  }

  private follow(signal: AbortSignal): void {
    if (this.disposed) throw new Error('CONTINUOUS_GUARD_UNAVAILABLE');
    if (!this.abortListeners.has(signal)) {
      const listener = () => this.invalidate();
      this.abortListeners.set(signal, listener);
      signal.addEventListener('abort', listener, { once: true });
    }
    if (signal.aborted) this.invalidate();
  }

  private requireActive(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    this.signal.throwIfAborted();
    if (this.disposed || this.page.isClosed()) throw new Error('CONTINUOUS_GUARD_UNAVAILABLE');
  }

  private requireInstalled(signal: AbortSignal): void {
    this.requireActive(signal);
    if (!this.installed) throw new Error('CONTINUOUS_GUARD_NOT_INSTALLED');
  }

  private invalidate(): void {
    if (this.signal.aborted) return;
    this.permits.clear();
    this.controller.abort(new Error('CONTINUOUS_GUARD_INVALIDATED'));
    // The Node latch is synchronous; the DOM latch closes even when an operation was cancelled.
    void settle(
      this.page.evaluate((scopeName) => {
        const scope = (window as unknown as Record<string, ContinuousScope | undefined>)[scopeName];
        if (scope) scope.blocked = true;
      }, this.scopeName),
    );
    try {
      this.onInvalidated();
    } catch {
      /* The permanent latch is already closed. */
    }
  }

  private async authorized<T>(
    signal: AbortSignal,
    operation: (permit: string) => Promise<T>,
  ): Promise<T> {
    const permit = randomUUID();
    this.permits.add(permit);
    const work = operation(permit);
    // Delayed evaluation may settle after cancellation; it must not leave orphaned listeners.
    const settled = () => {
      if (this.disposed || this.signal.aborted)
        void settle(
          this.page.evaluate((scopeName) => {
            const scopes = window as unknown as Record<string, ContinuousScope | undefined>;
            scopes[scopeName]?.cleanup();
            delete scopes[scopeName];
          }, this.scopeName),
        );
    };
    void work.then(settled, settled);
    try {
      return await this.bounded(work, signal);
    } finally {
      this.permits.delete(permit);
    }
  }

  private bounded<T>(work: Promise<T>, signal?: AbortSignal, allowInvalidated = false): Promise<T> {
    if (!allowInvalidated) this.requireActive(signal);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, value?: T) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        this.signal.removeEventListener('abort', invalidated);
        if (error) reject(error);
        else resolve(value as T);
      };
      const aborted = () => finish(signal?.reason ?? new Error('CONTINUOUS_GUARD_CANCELLED'));
      const invalidated = () => finish(this.signal.reason);
      const timer = setTimeout(() => {
        this.invalidate();
        finish(new Error('CONTINUOUS_GUARD_PAGE_TIMEOUT'));
      }, 3000);
      signal?.addEventListener('abort', aborted, { once: true });
      if (!allowInvalidated) this.signal.addEventListener('abort', invalidated, { once: true });
      if (signal?.aborted) aborted();
      else if (!allowInvalidated && this.signal.aborted) invalidated();
      work.then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });
  }
}

function settle(work: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    work.then(finish, finish);
  });
}

async function installContinuousScope(request: {
  scopeName: string;
  bindingName: string;
  permit: string;
}) {
  const scopes = window as unknown as Record<string, unknown>;
  const authorize = scopes[request.bindingName] as
    ((message: GuardMessage) => Promise<boolean>) | undefined;
  if (!authorize || !(await authorize({ type: 'authorize', permit: request.permit })))
    throw new Error('CONTINUOUS_GUARD_AUTHORIZATION_EXPIRED');
  if (scopes[request.scopeName]) throw new Error('CONTINUOUS_GUARD_SCOPE_EXISTS');
  const scope: ContinuousScope = {
    blocked: false,
    activeScope: null,
    mediaError: false,
    expectedInputs: 0,
    criticalInputs: 0,
    trackedMediaCount: 0,
    mediaGeneration: 0,
    cleanup: () => undefined,
  };
  const trackedMedia = new Set<HTMLVideoElement>();
  const acceptedArms = new WeakSet<ChildArm>();
  let observedMedia: HTMLVideoElement | null = null;
  const notify = () => {
    const listener = scopes[request.bindingName] as
      ((message: GuardMessage) => Promise<boolean>) | undefined;
    void listener?.({ type: 'invalidated' }).catch(() => undefined);
  };
  const block = () => {
    if (scope.blocked) return;
    scope.blocked = true;
    notify();
  };
  const mediaError = (event: Event) => {
    if (
      !event.isTrusted ||
      !(event.target instanceof HTMLVideoElement) ||
      !(trackedMedia.has(event.target) || event.target.id === 'vjs_container_html5_api')
    )
      return;
    scope.mediaError = true;
    block();
  };
  const watchMedia = (media: HTMLVideoElement) => {
    if (!trackedMedia.has(media)) {
      trackedMedia.add(media);
      scope.trackedMediaCount = trackedMedia.size;
      media.addEventListener('error', mediaError);
    }
    if (media.error) {
      scope.mediaError = true;
      block();
    }
  };
  const hasActiveChild = () => {
    const child = scope.activeScope
      ? (scopes[scope.activeScope] as ChildScope | undefined)
      : undefined;
    return !!child && !child.blocked && !child.mediaError;
  };
  const currentMedia = () => {
    const matches = document.querySelectorAll('video#vjs_container_html5_api');
    return matches.length === 1 && matches[0] instanceof HTMLVideoElement ? matches[0] : null;
  };
  const mediaChanged = (event: Event) => {
    if (
      !event.isTrusted ||
      !(event.target instanceof HTMLVideoElement) ||
      event.target.id !== 'vjs_container_html5_api'
    )
      return;
    watchMedia(event.target);
    scope.mediaGeneration++;
    observedMedia = currentMedia();
    if (!hasActiveChild()) block();
  };
  const nodesChanged = new MutationObserver(() => {
    const current = currentMedia();
    if (current === observedMedia) return;
    observedMedia = current;
    scope.mediaGeneration++;
    if (current) watchMedia(current);
    if (!hasActiveChild()) block();
  });
  const manual = (event: Event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    if (
      event instanceof KeyboardEvent &&
      ![
        ' ',
        'Enter',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'k',
        'j',
        'l',
        '+',
        '-',
      ].includes(event.key)
    )
      return;
    if (
      !(event instanceof KeyboardEvent) &&
      !event.target.closest(
        '#vjs_container,.videoArea,.speedBox,.chapterScrollbar li,.el-dialog__wrapper,[role="dialog"]',
      )
    )
      return;
    const child = scope.activeScope
      ? (scopes[scope.activeScope] as ChildScope | undefined)
      : undefined;
    const arm = child?.arm;
    const target = event.target.closest('.catalogue_title');
    const row = target?.closest('li.video');
    if (
      !scope.blocked &&
      !scope.mediaError &&
      child &&
      !child.blocked &&
      !child.mediaError &&
      arm &&
      !arm.consumed &&
      !arm.blocked &&
      !acceptedArms.has(arm) &&
      performance.now() <= arm.expiresAt &&
      event instanceof PointerEvent &&
      event.type === 'pointerdown' &&
      event.button === 0 &&
      event.isPrimary &&
      target &&
      row?.querySelector('.hour')?.textContent?.trim() === arm.ordinal &&
      target.closest('.video-study') &&
      document.querySelectorAll('.video-study').length === 1
    ) {
      acceptedArms.add(arm);
      scope.expectedInputs++;
      return; // The child installed later consumes its own narrow permit; the outer guard never arms.
    }
    scope.criticalInputs++;
    block();
  };
  document.addEventListener('pointerdown', manual, true);
  document.addEventListener('keydown', manual, true);
  document.addEventListener('error', mediaError, true);
  document.addEventListener('loadstart', mediaChanged, true);
  document.addEventListener('loadedmetadata', mediaChanged, true);
  scope.cleanup = () => {
    scope.blocked = true;
    scope.activeScope = null;
    document.removeEventListener('pointerdown', manual, true);
    document.removeEventListener('keydown', manual, true);
    document.removeEventListener('error', mediaError, true);
    document.removeEventListener('loadstart', mediaChanged, true);
    document.removeEventListener('loadedmetadata', mediaChanged, true);
    nodesChanged.disconnect();
    trackedMedia.forEach((media) => media.removeEventListener('error', mediaError));
    trackedMedia.clear();
    scope.trackedMediaCount = 0;
    observedMedia = null;
  };
  scopes[request.scopeName] = scope;
  for (const media of document.querySelectorAll('video#vjs_container_html5_api'))
    if (media instanceof HTMLVideoElement) watchMedia(media);
  observedMedia = currentMedia();
  nodesChanged.observe(document.documentElement, { childList: true, subtree: true });
}
