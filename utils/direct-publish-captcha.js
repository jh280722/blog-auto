function cloneJsonValue(value) {
  if (value == null) return value;

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

export function summarizeDirectPublishCaptchaArtifactCapture(artifactResult = null, { nowIso = new Date().toISOString() } = {}) {
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

export function summarizeDirectPublishCaptchaSubmitResult(submitResult = null, { nowIso = new Date().toISOString() } = {}) {
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

export function buildMergedDirectPublishCaptchaState({
  existingState = null,
  tabId = null,
  status = undefined,
  url = undefined,
  requestData = undefined,
  captchaContext = null,
  handoff = null,
  submitResult = null,
  lastCaptchaWait = undefined,
  lastDraftRestore = undefined,
  lastCheckedAt = undefined,
  nowIso = new Date().toISOString()
} = {}) {
  const rawExisting = existingState && typeof existingState === 'object'
    ? (cloneJsonValue(existingState) || existingState)
    : {};
  const normalizedExistingTabId = Number.isInteger(Number(rawExisting.tabId)) ? Number(rawExisting.tabId) : null;
  const normalizedTargetTabId = Number.isInteger(Number(tabId)) ? Number(tabId) : null;
  const shouldReuseExistingCaptchaMetadata = normalizedExistingTabId !== null
    && normalizedTargetTabId !== null
    && normalizedExistingTabId === normalizedTargetTabId;
  const existing = shouldReuseExistingCaptchaMetadata
    ? rawExisting
    : {
        ...rawExisting,
        captchaContext: null,
        lastCaptchaArtifactCapture: null,
        lastCaptchaSubmitResult: null
      };
  const existingContext = cloneJsonValue(existing.captchaContext) || null;
  const explicitContext = cloneJsonValue(captchaContext) || null;
  const handoffContext = cloneJsonValue(handoff?.captchaContext) || null;
  const nextCaptchaContext = {};
  let hasCaptchaContext = false;

  for (const context of [existingContext, explicitContext, handoffContext]) {
    if (!context || typeof context !== 'object') continue;
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined || value === null) continue;
      nextCaptchaContext[key] = cloneJsonValue(value) || value;
      hasCaptchaContext = true;
    }
  }

  const solveHints = cloneJsonValue(nextCaptchaContext.solveHints)
    || cloneJsonValue(handoff?.captchaArtifacts?.solveHints)
    || cloneJsonValue(existingContext?.solveHints)
    || null;
  if (hasCaptchaContext && solveHints && !nextCaptchaContext.solveHints) {
    nextCaptchaContext.solveHints = cloneJsonValue(solveHints);
  }

  const nextState = {
    ...existing,
    tabId: tabId ?? existing.tabId ?? null,
    status: status === undefined ? (existing.status || null) : status,
    url: url === undefined
      ? ((hasCaptchaContext ? nextCaptchaContext.url : null) || existing.url || null)
      : (url || (hasCaptchaContext ? nextCaptchaContext.url : null) || existing.url || null),
    captchaContext: hasCaptchaContext ? nextCaptchaContext : null,
    requestData: requestData === undefined ? (existing.requestData ?? null) : (requestData ?? null),
    lastCaptchaArtifactCapture: summarizeDirectPublishCaptchaArtifactCapture(handoff?.captchaArtifacts, { nowIso })
      || cloneJsonValue(existing.lastCaptchaArtifactCapture)
      || null,
    lastCaptchaSubmitResult: summarizeDirectPublishCaptchaSubmitResult(submitResult, { nowIso })
      || cloneJsonValue(existing.lastCaptchaSubmitResult)
      || null,
    lastCheckedAt: lastCheckedAt === undefined ? nowIso : (lastCheckedAt ?? nowIso)
  };

  const resolvedLastCaptchaWait = lastCaptchaWait === undefined
    ? cloneJsonValue(existing.lastCaptchaWait)
    : (lastCaptchaWait ?? null);
  if (resolvedLastCaptchaWait !== undefined) {
    nextState.lastCaptchaWait = resolvedLastCaptchaWait;
  }

  const resolvedLastDraftRestore = lastDraftRestore === undefined
    ? cloneJsonValue(existing.lastDraftRestore)
    : (lastDraftRestore ?? null);
  if (resolvedLastDraftRestore !== undefined) {
    nextState.lastDraftRestore = resolvedLastDraftRestore;
  }

  if ('solveHints' in nextState) {
    delete nextState.solveHints;
  }

  return nextState;
}
