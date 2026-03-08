/**
 * Background Service Worker
 * - Popup ↔ Content Script 메시지 라우팅
 * - 외부 API 수신 (externally_connectable)
 * - 발행 큐 관리
 */

// ── 발행 큐 / 직접 발행 상태 ─────────────────────
let publishQueue = [];
let isProcessing = false;
let currentTabId = null;
let directPublishState = null;

const DIRECT_PUBLISH_STATE_KEY = 'directPublishState';

const EDITOR_PREPARE_DEFAULTS = {
  loadTimeoutMs: 15000,
  pingTimeoutMs: 1500,
  pingRetries: 5,
  pingIntervalMs: 800,
  postLoadDelayMs: 700
};

/**
 * 큐 상태를 스토리지에 저장
 */
async function saveQueueState() {
  await chrome.storage.local.set({
    publishQueue: publishQueue.map(item => ({
      ...item,
      status: item.status,
      error: item.error || null
    }))
  });
}

/**
 * 큐 상태 로드
 */
async function loadQueueState() {
  const result = await chrome.storage.local.get('publishQueue');
  if (result.publishQueue) {
    publishQueue = result.publishQueue;
  }
}

async function loadDirectPublishState() {
  const result = await chrome.storage.local.get(DIRECT_PUBLISH_STATE_KEY);
  directPublishState = result[DIRECT_PUBLISH_STATE_KEY] || null;
}

async function persistDirectPublishState() {
  if (directPublishState) {
    await chrome.storage.local.set({ [DIRECT_PUBLISH_STATE_KEY]: directPublishState });
  } else {
    await chrome.storage.local.remove(DIRECT_PUBLISH_STATE_KEY);
  }
}

async function setDirectPublishState(state) {
  directPublishState = state ? { ...state } : null;
  await persistDirectPublishState();
  return directPublishState;
}

async function clearDirectPublishState() {
  directPublishState = null;
  await persistDirectPublishState();
}

async function updateDirectPublishState(patch = {}) {
  if (!directPublishState) return null;
  directPublishState = {
    ...directPublishState,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await persistDirectPublishState();
  return directPublishState;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildNewPostUrl(blogName) {
  return `https://${blogName}.tistory.com/manage/newpost`;
}

function getTabBlogName(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('.tistory.com')) return null;
    return parsed.hostname.replace(/\.tistory\.com$/, '');
  } catch (_) {
    return null;
  }
}

function isManageTab(url) {
  return typeof url === 'string' && url.includes('.tistory.com/manage/');
}

function isNewPostTab(url) {
  return typeof url === 'string' && url.includes('/manage/newpost');
}

function isEditPostTab(url) {
  return typeof url === 'string' && url.includes('/manage/post/');
}

function normalizeUrl(url) {
  return typeof url === 'string' ? url.split('#')[0] : null;
}

function makePreparationResponse({ success, status, error = null, tab = null, url = null, tabId = null, blogName = null, diagnostics }) {
  return {
    success,
    status,
    error,
    url: url ?? tab?.url ?? null,
    tabId: tabId ?? tab?.id ?? null,
    blogName: blogName || getTabBlogName(tab?.url) || null,
    diagnostics
  };
}

function withPreparationDetails(response, preparation) {
  if (!preparation) return response;

  const next = {
    ...response,
    tabId: response.tabId ?? preparation.tabId ?? null,
    blogName: response.blogName ?? preparation.blogName ?? null,
    diagnostics: preparation.diagnostics
  };

  if (!response.url && preparation.url) {
    next.url = preparation.url;
  } else if (response.url && preparation.url) {
    next.editorUrl = preparation.url;
  }

  return next;
}

function buildDirectPublishState({ response, preparation, requestData = {}, captchaContext = null }) {
  return {
    tabId: response?.tabId ?? preparation?.tabId ?? null,
    blogName: requestData.blogName || response?.blogName || preparation?.blogName || null,
    url: response?.editorUrl || response?.url || preparation?.url || null,
    visibility: requestData.visibility || null,
    status: response?.status || 'captcha_required',
    detectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnostics: preparation?.diagnostics || null,
    captchaContext: captchaContext || null
  };
}

function attachDirectPublishState(response, state = directPublishState) {
  if (!state) return response;
  return {
    ...response,
    directPublish: { ...state }
  };
}

async function getLiveDirectPublishState(options = {}) {
  if (!directPublishState) return null;

  const snapshot = { ...directPublishState };

  if (!snapshot.tabId) {
    return snapshot;
  }

  try {
    const tab = await chrome.tabs.get(snapshot.tabId);
    if (tab?.url && tab.url !== snapshot.url) {
      snapshot.url = tab.url;
      await updateDirectPublishState({ url: tab.url });
    }
  } catch (error) {
    await clearDirectPublishState();
    return null;
  }

  if (options.includeCaptchaContext) {
    try {
      const captchaContext = await chrome.tabs.sendMessage(snapshot.tabId, { action: 'GET_CAPTCHA_CONTEXT' });
      snapshot.captchaContext = captchaContext;
      await updateDirectPublishState({ captchaContext, url: captchaContext?.url || snapshot.url });
    } catch (error) {
      snapshot.captchaContext = { success: false, error: error.message };
    }
  }

  return snapshot;
}

async function buildPreparationFromDirectPublishState(options = {}) {
  const requestedBlogName = options.blogName || null;
  const liveState = await getLiveDirectPublishState();
  if (!liveState?.tabId) {
    return null;
  }

  const diagnostics = {
    requestedBlogName,
    blogName: liveState.blogName || requestedBlogName || null,
    currentTabId,
    candidateCount: 1,
    source: 'direct_publish_state',
    attempts: []
  };

  const resumeProbe = await probeTabReady(liveState.tabId, diagnostics, 'probe_saved_direct_publish_tab');
  if (!resumeProbe.success) {
    await updateDirectPublishState({
      lastProbeError: resumeProbe.error,
      lastProbeAt: new Date().toISOString(),
      diagnostics
    });
    return null;
  }

  const tab = await chrome.tabs.get(liveState.tabId);
  currentTabId = liveState.tabId;

  return makePreparationResponse({
    success: true,
    status: 'editor_ready',
    tab,
    blogName: liveState.blogName || requestedBlogName || null,
    diagnostics
  });
}

async function getCaptchaContextForTab(tabId) {
  if (!tabId) {
    return { success: false, status: 'editor_not_ready', error: 'CAPTCHA 컨텍스트를 읽을 탭 ID가 없습니다.' };
  }

  try {
    const captchaContext = await chrome.tabs.sendMessage(tabId, { action: 'GET_CAPTCHA_CONTEXT' });
    return { success: true, tabId, captchaContext };
  } catch (error) {
    return { success: false, status: 'editor_not_ready', error: error.message, tabId };
  }
}

function normalizeCaptchaAnswer(answer) {
  const raw = String(answer ?? '');
  const trimmed = raw.trim();
  const withoutWhitespace = trimmed.replace(/\s+/g, '');
  const value = withoutWhitespace || trimmed;
  const summary = {
    changed: value !== raw,
    strategy: !trimmed ? 'empty' : (value !== trimmed ? 'remove_whitespace' : (trimmed !== raw ? 'trim' : 'none')),
    originalLength: raw.length,
    normalizedLength: value.length
  };

  return {
    value,
    summary
  };
}

async function submitCaptchaForTab(tabId, answer, options = {}) {
  if (!tabId) {
    return { success: false, status: 'editor_not_ready', error: 'CAPTCHA 답안을 전달할 탭 ID가 없습니다.' };
  }

  const normalization = normalizeCaptchaAnswer(answer);
  if (!normalization.value) {
    return { success: false, status: 'captcha_answer_required', error: 'CAPTCHA 답안을 입력하세요.', tabId, answerNormalization: normalization.summary };
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'SUBMIT_CAPTCHA',
      data: {
        answer: normalization.value,
        waitMs: options.waitMs
      }
    });
    return {
      ...result,
      tabId,
      answerNormalization: normalization.summary
    };
  } catch (error) {
    return { success: false, status: 'editor_not_ready', error: error.message, tabId, answerNormalization: normalization.summary };
  }
}

