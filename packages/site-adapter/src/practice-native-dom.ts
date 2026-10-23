import type {
  PracticeAction,
  PracticeContext,
  PracticeFeedback,
  PracticeQuestion,
  PracticeVideo,
} from '../../contracts/src/practice';
import type { NativeQuestionLayout } from '../../practice/src/native-question';
import type { PracticeStopReason } from './practice-diagnostics';

export interface NativePracticeRequest {
  mode:
    | 'arm'
    | 'sample'
    | 'action'
    | 'feedback'
    | 'dispose'
    | 'input-arm'
    | 'input-validate'
    | 'input-commit'
    | 'input-finish'
    | 'input-clear'
    | 'input-cancel';
  key: string;
  binding: string;
  url: string;
  courseId: string;
  grantId: string;
  expiresAt: number;
  allowExistingFeedback?: boolean;
  action?: PracticeAction;
  context?: PracticeContext;
  video?: PracticeVideo;
  inputPart?: 'option' | 'submit' | 'close';
  inputToken?: string;
  /** Page-local only: never sent from Node or stored in the ledger. */
  inputEvent?: Event;
}
export interface NativePracticeSample {
  context: PracticeContext;
  question: PracticeQuestion | null;
  layout: NativeQuestionLayout | null;
  video: PracticeVideo;
  title: string;
  feedback: PracticeFeedback;
  verified: boolean;
  feedbackPending?: boolean;
  inputConfirmed?: boolean;
  closePending?: boolean;
  requiresSubmit?: boolean;
  captureClip?: { x: number; y: number; width: number; height: number };
}
interface NativeState {
  key: string;
  grantId: string;
  expiresAt: number;
  media: HTMLVideoElement;
  src: string;
  lesson: string;
  originalPaused: boolean;
  blocked: boolean;
  popup: Element | null;
  saved: PracticeContext | null;
  submissions: number;
  paused: boolean;
  closed: boolean;
  closeVerified: boolean;
  closeUntil: number;
  closingMasks: Element[];
  restored: boolean;
  receipt: string;
  allowExistingFeedback: boolean;
  existingFeedback: 'correct' | 'incorrect' | null;
  submitFooterIssued: boolean;
  input: {
    token: string;
    part: 'option' | 'submit' | 'close';
    target: HTMLElement;
    action: PracticeAction;
    context: PracticeContext;
    video: PracticeVideo;
    expiresAt: number;
    pointerSeen: boolean;
    consumed: boolean;
  } | null;
  interaction: 'boolean-submit' | 'option-click' | null;
  dispose: () => void;
}

