function normalizePositiveInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizeCaptchaStage(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function cloneJsonValue(value) {
  if (value == null) return value;

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function isResumePublishLayerStage(stage) {
  return stage === 'before_publish' || stage === 'after_open_publish_layer';
}

function isProvidedSelector(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

export function summarizeQueueCaptchaArtifactCapture(artifactResult = null, { nowIso = new Date().toISOString() } = {}) {
  if (!artifactResult || typeof artifactResult !== 'object') {
    return null;
  }

  return {
    success: !!artifactResult.success,
    status: artifactResult.status || null,
    artifactKind: artifactResult.artifact?.kind || null,
    artifactPreference: artifactResult.artifactPreference || null,
    captureErrorCount: Array.isArray(artifactResult.captureErrors) ? artifactResult.captureErrors.length : 0,
    capturedAt: nowIso
  };
}

export function summarizeQueueCaptchaSubmitResult(submitResult = null, { nowIso = new Date().toISOString() } = {}) {
  if (!submitResult || typeof submitResult !== 'object') {
    return null;
  }

  return {
    success: !!submitResult.success,
    status: submitResult.status || null,
    captchaStillAppears: submitResult.captchaStillAppears ?? null,
    answerLength: typeof submitResult.answerLength === 'number' ? submitResult.answerLength : null,
    normalization: submitResult.answerNormalization || null,
    updatedAt: nowIso
  };
}

export function clearQueueCaptchaPauseState() {
  return {
    captchaTabId: null,
    captchaStage: null,
    captchaContext: null,
    solveHints: null,
    lastCaptchaArtifactCapture: null,
    lastCaptchaSubmitResult: null,
    lastCheckedAt: null
  };
}

export function buildQueueCaptchaSavedStateForAnswerResolution({
  queueItem = null,
  directPublishState = null,
  requestedTabId = null
} = {}) {
  const normalizedRequestedTabId = normalizePositiveInteger(requestedTabId);
  const normalizedDirectPublishTabId = normalizePositiveInteger(directPublishState?.tabId);
  const shouldReuseDirectPublishState = !normalizedRequestedTabId
    || (normalizedDirectPublishTabId !== null && normalizedDirectPublishTabId === normalizedRequestedTabId);
  const baseState = shouldReuseDirectPublishState
    ? (cloneJsonValue(directPublishState) || null)
    : null;
  const queueContext = cloneJsonValue(queueItem?.captchaContext) || null;
  const queueSolveHints = cloneJsonValue(queueItem?.solveHints) || null;
  const hasQueueContext = !!(queueContext && typeof queueContext === 'object');

  if (!queueContext && !queueSolveHints) {
    return baseState;
  }

  const mergedCaptchaContext = hasQueueContext
    ? { ...queueContext }
    : {};

  if (queueSolveHints) {
    mergedCaptchaContext.solveHints = queueSolveHints;
  } else if (hasQueueContext && !queueContext?.solveHints) {
    delete mergedCaptchaContext.solveHints;
  }

  return {
    ...(baseState && typeof baseState === 'object' ? baseState : {}),
    captchaContext: mergedCaptchaContext
  };
}

export function buildQueueCaptchaPauseState({
  existingItem = null,
  tabId = null,
  response = null,
  handoff = null,
  submitResult = null,
  error = null,
  nowIso = new Date().toISOString()
} = {}) {
  const normalizedTabId = normalizePositiveInteger(tabId) ?? normalizePositiveInteger(existingItem?.captchaTabId);
  const diagnostics = cloneJsonValue(response?.diagnostics)
    ?? cloneJsonValue(existingItem?.diagnostics)
    ?? null;
  const responseContext = cloneJsonValue(response?.captchaContext) || null;
  const handoffContext = cloneJsonValue(handoff?.captchaContext) || null;
  const existingContext = cloneJsonValue(existingItem?.captchaContext) || null;
  const captchaContext = handoffContext || responseContext || existingContext || null;
  const solveHints = cloneJsonValue(captchaContext?.solveHints)
    || cloneJsonValue(handoff?.captchaArtifacts?.solveHints)
    || cloneJsonValue(response?.solveHints)
    || cloneJsonValue(existingItem?.solveHints)
    || null;

  if (captchaContext && solveHints && !captchaContext.solveHints) {
    captchaContext.solveHints = cloneJsonValue(solveHints);
  }

  return {
    status: 'captcha_paused',
    error: typeof error === 'string' && error.trim().length > 0
      ? error.trim()
      : (existingItem?.error || 'CAPTCHA 감지 — 같은 탭에서 solve 후 재개'),
    publishStatus: 'captcha_required',
    captchaTabId: normalizedTabId,
    captchaStage: normalizeCaptchaStage(response?.captchaStage) || normalizeCaptchaStage(existingItem?.captchaStage),
    diagnostics,
    captchaContext,
    solveHints,
    lastCaptchaArtifactCapture: summarizeQueueCaptchaArtifactCapture(handoff?.captchaArtifacts, { nowIso })
      || cloneJsonValue(existingItem?.lastCaptchaArtifactCapture)
      || null,
    lastCaptchaSubmitResult: summarizeQueueCaptchaSubmitResult(submitResult, { nowIso })
      || cloneJsonValue(existingItem?.lastCaptchaSubmitResult)
      || null,
    lastCheckedAt: nowIso
  };
}

export function decideQueueCaptchaResumeProbeAction({ probeResult = null, captchaStage = null } = {}) {
  if (probeResult?.success) {
    return {
      action: 'resume_now',
      status: 'editor_ready',
      reason: null,
      error: null
    };
  }

  const reason = probeResult?.reason || null;
  const error = probeResult?.error || null;
  const normalizedStage = normalizeCaptchaStage(captchaStage);

  if (reason === 'captcha_present') {
    return {
      action: 'captcha_required',
      status: 'captcha_required',
      reason,
      error
    };
  }

  if (reason === 'publish_layer_open') {
    const shouldResumePublishLayer = isResumePublishLayerStage(normalizedStage);
    return {
      action: shouldResumePublishLayer
        ? 'resume_publish_layer_open'
        : 'wait_for_post_captcha_settle',
      status: shouldResumePublishLayer
        ? 'resume_publish_layer_open'
        : 'resume_post_captcha_settle',
      reason,
      error
    };
  }

  return {
    action: 'editor_not_ready',
    status: 'editor_not_ready',
    reason,
    error
  };
}

export function findQueueCaptchaItem(queue = [], { itemId = null, tabId = null } = {}) {
  const pausedItems = Array.isArray(queue)
    ? queue.filter((item) => item && item.status === 'captcha_paused')
    : [];

  const normalizedItemId = typeof itemId === 'string' ? itemId.trim() : '';
  if (normalizedItemId) {
    return pausedItems.find((item) => item.id === normalizedItemId) || null;
  }

  const normalizedTabId = normalizePositiveInteger(tabId);
  if (normalizedTabId !== null) {
    const matchedItems = pausedItems.filter((item) => normalizePositiveInteger(item?.captchaTabId) === normalizedTabId);
    return matchedItems.length === 1 ? matchedItems[0] : null;
  }
  if (isProvidedSelector(tabId)) {
    return null;
  }

  return pausedItems.length === 1 ? pausedItems[0] : null;
}

export function summarizeQueueCaptchaSelection(queue = [], { itemId = null, tabId = null } = {}) {
  const pausedItems = Array.isArray(queue)
    ? queue.filter((item) => item && item.status === 'captcha_paused')
    : [];
  const normalizedItemId = typeof itemId === 'string' ? itemId.trim() : '';
  const normalizedTabId = normalizePositiveInteger(tabId);

  return {
    pausedCount: pausedItems.length,
    requestedItemId: normalizedItemId || null,
    requestedTabId: normalizedTabId,
    pausedItemIds: pausedItems.map((item) => item.id).filter(Boolean),
    pausedTabIds: pausedItems.map((item) => normalizePositiveInteger(item?.captchaTabId)).filter((value) => value !== null)
  };
}

export function getQueueCaptchaSelectionFailure({
  queue = [],
  itemId = null,
  tabId = null,
  matchedItem = null,
  directPublishTabId = null
} = {}) {
  const selection = summarizeQueueCaptchaSelection(queue, { itemId, tabId });
  const normalizedItemId = typeof itemId === 'string' ? itemId.trim() : '';
  const normalizedTabId = normalizePositiveInteger(tabId);
  const normalizedDirectPublishTabId = normalizePositiveInteger(directPublishTabId);
  const tabIdProvided = isProvidedSelector(tabId);

  if (normalizedItemId && !matchedItem) {
    return {
      status: 'item_not_found',
      error: '지정한 captcha_paused 큐 항목을 찾지 못했습니다.',
      queueSelection: selection
    };
  }

  if (tabIdProvided && normalizedTabId === null) {
    return {
      status: 'item_not_found',
      error: '유효한 captchaTabId를 지정하세요.',
      queueSelection: selection
    };
  }

  if (normalizedItemId && normalizedTabId !== null && matchedItem) {
    const matchedTabId = normalizePositiveInteger(matchedItem?.captchaTabId);
    if (matchedTabId !== normalizedTabId) {
      return {
        status: 'queue_captcha_target_required',
        error: '지정한 id와 captchaTabId가 같은 captcha_paused 큐 항목을 가리키지 않습니다.',
        queueSelection: selection
      };
    }
  }

  if (normalizedTabId !== null && !matchedItem && normalizedDirectPublishTabId !== normalizedTabId) {
    return {
      status: 'item_not_found',
      error: '지정한 captchaTabId와 일치하는 captcha_paused 큐 항목을 찾지 못했습니다.',
      queueSelection: selection
    };
  }

  if (!normalizedItemId && !tabIdProvided && normalizedDirectPublishTabId === null && selection.pausedCount > 1) {
    return {
      status: 'queue_captcha_target_required',
      error: 'captcha_paused 큐 항목이 여러 개입니다. id 또는 tabId를 지정하세요.',
      queueSelection: selection
    };
  }

  return null;
}