async function refreshDirectPublishCaptchaState(tabId, submitResult) {
  if (!tabId) {
    return null;
  }

  const refreshedContext = await getCaptchaContextForTab(tabId);
  if (directPublishState?.tabId === tabId) {
    await updateDirectPublishState({
      url: refreshedContext.success ? (refreshedContext.captchaContext?.url || directPublishState?.url) : directPublishState?.url,
      captchaContext: refreshedContext.success ? refreshedContext.captchaContext : refreshedContext,
      lastCheckedAt: new Date().toISOString(),
      lastCaptchaSubmitResult: {
        success: submitResult.success,
        status: submitResult.status || null,
        captchaStillAppears: submitResult.captchaStillAppears ?? refreshedContext?.captchaContext?.captchaPresent ?? null,
        answerLength: typeof submitResult.answerLength === 'number' ? submitResult.answerLength : null,
        normalization: submitResult.answerNormalization || null,
        updatedAt: new Date().toISOString()
      }
    });
  }

  return refreshedContext;
}

async function buildPreparationFromPreferredTab(tabId, requestData = {}) {
  if (!tabId) return null;

  const diagnostics = {
    requestedBlogName: requestData.blogName || null,
    blogName: requestData.blogName || directPublishState?.blogName || null,
    currentTabId,
    candidateCount: 1,
    source: 'preferred_tab',
    attempts: []
  };

  const resumeProbe = await probeTabReady(tabId, diagnostics, 'probe_preferred_direct_publish_tab');
  if (!resumeProbe.success) {
    diagnostics.attempts.push({
      step: 'probe_preferred_direct_publish_tab_failed',
      error: resumeProbe.error,
      at: new Date().toISOString()
    });
    return null;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    currentTabId = tabId;

    return makePreparationResponse({
      success: true,
      status: 'editor_ready',
      tab,
      blogName: requestData.blogName || directPublishState?.blogName || getTabBlogName(tab.url) || null,
      diagnostics
    });
  } catch (error) {
    diagnostics.attempts.push({
      step: 'probe_preferred_direct_publish_tab_missing',
      error: error.message,
      at: new Date().toISOString()
    });
    return null;
  }
}

async function resumeDirectPublishFlow(requestData = {}, options = {}) {
  let preparation = await buildPreparationFromPreferredTab(options.preferredTabId || null, requestData);
  if (!preparation) {
    preparation = await buildPreparationFromDirectPublishState({ blogName: requestData.blogName || null });
  }
  if (!preparation) {
    preparation = await prepareEditorTab({ blogName: requestData.blogName || directPublishState?.blogName || null });
  }
  if (!preparation.success) {
    return attachDirectPublishState(preparation);
  }

  try {
    const captchaCheck = await chrome.tabs.sendMessage(preparation.tabId, { action: 'CHECK_CAPTCHA' });
    if (captchaCheck?.captchaPresent) {
      const captchaContextResult = await getCaptchaContextForTab(preparation.tabId);
      const liveState = await getLiveDirectPublishState();
      const nextState = liveState || buildDirectPublishState({
        response: { ...captchaCheck, status: 'captcha_required', tabId: preparation.tabId },
        preparation,
        requestData,
        captchaContext: captchaContextResult.success ? captchaContextResult.captchaContext : captchaContextResult
      });
      await setDirectPublishState({
        ...nextState,
        tabId: preparation.tabId,
        blogName: requestData.blogName || nextState.blogName || preparation.blogName,
        url: preparation.url || nextState.url,
        status: 'captcha_required',
        captchaContext: captchaContextResult.success ? captchaContextResult.captchaContext : captchaContextResult
      });
      return attachDirectPublishState(withPreparationDetails({
        success: false,
        error: 'CAPTCHA가 아직 표시되어 있습니다.',
        status: 'captcha_required'
      }, preparation));
    }
  } catch (e) { /* 진행 */ }

  try {
    await ensurePageWorldVisibilityInterceptor(preparation.tabId);
    const response = await chrome.tabs.sendMessage(preparation.tabId, {
      action: 'RESUME_PUBLISH',
      data: { visibility: requestData.visibility || directPublishState?.visibility || 'public' }
    });
    const responseWithPreparation = withPreparationDetails(response, preparation);

    if (responseWithPreparation.success) {
      await clearDirectPublishState();
      return responseWithPreparation;
    }

    if (responseWithPreparation.status === 'captcha_required') {
      const captchaContextResult = await getCaptchaContextForTab(preparation.tabId);
      const directState = buildDirectPublishState({
        response: responseWithPreparation,
        preparation,
        requestData: {
          ...requestData,
          blogName: requestData.blogName || directPublishState?.blogName || preparation.blogName,
          visibility: requestData.visibility || directPublishState?.visibility || null
        },
        captchaContext: captchaContextResult.success ? captchaContextResult.captchaContext : captchaContextResult
      });
      await setDirectPublishState(directState);
      return attachDirectPublishState(responseWithPreparation, directState);
    }

    return attachDirectPublishState(responseWithPreparation);
  } catch (e) {
    return attachDirectPublishState(makePreparationResponse({
      success: false,
      status: 'editor_not_ready',
      error: e.message,
      tabId: preparation.tabId,
      url: preparation.url,
      blogName: preparation.blogName,
      diagnostics: preparation.diagnostics
    }));
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

async function blobToDataUrl(blob) {
  const mimeType = blob.type || 'application/octet-stream';
  const buffer = await blob.arrayBuffer();
  return `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`;
}

async function prepareCaptchaCaptureForTab(tabId) {
  if (!tabId) {
    return { success: false, status: 'editor_not_ready', error: 'CAPTCHA 캡처를 준비할 탭 ID가 없습니다.' };
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, { action: 'PREPARE_CAPTCHA_CAPTURE' });
    return { ...result, tabId };
  } catch (error) {
    return { success: false, status: 'editor_not_ready', error: error.message, tabId };
  }
}

async function getCaptchaImageArtifactForTab(tabId) {
  if (!tabId) {
    return { success: false, status: 'editor_not_ready', error: 'CAPTCHA 이미지 아티팩트를 읽을 탭 ID가 없습니다.' };
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, { action: 'GET_CAPTCHA_IMAGE_ARTIFACT' });
    return { ...result, tabId };
  } catch (error) {
    return { success: false, status: 'editor_not_ready', error: error.message, tabId };
  }
}

async function activateTabForCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const windowInfo = await chrome.windows.get(tab.windowId, { populate: true });
  const previousActiveTabId = windowInfo.tabs?.find((candidate) => candidate.active)?.id || null;
  const targetWasActive = previousActiveTabId === tabId;
  let windowRestored = false;

  if (windowInfo.state === 'minimized') {
    await chrome.windows.update(tab.windowId, { state: 'normal' });
    windowRestored = true;
    await delay(120);
  }

  if (!targetWasActive) {
    await chrome.tabs.update(tabId, { active: true });
    await delay(180);
  }

  return {
    windowId: tab.windowId,
    previousActiveTabId,
    targetWasActive,
    windowRestored
  };
}

async function restoreTabAfterCapture(tabId, activationState, options = {}) {
  if (!options.restoreActiveTab) return;
  if (!activationState?.previousActiveTabId) return;
  if (activationState.previousActiveTabId === tabId) return;

  try {
    await chrome.tabs.update(activationState.previousActiveTabId, { active: true });
  } catch (error) {
    console.warn('[TistoryAuto BG] CAPTCHA 캡처 후 이전 탭 복원 실패:', error);
  }
}

