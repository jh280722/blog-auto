function normalizePositiveInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizeCaptchaStage(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function isResumePublishLayerStage(stage) {
  return stage === 'before_publish' || stage === 'after_open_publish_layer';
}

function isProvidedSelector(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
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
