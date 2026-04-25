(() => {
  const root = typeof globalThis !== 'undefined' ? globalThis : window;
  if (root.__BLOG_AUTO_PUBLISH_CONFIRMATION__) return;

  const PUBLISH_PROGRESS_TEXT_RE = /(저장\s*중|발행\s*중|게시\s*중|처리\s*중|업로드\s*중|publishing|saving|processing)/i;

  function normalizeCompactText(value = '') {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function hasPublishProgressText(value = '') {
    return PUBLISH_PROGRESS_TEXT_RE.test(normalizeCompactText(value));
  }

  function normalizePublishConfirmationState(input = {}) {
    const confirmButtonText = normalizeCompactText(input.confirmButtonText || input.confirmButton?.text || '');
    const completeButtonText = normalizeCompactText(input.completeButtonText || input.completeButton?.text || '');
    const publishLayerPresent = !!input.publishLayerPresent;
    const confirmButtonPresent = !!(input.confirmButtonPresent || input.confirmButton || confirmButtonText);
    const completeButtonPresent = !!(input.completeButtonPresent || input.completeButton || completeButtonText);
    const confirmButtonDisabled = !!(input.confirmButtonDisabled || input.confirmButton?.disabled || input.confirmButtonAriaDisabled === true || input.confirmButtonAriaDisabled === 'true');
    const completeButtonDisabled = !!(input.completeButtonDisabled || input.completeButton?.disabled || input.completeButtonAriaDisabled === true || input.completeButtonAriaDisabled === 'true');
    const progressTextPresent = hasPublishProgressText(confirmButtonText) || hasPublishProgressText(completeButtonText);
    const controlDisabled = confirmButtonDisabled || completeButtonDisabled;

    let state = 'layer_closed';
    let recommendedAction = 'recover_or_prepare_editor';
    let safeToRetryFinalConfirm = false;
    let safeToPollSameTab = false;

    if (input.captchaPresent) {
      state = 'captcha_present';
      recommendedAction = 'solve_captcha_same_tab_then_resume';
      safeToPollSameTab = true;
    } else if (publishLayerPresent && (progressTextPresent || (controlDisabled && (confirmButtonPresent || completeButtonPresent)))) {
      state = 'confirm_in_flight';
      recommendedAction = 'poll_same_tab_before_retry';
      safeToPollSameTab = true;
    } else if (publishLayerPresent && confirmButtonPresent) {
      state = 'confirm_ready';
      recommendedAction = 'retry_final_confirm_same_tab';
      safeToRetryFinalConfirm = true;
    } else if (publishLayerPresent) {
      state = 'layer_open_without_confirm_button';
      recommendedAction = 'inspect_publish_layer_same_tab';
      safeToPollSameTab = true;
    }

    return {
      state,
      publishLayerPresent,
      confirmButtonPresent,
      confirmButtonText: confirmButtonText || null,
      confirmButtonDisabled,
      completeButtonPresent,
      completeButtonText: completeButtonText || null,
      completeButtonDisabled,
      progressTextPresent,
      captchaPresent: !!input.captchaPresent,
      safeToRetryFinalConfirm,
      safeToPollSameTab,
      recommendedAction
    };
  }

  function buildUnobservedPublishRequestFailure(input = {}) {
    if (input.requestObserved) return null;

    const confirmationState = normalizePublishConfirmationState(input.confirmationState || input);

    if (confirmationState.state === 'captcha_present') {
      return {
        status: 'captcha_required',
        error: '발행 확인 단계에서 CAPTCHA가 감지되었습니다. 같은 탭에서 해결한 뒤 resume 경로로 이어가세요.',
        retryable: true,
        sameTabRequired: true,
        recommendedAction: confirmationState.recommendedAction,
        confirmationState
      };
    }

    if (confirmationState.state === 'confirm_in_flight') {
      return {
        status: 'publish_confirm_in_flight',
        error: '발행 확인 버튼 클릭 후 저장/발행 진행 상태가 남아 있지만 manage/post 요청은 아직 확인되지 않았습니다. 새 탭으로 재작성하지 말고 같은 탭을 먼저 재조회하세요.',
        retryable: false,
        sameTabRequired: true,
        recommendedAction: confirmationState.recommendedAction,
        confirmationState
      };
    }

    if (confirmationState.state === 'confirm_ready' || confirmationState.state === 'layer_open_without_confirm_button') {
      return {
        status: 'publish_confirm_unresolved',
        error: '발행 확인 단계가 완료되지 않았고 manage/post 요청도 확인되지 않았습니다. 공개 글 오염을 피하려면 같은 탭의 발행 레이어 상태를 재사용해 final confirm만 재시도하세요.',
        retryable: true,
        sameTabRequired: true,
        recommendedAction: confirmationState.recommendedAction,
        confirmationState
      };
    }

    return null;
  }

  root.__BLOG_AUTO_PUBLISH_CONFIRMATION__ = {
    normalizeCompactText,
    hasPublishProgressText,
    normalizePublishConfirmationState,
    buildUnobservedPublishRequestFailure
  };
})();