/** One page-side function owns sampling and final synchronous checks. Never serialize its state. */
export function nativePracticeDom(
  request: NativePracticeRequest,
): NativePracticeSample | null | Promise<NativePracticeSample> {
  const registry = window as unknown as Record<string, unknown>;
  let state = registry[request.key] as NativeState | undefined;
  if (request.mode === 'dispose') {
    state?.dispose();
    return null;
  }
  if (request.mode === 'input-cancel') {
    if (state) state.blocked = true;
    return null;
  }
  if (request.mode === 'input-clear') {
    if (state?.input && state.input.token === request.inputToken) state.input = null;
    return null;
  }
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '');
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    );
  };
  let phase: PracticeStopReason = 'DOM_ROUTE_CHECK';
  const fail: () => never = () => {
    throw new Error(`NATIVE_PRACTICE_CONTEXT_CHANGED:${phase}`);
  };
  const url = new URL(location.href);
  if (
    url.origin !== 'https://studyvideoh5.zhihuishu.com' ||
    url.pathname !== '/stuStudy' ||
    url.hash ||
    url.username ||
    url.password ||
    location.href !== request.url ||
    [...url.searchParams.keys()].length !== 1 ||
    url.searchParams.getAll('recruitAndCourseId').length !== 1 ||
    Date.now() >= request.expiresAt
  )
    fail();
  phase = 'DOM_MEDIA_CHECK';
  const roots = document.querySelectorAll('.video-study');
  if (roots.length !== 1 || document.querySelectorAll('video').length !== 1) fail();
  const root = roots[0];
  const media = root.querySelector('video#vjs_container_html5_api');
  const heading = root.querySelector('.source-name')?.textContent?.trim() ?? '';
  const lesson = root.querySelector('#lessonOrder')?.textContent?.trim() ?? '';
  if (
    !(media instanceof HTMLVideoElement) ||
    !heading ||
    heading.length > 200 ||
    !lesson ||
    root.querySelectorAll('.header_userInfo').length !== 1 ||
    !visible(root.querySelector('.header_userInfo')!) ||
    root.querySelectorAll('.userLinks .iconheiyemoshi-anquantuichu').length !== 1 ||
    !media.currentSrc ||
    media.readyState < 2 ||
    !Number.isFinite(media.duration) ||
    media.duration <= 0 ||
    media.error
  )
    fail();
  const video = media as HTMLVideoElement;
  phase = 'DOM_ALERT_CHECK';
  const alerts = [
    ...document.querySelectorAll(
      '[role="alert"],.el-message,.el-notification,.el-message-box__wrapper',
    ),
  ].filter(visible);
  if (
    alerts.some((element) =>
      /检测.{0,20}(脚本|插件)|(?:脚本|插件).{0,20}(?:执行|检测|异常|禁止)/u.test(
        element.textContent ?? '',
      ),
    )
  )
    fail();
  // Any other visible alert requires manual review too; never click through a new prompt.
  if (alerts.length) fail();
  phase = 'DOM_DIALOG_CHECK';
  const candidates = [
    ...document.querySelectorAll(
      '.el-dialog__wrapper,[role="dialog"],[aria-modal="true"],.ep-overlay-dialog',
    ),
  ].filter(visible);
  const dialogs = [...document.querySelectorAll('.el-dialog__wrapper.dialog-test')].filter(visible);
  const backdrops = [...document.querySelectorAll('.v-modal')].filter(visible);
  // Only the just-consumed close input may observe its original nodes leaving.
  // A new prompt/backdrop or any other request keeps the normal strict checks.
  const closeInFlight =
    request.mode === 'input-finish' &&
    state?.closed === true &&
    !state.closeVerified &&
    state.input?.part === 'close' &&
    state.input.consumed &&
    state.input.token === request.inputToken;
  const closePending = closeInFlight && (candidates.length > 0 || backdrops.length > 0);
  if (
    closeInFlight &&
    ((closePending && performance.now() > state!.closeUntil) ||
      !state!.popup ||
      candidates.some((e) => e !== state!.popup && !state!.popup!.contains(e)) ||
      dialogs.some((e) => e !== state!.popup) ||
      backdrops.some((e) => !state!.closingMasks.includes(e)))
  )
    fail();
  if (
    [...document.querySelectorAll('.mask,iframe[src*="captcha.gtimg.com"]')].some(visible) ||
    (!closeInFlight && dialogs.length !== 1 && backdrops.length > 0)
  )
    fail();
  if (request.mode === 'arm') {
    if (state || registry.stage3NativePracticeOwner || candidates.length || dialogs.length) fail();
    const stored: NativeState = {
      key: request.key,
      grantId: request.grantId,
      expiresAt: request.expiresAt,
      media: video,
      src: video.currentSrc,
      lesson,
      originalPaused: video.paused,
      blocked: false,
      popup: null,
      saved: null,
      submissions: 0,
      paused: false,
      closed: false,
      closeVerified: false,
      closeUntil: 0,
      closingMasks: [],
      restored: false,
      receipt: '',
      allowExistingFeedback: request.allowExistingFeedback === true,
      existingFeedback: null,
      submitFooterIssued: false,
      input: null,
      interaction: null,
      dispose: () => undefined,
    };
    const invalidate = (reason: PracticeStopReason) => {
      if (stored.blocked) return;
      stored.blocked = true;
      const notify = registry[request.binding] as
        ((reason: PracticeStopReason) => Promise<unknown>) | undefined;
      void notify?.(reason).catch(() => undefined);
    };
    const manual = (event: Event) => {
      if (event instanceof KeyboardEvent && ['PageDown', 'PageUp', 'Tab'].includes(event.key))
        return;
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const input = stored.input;
      if (
        input?.pointerSeen &&
        !input.consumed &&
        event.type === 'click' &&
        !input.target.contains(event.target)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        invalidate('INPUT_RETARGETED');
        return;
      }
      if (
        input &&
        input.target.contains(event.target) &&
        ['pointerdown', 'click'].includes(event.type)
      ) {
        try {
          if (stored.blocked || input.consumed) throw new Error('NATIVE_INPUT_CONSUMED');
          nativePracticeDom({
            ...request,
            mode: event.type === 'pointerdown' ? 'input-validate' : 'input-commit',
            action: input.action,
            context: input.context,
            video: input.video,
            inputToken: input.token,
            inputPart: input.part,
            inputEvent: event,
          });
          return;
        } catch {
          // Keep this latch until the in-flight browser command settles; a late
          // expected command must not reach a changed/disabled/graded target.
          event.preventDefault();
          event.stopImmediatePropagation();
          invalidate('INPUT_GUARD_FAILED');
          return;
        }
      }
      if (event.target.closest('.video-study,.dialog-test')) invalidate('PAGE_INPUT');
    };
    const observer = new MutationObserver(() => {
      if (document.querySelector('#vjs_container_html5_api') !== video)
        invalidate('MEDIA_NODE_CHANGED');
      else if (video.currentSrc !== stored.src) invalidate('MEDIA_SOURCE_CHANGED');
      else if (root.querySelector('#lessonOrder')?.textContent?.trim() !== stored.lesson)
        invalidate('LESSON_CHANGED');
    });
    observer.observe(root, { childList: true, subtree: true });
    document.addEventListener('pointerdown', manual, true);
    document.addEventListener('click', manual, true);
    document.addEventListener('keydown', manual, true);
    const emptied = () => invalidate('MEDIA_EMPTIED');
    const loadstart = () => invalidate('MEDIA_LOADSTART');
    const ratechange = () => invalidate('MEDIA_RATECHANGE');
    video.addEventListener('emptied', emptied);
    video.addEventListener('loadstart', loadstart);
    video.addEventListener('ratechange', ratechange);
    const timer = setTimeout(
      () => {
        invalidate('PAGE_GRANT_EXPIRED');
        // An already-issued browser input must still meet the blocked capture
        // latch. Node cleanup releases it after that bounded command settles.
        if (!stored.input) stored.dispose();
      },
      Math.max(0, request.expiresAt - Date.now()),
    );
    stored.dispose = () => {
      stored.blocked = true;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('pointerdown', manual, true);
      document.removeEventListener('click', manual, true);
      document.removeEventListener('keydown', manual, true);
      video.removeEventListener('emptied', emptied);
      video.removeEventListener('loadstart', loadstart);
      video.removeEventListener('ratechange', ratechange);
      delete registry[request.key];
      if (registry.stage3NativePracticeOwner === request.key)
        delete registry.stage3NativePracticeOwner;
    };
    registry[request.key] = stored;
    registry.stage3NativePracticeOwner = request.key;
    state = stored;
  }
  phase = 'DOM_STATE_CHECK';
  if (
    !state ||
    state.blocked ||
    state.grantId !== request.grantId ||
    state.expiresAt !== request.expiresAt ||
    state.allowExistingFeedback !== (request.allowExistingFeedback === true) ||
    state.media !== video ||
    state.src !== video.currentSrc ||
    state.lesson !== lesson
  )
    fail();
  const current = state!;
  const mediaState: PracticeVideo = {
    mediaId: video.id,
    generation: 0,
    manualRevision: 0,
    paused: current.originalPaused,
  };
  let question: PracticeQuestion | null = null;
  let layout: NativeQuestionLayout | null = null;
  let captureClip: NativePracticeSample['captureClip'];
  let context: PracticeContext = current.saved ?? {
    source: 'zhihuishu-verified',
    authorizationId: request.grantId,
    classification: 'unknown',
    explicitNonGraded: false,
    authenticated: true,
    courseId: request.courseId,
    popupId: request.key,
    revision: '',
  };
  let footer: HTMLElement | null = null;
  let correct = false;
  let incorrect = false;
  let feedbackMarkup = false;
  if (!current.closed && dialogs.length === 1) {
    const dialog = dialogs[0];
    if (
      candidates.some((element) => element !== dialog && !dialog.contains(element)) ||
      (current.popup && current.popup !== dialog)
    )
      fail();
    const headers = dialog.querySelectorAll(':scope > .el-dialog > .el-dialog__header');
    phase = 'DOM_NOTE_CHECK';
    const note = '弹题是为了帮助同学们巩固知识点，不会影响到大家作业和考试的成绩。';
    if (
      headers.length !== 1 ||
      headers[0].querySelectorAll('p').length !== 1 ||
      headers[0].querySelectorAll('h4').length !== 1 ||
      !visible(headers[0].querySelector('p')!) ||
      !visible(headers[0].querySelector('h4')!) ||
      normalize(headers[0].querySelector('p')?.textContent ?? '') !== normalize(note) ||
      normalize(headers[0].querySelector('h4')?.textContent ?? '') !==
        normalize('AI助教小智给你出题啦！学习过程中有问题，随时点我') ||
      dialog.querySelector('iframe,img,canvas') ||
      (!['feedback', 'input-finish'].includes(request.mode) &&
        [...dialog.querySelectorAll('.el-loading-mask')].some(visible))
    )
      fail();
    phase = 'DOM_QUESTION_CHECK';
    const titles = dialog.querySelectorAll('.topic-title');
    const marker = titles[0]?.querySelector('.title-tit');
    const stem = marker?.nextElementSibling;
    const ordinals = dialog.querySelectorAll('.el-pager .number.active');
    const ordinalText = ordinals[0]?.textContent?.trim() ?? '';
    const markerText = marker?.textContent ?? '';
    const typeMarker = normalize(markerText).match(
      /^(?:(\d{1,3})[.、]?)?[【[(]?(判断题|多选题|单选题)[】\])]?$/u,
    );
    const type =
      typeMarker && (!typeMarker[1] || Number(typeMarker[1]) === Number(ordinalText))
        ? ({ 判断题: 'boolean', 多选题: 'multiple', 单选题: 'single' } as const)[
            typeMarker[2] as '判断题'
          ]
        : null;
    const items = [...dialog.querySelectorAll('.topic-list > li.topic-item')];
    const options = items.map((item) => ({
      id:
        (item.querySelector('.topic-option-item')?.textContent?.trim() ?? '').match(
          /^([A-Z])[\s.)、．:：]*$/,
        )?.[1] ?? '',
      text: item.querySelector('.item-topic')?.textContent?.trim() ?? '',
    }));
    const complete =
      titles.length === 1 &&
      !!marker &&
      stem?.tagName === 'SPAN' &&
      !!type &&
      items.length >= 2 &&
      items.length <= 10 &&
      items.every(
        (item, i) =>
          visible(item) &&
          item.querySelectorAll('.topic-option-item').length === 1 &&
          item.querySelectorAll('.item-topic').length === 1 &&
          options[i].id === String.fromCharCode(65 + i),
      );
    if (type) question = { type, stem: stem?.textContent?.trim() ?? '', options, complete };
    const bodies = dialog.querySelectorAll(':scope > .el-dialog > .el-dialog__body');
    const box = bodies[0]?.getBoundingClientRect();
    const fits = (element: Element) => {
      const r = element.getBoundingClientRect();
      return (
        !!box &&
        visible(element) &&
        r.top >= box.top - 1 &&
        r.bottom <= box.bottom + 1 &&
        r.left >= box.left - 1 &&
        r.right <= box.right + 1
      );
    };
    const footerNodes = dialog.querySelectorAll('.el-dialog__footer .btn');
    if (footerNodes.length === 1) footer = footerNodes[0] as HTMLElement;
    if (!footer || !visible(footer)) fail();
    const footerLabel = footer!.textContent?.trim();
    const extraTitleNodes =
      titles.length === 1
        ? [...titles[0].children].filter((element) => element !== marker && element !== stem)
        : [];
    feedbackMarkup = extraTitleNodes.some(
      (element) =>
        element.children.length > 0 ||
        !!element.textContent?.trim() ||
        !element.matches('span.right'),
    );
    const icons = dialog.querySelectorAll('.topic-title span.right i.iconzhengque1');
    const correctNode = extraTitleNodes[0];
    const nestedCorrect = correctNode?.firstElementChild;
    // Real 9.2.1 wraps the visible block feedback in a boxless inline SPAN.
    // Accept only this observed shape; the current receipt still binds it.
    const nestedCorrectMarkup =
      correctNode?.tagName === 'SPAN' &&
      correctNode.classList.length === 0 &&
      correctNode.children.length === 1 &&
      nestedCorrect?.matches('span.right') &&
      nestedCorrect.classList.length === 1 &&
      visible(nestedCorrect) &&
      nestedCorrect.children.length === 1 &&
      nestedCorrect.firstElementChild === icons[0] &&
      icons[0]?.matches('i.iconfont.iconzhengque1') &&
      icons[0].classList.length === 2 &&
      icons[0].children.length === 0 &&
      !icons[0].textContent?.trim() &&
      normalize(correctNode.textContent ?? '') === '正确' &&
      normalize(nestedCorrect.textContent ?? '') === '正确' &&
      !dialog.querySelector('.topic-title i.iconcuowu1');
    correct =
      icons.length === 1 &&
      visible(icons[0]) &&
      extraTitleNodes.length === 1 &&
      ((correctNode.matches('span.right') && correctNode.querySelectorAll('i').length === 1) ||
        nestedCorrectMarkup === true) &&
      footerLabel === '关闭' &&
      !footer!.hasAttribute('disabled') &&
      footer!.getAttribute('aria-disabled') !== 'true' &&
      ![...dialog.querySelectorAll('.el-loading-mask')].some(visible);
    // Observed wrong feedback uses a classless SPAN, either with a direct icon
    // or one visible SPAN.error wrapping the exact label/icon (real 9.1.1).
    // The outer inline wrapper may have no box around its block child.
    // Receipt/context checks still bind either shape to this issue.
    const wrongIcons = dialog.querySelectorAll('.topic-title i.iconfont.iconcuowu1');
    const wrongNode = extraTitleNodes[0];
    const nestedWrong = wrongNode?.firstElementChild;
    const wrongContent =
      wrongNode?.children.length === 1 &&
      nestedWrong?.matches('span.error') &&
      nestedWrong.classList.length === 1 &&
      visible(nestedWrong) &&
      normalize(wrongNode.textContent ?? '') === normalize(nestedWrong.textContent ?? '')
        ? nestedWrong
        : wrongNode;
    incorrect =
      icons.length === 0 &&
      wrongIcons.length === 1 &&
      visible(wrongIcons[0]) &&
      extraTitleNodes.length === 1 &&
      wrongNode.tagName === 'SPAN' &&
      wrongNode.classList.length === 0 &&
      wrongNode.children.length === 1 &&
      wrongContent.children.length === 1 &&
      wrongContent.firstElementChild === wrongIcons[0] &&
      wrongIcons[0].classList.length === 2 &&
      wrongIcons[0].children.length === 0 &&
      !wrongIcons[0].textContent?.trim() &&
      normalize(wrongNode.textContent ?? '') === '错误' &&
      footerLabel === '关闭' &&
      !footer!.hasAttribute('disabled') &&
      footer!.getAttribute('aria-disabled') !== 'true' &&
      ![...dialog.querySelectorAll('.el-loading-mask')].some(visible);
    if (
      !current.receipt &&
      current.allowExistingFeedback &&
      (feedbackMarkup || current.existingFeedback)
    ) {
      const observed =
        correct && nestedCorrectMarkup === true
          ? 'correct'
          : incorrect && wrongContent !== wrongNode
            ? 'incorrect'
            : null;
      if (
        !observed ||
        !question?.complete ||
        !['boolean', 'single'].includes(question.type) ||
        question.stem.trim().length < 4 ||
        question.stem.length > 2000 ||
        !question.options.every((option) => !!option.text.trim() && option.text.length <= 500) ||
        new Set(question.options.map((option) => normalize(option.text))).size !==
          question.options.length ||
        bodies.length !== 1 ||
        !fits(titles[0]) ||
        !items.every(fits) ||
        (question.type === 'boolean' &&
          ![
            ['对', '错'],
            ['正确', '错误'],
          ].some((pair) =>
            pair.every((text) =>
              question!.options.some((option) => normalize(option.text) === text),
            ),
          )) ||
        (question.type === 'boolean'
          ? question.options.length !== 2
          : question.options.length !== 4) ||
        current.submissions ||
        current.interaction ||
        (current.saved && !current.existingFeedback) ||
        (current.existingFeedback && current.existingFeedback !== observed)
      )
        fail();
      current.existingFeedback = observed;
    } else if (!current.receipt) {
      const selectedOrDisabled = items.some(
        (item) =>
          item.matches(
            '.selected,.active,.is-checked,.right,.wrong,[aria-selected="true"],[aria-checked="true"],[aria-disabled="true"],[disabled]',
          ) ||
          !!item.querySelector(
            'input:checked,[aria-selected="true"],[aria-checked="true"],[aria-disabled="true"],[disabled]',
          ),
      );
      if (feedbackMarkup || icons.length || selectedOrDisabled || !question?.complete) fail();
      const boolean =
        question!.type === 'boolean' &&
        question!.options.length === 2 &&
        [
          ['对', '错'],
          ['正确', '错误'],
        ].some((pair) =>
          pair.every((text) => question!.options.some((option) => option.text === text)),
        );
      const clickOptions =
        question!.stem.trim().length >= 4 &&
        question!.stem.length <= 2000 &&
        question!.options.every((option) => !!option.text.trim() && option.text.length <= 500) &&
        items.every((item) => {
          let children = [...item.children];
          if (children.length === 3) {
            // Observed unanswered native slot: zero-sized DIV containing only
            // the known local SVG icon. Other icons/states remain unverified.
            const slot = children[0],
              svg = slot.firstElementChild,
              use = svg?.firstElementChild,
              slotBox = slot.getBoundingClientRect();
            if (
              slot.tagName !== 'DIV' ||
              slot.classList.length ||
              slot.children.length !== 1 ||
              slot.textContent?.trim() ||
              visible(slot) ||
              (slotBox.width !== 0 && slotBox.height !== 0) ||
              svg?.localName !== 'svg' ||
              svg.classList.length !== 2 ||
              !svg.matches('.icon.topic-option') ||
              svg.getAttribute('aria-hidden') !== 'true' ||
              svg.children.length !== 1 ||
              use?.localName !== 'use' ||
              use.children.length ||
              use.classList.length ||
              use.textContent?.trim() ||
              use.hasAttribute('href') ||
              use.getAttributeNS('http://www.w3.org/1999/xlink', 'href') !== '#iconxuan'
            )
              return false;
            children = children.slice(1);
          }
          return (
            item.classList.length === 1 &&
            item.classList.contains('topic-item') &&
            children.length === 2 &&
            children[0].matches('.topic-option-item') &&
            children[1].matches('.item-topic')
          );
        }) &&
        new Set(question!.options.map((option) => normalize(option.text))).size ===
          question!.options.length;
      const single = question!.type === 'single' && question!.options.length === 4;
      const interaction =
        boolean && footerLabel === '提交'
          ? 'boolean-submit'
          : (boolean || single) && clickOptions && footerLabel === '关闭'
            ? 'option-click'
            : null;
      if (!interaction || (current.interaction && current.interaction !== interaction)) fail();
      current.interaction = interaction;
    } else if (
      (current.interaction === 'option-click' && footerLabel !== '关闭') ||
      (current.interaction === 'boolean-submit' && !['提交', '关闭'].includes(footerLabel ?? ''))
    )
      fail();
    const revision = JSON.stringify([ordinalText, question, current.interaction]);
    context = {
      source: 'zhihuishu-verified',
      authorizationId: request.grantId,
      classification: 'non-graded',
      explicitNonGraded: true,
      authenticated: true,
      courseId: request.courseId,
      popupId: request.key,
      revision,
      ...(current.existingFeedback ? { existingFeedback: current.existingFeedback } : {}),
    };
    if (!current.saved) {
      current.saved = context;
      current.popup = dialog;
    } else if (JSON.stringify(current.saved) !== JSON.stringify(context)) fail();
    if (type && ordinals.length === 1 && /^\d{1,3}$/.test(ordinalText))
      layout = {
        kind: 'zhihuishu-dialog-v1',
        type,
        ordinal: Number(ordinalText),
        fullyVisible: complete && bodies.length === 1 && fits(titles[0]) && items.every(fits),
        unanswered: !current.receipt && !feedbackMarkup,
        optionIds: options.map((option) => option.id),
        expectedStem: question?.stem || null,
        expectedOptionTexts: options.map((option) => option.text || null),
      };
    if (layout?.fullyVisible) {
      const rects = [titles[0], ...items].map((element) => element.getBoundingClientRect());
      // Retain nearby whitespace for OCR segmentation while staying within the
      // verified body and excluding the footer. Never crop an offscreen node.
      const onScreen = rects.every(
        (rect) =>
          rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      );
      const x = Math.floor(
        Math.max(0, box!.left, Math.min(...rects.map((rect) => rect.left)) - 16),
      );
      const y = Math.floor(Math.max(0, box!.top, Math.min(...rects.map((rect) => rect.top)) - 16));
      const right = Math.ceil(
        Math.min(innerWidth, box!.right, Math.max(...rects.map((rect) => rect.right)) + 16),
      );
      const bottom = Math.ceil(
        Math.min(innerHeight, box!.bottom, Math.max(...rects.map((rect) => rect.bottom)) + 16),
      );
      const footerBox = footer!.getBoundingClientRect();
      if (
        onScreen &&
        x >= 0 &&
        y >= 0 &&
        right <= innerWidth &&
        bottom <= innerHeight &&
        right > x &&
        bottom > y &&
        !(
          footerBox.left < right &&
          footerBox.right > x &&
          footerBox.top < bottom &&
          footerBox.bottom > y
        )
      )
        captureClip = { x: x + scrollX, y: y + scrollY, width: right - x, height: bottom - y };
    }
  } else if (!current.closed && (current.popup || candidates.length)) fail();
  if (current.closed && candidates.length && !closePending) fail();
  if (['input-arm', 'input-validate', 'input-commit'].includes(request.mode)) {
    phase = 'DOM_INPUT_CHECK';
    const action = request.action,
      part = request.inputPart;
    if (
      !action ||
      !request.context ||
      !request.video ||
      !request.inputToken ||
      JSON.stringify(context) !== JSON.stringify(request.context) ||
      JSON.stringify(mediaState) !== JSON.stringify(request.video)
    )
      fail();
    let target: HTMLElement | null = null;
    if (action!.type === 'submit') {
      if (
        current.existingFeedback ||
        !question?.complete ||
        question.stem.trim().length < 4 ||
        question.stem.length > 2000 ||
        !current.interaction ||
        action!.optionIds.length !== 1 ||
        !footer ||
        (current.interaction === 'boolean-submit'
          ? footer.textContent?.trim() !== '提交'
          : footer.textContent?.trim() !== '关闭')
      )
        fail();
      if (part === 'option') {
        if (current.submissions || current.closed) fail();
        const matches = [
          ...current.popup!.querySelectorAll<HTMLElement>('.topic-list > li.topic-item'),
        ].filter(
          (item) =>
            (item.querySelector('.topic-option-item')?.textContent?.trim() ?? '').match(
              /^([A-Z])[\s.)、．:：]*$/,
            )?.[1] === action!.optionIds[0],
        );
        if (matches.length !== 1) fail();
        target = matches[0];
      } else if (part === 'submit') {
        if (
          current.interaction !== 'boolean-submit' ||
          current.submissions !== 1 ||
          current.receipt !== action!.submissionId ||
          current.submitFooterIssued ||
          current.closed
        )
          fail();
        target = footer;
      } else fail();
    } else if (action!.type === 'close' && part === 'close') {
      if (
        current.closed ||
        (!current.receipt && !current.existingFeedback) ||
        (!correct && !incorrect)
      )
        fail();
      target = footer;
    } else fail();
    if (
      !target ||
      !target.isConnected ||
      !visible(target) ||
      target.hasAttribute('disabled') ||
      target.getAttribute('aria-disabled') === 'true' ||
      !footer ||
      !visible(footer) ||
      footer.hasAttribute('disabled') ||
      footer.getAttribute('aria-disabled') === 'true'
    )
      fail();
    if (request.mode === 'input-arm') {
      if (current.input) fail();
      current.input = {
        token: request.inputToken!,
        part: part!,
        target: target!,
        action: action!,
        context: request.context!,
        video: request.video!,
        expiresAt: performance.now() + 3000,
        pointerSeen: false,
        consumed: false,
      };
    } else {
      const input = current.input,
        event = request.inputEvent;
      if (
        !input ||
        input.token !== request.inputToken ||
        input.part !== part ||
        input.target !== target ||
        input.consumed ||
        performance.now() > input.expiresAt ||
        !event?.isTrusted ||
        !(event.target instanceof Element) ||
        !target!.contains(event.target)
      )
        fail();
      if (request.mode === 'input-validate') {
        if (
          input!.pointerSeen ||
          !(event instanceof PointerEvent) ||
          event.type !== 'pointerdown' ||
          event.button !== 0 ||
          !event.isPrimary
        )
          fail();
        input!.pointerSeen = true;
      } else {
        if (
          !input!.pointerSeen ||
          !(event instanceof MouseEvent) ||
          event.type !== 'click' ||
          event.button !== 0 ||
          event.detail !== 1
        )
          fail();
        input!.consumed = true;
        if (part === 'option' && action!.type === 'submit') {
          current.submissions++;
          current.receipt = action!.submissionId;
        } else if (part === 'submit') current.submitFooterIssued = true;
        else if (part === 'close') {
          current.closed = true;
          current.closeUntil = performance.now() + 2000;
          current.closingMasks = backdrops;
        }
      }
    }
  }
  if (
    request.mode === 'input-finish' &&
    (!current.input || current.input.token !== request.inputToken || !current.input.consumed)
  )
    fail();
  if (request.mode === 'action') {
    phase = 'DOM_ACTION_CHECK';
    const action = request.action;
    if (
      !action ||
      !request.context ||
      JSON.stringify(context) !== JSON.stringify(request.context) ||
      JSON.stringify(mediaState) !== JSON.stringify(request.video)
    )
      fail();
    if (action.type === 'pause') {
      if (current.paused || current.closed) fail();
      current.paused = true;
      video.pause();
    } else if (action.type === 'correct') throw new Error('NATIVE_INCORRECT_FEEDBACK_UNVERIFIED');
    else if (action.type === 'submit' || action.type === 'close') fail();
    else {
      phase = 'DOM_RESTORE_CHECK';
      if (
        !current.closed ||
        !current.closeVerified ||
        current.originalPaused ||
        current.restored ||
        candidates.length
      )
        fail();
      current.restored = true;
      if (!video.paused)
        return {
          context,
          question,
          layout,
          video: mediaState,
          title: heading,
          feedback: { status: 'unknown' },
          verified: true,
        };
      // The promise is intentionally returned to the caller; the effect itself has already issued.
      return video.play().then(() => ({
        context,
        question,
        layout,
        video: mediaState,
        title: heading,
        feedback: { status: 'unknown' as const },
        verified: !video.paused,
      }));
    }
  }
  if (current.closed && !candidates.length && !backdrops.length) current.closeVerified = true;
  const verified =
    request.action?.type === 'pause'
      ? video.paused
      : request.action?.type === 'close'
        ? current.closeVerified
        : request.action?.type === 'restore'
          ? !video.paused
          : false;
  return {
    context,
    question,
    layout,
    captureClip,
    inputConfirmed: request.mode === 'input-finish',
    closePending,
    requiresSubmit: current.interaction === 'boolean-submit',
    video: mediaState,
    title: heading,
    feedback:
      current.receipt && correct
        ? { status: 'correct', receipt: current.receipt }
        : current.receipt && incorrect
          ? { status: 'incorrect', receipt: current.receipt }
          : { status: 'unknown' },
    verified,
    feedbackPending:
      !!current.receipt &&
      !correct &&
      !incorrect &&
      !!current.popup &&
      (footer?.textContent?.trim() !== '关闭' ||
        (current.interaction === 'option-click' && !feedbackMarkup) ||
        [...current.popup.querySelectorAll('.el-loading-mask')].some(visible)),
  };
}