async function cropScreenshotDataUrl(sourceDataUrl, candidate, viewport, options = {}) {
  if (!sourceDataUrl) {
    throw new Error('captcha_screenshot_missing');
  }

  const baseRect = candidate?.visibleRect || candidate?.rect || null;
  if (!baseRect) {
    throw new Error('captcha_capture_rect_missing');
  }

  const viewportWidth = Number(viewport?.innerWidth) || 0;
  const viewportHeight = Number(viewport?.innerHeight) || 0;
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    throw new Error('captcha_viewport_missing');
  }

  const response = await fetch(sourceDataUrl);
  const sourceBlob = await response.blob();
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    const scaleX = sourceWidth / viewportWidth;
    const scaleY = sourceHeight / viewportHeight;
    const paddingCssPx = Math.max(0, Number(options.paddingPx) || 8);

    const leftCss = clamp(baseRect.left - paddingCssPx, 0, viewportWidth);
    const topCss = clamp(baseRect.top - paddingCssPx, 0, viewportHeight);
    const rightCss = clamp(baseRect.right + paddingCssPx, 0, viewportWidth);
    const bottomCss = clamp(baseRect.bottom + paddingCssPx, 0, viewportHeight);

    if (rightCss <= leftCss || bottomCss <= topCss) {
      throw new Error('captcha_capture_rect_not_visible');
    }

    const cropX = clamp(Math.floor(leftCss * scaleX), 0, Math.max(0, sourceWidth - 1));
    const cropY = clamp(Math.floor(topCss * scaleY), 0, Math.max(0, sourceHeight - 1));
    const cropRight = clamp(Math.ceil(rightCss * scaleX), cropX + 1, sourceWidth);
    const cropBottom = clamp(Math.ceil(bottomCss * scaleY), cropY + 1, sourceHeight);
    const cropWidth = cropRight - cropX;
    const cropHeight = cropBottom - cropY;

    const canvas = new OffscreenCanvas(cropWidth, cropHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('captcha_crop_canvas_unavailable');
    }

    ctx.drawImage(bitmap, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    const cropBlob = await canvas.convertToBlob({ type: 'image/png' });
    const cropDataUrl = await blobToDataUrl(cropBlob);

    return {
      mimeType: 'image/png',
      dataUrl: cropDataUrl,
      width: cropWidth,
      height: cropHeight,
      sourceImage: {
        width: sourceWidth,
        height: sourceHeight
      },
      crop: {
        x: cropX,
        y: cropY,
        width: cropWidth,
        height: cropHeight,
        paddingCssPx,
        cssRect: {
          left: Math.round(leftCss * 100) / 100,
          top: Math.round(topCss * 100) / 100,
          width: Math.round((rightCss - leftCss) * 100) / 100,
          height: Math.round((bottomCss - topCss) * 100) / 100,
          right: Math.round(rightCss * 100) / 100,
          bottom: Math.round(bottomCss * 100) / 100
        },
        scale: {
          x: Math.round(scaleX * 1000) / 1000,
          y: Math.round(scaleY * 1000) / 1000
        }
      },
      sourceDataUrl: options.includeSourceImage ? sourceDataUrl : null
    };
  } finally {
    bitmap.close();
  }
}

async function captureCaptchaViewportCrop(tab, captureContext, options = {}) {
  const candidate = captureContext?.activeCaptureCandidate || null;
  if (!candidate) {
    return {
      success: false,
      status: 'captcha_capture_target_not_found',
      error: '보이는 CAPTCHA 캡처 대상이 없습니다.',
      tabId: tab?.id || null
    };
  }

  let activationState = null;
  let screenshotDataUrl = null;

  try {
    activationState = await activateTabForCapture(tab.id);
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (error) {
    return {
      success: false,
      status: 'captcha_viewport_capture_failed',
      error: error.message,
      stage: 'capture_visible_tab',
      tabId: tab?.id || null
    };
  } finally {
    await restoreTabAfterCapture(tab.id, activationState, { restoreActiveTab: !options.keepTabActive });
  }

  try {
    const crop = await cropScreenshotDataUrl(screenshotDataUrl, candidate, captureContext?.viewport, options);
    return {
      success: true,
      status: 'captcha_viewport_crop_ready',
      tabId: tab.id,
      artifact: {
        kind: 'viewport_crop',
        mimeType: crop.mimeType,
        dataUrl: crop.dataUrl,
        width: crop.width,
        height: crop.height,
        rect: candidate.rect || null,
        visibleRect: candidate.visibleRect || null,
        sourceImage: crop.sourceImage,
        crop: crop.crop,
        sourceDataUrl: crop.sourceDataUrl
      }
    };
  } catch (error) {
    return {
      success: false,
      status: 'captcha_viewport_crop_failed',
      error: error.message,
      stage: 'crop_visible_tab',
      tabId: tab.id
    };
  }
}

async function getCaptchaArtifactsForTab(tabId, options = {}) {
  if (!tabId) {
    return {
      success: false,
      status: 'editor_not_ready',
      error: 'CAPTCHA 아티팩트를 읽을 탭 ID가 없습니다.'
    };
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    return {
      success: false,
      status: 'editor_not_ready',
      error: error.message,
      tabId
    };
  }

  const prepared = await prepareCaptchaCaptureForTab(tabId);
  if (!prepared.success) {
    return {
      ...prepared,
      tabId,
      url: tab.url || null
    };
  }

  const captureContext = prepared.captureContext || null;
  const selectedCandidate = captureContext?.activeCaptureCandidate || prepared.selectedCandidate || null;
  const directImageResult = await getCaptchaImageArtifactForTab(tabId);
  const viewportCropResult = await captureCaptchaViewportCrop(tab, captureContext, options);
  const artifacts = {};
  const captureErrors = [];

  if (directImageResult.success && directImageResult.artifact?.dataUrl) {
    artifacts.directImage = directImageResult.artifact;
  } else if (!directImageResult.success) {
    captureErrors.push({
      type: 'direct_image',
      status: directImageResult.status || null,
      error: directImageResult.error || 'direct_image_unavailable'
    });
  }

  if (viewportCropResult.success && viewportCropResult.artifact?.dataUrl) {
    artifacts.viewportCrop = viewportCropResult.artifact;
  } else if (!viewportCropResult.success) {
    captureErrors.push({
      type: 'viewport_crop',
      status: viewportCropResult.status || null,
      error: viewportCropResult.error || 'viewport_crop_unavailable'
    });
  }

  const preferredArtifactKey = artifacts.viewportCrop ? 'viewportCrop' : (artifacts.directImage ? 'directImage' : null);
  if (!preferredArtifactKey) {
    return {
      success: false,
      status: 'captcha_artifact_capture_failed',
      error: captureErrors[0]?.error || 'CAPTCHA 이미지 아티팩트를 생성하지 못했습니다.',
      tabId,
      url: captureContext?.url || tab.url || null,
      selectedCandidate,
      captureContext,
      captureErrors
    };
  }

  return {
    success: true,
    status: 'captcha_artifacts_ready',
    tabId,
    url: captureContext?.url || tab.url || null,
    selectedCandidate,
    captureContext,
    artifactPreference: preferredArtifactKey,
    artifact: artifacts[preferredArtifactKey],
    artifacts,
    captureErrors
  };
}

async function sendTabMessageWithTimeout(tabId, message, timeoutMs = EDITOR_PREPARE_DEFAULTS.pingTimeoutMs) {
  let timerId;

  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message),
      new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error('ping_timeout')), timeoutMs);
      })
    ]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

