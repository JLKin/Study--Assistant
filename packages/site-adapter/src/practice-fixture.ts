import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type {
  PracticeAction,
  PracticeContext,
  PracticeFeedback,
  PracticeQuestion,
  PracticeSiteAdapter,
  PracticeVideo,
} from '../../contracts/src/practice';

export function isStage3FixtureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.pathname === '/stage3-fixture' &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Only this local fixture implements effects. No real-site selectors are invented here. */
export class FixturePracticeSiteAdapter implements PracticeSiteAdapter {
  readonly kind = 'fixture' as const;
  constructor(private readonly page: Page) {}
  async watchManual(signal: AbortSignal, onManual: () => void): Promise<() => Promise<void>> {
    this.check(signal);
    const name = `stage3Manual_${randomUUID().replaceAll('-', '')}`;
    let disposed = false;
    const binding = await this.page.exposeBinding(name, (source) => {
      if (!disposed && source.page === this.page && source.frame === this.page.mainFrame())
        onManual();
    });
    const changed = () => {
      if (!disposed) onManual();
    };
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener('abort', abort);
      this.page.off('framenavigated', changed);
      this.page.off('close', changed);
      await this.page
        .evaluate((key) => {
          const registry = window as unknown as Record<string, (() => void) | undefined>;
          registry[`${key}_dispose`]?.();
          delete registry[`${key}_dispose`];
        }, name)
        .catch(() => undefined);
      await binding.dispose().catch(() => undefined);
    };
    const abort = () => {
      void dispose();
    };
    try {
      signal.throwIfAborted();
      await this.page.evaluate((key) => {
        const registry = window as unknown as Record<string, (() => void) | undefined>;
        const media = document.querySelector('#video');
        const manual = (event: Event) => {
          if (event instanceof KeyboardEvent && ['PageDown', 'PageUp', 'Tab'].includes(event.key))
            return;
          if (event.isTrusted && (event.target as Element).closest('#course')) registry[key]?.();
        };
        const observer = new MutationObserver(() => {
          if (document.querySelector('#video') !== media) registry[key]?.();
        });
        observer.observe(document.querySelector('#course')!, { childList: true, subtree: true });
        document.addEventListener('pointerdown', manual, true);
        document.addEventListener('keydown', manual, true);
        registry[`${key}_dispose`] = () => {
          observer.disconnect();
          document.removeEventListener('pointerdown', manual, true);
          document.removeEventListener('keydown', manual, true);
        };
      }, name);
      this.page.on('framenavigated', changed);
      this.page.on('close', changed);
      signal.addEventListener('abort', abort, { once: true });
      signal.throwIfAborted();
      return dispose;
    } catch (error) {
      await dispose();
      throw error;
    }
  }
  private check(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!isStage3FixtureUrl(this.page.url())) throw new Error('PRACTICE_LOCKED');
  }
  async context(signal: AbortSignal): Promise<PracticeContext> {
    this.check(signal);
    return this.page.evaluate(() => {
      const url = new URL(location.href);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.pathname !== '/stage3-fixture' ||
        url.username ||
        url.password
      )
        throw new Error('PRACTICE_LOCKED');
      const root = document.querySelector<HTMLElement>('#course')!;
      const dialog = document.querySelector<HTMLElement>('#practice')!;
      const safe =
        dialog.dataset.classification === 'non-graded' &&
        dialog.dataset.nonGraded === 'true' &&
        document.querySelector('#scope')?.textContent === '非计分巩固练习，不影响课程成绩' &&
        root.dataset.pageKind === 'course';
      const classification = dialog.dataset.classification;
      return {
        source: 'fixture',
        classification: safe
          ? 'non-graded'
          : classification === 'exam' || classification === 'graded'
            ? classification
            : 'unknown',
        explicitNonGraded: safe,
        authenticated: root.dataset.authenticated === 'true',
        courseId: root.dataset.courseId ?? '',
        popupId: dialog.dataset.popupId ?? '',
        revision: JSON.stringify([
          dialog.dataset.type,
          dialog.dataset.complete,
          document.querySelector('#stem')?.textContent,
          document.querySelector('#options')?.textContent,
          [...document.querySelectorAll<HTMLInputElement>('#options input')].map(
            (input) => input.dataset.optionId,
          ),
          // Pixel identity is transient context only; never write image data to the ledger.
          [...dialog.querySelectorAll<HTMLCanvasElement>(':scope > canvas#ocr-question')].map(
            (canvas) => [canvas.width, canvas.height, canvas.hidden, canvas.toDataURL()],
          ),
        ]),
      };
    });
  }
  async question(signal: AbortSignal): Promise<PracticeQuestion | null> {
    this.check(signal);
    return this.page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('#practice')!;
      return {
        type: dialog.dataset.type as PracticeQuestion['type'],
        stem: document.querySelector('#stem')?.textContent ?? '',
        complete: dialog.dataset.complete === 'true',
        options: [...document.querySelectorAll<HTMLInputElement>('#options input')].map(
          (input) => ({
            id: input.dataset.optionId ?? '',
            text: input.parentElement?.querySelector('span')?.textContent ?? '',
          }),
        ),
      };
    });
  }
  async capture(signal: AbortSignal): Promise<Uint8Array> {
    this.check(signal);
    // A fixture can explicitly supply a question image instead of complete DOM text.
    // Crop that image without relaxing the strict OCR parser or adding real-site selectors.
    const image = this.page.locator('#practice > canvas#ocr-question');
    const count = await image.count();
    signal.throwIfAborted();
    if (count > 1) throw new Error('QUESTION_IMAGE_UNCERTAIN');
    if (count === 1) return image.screenshot({ timeout: 3000 });
    return this.page.locator('#practice').screenshot({ timeout: 3000 });
  }
  async video(signal: AbortSignal): Promise<PracticeVideo> {
    this.check(signal);
    return this.page.evaluate(() => {
      const api = (
        window as unknown as {
          stage3Fixture: { state: { generation: number; manualRevision: number } };
        }
      ).stage3Fixture;
      const media = document.querySelector<HTMLVideoElement>('#video')!;
      return {
        mediaId: media.id,
        generation: api.state.generation,
        manualRevision: api.state.manualRevision,
        paused: media.paused,
      };
    });
  }
  async prepare(
    _action: PracticeAction,
    context: PracticeContext,
    video: PracticeVideo,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.context(signal);
    const media = await this.video(signal);
    if (
      JSON.stringify(current) !== JSON.stringify(context) ||
      media.generation !== video.generation ||
      media.manualRevision !== video.manualRevision ||
      media.mediaId !== video.mediaId
    )
      throw new Error('PRACTICE_CONTEXT_CHANGED');
  }
  async perform(
    action: PracticeAction,
    context: PracticeContext,
    video: PracticeVideo,
    signal: AbortSignal,
  ): Promise<void> {
    this.check(signal);
    // This evaluation checks identity, classification, text, manual intent and budgets in the same page turn as the effect.
    await this.page.evaluate(
      ({ action, context, video }) => {
        // Do not trust a URL check made before the command crossed into the browser.
        const url = new URL(location.href);
        if (
          url.protocol !== 'http:' ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
          url.pathname !== '/stage3-fixture' ||
          url.username ||
          url.password
        )
          throw new Error('PRACTICE_LOCKED');
        const root = document.querySelector<HTMLElement>('#course')!;
        const dialog = document.querySelector<HTMLElement>('#practice')!;
        const media = document.querySelector<HTMLVideoElement>('#video')!;
        const api = (
          window as unknown as {
            stage3Fixture: {
              state: {
                generation: number;
                manualRevision: number;
                submissions: number;
                closes: number;
                restores: number;
                pauses: number;
                receipt: string;
                feedback: string;
              };
              show(): void;
            };
          }
        ).stage3Fixture;
        const state = api.state;
        const inputs = [...document.querySelectorAll<HTMLInputElement>('#options input')];
        const revision = JSON.stringify([
          dialog.dataset.type,
          dialog.dataset.complete,
          document.querySelector('#stem')?.textContent,
          document.querySelector('#options')?.textContent,
          inputs.map((input) => input.dataset.optionId),
          // Keep this synchronous with the effect so changes after prepare cannot slip through.
          [...dialog.querySelectorAll<HTMLCanvasElement>(':scope > canvas#ocr-question')].map(
            (canvas) => [canvas.width, canvas.height, canvas.hidden, canvas.toDataURL()],
          ),
        ]);
        if (
          root.dataset.courseId !== context.courseId ||
          root.dataset.authenticated !== 'true' ||
          root.dataset.pageKind !== 'course' ||
          dialog.dataset.popupId !== context.popupId ||
          dialog.dataset.classification !== 'non-graded' ||
          dialog.dataset.nonGraded !== 'true' ||
          document.querySelector('#scope')?.textContent !== '非计分巩固练习，不影响课程成绩' ||
          revision !== context.revision ||
          media.id !== video.mediaId ||
          state.generation !== video.generation ||
          state.manualRevision !== video.manualRevision
        )
          throw new Error('PRACTICE_CONTEXT_CHANGED');
        if (action.type === 'pause') {
          if (dialog.hidden || state.pauses) throw new Error('PRACTICE_BUDGET');
          state.pauses++;
          media.pause();
        } else if (action.type === 'submit' || action.type === 'correct') {
          if (
            dialog.hidden ||
            (action.type === 'submit'
              ? state.submissions !== 0
              : state.submissions !== 1 || state.feedback !== 'incorrect') ||
            !action.optionIds.length ||
            new Set(action.optionIds).size !== action.optionIds.length ||
            action.optionIds.some(
              (id) => inputs.filter((input) => input.dataset.optionId === id).length !== 1,
            ) ||
            (dialog.dataset.type !== 'multiple' && action.optionIds.length !== 1)
          )
            throw new Error('PRACTICE_BUDGET');
          for (const input of inputs)
            input.checked = action.optionIds.includes(input.dataset.optionId!);
          state.receipt = action.submissionId;
          document.querySelector<HTMLButtonElement>('#submit')!.click();
        } else if (action.type === 'close') {
          if (dialog.hidden || state.closes || !['correct', 'incorrect'].includes(state.feedback))
            throw new Error('FEEDBACK_UNKNOWN');
          document.querySelector<HTMLButtonElement>('#close')!.click();
        } else {
          if (
            !dialog.hidden ||
            !['correct', 'incorrect'].includes(state.feedback) ||
            video.paused ||
            state.restores ||
            state.closes !== 1
          )
            throw new Error('VIDEO_RESTORE_UNSAFE');
          state.restores++;
          api.show();
          return media.play();
        }
        api.show();
      },
      { action, context, video },
    );
  }
  async feedback(signal: AbortSignal): Promise<PracticeFeedback> {
    this.check(signal);
    return this.page.evaluate(() => {
      const state = (
        window as unknown as {
          stage3Fixture: {
            state: { feedback: string; receipt: string; correctTexts: string[] | null };
          };
        }
      ).stage3Fixture.state;
      const visible = document.querySelector('#feedback')?.textContent;
      if (state.feedback === 'correct' && visible === '正确')
        return { status: 'correct', receipt: state.receipt };
      if (state.feedback === 'incorrect' && visible?.startsWith('错误；正确反馈：'))
        return {
          status: 'incorrect',
          receipt: state.receipt,
        };
      return { status: 'unknown' };
    });
  }
  async verify(
    action: PracticeAction,
    _video: PracticeVideo,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.check(signal);
    return this.page.evaluate((type) => {
      const media = document.querySelector<HTMLVideoElement>('#video')!;
      return type === 'pause'
        ? media.paused
        : type === 'close'
          ? document.querySelector<HTMLElement>('#practice')!.hasAttribute('hidden')
          : type === 'restore'
            ? !media.paused
            : false;
    }, action.type);
  }
}

