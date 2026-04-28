const DEFAULT_EXTENSION_ID = 'hgilggglgpcjbkkmocmjpkcbhnhebjao';
const DEFAULT_CHROME_DEBUG_BASE_URL = 'http://127.0.0.1:18800';
const DEFAULT_RUNTIME_TIMEOUT_MS = 90000;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 5000;
const DEFAULT_DEVTOOLS_HTTP_TIMEOUT_MS = 5000;
const DEFAULT_DEVTOOLS_COMMAND_TIMEOUT_MS = 10000;

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseCliArgs(argv, {
  env = process.env,
  defaults = {}
} = {}) {
  const options = {
    action: null,
    dataJson: null,
    dataFile: null,
    dataStdin: false,
    chromeDebugBaseUrl: defaults.chromeDebugBaseUrl || DEFAULT_CHROME_DEBUG_BASE_URL,
    extensionId: defaults.extensionId || DEFAULT_EXTENSION_ID,
    apiPageUrl: defaults.apiPageUrl || null,
    runtimeTimeoutMs: parseInteger(env.BLOG_AUTO_CALL_TIMEOUT_MS, defaults.runtimeTimeoutMs || DEFAULT_RUNTIME_TIMEOUT_MS),
    diagnosticTimeoutMs: defaults.diagnosticTimeoutMs || DEFAULT_DIAGNOSTIC_TIMEOUT_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--action':
        options.action = readOptionValue(argv, index, '--action');
        index += 1;
        break;
      case '--data-json':
        options.dataJson = readOptionValue(argv, index, '--data-json');
        index += 1;
        break;
      case '--data-file':
        options.dataFile = readOptionValue(argv, index, '--data-file');
        index += 1;
        break;
      case '--stdin':
        options.dataStdin = true;
        break;
      case '--timeout-ms':
        options.runtimeTimeoutMs = parseInteger(readOptionValue(argv, index, '--timeout-ms'), options.runtimeTimeoutMs);
        index += 1;
        break;
      case '--diagnostic-timeout-ms':
        options.diagnosticTimeoutMs = parseInteger(readOptionValue(argv, index, '--diagnostic-timeout-ms'), options.diagnosticTimeoutMs);
        index += 1;
        break;
      case '--chrome-debug-base-url':
        options.chromeDebugBaseUrl = readOptionValue(argv, index, '--chrome-debug-base-url');
        index += 1;
        break;
      case '--extension-id':
        options.extensionId = readOptionValue(argv, index, '--extension-id');
        index += 1;
        break;
      case '--api-page-url':
        options.apiPageUrl = readOptionValue(argv, index, '--api-page-url');
        index += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (!arg.startsWith('--') && !options.action) {
          options.action = arg;
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.apiPageUrl) {
    options.apiPageUrl = buildApiPageUrl(options.extensionId);
  }

  return options;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonSafe(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stripDataUrlFromArtifact(artifact) {
  if (!isPlainObject(artifact)) return artifact ?? null;
  const copy = { ...artifact };
  delete copy.dataUrl;
  return copy;
}

function compactSolveHints(solveHints) {
  if (!isPlainObject(solveHints)) return solveHints ?? null;
  const {
    prompt,
    answerMode,
    submitField,
    targetEntity,
    nextAction,
    challengeKind,
    challengeLengthHint,
    preferredSolveMode
  } = solveHints;
  return {
    prompt: typeof prompt === 'string' ? prompt : null,
    answerMode: answerMode ?? null,
    submitField: submitField ?? null,
    targetEntity: targetEntity ?? null,
    nextAction: nextAction ?? null,
    challengeKind: challengeKind ?? null,
    challengeLengthHint: challengeLengthHint ?? null,
    preferredSolveMode: preferredSolveMode ?? null
  };
}

function compactCaptchaContext(captchaContext) {
  if (!isPlainObject(captchaContext)) return captchaContext ?? null;
  return {
    captchaPresent: captchaContext.captchaPresent ?? null,
    iframeCaptchaPresent: captchaContext.iframeCaptchaPresent ?? null,
    iframeShellOnly: captchaContext.iframeShellOnly ?? null,
    preferredSolveMode: captchaContext.preferredSolveMode ?? null,
    challengeText: captchaContext.challengeText ?? null,
    challengeMasked: captchaContext.challengeMasked ?? null,
    challengeSlotCount: captchaContext.challengeSlotCount ?? null,
    answerCandidates: Array.isArray(captchaContext.answerCandidates)
      ? captchaContext.answerCandidates.slice(0, 3)
      : null,
    confirmButtonText: captchaContext.confirmButtonText ?? null,
    activeAnswerInput: captchaContext.activeAnswerInput ? {
      selector: captchaContext.activeAnswerInput.selector ?? null,
      domPath: captchaContext.activeAnswerInput.domPath ?? null
    } : null,
    activeSubmitButton: captchaContext.activeSubmitButton ? {
      selector: captchaContext.activeSubmitButton.selector ?? null,
      domPath: captchaContext.activeSubmitButton.domPath ?? null,
      text: captchaContext.activeSubmitButton.text ?? null
    } : null,
    solveHints: compactSolveHints(captchaContext.solveHints)
  };
}

function compactCaptchaSubmitResult(result) {
  if (!isPlainObject(result)) return result ?? null;
  return {
    success: result.success ?? null,
    status: result.status ?? null,
    captchaStillAppears: result.captchaStillAppears ?? null,
    error: result.error ?? null,
    beforePreferredSolveMode: result.beforeContext?.preferredSolveMode ?? null,
    afterPreferredSolveMode: result.afterContext?.preferredSolveMode ?? null,
    answerAttemptHistory: Array.isArray(result.answerAttemptHistory)
      ? result.answerAttemptHistory.slice(0, 3)
      : null,
    answerRetrySummary: result.answerRetrySummary ?? null
  };
}

function compactPublishConfirmationState(confirmationState) {
  if (!isPlainObject(confirmationState)) return confirmationState ?? null;
  return {
    state: confirmationState.state ?? null,
    publishLayerPresent: confirmationState.publishLayerPresent ?? null,
    confirmButtonPresent: confirmationState.confirmButtonPresent ?? null,
    confirmButtonText: confirmationState.confirmButtonText ?? null,
    confirmButtonDisabled: confirmationState.confirmButtonDisabled ?? null,
    progressTextPresent: confirmationState.progressTextPresent ?? null,
    captchaPresent: confirmationState.captchaPresent ?? null,
    safeToRetryFinalConfirm: confirmationState.safeToRetryFinalConfirm ?? null,
    safeToPollSameTab: confirmationState.safeToPollSameTab ?? null,
    recommendedAction: confirmationState.recommendedAction ?? null
  };
}

function compactPublishConfirmationRecovery(recovery) {
  if (!isPlainObject(recovery)) return recovery ?? null;
  return {
    status: recovery.status ?? null,
    retryable: recovery.retryable ?? null,
    sameTabRequired: recovery.sameTabRequired ?? null,
    recommendedAction: recovery.recommendedAction ?? null,
    updatedAt: recovery.updatedAt ?? null
  };
}

function summarizeDirectStateForDiagnostics(directState) {
  if (!isPlainObject(directState)) return directState ?? null;
  const directPublish = isPlainObject(directState.directPublish)
    ? {
        tabId: directState.directPublish.tabId ?? null,
        blogName: directState.directPublish.blogName ?? null,
        url: directState.directPublish.url ?? null,
        visibility: directState.directPublish.visibility ?? null,
        detectedAt: directState.directPublish.detectedAt ?? null,
        publishTrace: directState.directPublish.publishTrace ?? null,
        stage: directState.directPublish.stage ?? null,
        phase: directState.directPublish.phase ?? null,
        status: directState.directPublish.status ?? null,
        confirmationState: compactPublishConfirmationState(directState.directPublish.confirmationState),
        publishConfirmationRecovery: compactPublishConfirmationRecovery(directState.directPublish.publishConfirmationRecovery),
        captchaContext: compactCaptchaContext(directState.directPublish.captchaContext),
        solveHints: compactSolveHints(directState.directPublish.solveHints),
        lastCaptchaSubmitResult: compactCaptchaSubmitResult(directState.directPublish.lastCaptchaSubmitResult),
        lastCaptchaArtifactCapture: summarizeCaptchaArtifactsForDiagnostics(directState.directPublish.lastCaptchaArtifactCapture)
      }
    : directState.directPublish ?? null;

  return {
    success: directState.success ?? null,
    status: directState.status ?? null,
    error: directState.error ?? null,
    directPublish,
    directPublishRuntimeState: cloneJsonSafe(directState.directPublishRuntimeState) ?? null
  };
}

function summarizeQueueStateForDiagnostics(queueState) {
  if (!isPlainObject(queueState)) return queueState ?? null;
  const queue = Array.isArray(queueState.queue) ? queueState.queue : [];
  const counts = queue.reduce((acc, item) => {
    const status = item?.status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  const recentItems = queue.slice(-5).map((item) => ({
    id: item?.id ?? null,
    status: item?.status ?? null,
    publishStatus: item?.publishStatus ?? null,
    captchaTabId: item?.captchaTabId ?? null,
    publishConfirmTabId: item?.publishConfirmTabId ?? null,
    confirmationState: item?.confirmationState?.state ?? null,
    publishConfirmationRecovery: compactPublishConfirmationRecovery(item?.publishConfirmationRecovery),
    error: item?.error ?? null
  }));

  const captchaPausedItems = queue
    .filter((item) => item?.status === 'captcha_paused')
    .slice(0, 3)
    .map((item) => ({
      id: item?.id ?? null,
      status: item?.status ?? null,
      captchaTabId: item?.captchaTabId ?? null,
      captchaStage: item?.captchaStage ?? null,
      preferredSolveMode: item?.captchaContext?.preferredSolveMode ?? null,
      submitField: item?.solveHints?.submitField ?? null
    }));

  const publishConfirmPausedItems = queue
    .filter((item) => item?.status === 'publish_confirm_paused')
    .slice(0, 3)
    .map((item) => ({
      id: item?.id ?? null,
      status: item?.status ?? null,
      publishStatus: item?.publishStatus ?? null,
      publishConfirmTabId: item?.publishConfirmTabId ?? null,
      confirmationState: item?.confirmationState?.state ?? null,
      recommendedAction: item?.publishConfirmationRecovery?.recommendedAction
        ?? item?.confirmationState?.recommendedAction
        ?? null
    }));

  return {
    success: queueState.success ?? null,
    status: queueState.status ?? null,
    error: queueState.error ?? null,
    isProcessing: queueState.isProcessing ?? null,
    queueRuntimeState: cloneJsonSafe(queueState.queueRuntimeState) ?? null,
    total: queue.length,
    counts,
    captchaPausedItems,
    publishConfirmPausedItems,
    recentItems
  };
}

function summarizeCaptchaContextForDiagnostics(captchaContextResult) {
  if (!isPlainObject(captchaContextResult)) return captchaContextResult ?? null;
  return {
    success: captchaContextResult.success ?? null,
    status: captchaContextResult.status ?? null,
    error: captchaContextResult.error ?? null,
    tabId: captchaContextResult.tabId ?? null,
    queueItemId: captchaContextResult.queueItemId ?? null,
    queueSelection: cloneJsonSafe(captchaContextResult.queueSelection) ?? null,
    captchaContext: compactCaptchaContext(captchaContextResult.captchaContext || captchaContextResult),
    solveHints: compactSolveHints(captchaContextResult.solveHints)
  };
}

function summarizeCaptchaArtifactsForDiagnostics(artifactResult) {
  if (!isPlainObject(artifactResult)) return artifactResult ?? null;
  const artifacts = isPlainObject(artifactResult.artifacts)
    ? Object.fromEntries(
        Object.entries(artifactResult.artifacts)
          .filter(([, artifact]) => artifact != null)
          .map(([key, artifact]) => [key, stripDataUrlFromArtifact(artifact)])
      )
    : null;

  return {
    success: artifactResult.success ?? null,
    status: artifactResult.status ?? null,
    error: artifactResult.error ?? null,
    tabId: artifactResult.tabId ?? null,
    queueItemId: artifactResult.queueItemId ?? null,
    artifactPreference: artifactResult.artifactPreference ?? null,
    artifact: stripDataUrlFromArtifact(artifactResult.artifact),
    artifacts,
    solveHints: compactSolveHints(artifactResult.solveHints),
    captureContext: compactCaptchaContext(artifactResult.captureContext)
  };
}

function classifyBridgeTimeoutCause({ action, directState, queueState, captchaContext } = {}) {
  const directPublish = directState?.directPublish;
  const directRuntime = directState?.directPublishRuntimeState;
  const directCaptchaPresent = directPublish?.captchaContext?.captchaPresent === true
    || captchaContext?.captchaContext?.captchaPresent === true;
  if (directRuntime?.active && directCaptchaPresent) {
    return 'direct_publish_captcha_wait_active';
  }

  const directPublishStatus = String(directPublish?.status || '').trim();
  if (directPublish?.phase === 'publish_confirmation'
    || directPublishStatus.startsWith('publish_confirm_')
    || directPublish?.publishConfirmationRecovery?.status) {
    return 'direct_publish_confirmation_pending';
  }

  const queueItems = Array.isArray(queueState?.queue) ? queueState.queue : [];
  const pausedItem = queueItems.find((item) => item?.status === 'captcha_paused');
  if (pausedItem) {
    return 'queue_captcha_paused';
  }

  const publishConfirmPausedItem = queueItems.find((item) => item?.status === 'publish_confirm_paused');
  if (publishConfirmPausedItem) {
    return 'queue_publish_confirmation_paused';
  }

  if (directRuntime?.active) {
    return 'direct_publish_runtime_active';
  }

  if (queueState?.queueRuntimeState?.active || queueState?.isProcessing) {
    return 'queue_runtime_active';
  }

  if (action === 'PREPARE_EDITOR') {
    return 'editor_prepare_unresolved';
  }

  if (action === 'WRITE_POST') {
    return 'write_post_unresolved';
  }

  return 'extension_bridge_no_callback';
}

function normalizeBridgeDiagnosticError(error, status = 'bridge_diagnostic_error') {
  return {
    success: false,
    status,
    error: error?.message || String(error) || 'Unknown diagnostic collection error'
  };
}

function buildTimeoutDiagnosticFailurePayload(error) {
  const failure = normalizeBridgeDiagnosticError(error);

  return {
    directState: { ...failure },
    queueState: { ...failure },
    captchaContext: { ...failure },
    captchaArtifacts: { ...failure }
  };
}

function buildBridgeTimeoutResult({
  action,
  runtimeTimeoutMs,
  timedOutAt,
  startedAt,
  apiTarget,
  directState,
  queueState,
  captchaContext,
  captchaArtifacts
}) {
  const bridgeDiagnostics = {
    action,
    runtimeTimeoutMs,
    startedAt,
    timedOutAt,
    apiTarget: cloneJsonSafe(apiTarget) ?? null,
    inferredCause: classifyBridgeTimeoutCause({ action, directState, queueState, captchaContext }),
    directState: summarizeDirectStateForDiagnostics(directState),
    queueState: summarizeQueueStateForDiagnostics(queueState),
    captchaContext: summarizeCaptchaContextForDiagnostics(captchaContext),
    captchaArtifacts: summarizeCaptchaArtifactsForDiagnostics(captchaArtifacts)
  };

  return {
    success: false,
    status: 'bridge_timeout',
    error: `${action} did not return a callback within ${runtimeTimeoutMs}ms.`,
    action,
    runtimeTimeoutMs,
    bridgeDiagnostics
  };
}

function summarizeBrowserVersionForDiagnostics(versionResult) {
  if (!isPlainObject(versionResult)) return versionResult ?? null;
  return {
    success: true,
    browser: versionResult.Browser ?? null,
    protocolVersion: versionResult['Protocol-Version'] ?? null,
    userAgent: versionResult['User-Agent'] ?? null,
    hasWebSocketDebuggerUrl: Boolean(versionResult.webSocketDebuggerUrl)
  };
}

function summarizeDebugTargetsForDiagnostics(targets, apiPageUrl) {
  if (!Array.isArray(targets)) return targets ?? null;

  const pageTargets = targets.filter((target) => target?.type === 'page');
  const apiTarget = pageTargets.find((target) => target?.url === apiPageUrl) || null;

  return {
    success: true,
    total: targets.length,
    pageTargetCount: pageTargets.length,
    otherPageTargetCount: Math.max(pageTargets.length - (apiTarget ? 1 : 0), 0),
    apiTarget: apiTarget
      ? {
          present: true,
          id: apiTarget.id ?? null,
          title: apiTarget.title ?? null,
          url: apiTarget.url ?? null,
          attached: apiTarget.attached ?? null,
          hasWebSocketDebuggerUrl: Boolean(apiTarget.webSocketDebuggerUrl)
        }
      : {
          present: false,
          url: apiPageUrl
        }
  };
}

function buildSetupDiagnosticFailurePayload(error) {
  const failure = normalizeBridgeDiagnosticError(error);
  return {
    browserVersion: { ...failure },
    debugTargets: { ...failure }
  };
}

async function collectSetupDiagnostics({
  chromeDebugBaseUrl = DEFAULT_CHROME_DEBUG_BASE_URL,
  apiPageUrl,
  timeoutMs = DEFAULT_DIAGNOSTIC_TIMEOUT_MS
}) {
  const browserVersion = await getBrowserVersion(chromeDebugBaseUrl, { timeoutMs })
    .then((result) => summarizeBrowserVersionForDiagnostics(result))
    .catch((error) => normalizeBridgeDiagnosticError(error));

  const debugTargets = await listDebugTargets(chromeDebugBaseUrl, { timeoutMs })
    .then((targets) => summarizeDebugTargetsForDiagnostics(targets, apiPageUrl))
    .catch((error) => normalizeBridgeDiagnosticError(error));

  return {
    browserVersion,
    debugTargets
  };
}

function classifyBridgeSetupFailure({ stage, error, browserVersion, debugTargets, apiTarget } = {}) {
  const message = error?.message || String(error) || '';

  if (stage === 'call_extension_action') {
    if (apiTarget && !apiTarget.webSocketDebuggerUrl) {
      return 'api_page_target_missing_websocket';
    }
    if (/Timed out connecting to Chrome DevTools websocket/i.test(message)) {
      return 'devtools_websocket_connect_timeout';
    }
    if (/Timed out waiting for Chrome DevTools response/i.test(message)) {
      return 'devtools_command_timeout';
    }
    if (/websocket closed/i.test(message)) {
      return 'devtools_websocket_closed';
    }
    if (/Protocol error/i.test(message)) {
      return 'devtools_protocol_error';
    }
    if (browserVersion?.success === false || debugTargets?.success === false) {
      return 'bridge_transport_error';
    }
    return 'bridge_transport_error';
  }

  if (browserVersion?.success === false || debugTargets?.success === false) {
    if (/fetch failed|network|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|Chrome DevTools endpoint|DevTools websocket|timed out/i.test(message)) {
      return 'devtools_unreachable';
    }
    return 'devtools_diagnostic_unavailable';
  }

  if (stage === 'ensure_api_target') {
    if (debugTargets?.apiTarget?.present === false) {
      return 'api_page_target_missing';
    }
    if (debugTargets?.apiTarget?.present === true && !debugTargets.apiTarget.hasWebSocketDebuggerUrl) {
      return 'api_page_target_missing_websocket';
    }
    if (/Failed to create or discover API page target/i.test(message)) {
      return 'api_page_target_create_failed';
    }
  }

  return 'bridge_setup_error';
}

function buildBridgeSetupFailureResult({
  action,
  stage,
  error,
  runtimeTimeoutMs,
  startedAt,
  failedAt,
  chromeDebugBaseUrl,
  apiPageUrl,
  apiTarget,
  browserVersion,
  debugTargets
}) {
  const normalizedError = error instanceof Error
    ? error
    : new Error(String(error || 'Unknown bridge setup error'));

  return {
    success: false,
    status: stage === 'call_extension_action' ? 'bridge_transport_error' : 'bridge_setup_error',
    error: normalizedError.message,
    action,
    bridgeDiagnostics: {
      stage,
      startedAt,
      failedAt,
      runtimeTimeoutMs,
      chromeDebugBaseUrl,
      apiPageUrl,
      apiTarget: apiTarget ? {
        id: apiTarget.id ?? null,
        title: apiTarget.title ?? null,
        url: apiTarget.url ?? null,
        hasWebSocketDebuggerUrl: Boolean(apiTarget.webSocketDebuggerUrl)
      } : null,
      inferredCause: classifyBridgeSetupFailure({
        stage,
        error: normalizedError,
        browserVersion,
        debugTargets,
        apiTarget
      }),
      browserVersion: cloneJsonSafe(browserVersion) ?? null,
      debugTargets: cloneJsonSafe(debugTargets) ?? null
    }
  };
}

async function fetchJson(baseUrl, path, {
  method = 'GET',
  body,
  timeoutMs = DEFAULT_DEVTOOLS_HTTP_TIMEOUT_MS
} = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Chrome DevTools endpoint ${path} returned HTTP ${response.status}`);
  }
  return await response.json();
}

function buildApiPageUrl(extensionId = DEFAULT_EXTENSION_ID) {
  return `chrome-extension://${extensionId}/api/api-page.html`;
}

async function listDebugTargets(chromeDebugBaseUrl = DEFAULT_CHROME_DEBUG_BASE_URL, {
  timeoutMs = DEFAULT_DEVTOOLS_HTTP_TIMEOUT_MS
} = {}) {
  return await fetchJson(chromeDebugBaseUrl, '/json/list', { timeoutMs });
}

async function getBrowserVersion(chromeDebugBaseUrl = DEFAULT_CHROME_DEBUG_BASE_URL, {
  timeoutMs = DEFAULT_DEVTOOLS_HTTP_TIMEOUT_MS
} = {}) {
  return await fetchJson(chromeDebugBaseUrl, '/json/version', { timeoutMs });
}

async function findApiTarget({
  chromeDebugBaseUrl = DEFAULT_CHROME_DEBUG_BASE_URL,
  apiPageUrl,
  timeoutMs = DEFAULT_DEVTOOLS_HTTP_TIMEOUT_MS
}) {
  const targets = await listDebugTargets(chromeDebugBaseUrl, { timeoutMs });
  return targets.find((target) => target.type === 'page' && target.url === apiPageUrl) || null;
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.websocket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect({ timeoutMs = DEFAULT_DEVTOOLS_COMMAND_TIMEOUT_MS } = {}) {
    if (this.websocket) return;
    this.websocket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          this.websocket?.close();
        } catch {}
        reject(new Error(`Timed out connecting to Chrome DevTools websocket after ${timeoutMs}ms`));
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(new Error(event?.message || 'Failed to connect to Chrome DevTools websocket'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.websocket?.removeEventListener('open', onOpen);
        this.websocket?.removeEventListener('error', onError);
      };
      this.websocket.addEventListener('open', onOpen, { once: true });
      this.websocket.addEventListener('error', onError, { once: true });
    });

    this.websocket.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data);
      if (!('id' in payload)) return;
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message || 'Chrome DevTools Protocol error'));
        return;
      }
      pending.resolve(payload.result ?? null);
    });

    this.websocket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Chrome DevTools websocket closed before the command resolved'));
      }
      this.pending.clear();
      this.websocket = null;
    });
  }

  async send(method, params = {}, { timeoutMs = DEFAULT_DEVTOOLS_COMMAND_TIMEOUT_MS } = {}) {
    await this.connect({ timeoutMs });
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.websocket?.close();
        } catch {}
        reject(new Error(`Timed out waiting for Chrome DevTools response to ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.websocket.send(payload);
    });
  }

  async close() {
    if (!this.websocket) return;
    const websocket = this.websocket;
    this.websocket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Chrome DevTools websocket closed before the command resolved'));
    }
    this.pending.clear();
    await new Promise((resolve) => {
      websocket.addEventListener('close', () => resolve(), { once: true });
      websocket.close();
    }).catch(() => {});
  }
}

async function createApiTarget({
  chromeDebugBaseUrl = DEFAULT_CHROME_DEBUG_BASE_URL,
  apiPageUrl,
  timeoutMs = DEFAULT_DEVTOOLS_HTTP_TIMEOUT_MS
}) {
  const version = await getBrowserVersion(chromeDebugBaseUrl, { timeoutMs });
  const browserClient = new CdpClient(version.webSocketDebuggerUrl);
  try {
    const result = await browserClient.send('Target.createTarget', { url: apiPageUrl }, { timeoutMs });
    return result?.targetId || null;
  } finally {
    await browserClient.close();
  }
}

async function ensureApiTarget({
  chromeDebugBaseUrl = DEFAULT_CHROME_DEBUG_BASE_URL,
  apiPageUrl,
  createTimeoutMs = 5000
}) {
  const httpTimeoutMs = Math.max(1000, Math.min(createTimeoutMs, DEFAULT_DEVTOOLS_HTTP_TIMEOUT_MS));
  let target = await findApiTarget({ chromeDebugBaseUrl, apiPageUrl, timeoutMs: httpTimeoutMs });
  if (target) return target;

  await createApiTarget({ chromeDebugBaseUrl, apiPageUrl, timeoutMs: httpTimeoutMs });
  const deadline = Date.now() + createTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    target = await findApiTarget({ chromeDebugBaseUrl, apiPageUrl, timeoutMs: httpTimeoutMs });
    if (target) return target;
  }

  throw new Error(`Failed to create or discover API page target for ${apiPageUrl}`);
}

function buildBridgeExpression({ extensionId, action, data, runtimeTimeoutMs }) {
  const payloadJson = JSON.stringify({ action, data });
  const extensionIdJson = JSON.stringify(extensionId);
  return `(() => {
    const payload = ${payloadJson};
    const extensionId = ${extensionIdJson};
    const runtimeTimeoutMs = ${Number(runtimeTimeoutMs)};
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({
          __bridgeTimeout: true,
          action: payload.action,
          runtimeTimeoutMs,
          elapsedMs: Date.now() - startedAt
        });
      }, runtimeTimeoutMs);
      try {
        chrome.runtime.sendMessage(extensionId, payload, (response) => {
          clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            finish({
              __bridgeError: true,
              action: payload.action,
              error: lastError.message,
              elapsedMs: Date.now() - startedAt
            });
            return;
          }
          finish(response ?? null);
        });
      } catch (error) {
        clearTimeout(timer);
        finish({
          __bridgeError: true,
          action: payload.action,
          error: error?.message || String(error),
          elapsedMs: Date.now() - startedAt
        });
      }
    });
  })()`;
}

async function evaluateOnTarget({
  targetWebSocketUrl,
  expression,
  timeoutMs = DEFAULT_DEVTOOLS_COMMAND_TIMEOUT_MS
}) {
  const client = new CdpClient(targetWebSocketUrl);
  try {
    const result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, { timeoutMs });
    return result?.result?.value ?? null;
  } finally {
    await client.close();
  }
}

async function callExtensionAction({
  targetWebSocketUrl,
  extensionId = DEFAULT_EXTENSION_ID,
  action,
  data = {},
  runtimeTimeoutMs = DEFAULT_RUNTIME_TIMEOUT_MS
}) {
  const expression = buildBridgeExpression({ extensionId, action, data, runtimeTimeoutMs });
  const cdpTimeoutMs = Math.max(runtimeTimeoutMs + 10000, DEFAULT_DEVTOOLS_COMMAND_TIMEOUT_MS);
  return await evaluateOnTarget({ targetWebSocketUrl, expression, timeoutMs: cdpTimeoutMs });
}

function pickDiagnosticCaptchaTarget({ action, originalData = {}, directState, queueState }) {
  const explicitId = typeof originalData.id === 'string' && originalData.id.trim() ? originalData.id.trim() : null;
  if (explicitId) return { id: explicitId };

  const explicitTabId = Number.isInteger(originalData.tabId) && originalData.tabId > 0 ? originalData.tabId : null;
  if (explicitTabId) return { tabId: explicitTabId };

  const directTabId = directState?.directPublish?.tabId;
  if (Number.isInteger(directTabId) && directTabId > 0) {
    return { tabId: directTabId };
  }

  const pausedItems = Array.isArray(queueState?.queue)
    ? queueState.queue.filter((item) => item?.status === 'captcha_paused')
    : [];
  if (pausedItems.length === 1 && pausedItems[0]?.id) {
    return { id: pausedItems[0].id };
  }

  if (action === 'SUBMIT_CAPTCHA' || action === 'SUBMIT_CAPTCHA_AND_RESUME' || action === 'GET_CAPTCHA_CONTEXT' || action === 'GET_CAPTCHA_ARTIFACTS') {
    return {};
  }

  return null;
}

function normalizeDiagnosticCallResult(result) {
  if (result?.__bridgeTimeout) {
    return {
      success: false,
      status: 'bridge_diagnostic_timeout',
      error: `${result.action || 'Diagnostic action'} timed out after ${result.runtimeTimeoutMs}ms`
    };
  }
  if (result?.__bridgeError) {
    return {
      success: false,
      status: 'bridge_diagnostic_error',
      error: result.error || 'Diagnostic bridge call failed'
    };
  }
  return result;
}

async function collectTimeoutDiagnostics({
  targetWebSocketUrl,
  extensionId = DEFAULT_EXTENSION_ID,
  action,
  originalData = {},
  runtimeTimeoutMs = DEFAULT_DIAGNOSTIC_TIMEOUT_MS
}) {
  const directState = normalizeDiagnosticCallResult(await callExtensionAction({
    targetWebSocketUrl,
    extensionId,
    action: 'GET_DIRECT_PUBLISH_STATE',
    data: { includeCaptchaContext: true },
    runtimeTimeoutMs
  }).catch((error) => ({ success: false, status: 'bridge_diagnostic_error', error: error.message })));

  const queueState = normalizeDiagnosticCallResult(await callExtensionAction({
    targetWebSocketUrl,
    extensionId,
    action: 'GET_QUEUE',
    data: {},
    runtimeTimeoutMs
  }).catch((error) => ({ success: false, status: 'bridge_diagnostic_error', error: error.message })));

  const captchaTarget = pickDiagnosticCaptchaTarget({
    action,
    originalData,
    directState,
    queueState
  });

  let captchaContext = null;
  let captchaArtifacts = null;
  if (captchaTarget) {
    captchaContext = normalizeDiagnosticCallResult(await callExtensionAction({
      targetWebSocketUrl,
      extensionId,
      action: 'GET_CAPTCHA_CONTEXT',
      data: captchaTarget,
      runtimeTimeoutMs
    }).catch((error) => ({ success: false, status: 'bridge_diagnostic_error', error: error.message })));

    captchaArtifacts = normalizeDiagnosticCallResult(await callExtensionAction({
      targetWebSocketUrl,
      extensionId,
      action: 'GET_CAPTCHA_ARTIFACTS',
      data: captchaTarget,
      runtimeTimeoutMs
    }).catch((error) => ({ success: false, status: 'bridge_diagnostic_error', error: error.message })));
  }

  return {
    directState,
    queueState,
    captchaContext,
    captchaArtifacts
  };
}

export {
  DEFAULT_CHROME_DEBUG_BASE_URL,
  DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
  DEFAULT_EXTENSION_ID,
  DEFAULT_RUNTIME_TIMEOUT_MS,
  buildApiPageUrl,
  buildBridgeSetupFailureResult,
  buildBridgeTimeoutResult,
  buildSetupDiagnosticFailurePayload,
  buildTimeoutDiagnosticFailurePayload,
  callExtensionAction,
  classifyBridgeSetupFailure,
  classifyBridgeTimeoutCause,
  collectSetupDiagnostics,
  collectTimeoutDiagnostics,
  ensureApiTarget,
  evaluateOnTarget,
  listDebugTargets,
  parseCliArgs,
  pickDiagnosticCaptchaTarget,
  summarizeBrowserVersionForDiagnostics,
  summarizeCaptchaArtifactsForDiagnostics,
  summarizeDebugTargetsForDiagnostics,
  summarizeQueueStateForDiagnostics
};