async function waitForTabLoadComplete(tabId, timeoutMs = EDITOR_PREPARE_DEFAULTS.loadTimeoutMs) {
  try {
    const existingTab = await chrome.tabs.get(tabId);
    if (existingTab.status === 'complete') {
      return { success: true, tab: existingTab };
    }
  } catch (error) {
    return { success: false, error: 'tab_missing' };
  }

  return new Promise((resolve) => {
    let resolved = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timerId);
    };

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish({ success: true, tab });
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        finish({ success: false, error: 'tab_closed' });
      }
    };

    const timerId = setTimeout(() => finish({ success: false, error: 'load_timeout' }), timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function probeTabReady(tabId, diagnostics, step, options = {}) {
  const retries = options.pingRetries || EDITOR_PREPARE_DEFAULTS.pingRetries;
  const timeoutMs = options.pingTimeoutMs || EDITOR_PREPARE_DEFAULTS.pingTimeoutMs;
  const intervalMs = options.pingIntervalMs || EDITOR_PREPARE_DEFAULTS.pingIntervalMs;

  let lastError = 'ping_failed';

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const pingResult = await sendTabMessageWithTimeout(tabId, { action: 'PING' }, timeoutMs);
      if (pingResult?.success) {
        diagnostics.attempts.push({ step, tabId, attempt, outcome: 'ready' });
        return { success: true, attempts: attempt };
      }

      lastError = pingResult?.error || 'unexpected_ping_response';
      diagnostics.attempts.push({ step, tabId, attempt, outcome: 'not_ready', error: lastError });
    } catch (error) {
      lastError = error?.message || 'ping_failed';
      diagnostics.attempts.push({ step, tabId, attempt, outcome: 'not_ready', error: lastError });
    }

    if (attempt < retries) {
      await delay(intervalMs);
    }
  }

  return { success: false, error: lastError };
}

/**
 * 큐에서 글 하나를 발행
 */
async function processNextInQueue() {
  if (isProcessing || publishQueue.length === 0) return;

  const pendingIndex = publishQueue.findIndex(item => item.status === 'pending');
  if (pendingIndex === -1) {
    isProcessing = false;
    return;
  }

  isProcessing = true;
  const item = publishQueue[pendingIndex];
  item.status = 'processing';
  await saveQueueState();

  try {
    // 블로그명 추출
    const blogName = item.data.blogName || await getBlogName();
    if (!blogName) throw new Error('블로그 이름을 설정해주세요.');

    const preparation = await prepareEditorTab({ blogName });
    if (!preparation.success) {
      item.status = 'failed';
      item.error = preparation.error || '에디터 준비 실패';
      item.publishStatus = preparation.status || 'editor_not_ready';
      item.diagnostics = preparation.diagnostics;
    } else {
      currentTabId = preparation.tabId;
      await ensurePageWorldVisibilityInterceptor(preparation.tabId);

      const response = await chrome.tabs.sendMessage(preparation.tabId, {
        action: 'WRITE_POST',
        data: { ...item.data, autoPublish: true }
      });
      const responseWithPreparation = withPreparationDetails(response, preparation);

      if (responseWithPreparation.success) {
        item.status = 'completed';
        item.completedAt = new Date().toISOString();
        item.publishStatus = responseWithPreparation.status || 'published';
      } else if (responseWithPreparation.status === 'captcha_required') {
        // CAPTCHA 감지 — 실패가 아닌 일시정지 상태로 보존 (에디터 내용 유지됨)
        item.status = 'captcha_paused';
        item.error = 'CAPTCHA 감지 — 브라우저에서 해결 후 Resume 클릭';
        item.publishStatus = 'captcha_required';
        item.captchaTabId = currentTabId; // 에디터가 살아있는 탭 ID 보존
        item.diagnostics = responseWithPreparation.diagnostics;
        console.warn('[TistoryAuto BG] CAPTCHA 감지 — 큐 일시정지 (captcha_paused). tabId:', currentTabId);
        await saveQueueState();
        isProcessing = false;
        return; // 다음 항목 처리하지 않음 (사용자가 Resume 해야 함)
      } else {
        item.status = 'failed';
        item.error = responseWithPreparation.error || responseWithPreparation.message || '발행 실패';
        item.publishStatus = responseWithPreparation.status || 'unknown_error';
        item.diagnostics = responseWithPreparation.diagnostics;
      }
    }
  } catch (error) {
    item.status = 'failed';
    item.error = error.message;
  }

  await saveQueueState();
  isProcessing = false;

  // 다음 항목 처리 (사용자 설정 간격 사용)
  const nextPending = publishQueue.find(i => i.status === 'pending');
  if (nextPending) {
    const settings = await chrome.storage.local.get('publishInterval');
    const intervalMs = ((settings.publishInterval || 5) * 1000);
    setTimeout(() => processNextInQueue(), intervalMs);
  }
}

/**
 * 저장된 블로그명 가져오기
 */
async function getBlogName() {
  const result = await chrome.storage.local.get('blogName');
  return result.blogName || null;
}

/**
 * 최적의 티스토리 글쓰기 탭 후보 찾기
 * 우선순위: 현재 추적 중이며 살아있는 탭 > newpost 탭 > edit 탭 > 기타 manage 탭
 */
async function getTistoryTabCandidates(targetBlogName = null) {
  const allTabs = await chrome.tabs.query({ url: '*://*.tistory.com/manage/*' });
  if (allTabs.length === 0) return [];

  return [...allTabs].sort((a, b) => {
    const score = (tab) => {
      const tabBlogName = getTabBlogName(tab.url);
      const sameBlogScore = targetBlogName && tabBlogName !== targetBlogName ? 1 : 0;
      const trackedScore = currentTabId && tab.id === currentTabId ? 0 : 1;
      const pageScore = isNewPostTab(tab.url) ? 0 : isEditPostTab(tab.url) ? 1 : 2;
      const accessScore = -(tab.lastAccessed || 0);
      return [sameBlogScore, trackedScore, pageScore, accessScore];
    };

    const [sameBlogA, trackedA, pageA, accessA] = score(a);
    const [sameBlogB, trackedB, pageB, accessB] = score(b);
    return sameBlogA - sameBlogB || trackedA - trackedB || pageA - pageB || accessA - accessB;
  });
}