/** A real URL can only receive a read-only locked adapter, irrespective of page appearance. */
export class RestrictedPracticeSiteAdapter implements PracticeSiteAdapter {
  readonly kind = 'real-unverified' as const;
  async context(signal: AbortSignal): Promise<PracticeContext> {
    signal.throwIfAborted();
    return {
      source: this.kind,
      classification: 'unknown',
      explicitNonGraded: false,
      authenticated: false,
      courseId: '',
      popupId: '',
      revision: '',
    };
  }
  async question(): Promise<null> {
    return null;
  }
  async capture(): Promise<Uint8Array> {
    throw new Error('PRACTICE_LOCKED');
  }
  async video(): Promise<PracticeVideo> {
    throw new Error('PRACTICE_LOCKED');
  }
  async prepare(): Promise<void> {
    throw new Error('PRACTICE_LOCKED');
  }
  async perform(): Promise<void> {
    throw new Error('PRACTICE_LOCKED');
  }
  async feedback(): Promise<PracticeFeedback> {
    return { status: 'unknown' };
  }
  async verify(): Promise<boolean> {
    return false;
  }
}
export function practiceAdapterForPage(page: Page): PracticeSiteAdapter {
  return isStage3FixtureUrl(page.url())
    ? new FixturePracticeSiteAdapter(page)
    : new RestrictedPracticeSiteAdapter();
}
