function cloneJsonValue(value) {
  if (value == null) return value;

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function normalizePositiveInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizeCompactText(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isProvidedSelector(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

const PUBLISH_CONFIRMATION_RECOVERY_STATUSES = new Set([
  'publish_confirm_unresolved',
  'publish_confirm_in_flight'
]);

const DIRECT_PUBLISH_CONFIRMATION_TERMINAL_STATUSES = new Set([
  ...PUBLISH_CONFIRMATION_RECOVERY_STATUSES,
  'publish_confirm_target_not_found'
]);

export function isPublishConfirmationRecoveryStatus(status) {
  return PUBLISH_CONFIRMATION_RECOVERY_STATUSES.has(normalizeCompactText(status));
}

export function isDirectPublishConfirmationRecoveryState(state = null) {
  if (!state || typeof state !== 'object') return false;
  const status = normalizeCompactText(state.status);
  const phase = normalizeCompactText(state.phase);
  return phase === 'publish_confirmation'
    || DIRECT_PUBLISH_CONFIRMATION_TERMINAL_STATUSES.has(status);
}

export function summarizePublishConfirmationStateForRecovery(confirmationState = null) {
  const source = confirmationState && typeof confirmationState === 'object'
    ? (cloneJsonValue(confirmationState) || confirmationState)
    : {};

  return {
    state: normalizeCompactText(source.state) || null,
    publishLayerPresent: !!source.publishLayerPresent,
    confirmButtonPresent: !!source.confirmButtonPresent,
    confirmButtonText: normalizeCompactText(source.confirmButtonText) || null,
    confirmButtonDisabled: !!source.confirmButtonDisabled,
    completeButtonPresent: !!source.completeButtonPresent,
    completeButtonText: normalizeCompactText(source.completeButtonText) || null,
    completeButtonDisabled: !!source.completeButtonDisabled,
    progressTextPresent: !!source.progressTextPresent,
    captchaPresent: !!source.captchaPresent,
    safeToRetryFinalConfirm: !!source.safeToRetryFinalConfirm,
    safeToPollSameTab: !!source.safeToPollSameTab,
    recommendedAction: normalizeCompactText(source.recommendedAction) || null
  };
}

export function buildPublishConfirmationRecoverySummary({ response = null, nowIso = new Date().toISOString() } = {}) {
  if (!isPublishConfirmationRecoveryStatus(response?.status)) return null;

  return {
    status: response.status,
    retryable: !!response.retryable,
    sameTabRequired: response.sameTabRequired !== false,
    recommendedAction: normalizeCompactText(response.recommendedAction) || null,
    updatedAt: nowIso
  };
}

export function buildDirectPublishConfirmationRecoveryPatch({ response = null, nowIso = new Date().toISOString() } = {}) {
  if (!isPublishConfirmationRecoveryStatus(response?.status)) return null;

  const confirmationState = summarizePublishConfirmationStateForRecovery(response.confirmationState);

  return {
    phase: 'publish_confirmation',
    stage: confirmationState.state || response.status,
    status: response.status,
    confirmationState,
    publishConfirmationRecovery: buildPublishConfirmationRecoverySummary({ response, nowIso })
  };
}

export function buildDirectPublishConfirmationTargetMissingResult({
  state = null,
  tabId = null,
  diagnostics = null,
  error = null,
  nowIso = new Date().toISOString()
} = {}) {
  const normalizedTabId = normalizePositiveInteger(tabId) ?? normalizePositiveInteger(state?.tabId);
  const confirmationState = summarizePublishConfirmationStateForRecovery(state?.confirmationState);
  const resolvedError = normalizeCompactText(error)
    || '저장된 티스토리 최종 확인 탭을 찾지 못했습니다. 새 글쓰기 탭을 열어 재작성하지 말고, 원격 발행 상태를 먼저 확인한 뒤 재시도하세요.';

  return {
    success: false,
    status: 'publish_confirm_target_not_found',
    error: resolvedError,
    tabId: normalizedTabId,
    sameTabRequired: true,
    recommendedAction: 'verify_remote_state_before_retry',
    confirmationState,
    publishConfirmationRecovery: {
      status: 'publish_confirm_target_not_found',
      retryable: false,
      sameTabRequired: true,
      recommendedAction: 'verify_remote_state_before_retry',
      updatedAt: nowIso
    },
    diagnostics: cloneJsonValue(diagnostics) ?? null
  };
}

export function clearQueuePublishConfirmationPauseState() {
  return {
    publishConfirmTabId: null,
    confirmationState: null,
    publishConfirmationRecovery: null
  };
}

export function buildQueuePublishConfirmationPauseState({
  existingItem = null,
  tabId = null,
  response = null,
  error = null,
  nowIso = new Date().toISOString()
} = {}) {
  if (!isPublishConfirmationRecoveryStatus(response?.status)) return null;

  const normalizedTabId = normalizePositiveInteger(tabId) ?? normalizePositiveInteger(existingItem?.publishConfirmTabId);
  const diagnostics = cloneJsonValue(response?.diagnostics)
    ?? cloneJsonValue(existingItem?.diagnostics)
    ?? null;
  const resolvedError = normalizeCompactText(error)
    || normalizeCompactText(response?.error)
    || '티스토리 최종 확인 단계가 같은 탭에서 미완료 상태로 남아 큐를 일시정지했습니다.';

  return {
    status: 'publish_confirm_paused',
    error: resolvedError,
    publishStatus: response.status,
    publishConfirmTabId: normalizedTabId,
    confirmationState: summarizePublishConfirmationStateForRecovery(response.confirmationState),
    publishConfirmationRecovery: buildPublishConfirmationRecoverySummary({ response, nowIso }),
    diagnostics,
    lastCheckedAt: nowIso
  };
}

export function buildDirectPublishConfirmationResumePreflight({
  confirmationState = null,
  nowIso = new Date().toISOString()
} = {}) {
  const summarizedState = summarizePublishConfirmationStateForRecovery(confirmationState);
  const state = summarizedState.state || 'unknown';
  const recommendedAction = summarizedState.recommendedAction
    || (summarizedState.safeToRetryFinalConfirm ? 'retry_final_confirm_same_tab' : null);

  if (state === 'confirm_ready' && summarizedState.safeToRetryFinalConfirm) {
    return {
      shouldResume: true,
      status: 'confirm_ready',
      recommendedAction: recommendedAction || 'retry_final_confirm_same_tab'
    };
  }

  if (state === 'captcha_present' || summarizedState.captchaPresent) {
    return {
      shouldResume: false,
      status: 'captcha_required',
      error: '티스토리 최종 확인 재개 전 CAPTCHA가 감지되었습니다. 같은 탭 CAPTCHA solve 후 재개하세요.',
      sameTabRequired: true,
      recommendedAction: recommendedAction || 'solve_captcha_same_tab_then_resume',
      confirmationState: summarizedState
    };
  }

  if (state === 'confirm_in_flight') {
    const response = {
      status: 'publish_confirm_in_flight',
      retryable: false,
      sameTabRequired: true,
      recommendedAction: recommendedAction || 'poll_same_tab_before_retry',
      confirmationState: summarizedState,
      error: '티스토리 최종 확인이 아직 저장중/발행중입니다. 중복 클릭하지 말고 같은 탭을 다시 poll 하세요.'
    };
    return {
      shouldResume: false,
      status: response.status,
      error: response.error,
      sameTabRequired: true,
      recommendedAction: response.recommendedAction,
      confirmationState: summarizedState,
      publishConfirmationRecovery: buildPublishConfirmationRecoverySummary({ response, nowIso })
    };
  }

  if (state === 'layer_open_without_confirm_button') {
    const response = {
      status: 'publish_confirm_unresolved',
      retryable: false,
      sameTabRequired: true,
      recommendedAction: recommendedAction || 'inspect_publish_layer_same_tab',
      confirmationState: summarizedState,
      error: '티스토리 최종 확인 레이어는 열려 있지만 확인 버튼을 찾지 못했습니다. 같은 탭 레이어를 먼저 재조회하세요.'
    };
    return {
      shouldResume: false,
      status: response.status,
      error: response.error,
      sameTabRequired: true,
      recommendedAction: response.recommendedAction,
      confirmationState: summarizedState,
      publishConfirmationRecovery: buildPublishConfirmationRecoverySummary({ response, nowIso })
    };
  }

  return {
    shouldResume: false,
    status: 'publish_confirm_target_not_found',
    error: '저장된 최종 확인 레이어를 같은 탭에서 찾지 못했습니다. 새 탭 재작성 없이 direct publish state와 실제 탭 상태를 다시 확인하세요.',
    sameTabRequired: true,
    recommendedAction: recommendedAction || 'recover_or_prepare_editor',
    confirmationState: summarizedState
  };
}

export function buildQueuePublishConfirmationResumePreflight({
  existingItem = null,
  tabId = null,
  confirmationState = null,
  nowIso = new Date().toISOString()
} = {}) {
  const summarizedState = summarizePublishConfirmationStateForRecovery(confirmationState);
  const state = summarizedState.state || 'unknown';
  const recommendedAction = summarizedState.recommendedAction
    || (summarizedState.safeToRetryFinalConfirm ? 'retry_final_confirm_same_tab' : null);

  if (state === 'confirm_ready' && summarizedState.safeToRetryFinalConfirm) {
    return {
      shouldResume: true,
      status: 'confirm_ready',
      recommendedAction: recommendedAction || 'retry_final_confirm_same_tab'
    };
  }

  if (state === 'captcha_present' || summarizedState.captchaPresent) {
    return {
      shouldResume: false,
      status: 'captcha_required',
      error: '티스토리 최종 확인 재개 전 CAPTCHA가 감지되었습니다. 같은 탭 CAPTCHA pause로 전환하세요.',
      sameTabRequired: true,
      recommendedAction: recommendedAction || 'solve_captcha_same_tab_then_resume',
      confirmationState: summarizedState
    };
  }

  if (state === 'confirm_in_flight') {
    const response = {
      status: 'publish_confirm_in_flight',
      retryable: false,
      sameTabRequired: true,
      recommendedAction: recommendedAction || 'poll_same_tab_before_retry',
      confirmationState: summarizedState,
      error: '티스토리 최종 확인이 아직 저장중/발행중입니다. 중복 클릭하지 말고 같은 탭을 다시 poll 하세요.'
    };
    return {
      shouldResume: false,
      status: response.status,
      error: response.error,
      sameTabRequired: true,
      recommendedAction: response.recommendedAction,
      confirmationState: summarizedState,
      pauseState: buildQueuePublishConfirmationPauseState({
        existingItem,
        tabId,
        response,
        error: response.error,
        nowIso
      })
    };
  }

  if (state === 'layer_open_without_confirm_button') {
    const response = {
      status: 'publish_confirm_unresolved',
      retryable: false,
      sameTabRequired: true,
      recommendedAction: recommendedAction || 'inspect_publish_layer_same_tab',
      confirmationState: summarizedState,
      error: '티스토리 최종 확인 레이어는 열려 있지만 확인 버튼을 찾지 못했습니다. 같은 탭 레이어를 먼저 재조회하세요.'
    };
    return {
      shouldResume: false,
      status: response.status,
      error: response.error,
      sameTabRequired: true,
      recommendedAction: response.recommendedAction,
      confirmationState: summarizedState,
      pauseState: buildQueuePublishConfirmationPauseState({
        existingItem,
        tabId,
        response,
        error: response.error,
        nowIso
      })
    };
  }

  return {
    shouldResume: false,
    status: 'publish_confirm_target_not_found',
    error: '저장된 최종 확인 레이어를 같은 탭에서 찾지 못했습니다. 새 탭 재작성 없이 GET_QUEUE와 실제 탭 상태를 다시 확인하세요.',
    sameTabRequired: true,
    recommendedAction: recommendedAction || 'recover_or_prepare_editor',
    confirmationState: summarizedState
  };
}

export function findQueuePublishConfirmationItem(queue = [], { itemId = null, tabId = null } = {}) {
  const pausedItems = Array.isArray(queue)
    ? queue.filter((item) => item && item.status === 'publish_confirm_paused')
    : [];

  const normalizedItemId = typeof itemId === 'string' ? itemId.trim() : '';
  if (normalizedItemId) return pausedItems.find((item) => item.id === normalizedItemId) || null;

  const normalizedTabId = normalizePositiveInteger(tabId);
  if (normalizedTabId !== null) {
    const matchedItems = pausedItems.filter((item) => normalizePositiveInteger(item?.publishConfirmTabId) === normalizedTabId);
    return matchedItems.length === 1 ? matchedItems[0] : null;
  }
  if (isProvidedSelector(tabId)) return null;

  return pausedItems.length === 1 ? pausedItems[0] : null;
}

export function summarizeQueuePublishConfirmationSelection(queue = [], { itemId = null, tabId = null } = {}) {
  const pausedItems = Array.isArray(queue)
    ? queue.filter((item) => item && item.status === 'publish_confirm_paused')
    : [];
  const normalizedItemId = typeof itemId === 'string' ? itemId.trim() : '';
  const normalizedTabId = normalizePositiveInteger(tabId);

  return {
    pausedCount: pausedItems.length,
    requestedItemId: normalizedItemId || null,
    requestedTabId: normalizedTabId,
    pausedItemIds: pausedItems.map((item) => item.id).filter(Boolean),
    pausedTabIds: pausedItems.map((item) => normalizePositiveInteger(item?.publishConfirmTabId)).filter((value) => value !== null)
  };
}

export function getQueuePublishConfirmationSelectionFailure({
  queue = [],
  itemId = null,
  tabId = null,
  matchedItem = null,
  directPublishTabId = null
} = {}) {
  const selection = summarizeQueuePublishConfirmationSelection(queue, { itemId, tabId });
  const normalizedItemId = typeof itemId === 'string' ? itemId.trim() : '';
  const normalizedTabId = normalizePositiveInteger(tabId);
  const normalizedDirectPublishTabId = normalizePositiveInteger(directPublishTabId);
  const tabIdProvided = isProvidedSelector(tabId);

  if (normalizedItemId && !matchedItem) {
    return {
      status: 'item_not_found',
      error: '지정한 publish_confirm_paused 큐 항목을 찾지 못했습니다.',
      queueSelection: selection
    };
  }

  if (tabIdProvided && normalizedTabId === null) {
    return {
      status: 'item_not_found',
      error: '유효한 publishConfirmTabId를 지정하세요.',
      queueSelection: selection
    };
  }

  if (normalizedItemId && normalizedTabId !== null && matchedItem) {
    const matchedTabId = normalizePositiveInteger(matchedItem?.publishConfirmTabId);
    if (matchedTabId !== normalizedTabId) {
      return {
        status: 'queue_publish_confirm_target_required',
        error: '지정한 id와 publishConfirmTabId가 같은 publish_confirm_paused 큐 항목을 가리키지 않습니다.',
        queueSelection: selection
      };
    }
  }

  if (normalizedTabId !== null && !matchedItem && normalizedDirectPublishTabId !== normalizedTabId) {
    return {
      status: 'item_not_found',
      error: '지정한 publishConfirmTabId와 일치하는 publish_confirm_paused 큐 항목을 찾지 못했습니다.',
      queueSelection: selection
    };
  }

  if (matchedItem && normalizePositiveInteger(matchedItem?.publishConfirmTabId) === null && !tabIdProvided) {
    return {
      status: 'publish_confirm_target_not_found',
      error: '선택한 publish_confirm_paused 큐 항목에 유효한 publishConfirmTabId가 없습니다. GET_QUEUE 상태를 다시 확인하세요.',
      queueSelection: selection
    };
  }

  if (!normalizedItemId && !tabIdProvided && normalizedDirectPublishTabId === null && selection.pausedCount > 1) {
    return {
      status: 'queue_publish_confirm_target_required',
      error: 'publish_confirm_paused 큐 항목이 여러 개입니다. id 또는 tabId를 지정하세요.',
      queueSelection: selection
    };
  }

  return null;
}