function installPageWorldPostInterceptor() {
  if (window.__BLOG_AUTO_VISIBILITY_INTERCEPTOR_INSTALLED__) return;
  window.__BLOG_AUTO_VISIBILITY_INTERCEPTOR_INSTALLED__ = true;

  const pageState = window.__BLOG_AUTO_POST_INTERCEPTOR_STATE__ || (window.__BLOG_AUTO_POST_INTERCEPTOR_STATE__ = {
    captchaPayload: {
      recaptchaValue: null,
      challengeCode: null,
      source: null,
      updatedAt: null
    }
  });

  const MANAGE_POST_LOG_KEY = '__blog_auto_last_manage_post_diag';
  const CAPTCHA_PAYLOAD_LOG_KEY = '__blog_auto_last_captcha_payload';
  const CAPTCHA_KEY_RE = /(recaptchaValue|g-recaptcha-response|challengeCode)/i;

  const now = () => new Date().toISOString();

  const normalizeText = (value) => {
    if (value == null) return null;
    const text = typeof value === 'string' ? value : String(value);
    const trimmed = text.trim();
    return trimmed || null;
  };

  const normalizePayload = (payload) => {
    if (!payload || typeof payload !== 'object') return null;

    const recaptchaValue = normalizeText(
      payload.recaptchaValue
      || payload['g-recaptcha-response']
      || payload.gRecaptchaResponse
      || payload.captchaValue
      || null
    );
    const challengeCode = normalizeText(
      payload.challengeCode
      || payload.challenge_code
      || null
    );

    if (!recaptchaValue && !challengeCode) return null;
    return { recaptchaValue, challengeCode };
  };

  const persistPayloadSummary = (payload) => {
    try {
      localStorage.setItem(CAPTCHA_PAYLOAD_LOG_KEY, JSON.stringify({
        hasRecaptchaValue: !!payload?.recaptchaValue,
        hasChallengeCode: !!payload?.challengeCode,
        source: payload?.source || null,
        updatedAt: payload?.updatedAt || now()
      }));
    } catch (_) {}
  };

  const rememberPayload = (payload, source) => {
    const normalized = normalizePayload(payload);
    if (!normalized) return pageState.captchaPayload;

    const previous = pageState.captchaPayload || {};
    const next = {
      recaptchaValue: normalized.recaptchaValue || previous.recaptchaValue || null,
      challengeCode: normalized.challengeCode || previous.challengeCode || null,
      source,
      updatedAt: now()
    };

    const changed = next.recaptchaValue !== previous.recaptchaValue
      || next.challengeCode !== previous.challengeCode
      || next.source !== previous.source;

    pageState.captchaPayload = next;

    if (changed) {
      persistPayloadSummary(next);
      console.log('[TistoryAuto:page] CAPTCHA payload 갱신:', {
        source,
        hasRecaptchaValue: !!next.recaptchaValue,
        hasChallengeCode: !!next.challengeCode
      });
    }

    return next;
  };

  const extractPayload = (value, context = {}) => {
    if (value == null) return null;

    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return null;

      if ((text.startsWith('{') || text.startsWith('[')) && text.length < 50000) {
        try {
          return extractPayload(JSON.parse(text), context);
        } catch (_) {}
      }

      if ((text.includes('recaptchaValue=') || text.includes('challengeCode=') || text.includes('g-recaptcha-response=')) && text.length < 20000) {
        try {
          const params = new URLSearchParams(text);
          return normalizePayload(Object.fromEntries(params.entries()));
        } catch (_) {}
      }

      if (/captcha|challenge/i.test(context.path || '') && text.length >= 16) {
        return normalizePayload({ recaptchaValue: text });
      }

      return null;
    }

    if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
      return normalizePayload(Object.fromEntries(value.entries()));
    }

    if (typeof FormData !== 'undefined' && value instanceof FormData) {
      const entries = {};
      value.forEach((entryValue, entryKey) => {
        if (!(entryKey in entries)) {
          entries[entryKey] = entryValue;
        }
      });
      return normalizePayload(entries);
    }

    if (typeof value !== 'object') return null;

    const direct = normalizePayload(value);
    if (direct) return direct;

    const typeHint = normalizeText(
      value.type
      || value.event
      || value.kind
      || value.name
      || value.status
      || ''
    );
    if (typeHint && /captcha|challenge/i.test(typeHint)) {
      const inferred = normalizePayload({
        recaptchaValue: value.token || value.value || value.response || value.result || null,
        challengeCode: value.challengeCode || value.challenge_code || null
      });
      if (inferred) return inferred;
    }

    if ((context.depth || 0) >= 4) return null;

    for (const [key, nestedValue] of Object.entries(value)) {
      const nested = extractPayload(nestedValue, {
        depth: (context.depth || 0) + 1,
        path: context.path ? `${context.path}.${key}` : key
      });
      if (nested) return nested;
    }

    return null;
  };

  const readFirstValue = (selectors) => {
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const value = normalizeText('value' in el ? el.value : el.textContent);
        if (value) return value;
      }
    }
    return null;
  };

  const collectPayloadFromDom = () => normalizePayload({
    recaptchaValue: readFirstValue([
      'input[name="recaptchaValue"]',
      'textarea[name="recaptchaValue"]',
      'textarea[name="g-recaptcha-response"]',
      'input[name="g-recaptcha-response"]',
      'input[id*="recaptcha"][value]',
      'textarea[id*="recaptcha"]',
      'input[name*="captcha"][value]',
      'textarea[name*="captcha"]'
    ]),
    challengeCode: readFirstValue([
      'input[name="challengeCode"]',
      'textarea[name="challengeCode"]',
      'input[id*="challenge"][value]',
      'textarea[id*="challenge"]'
    ])
  });

  const collectPayloadFromDataset = () => normalizePayload({
    recaptchaValue: document.documentElement.dataset.blogAutoRecaptchaValue
      || document.documentElement.getAttribute('data-blog-auto-recaptcha-value')
      || null,
    challengeCode: document.documentElement.dataset.blogAutoChallengeCode
      || document.documentElement.getAttribute('data-blog-auto-challenge-code')
      || null
  });

  const collectPayloadFromCookies = () => {
    if (!document.cookie) return null;

    const values = {};
    document.cookie.split(';').forEach((part) => {
      const [rawKey, ...rawValue] = part.split('=');
      const key = normalizeText(rawKey);
      if (!key || !CAPTCHA_KEY_RE.test(key)) return;
      values[key] = decodeURIComponent(rawValue.join('=') || '');
    });

    return normalizePayload(values);
  };

  const collectPayloadFromStorage = (storage, storageName) => {
    if (!storage) return null;

    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !/captcha|challenge/i.test(key)) continue;

      try {
        const value = storage.getItem(key);
        const payload = extractPayload(value, { path: `${storageName}.${key}`, depth: 0 });
        if (payload) return payload;
      } catch (_) {}
    }

    return null;
  };

  const collectPayloadFromGlobals = () => {
    const globalNames = ['__NEXT_DATA__', '__INITIAL_STATE__', '__PRELOADED_STATE__', 'TistoryBlog'];
    for (const name of globalNames) {
      try {
        const payload = extractPayload(window[name], { path: name, depth: 0 });
        if (payload) return payload;
      } catch (_) {}
    }
    return null;
  };

  const refreshCaptchaPayload = (reason = 'refresh') => {
    const candidates = [
      { source: `${reason}:dataset`, payload: collectPayloadFromDataset() },
      { source: `${reason}:dom`, payload: collectPayloadFromDom() },
      { source: `${reason}:cookie`, payload: collectPayloadFromCookies() },
      { source: `${reason}:sessionStorage`, payload: collectPayloadFromStorage(window.sessionStorage, 'sessionStorage') },
      { source: `${reason}:localStorage`, payload: collectPayloadFromStorage(window.localStorage, 'localStorage') },
      { source: `${reason}:globals`, payload: collectPayloadFromGlobals() }
    ];

    candidates.forEach(({ source, payload }) => {
      if (payload) rememberPayload(payload, source);
    });

    return pageState.captchaPayload;
  };

  window.addEventListener('message', (event) => {
    const payload = extractPayload(event.data, { path: `message:${event.origin || 'unknown'}`, depth: 0 });
    if (payload) {
      rememberPayload(payload, `message:${event.origin || 'unknown'}`);
    }
  }, true);

  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    const result = originalSetItem.apply(this, arguments);
    if (key && /captcha|challenge/i.test(String(key))) {
      const storageName = this === window.sessionStorage ? 'sessionStorage' : 'localStorage';
      const payload = extractPayload(value, { path: `${storageName}.${key}`, depth: 0 });
      if (payload) {
        rememberPayload(payload, `${storageName}:${key}`);
      }
    }
    return result;
  };

  const shouldRewrite = (url) => typeof url === 'string' && url.includes('/manage/post.json');

  const getForcedVisibility = () => {
    const raw = document.documentElement.dataset.blogAutoTargetVisibilityNum;
    return raw == null || raw === '' ? null : Number(raw);
  };

  const persistRequestDiag = (diag) => {
    try {
      localStorage.setItem(MANAGE_POST_LOG_KEY, JSON.stringify(diag));
    } catch (_) {}
  };

  const rewritePayload = (payload) => {
    if (!payload || typeof payload !== 'object') return payload;

    const nextPayload = Array.isArray(payload) ? [...payload] : { ...payload };
    const forcedVisibility = getForcedVisibility();
    const captchaPayload = refreshCaptchaPayload('manage_post');

    let changed = false;

    if (forcedVisibility != null && nextPayload.visibility !== forcedVisibility) {
      nextPayload.visibility = forcedVisibility;
      changed = true;
    }

    if (!normalizeText(nextPayload.recaptchaValue) && normalizeText(captchaPayload?.recaptchaValue)) {
      nextPayload.recaptchaValue = captchaPayload.recaptchaValue;
      changed = true;
    }

    if (!normalizeText(nextPayload.challengeCode) && normalizeText(captchaPayload?.challengeCode)) {
      nextPayload.challengeCode = captchaPayload.challengeCode;
      changed = true;
    }

    const diag = {
      at: now(),
      changed,
      visibility: nextPayload.visibility ?? null,
      hasRecaptchaValue: !!normalizeText(nextPayload.recaptchaValue),
      hasChallengeCode: !!normalizeText(nextPayload.challengeCode),
      captchaSource: captchaPayload?.source || null
    };

    persistRequestDiag(diag);

    if (changed) {
      console.log('[TistoryAuto:page] manage/post.json payload 보정:', diag);
    } else if (!diag.hasRecaptchaValue) {
      console.warn('[TistoryAuto:page] manage/post.json recaptchaValue 누락:', diag);
    }

    return nextPayload;
  };

  const rewriteBody = (body) => {
    if (body == null) return body;

    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        return JSON.stringify(rewritePayload(parsed));
      } catch (_) {
        if ((body.includes('recaptchaValue=') || body.includes('challengeCode=') || body.includes('visibility=')) && body.length < 20000) {
          try {
            const params = new URLSearchParams(body);
            return new URLSearchParams(Object.entries(rewritePayload(Object.fromEntries(params.entries())))).toString();
          } catch (error) {
            console.warn('[TistoryAuto:page] manage/post.json body parse 실패:', error);
          }
        }
        return body;
      }
    }

    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      const rewritten = rewritePayload(Object.fromEntries(body.entries()));
      return new URLSearchParams(Object.entries(rewritten)).toString();
    }

    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const rewritten = rewritePayload(Object.fromEntries(body.entries()));
      const nextFormData = new FormData();
      Object.entries(rewritten).forEach(([key, value]) => {
        nextFormData.append(key, value == null ? '' : String(value));
      });
      return nextFormData;
    }

    if (typeof body === 'object') {
      return rewritePayload(body);
    }

    return body;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__blogAutoMeta = { method, url };
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const meta = this.__blogAutoMeta || {};
    const nextBody = shouldRewrite(meta.url) ? rewriteBody(body) : body;
    return origSend.call(this, nextBody);
  };

  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (!shouldRewrite(url)) {
        return origFetch(input, init);
      }

      try {
        if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
          return origFetch(input, { ...init, body: rewriteBody(init.body) });
        }

        if (typeof Request !== 'undefined' && input instanceof Request) {
          const method = (input.method || 'GET').toUpperCase();
          if (!['GET', 'HEAD'].includes(method)) {
            const originalBody = await input.clone().text();
            const nextBody = rewriteBody(originalBody);
            const rewrittenBody = typeof nextBody === 'string' ? nextBody : JSON.stringify(nextBody);
            if (rewrittenBody !== originalBody) {
              input = new Request(input, { body: rewrittenBody });
            }
          }
        }
      } catch (error) {
        console.warn('[TistoryAuto:page] fetch payload 보정 실패:', error);
      }

      return origFetch(input, init);
    };
  }

  refreshCaptchaPayload('init');
}

async function ensurePageWorldVisibilityInterceptor(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: installPageWorldPostInterceptor
    });
    return true;
  } catch (error) {
    console.warn('[TistoryAuto BG] MAIN world interceptor 주입 실패:', error);
    return false;
  }
}

async function navigateCandidateToEditor(tab, targetUrl, diagnostics) {
  diagnostics.attempts.push({
    step: normalizeUrl(tab.url) === normalizeUrl(targetUrl) ? 'reload_candidate' : 'navigate_candidate',
    tabId: tab.id,
    fromUrl: tab.url || null,
    toUrl: targetUrl
  });

  try {
    if (normalizeUrl(tab.url) === normalizeUrl(targetUrl)) {
      await chrome.tabs.reload(tab.id);
    } else {
      await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    }
  } catch (error) {
    diagnostics.attempts.push({
      step: 'navigate_candidate_result',
      tabId: tab.id,
      outcome: 'failed',
      error: error.message
    });
    return { success: false, error: error.message };
  }

  const loadResult = await waitForTabLoadComplete(tab.id);
  diagnostics.attempts.push({
    step: 'wait_for_load',
    tabId: tab.id,
    outcome: loadResult.success ? 'complete' : 'failed',
    error: loadResult.error || null
  });

  if (!loadResult.success) {
    return { success: false, error: loadResult.error, tab: tab };
  }

  await delay(EDITOR_PREPARE_DEFAULTS.postLoadDelayMs);
  return { success: true, tab: loadResult.tab };
}

function shouldReuseByNavigation(tab, targetBlogName) {
  if (!isManageTab(tab.url)) return false;

  const tabBlogName = getTabBlogName(tab.url);
  if (targetBlogName && tabBlogName !== targetBlogName) return false;

  return true;
}

async function tryPrepareCandidateTab(tab, diagnostics, targetBlogName = null) {
  diagnostics.attempts.push({
    step: 'inspect_candidate',
    tabId: tab.id,
    url: tab.url || null,
    status: tab.status || 'unknown'
  });

  const initialLoad = await waitForTabLoadComplete(tab.id);
  if (!initialLoad.success) {
    diagnostics.attempts.push({
      step: 'wait_for_load',
      tabId: tab.id,
      outcome: 'failed',
      error: initialLoad.error
    });
    return { success: false, error: initialLoad.error, tab };
  }

  if (initialLoad.tab) {
    tab = initialLoad.tab;
  }

  if (!targetBlogName) {
    targetBlogName = getTabBlogName(tab.url);
  }

  const initialProbe = await probeTabReady(tab.id, diagnostics, 'probe_existing');
  if (initialProbe.success) {
    currentTabId = tab.id;
    return makePreparationResponse({
      success: true,
      status: 'editor_ready',
      tab,
      blogName: targetBlogName,
      diagnostics
    });
  }

  if (!targetBlogName || !shouldReuseByNavigation(tab, targetBlogName)) {
    return { success: false, error: initialProbe.error, tab };
  }

  const targetUrl = buildNewPostUrl(targetBlogName);
  const navigation = await navigateCandidateToEditor(tab, targetUrl, diagnostics);
  if (!navigation.success) {
    return { success: false, error: navigation.error, tab };
  }

  const preparedTab = navigation.tab || tab;
  const finalProbe = await probeTabReady(preparedTab.id, diagnostics, 'probe_after_navigation');
  if (finalProbe.success) {
    currentTabId = preparedTab.id;
    return makePreparationResponse({
      success: true,
      status: 'editor_ready',
      tab: preparedTab,
      blogName: targetBlogName,
      diagnostics
    });
  }

  return { success: false, error: finalProbe.error, tab: preparedTab };
}

async function openFreshEditorTab(blogName, diagnostics) {
  const url = buildNewPostUrl(blogName);
  let createdTab;

  diagnostics.attempts.push({
    step: 'open_fresh_tab',
    toUrl: url
  });

  try {
    createdTab = await chrome.tabs.create({ url, active: true });
  } catch (error) {
    diagnostics.attempts.push({
      step: 'open_fresh_tab_result',
      outcome: 'failed',
      error: error.message
    });
    return { success: false, error: error.message };
  }

  const loadResult = await waitForTabLoadComplete(createdTab.id);
  diagnostics.attempts.push({
    step: 'wait_for_fresh_tab_load',
    tabId: createdTab.id,
    outcome: loadResult.success ? 'complete' : 'failed',
    error: loadResult.error || null
  });

  if (!loadResult.success) {
    return { success: false, error: loadResult.error, tab: createdTab };
  }

  await delay(EDITOR_PREPARE_DEFAULTS.postLoadDelayMs);

  const probeResult = await probeTabReady(createdTab.id, diagnostics, 'probe_fresh_tab');
  if (!probeResult.success) {
    return { success: false, error: probeResult.error, tab: loadResult.tab || createdTab };
  }

  currentTabId = createdTab.id;
  return makePreparationResponse({
    success: true,
    status: 'editor_ready',
    tab: loadResult.tab || createdTab,
    blogName,
    diagnostics
  });
}

async function prepareEditorTab(options = {}) {
  const requestedBlogName = options.blogName || null;
  const blogName = requestedBlogName || await getBlogName();
  const diagnostics = {
    requestedBlogName,
    blogName,
    currentTabId,
    candidateCount: 0,
    attempts: []
  };

  const candidates = await getTistoryTabCandidates(blogName);
  diagnostics.candidateCount = candidates.length;

  let lastFailure = null;

  for (const candidate of candidates) {
    const candidateBlogName = getTabBlogName(candidate.url);

    if (blogName && candidateBlogName && candidateBlogName !== blogName) {
      diagnostics.attempts.push({
        step: 'skip_candidate',
        tabId: candidate.id,
        url: candidate.url || null,
        reason: 'blog_mismatch',
        candidateBlogName
      });
      continue;
    }

    const result = await tryPrepareCandidateTab(candidate, diagnostics, blogName || candidateBlogName);
    if (result?.success) {
      return result;
    }

    lastFailure = result;
  }

  if (!blogName) {
    return makePreparationResponse({
      success: false,
      status: 'blog_not_configured',
      error: '블로그 이름이 설정되지 않았습니다. 설정을 저장하거나 PREPARE_EDITOR/WRITE_POST 호출 시 blogName을 함께 보내주세요.',
      diagnostics
    });
  }

  const freshTabResult = await openFreshEditorTab(blogName, diagnostics);
  if (freshTabResult.success) {
    return freshTabResult;
  }

  return makePreparationResponse({
    success: false,
    status: 'editor_not_ready',
    error: '콘텐츠 스크립트가 준비된 티스토리 글쓰기 탭을 확보하지 못했습니다. diagnostics를 확인하세요.',
    tab: freshTabResult.tab || lastFailure?.tab || null,
    blogName,
    diagnostics
  });
}

// ── 공통 메시지 처리 함수 ──────────────────────────
async function handleMessage(message, sender) {
  switch (message.action) {
    // Content Script가 준비되었음을 알림
    case 'CONTENT_READY':
      currentTabId = sender.tab?.id;
      return { success: true };

    case 'INJECT_MAIN_WORLD_VISIBILITY_HELPER': {
      const tabId = sender.tab?.id;
      if (!tabId) return { success: false, error: 'sender tab 없음' };
      const injected = await ensurePageWorldVisibilityInterceptor(tabId);
      return { success: injected };
    }

    // Popup / API → Content Script로 직접 발행
    case 'WRITE_POST': {
      await clearDirectPublishState();
      const preparation = await prepareEditorTab({ blogName: message.data?.blogName || null });
      if (!preparation.success) {
        return preparation;
      }

      try {
        await ensurePageWorldVisibilityInterceptor(preparation.tabId);
        const response = await chrome.tabs.sendMessage(preparation.tabId, message);
        const responseWithPreparation = withPreparationDetails(response, preparation);

        if (responseWithPreparation.status === 'captcha_required') {
          const captchaContextResult = await getCaptchaContextForTab(preparation.tabId);
          const directState = buildDirectPublishState({
            response: responseWithPreparation,
            preparation,
            requestData: message.data || {},
            captchaContext: captchaContextResult.success ? captchaContextResult.captchaContext : captchaContextResult
          });
          await setDirectPublishState(directState);
          return attachDirectPublishState(responseWithPreparation, directState);
        }

        if (responseWithPreparation.success) {
          await clearDirectPublishState();
        }

        return responseWithPreparation;
      } catch (err) {
        return makePreparationResponse({
          success: false,
          status: 'editor_not_ready',
          error: '콘텐츠 스크립트와 통신 실패. diagnostics를 확인한 뒤 페이지를 새로고침하거나 PREPARE_EDITOR를 다시 호출하세요.',
          tabId: preparation.tabId,
          url: preparation.url,
          blogName: preparation.blogName,
          diagnostics: preparation.diagnostics
        });
      }
    }

    case 'SET_TITLE':
    case 'SET_CONTENT':
    case 'SET_CATEGORY':
    case 'SET_TAGS':
    case 'SET_VISIBILITY':
    case 'INSERT_IMAGES':
    case 'PUBLISH':
    case 'GET_PAGE_INFO': {
      const preparation = await prepareEditorTab({ blogName: message.data?.blogName || null });
      if (!preparation.success) {
        return preparation;
      }

      try {
        await ensurePageWorldVisibilityInterceptor(preparation.tabId);
        const response = await chrome.tabs.sendMessage(preparation.tabId, message);
        return withPreparationDetails(response, preparation);
      } catch (err) {
        return makePreparationResponse({
          success: false,
          status: 'editor_not_ready',
          error: '콘텐츠 스크립트와 통신 실패. diagnostics를 확인한 뒤 페이지를 새로고침하거나 PREPARE_EDITOR를 다시 호출하세요.',
          tabId: preparation.tabId,
          url: preparation.url,
          blogName: preparation.blogName,
          diagnostics: preparation.diagnostics
        });
      }
    }

    case 'PREPARE_EDITOR':
      return await prepareEditorTab({ blogName: message.data?.blogName || null });

    // 큐에 글 추가
    case 'ADD_TO_QUEUE': {
      const items = Array.isArray(message.data) ? message.data : [message.data];
      for (const item of items) {
        publishQueue.push({
          id: Date.now() + Math.random().toString(36).substr(2, 9),
          data: item,
          status: 'pending',
          addedAt: new Date().toISOString(),
          error: null,
          completedAt: null
        });
      }
      await saveQueueState();
      return { success: true, queueLength: publishQueue.length };
    }

    // 큐 처리 시작
    case 'START_QUEUE':
      processNextInQueue();
      return { success: true, message: '큐 처리를 시작합니다.' };

    // 큐 상태 조회
    case 'GET_QUEUE':
      return { success: true, queue: publishQueue, isProcessing };

    // 큐 항목 삭제
    case 'REMOVE_FROM_QUEUE': {
      publishQueue = publishQueue.filter(item => item.id !== message.data.id);
      await saveQueueState();
      return { success: true };
    }

    // 큐 전체 초기화
    case 'CLEAR_QUEUE':
      publishQueue = [];
      await saveQueueState();
      return { success: true };

    // 설정 저장
    case 'SAVE_SETTINGS': {
      await chrome.storage.local.set(message.data);
      return { success: true };
    }

    // 설정 로드
    case 'LOAD_SETTINGS': {
      const settings = await chrome.storage.local.get(null);
      return { success: true, settings };
    }

    case 'GET_DIRECT_PUBLISH_STATE': {
      const state = await getLiveDirectPublishState({ includeCaptchaContext: !!message.data?.includeCaptchaContext });
      return { success: true, directPublish: state };
    }

    case 'GET_CAPTCHA_CONTEXT': {
      const explicitTabId = message.data?.tabId || null;
      const savedState = explicitTabId ? null : await getLiveDirectPublishState();
      const tabId = explicitTabId || savedState?.tabId || currentTabId;
      const captchaContextResult = await getCaptchaContextForTab(tabId);

      if (!captchaContextResult.success) {
        return captchaContextResult;
      }

      if (savedState?.tabId && savedState.tabId === tabId) {
        await updateDirectPublishState({
          url: captchaContextResult.captchaContext?.url || savedState.url,
          captchaContext: captchaContextResult.captchaContext,
          lastCheckedAt: new Date().toISOString()
        });
      }

      return {
        success: true,
        tabId,
        captchaContext: captchaContextResult.captchaContext,
        directPublish: savedState?.tabId === tabId ? { ...directPublishState } : null
      };
    }

    case 'GET_CAPTCHA_ARTIFACTS': {
      const explicitTabId = message.data?.tabId || null;
      const savedState = explicitTabId ? null : await getLiveDirectPublishState();
      const tabId = explicitTabId || savedState?.tabId || currentTabId;
      const artifactResult = await getCaptchaArtifactsForTab(tabId, message.data || {});

      if (savedState?.tabId && savedState.tabId === tabId) {
        await updateDirectPublishState({
          url: artifactResult.captureContext?.url || savedState.url,
          captchaContext: artifactResult.captureContext || savedState.captchaContext || null,
          lastCheckedAt: new Date().toISOString(),
          lastCaptchaArtifactCapture: {
            success: artifactResult.success,
            status: artifactResult.status || null,
            artifactKind: artifactResult.artifact?.kind || null,
            capturedAt: new Date().toISOString()
          }
        });
      }

      return {
        ...artifactResult,
        directPublish: savedState?.tabId === tabId ? { ...directPublishState } : null
      };
    }

    case 'SUBMIT_CAPTCHA': {
      const explicitTabId = message.data?.tabId || null;
      const savedState = explicitTabId ? null : await getLiveDirectPublishState();
      const tabId = explicitTabId || savedState?.tabId || currentTabId;
      const submitResult = await submitCaptchaForTab(tabId, message.data?.answer, { waitMs: message.data?.waitMs });
      const refreshedContext = await refreshDirectPublishCaptchaState(tabId, submitResult);
      const captchaStillAppears = refreshedContext?.success
        ? !!refreshedContext.captchaContext?.captchaPresent
        : !!submitResult.captchaStillAppears;

      return {
        ...submitResult,
        captchaStillAppears,
        directPublish: directPublishState?.tabId === tabId ? { ...directPublishState } : null
      };
    }

    case 'SUBMIT_CAPTCHA_AND_RESUME': {
      const explicitTabId = message.data?.tabId || null;
      const savedState = explicitTabId ? null : await getLiveDirectPublishState();
      const tabId = explicitTabId || savedState?.tabId || currentTabId;
      const initialSubmitResult = await submitCaptchaForTab(tabId, message.data?.answer, { waitMs: message.data?.waitMs });
      const refreshedContext = await refreshDirectPublishCaptchaState(tabId, initialSubmitResult);
      const captchaStillAppears = refreshedContext?.success
        ? !!refreshedContext.captchaContext?.captchaPresent
        : !!initialSubmitResult.captchaStillAppears;
      const submitResult = {
        ...initialSubmitResult,
        captchaStillAppears
      };

      if (!submitResult.success || captchaStillAppears) {
        return {
          ...submitResult,
          resumed: false,
          submitResult,
          resumeResult: null,
          directPublish: directPublishState?.tabId === tabId ? { ...directPublishState } : null
        };
      }

      const resumeResult = await resumeDirectPublishFlow({
        ...(message.data || {}),
        blogName: message.data?.blogName || savedState?.blogName || directPublishState?.blogName || null,
        visibility: message.data?.visibility || savedState?.visibility || directPublishState?.visibility || null
      }, {
        preferredTabId: tabId
      });

      return {
        ...resumeResult,
        resumed: true,
        submitResult,
        resumeResult
      };
    }

    // CAPTCHA 해결 후 발행 재개 (큐 항목)
    case 'RESUME_AFTER_CAPTCHA': {
      const itemId = message.data?.id;
      const item = publishQueue.find(i => i.id === itemId && i.status === 'captcha_paused');
      if (!item) {
        return { success: false, error: '재개할 captcha_paused 항목을 찾을 수 없음', status: 'item_not_found' };
      }

      const tabId = item.captchaTabId || currentTabId;
      if (!tabId) {
        return { success: false, error: '에디터 탭을 찾을 수 없음. 페이지를 새로 열어주세요.', status: 'editor_not_ready' };
      }

      const resumeDiagnostics = {
        requestedBlogName: item.data?.blogName || null,
        blogName: item.data?.blogName || null,
        currentTabId,
        candidateCount: 1,
        attempts: []
      };

      const resumeProbe = await probeTabReady(tabId, resumeDiagnostics, 'probe_resume_tab');
      if (!resumeProbe.success) {
        return {
          success: false,
          error: '에디터 탭이 닫혔거나 새로고침됨. RETRY로 처음부터 다시 시도하세요.',
          status: 'editor_not_ready',
          tabId,
          diagnostics: resumeDiagnostics
        };
      }

      // CAPTCHA가 아직 표시되어 있는지 확인
      try {
        const captchaCheck = await chrome.tabs.sendMessage(tabId, { action: 'CHECK_CAPTCHA' });
        if (captchaCheck?.captchaPresent) {
          return { success: false, error: 'CAPTCHA가 아직 표시되어 있습니다. 먼저 해결해주세요.', status: 'captcha_required' };
        }
      } catch (e) { /* 확인 실패 시 발행 시도 진행 */ }

      // 발행 재시도 (에디터 내용은 이미 입력되어 있음 — RESUME_PUBLISH만 호출)
      item.status = 'processing';
      await saveQueueState();

      try {
        await ensurePageWorldVisibilityInterceptor(tabId);
        const response = await chrome.tabs.sendMessage(tabId, {
          action: 'RESUME_PUBLISH',
          data: { visibility: item.data?.visibility || 'public' }
        });
        if (response.success) {
          item.status = 'completed';
          item.error = null;
          item.completedAt = new Date().toISOString();
          item.publishStatus = response.status || 'published';
          item.captchaTabId = null;
          await saveQueueState();
          isProcessing = false;
          // 다음 대기 항목 처리
          processNextInQueue();
          return { success: true, status: 'published', url: response.url };
        } else if (response.status === 'captcha_required') {
          item.status = 'captcha_paused';
          item.error = 'CAPTCHA 재발생 — 다시 해결 후 Resume 클릭';
          item.captchaTabId = tabId;
          await saveQueueState();
          isProcessing = false;
          return response;
        } else {
          item.status = 'failed';
          item.error = response.error || '재개 후 발행 실패';
          item.publishStatus = response.status;
          await saveQueueState();
          isProcessing = false;
          return response;
        }
      } catch (e) {
        item.status = 'failed';
        item.error = e.message;
        await saveQueueState();
        isProcessing = false;
        return { success: false, error: e.message };
      }
    }

    // 실패/일시정지 항목 처음부터 재시도
    case 'RETRY_ITEM': {
      const itemId = message.data?.id;
      const item = publishQueue.find(i => i.id === itemId);
      if (!item) return { success: false, error: '항목을 찾을 수 없음' };
      item.status = 'pending';
      item.error = null;
      item.captchaTabId = null;
      item.completedAt = null;
      item.publishStatus = null;
      await saveQueueState();
      return { success: true };
    }

    // CAPTCHA 해결 후 직접 발행 재개 (큐 외부, 팝업/API 직접 발행)
    case 'RESUME_DIRECT_PUBLISH':
      return await resumeDirectPublishFlow(message.data || {}, {
        preferredTabId: message.data?.tabId || null
      });

    default:
      return { success: false, error: `알 수 없는 액션: ${message.action}` };
  }
}

// ── 내부 메시지 핸들러 ──────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[TistoryAuto BG] 메시지:', message.action, 'from:', sender.tab?.url || 'popup/external');

  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));

  return true; // 비동기 응답
});

// ── 외부 연결 핸들러 (externally_connectable) ──────────────
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log('[TistoryAuto BG] 외부 메시지:', message.action, 'from:', sender.url);

  // 보안: localhost만 허용
  if (!sender.url?.startsWith('http://localhost') && !sender.url?.startsWith('http://127.0.0.1')) {
    sendResponse({ success: false, error: '허용되지 않은 출처입니다.' });
    return;
  }

  // 공통 핸들러로 처리
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));

  return true; // 비동기 응답
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (directPublishState?.tabId === tabId) {
    clearDirectPublishState().catch((error) => {
      console.warn('[TistoryAuto BG] directPublishState 정리 실패:', error);
    });
  }
});

// ── 초기화 ──────────────────────────────────
Promise.all([loadQueueState(), loadDirectPublishState()]).then(() => {
  console.log('[TistoryAuto BG] Service Worker 시작 ✅, 큐 항목:', publishQueue.length, 'directPublishState:', !!directPublishState);
});
