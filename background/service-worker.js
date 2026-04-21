/**
 * Background Service Worker
 * - Popup ↔ Content Script 메시지 라우팅
 * - 외부 API 수신 (externally_connectable)
 * - 발행 큐 관리
 */

import {
  detectCaptchaChallengeKind,
  inferCaptchaAnswer,
  inferCaptchaDirectAnswer,
  inferInstructionCaptchaAnswer,
  normalizeCaptchaAnswerLengthHint,
  normalizeCaptchaOcrCandidateTexts,
  parseCaptchaChallengeText
} from '../utils/captcha-inference.js';
import { buildCaptchaSolveHints } from '../utils/captcha-solve-hints.js';
import {
  buildCaptchaChallengeSignature,
  compareCaptchaChallengeSignatures,
  getChallengeFromCaptchaContext
} from '../utils/captcha-retry.js';
import {
  classifyRecoveredCaptchaSubmitOutcome,
  looksLikeDirectPublishCompletionUrl
} from '../utils/captcha-submit-recovery.js';
import {
  buildCaptchaAnswerAttemptCandidates,
  supportsRankedCaptchaAnswerRetries
} from '../utils/captcha-answer-retry.js';
import { isPostCaptchaPublishStillInFlight } from '../utils/captcha-post-submit-settle.js';
import { hasActionableCaptchaAnswerPath } from '../utils/captcha-submit-capability.js';
import {
  choosePreferredCaptchaArtifactKey,
  fetchCaptchaSourceImageArtifact,
  normalizeCaptchaArtifactCaptureOptions,
  resolveCaptchaArtifactSourceUrl,
  shouldFetchCaptchaSourceImage
} from '../utils/captcha-artifacts.js';

import {
  buildQueueContinuationPlan,
  decideQueueStartupAction,
  normalizeLoadedQueueState,
  QUEUE_CONTINUATION_ALARM,
  MV3_MIN_ALARM_DELAY_MS,
  runTrackedWakeTask
} from '../utils/queue-runtime.js';
import {
  buildQueueCaptchaPauseState,
  buildQueueCaptchaSavedStateForAnswerResolution,
  clearQueueCaptchaPauseState,
  decideQueueCaptchaResumeProbeAction,
  findQueueCaptchaItem,
  getQueueCaptchaSelectionFailure,
  summarizeQueueCaptchaSelection
} from '../utils/queue-captcha.js';
import {
  buildDirectPublishContinuationPlan,
  decideDirectPublishStartupAction,
  DIRECT_PUBLISH_CONTINUATION_ALARM
} from '../utils/direct-publish-runtime.js';

// ── 발행 큐 / 직접 발행 상태 ─────────────────────
let publishQueue = [];
let isProcessing = false;
let currentTabId = null;
let directPublishState = null;
let directPublishRuntimeState = {
  active: false,
  tabId: null,
  nextCheckTimeMs: null,
  deadlineMs: null,
  timeoutMs: null,
  pollIntervalMs: null,
  postClearDelayMs: null,
  updatedAt: null
};
let queueRuntimeState = {
  active: false,
  scheduledTimeMs: null,
  requestedDelayMs: null,
  updatedAt: null
};
let isDirectPublishRuntimeWakeInFlight = false;
let isQueueRuntimeWakeInFlight = false;
let isDirectPublishCaptchaWaitInProgress = false;
let runtimeStateLoaded = false;
let runtimeStateLoadPromise = null;

const DIRECT_PUBLISH_STATE_KEY = 'directPublishState';
const DIRECT_PUBLISH_RUNTIME_STATE_KEY = 'directPublishRuntimeState';
const QUEUE_RUNTIME_STATE_KEY = 'publishQueueRuntimeState';

const EDITOR_PREPARE_DEFAULTS = {
  loadTimeoutMs: 15000,
  pingTimeoutMs: 1500,
  pingRetries: 5,
  pingIntervalMs: 800,
  postLoadDelayMs: 700,
  editorProbeWaitMs: 1600,
  editorProbeIntervalMs: 250,
  editorProbeSettleDelayMs: 150,
  stageJitter: {
    enabled: true,
    extraRatio: 0.18,
    minExtraMs: 20,
    maxExtraMs: 450
  }
};

const DIRECT_PUBLISH_CAPTCHA_WAIT_DEFAULTS = {
  timeoutMs: 120000,
  pollIntervalMs: 1000,
  postClearDelayMs: 1200,
  stageJitter: {
    enabled: true,
    extraRatio: 0.15,
    minExtraMs: 20,
    maxExtraMs: 320
  }
};

const CAPTCHA_RETRY_READY_DEFAULTS = {
  timeoutMs: 4000,
  pollIntervalMs: 250
};

const POST_CAPTCHA_COMPLETION_WAIT_DEFAULTS = {
  timeoutMs: 8000,
  pollIntervalMs: 750
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

async function persistQueueRuntimeState() {
  await chrome.storage.local.set({
    [QUEUE_RUNTIME_STATE_KEY]: queueRuntimeState
  });
}

async function updateQueueRuntimeState(patch = {}) {
  queueRuntimeState = {
    ...queueRuntimeState,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await persistQueueRuntimeState();
  return queueRuntimeState;
}

async function clearQueueContinuationAlarm() {
  await chrome.alarms.clear(QUEUE_CONTINUATION_ALARM);
}

async function resetQueueRuntimeState() {
  queueRuntimeState = {
    active: false,
    scheduledTimeMs: null,
    requestedDelayMs: null,
    updatedAt: new Date().toISOString()
  };
  await persistQueueRuntimeState();
  await clearQueueContinuationAlarm();
}

async function scheduleQueueContinuation(intervalMs) {
  const plan = buildQueueContinuationPlan({ intervalMs });
  await chrome.alarms.create(plan.alarmName, { when: plan.scheduledTimeMs });
  await updateQueueRuntimeState({
    active: true,
    scheduledTimeMs: plan.scheduledTimeMs,
    requestedDelayMs: plan.requestedDelayMs
  });
  return plan;
}

async function scheduleNextPendingQueueItem() {
  const nextPending = publishQueue.find((item) => item.status === 'pending');
  if (!nextPending) {
    await resetQueueRuntimeState();
    return {
      scheduled: false,
      nextItemId: null,
      intervalMs: null,
      continuationPlan: null
    };
  }

  const settings = await chrome.storage.local.get('publishInterval');
  const intervalSeconds = Number(settings.publishInterval);
  const intervalMs = (Number.isFinite(intervalSeconds) ? Math.max(0, intervalSeconds) : 5) * 1000;
  const continuationPlan = await scheduleQueueContinuation(intervalMs);

  setTimeout(() => {
    processNextInQueue().catch((error) => {
      console.warn('[TistoryAuto BG] 큐 in-memory continuation 실패:', error);
    });
  }, continuationPlan.inMemoryDelayMs);

  return {
    scheduled: true,
    nextItemId: nextPending.id || null,
    intervalMs,
    continuationPlan
  };
}

async function wakeQueueProcessing(source = 'runtime') {
  const wakeOutcome = await runTrackedWakeTask({
    isInFlight: () => isQueueRuntimeWakeInFlight,
    setInFlight: (next) => {
      isQueueRuntimeWakeInFlight = !!next;
    },
    task: async () => {
      await clearQueueContinuationAlarm();
      await updateQueueRuntimeState({
        active: true,
        scheduledTimeMs: null,
        requestedDelayMs: null
      });
      return processNextInQueue();
    }
  });

  if (!wakeOutcome?.started && wakeOutcome?.skipped) {
    console.log(`[TistoryAuto BG] queue wake skipped (${source}) — another wake is already running.`);
  }

  return wakeOutcome;
}

async function scheduleImmediateQueueWake(source = 'runtime') {
  const fallbackScheduledTimeMs = Date.now() + MV3_MIN_ALARM_DELAY_MS;
  await chrome.alarms.create(QUEUE_CONTINUATION_ALARM, { when: fallbackScheduledTimeMs });
  await updateQueueRuntimeState({
    active: true,
    scheduledTimeMs: fallbackScheduledTimeMs,
    requestedDelayMs: 0
  });

  setTimeout(() => {
    wakeQueueProcessing(source).catch((error) => {
      console.warn(`[TistoryAuto BG] queue immediate wake 실패 (${source}):`, error);
    });
  }, 0);

  return {
    scheduled: true,
    scheduledTimeMs: fallbackScheduledTimeMs
  };
}

async function persistDirectPublishRuntimeState() {
  await chrome.storage.local.set({
    [DIRECT_PUBLISH_RUNTIME_STATE_KEY]: directPublishRuntimeState
  });
}

async function clearDirectPublishContinuationAlarm() {
  await chrome.alarms.clear(DIRECT_PUBLISH_CONTINUATION_ALARM);
}

async function resetDirectPublishRuntimeState() {
  directPublishRuntimeState = {
    active: false,
    tabId: null,
    nextCheckTimeMs: null,
    deadlineMs: null,
    timeoutMs: null,
    pollIntervalMs: null,
    postClearDelayMs: null,
    updatedAt: new Date().toISOString()
  };
  await persistDirectPublishRuntimeState();
  await clearDirectPublishContinuationAlarm();
}

async function updateDirectPublishRuntimeState(patch = {}) {
  directPublishRuntimeState = {
    ...directPublishRuntimeState,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await persistDirectPublishRuntimeState();
  return directPublishRuntimeState;
}

async function scheduleDirectPublishContinuation({ tabId, timeoutMs, pollIntervalMs, postClearDelayMs, deadlineMs = null } = {}) {
  const plan = buildDirectPublishContinuationPlan({
    timeoutMs,
    pollIntervalMs,
    deadlineMs
  });

  if (plan.alarmDelayMs > 0) {
    await chrome.alarms.create(plan.alarmName, { when: plan.scheduledTimeMs });
  } else {
    await clearDirectPublishContinuationAlarm();
  }

  await updateDirectPublishRuntimeState({
    active: true,
    tabId,
    nextCheckTimeMs: plan.nextCheckTimeMs,
    deadlineMs: plan.deadlineMs,
    timeoutMs: plan.timeoutMs,
    pollIntervalMs: plan.pollIntervalMs,
    postClearDelayMs: Math.max(0, Number(postClearDelayMs) || 0)
  });
  return plan;
}

/**
 * 큐 상태 로드
 */
async function loadQueueState() {
  const result = await chrome.storage.local.get('publishQueue');
  const normalized = normalizeLoadedQueueState(result.publishQueue || []);
  publishQueue = normalized.queue;
  if (normalized.recoveredCount > 0) {
    await saveQueueState();
  }
}

async function loadQueueRuntimeState() {
  const result = await chrome.storage.local.get(QUEUE_RUNTIME_STATE_KEY);
  const stored = result[QUEUE_RUNTIME_STATE_KEY];
  if (stored && typeof stored === 'object') {
    queueRuntimeState = {
      active: !!stored.active,
      scheduledTimeMs: Number(stored.scheduledTimeMs) || null,
      requestedDelayMs: Number(stored.requestedDelayMs) || null,
      updatedAt: stored.updatedAt || null
    };
  }
}

async function loadDirectPublishRuntimeState() {
  const result = await chrome.storage.local.get(DIRECT_PUBLISH_RUNTIME_STATE_KEY);
  const stored = result[DIRECT_PUBLISH_RUNTIME_STATE_KEY];
  if (stored && typeof stored === 'object') {
    const storedTabId = parseOptionalFiniteNumber(stored.tabId);
    const storedNextCheckTimeMs = parseOptionalFiniteNumber(stored.nextCheckTimeMs);
    const storedDeadlineMs = parseOptionalFiniteNumber(stored.deadlineMs);
    const storedTimeoutMs = parseOptionalFiniteNumber(stored.timeoutMs);
    const storedPollIntervalMs = parseOptionalFiniteNumber(stored.pollIntervalMs);
    const storedPostClearDelayMs = parseOptionalFiniteNumber(stored.postClearDelayMs);
    directPublishRuntimeState = {
      active: !!stored.active,
      tabId: Number.isInteger(storedTabId) ? storedTabId : null,
      nextCheckTimeMs: Number.isFinite(storedNextCheckTimeMs) ? storedNextCheckTimeMs : null,
      deadlineMs: Number.isFinite(storedDeadlineMs) ? storedDeadlineMs : null,
      timeoutMs: Number.isFinite(storedTimeoutMs) ? storedTimeoutMs : null,
      pollIntervalMs: Number.isFinite(storedPollIntervalMs) ? storedPollIntervalMs : null,
      postClearDelayMs: Number.isFinite(storedPostClearDelayMs) ? storedPostClearDelayMs : null,
      updatedAt: stored.updatedAt || null
    };
  }
}

async function loadDirectPublishState() {
  const result = await chrome.storage.local.get(DIRECT_PUBLISH_STATE_KEY);
  directPublishState = result[DIRECT_PUBLISH_STATE_KEY] || null;
}

async function ensureRuntimeStateLoaded() {
  if (runtimeStateLoaded) return;

  if (!runtimeStateLoadPromise) {
    runtimeStateLoadPromise = Promise.all([
      loadQueueState(),
      loadQueueRuntimeState(),
      loadDirectPublishState(),
      loadDirectPublishRuntimeState()
    ])
      .then(async () => {
        await restoreQueueContinuationAfterStartup();
        await restoreDirectPublishContinuationAfterStartup();
        runtimeStateLoaded = true;
      })
      .catch((error) => {
        runtimeStateLoadPromise = null;
        throw error;
      });
  }

  await runtimeStateLoadPromise;
}

async function restoreQueueContinuationAfterStartup() {
  const hasPendingItems = publishQueue.some((item) => item?.status === 'pending');
  if (!hasPendingItems) {
    if (queueRuntimeState?.active || queueRuntimeState?.scheduledTimeMs) {
      await resetQueueRuntimeState();
    } else {
      await clearQueueContinuationAlarm();
    }
    return;
  }

  const startupAction = decideQueueStartupAction({
    queue: publishQueue,
    queueRuntimeState,
    nowMs: Date.now()
  });

  if (startupAction.action === 'resume_now') {
    await scheduleImmediateQueueWake('startup');
    return;
  }

  if (startupAction.action === 'recreate_alarm') {
    await chrome.alarms.create(startupAction.alarmName, { when: startupAction.scheduledTimeMs });
    return;
  }

  await clearQueueContinuationAlarm();
}

async function handleDirectPublishContinuationWakeup(source = 'startup') {
  const startupAction = decideDirectPublishStartupAction({
    directPublishState,
    directPublishRuntimeState,
    nowMs: Date.now()
  });

  if (isDirectPublishCaptchaWaitInProgress && directPublishRuntimeState?.active) {
    const plan = buildDirectPublishContinuationPlan({
      timeoutMs: directPublishRuntimeState.timeoutMs,
      pollIntervalMs: directPublishRuntimeState.pollIntervalMs,
      deadlineMs: directPublishRuntimeState.deadlineMs
    });

    if (plan.alarmDelayMs > 0) {
      await chrome.alarms.create(plan.alarmName, { when: plan.scheduledTimeMs });
      await updateDirectPublishRuntimeState({
        nextCheckTimeMs: plan.nextCheckTimeMs,
        deadlineMs: plan.deadlineMs,
        timeoutMs: plan.timeoutMs,
        pollIntervalMs: plan.pollIntervalMs
      });
    } else {
      await clearDirectPublishContinuationAlarm();
    }
    return;
  }

  if (startupAction.action === 'none') {
    await clearDirectPublishContinuationAlarm();
    return;
  }

  if (startupAction.action === 'clear_runtime') {
    await resetDirectPublishRuntimeState();
    return;
  }

  if (startupAction.action === 'recreate_alarm') {
    await chrome.alarms.create(startupAction.alarmName, { when: startupAction.scheduledTimeMs });
    return;
  }

  if (startupAction.action === 'resume_now') {
    if (startupAction.remainingTimeoutMs !== null && startupAction.remainingTimeoutMs <= 0) {
      await clearDirectPublishContinuationAlarm();

      try {
        const liveTab = await chrome.tabs.get(startupAction.tabId || directPublishState?.tabId);
        if (looksLikeDirectPublishCompletionUrl(liveTab?.url || '')) {
          await clearDirectPublishState();
          return;
        }
      } catch (error) {
        // 탭 조회 실패는 아래 fail-closed 경로에서 처리
      }

      try {
        const captchaCheck = await getBlockingCaptchaStateForTab(startupAction.tabId || directPublishState?.tabId);
        if (captchaCheck?.success && !captchaCheck.captchaPresent) {
          const wakeOutcome = await runTrackedWakeTask({
            isInFlight: () => isDirectPublishRuntimeWakeInFlight,
            setInFlight: (next) => {
              isDirectPublishRuntimeWakeInFlight = !!next;
            },
            task: async () => {
              try {
                await resumeDirectPublishFlow(directPublishState?.requestData || {}, {
                  preferredTabId: startupAction.tabId || directPublishState?.tabId || null,
                  waitForCaptcha: false,
                  pollIntervalMs: directPublishRuntimeState?.pollIntervalMs,
                  postClearDelayMs: directPublishRuntimeState?.postClearDelayMs,
                  autoWakeSource: source
                });
              } catch (error) {
                console.warn('[TistoryAuto BG] expired direct publish wait 후 즉시 재개 실패:', error);
              } finally {
                await resetDirectPublishRuntimeState();
              }
            }
          });
          if (!wakeOutcome?.started) {
            return;
          }
          return;
        }
      } catch (error) {
        // same-tab probe 실패는 timeout fail-closed로 정리
      }

      if (directPublishState?.status === 'waiting_browser_handoff') {
        await updateDirectPublishState({
          status: 'captcha_required',
          lastCaptchaWait: {
            ...(directPublishState?.lastCaptchaWait || {}),
            enabled: true,
            success: false,
            status: 'captcha_wait_timeout',
            error: '저장된 same-tab CAPTCHA 대기 시간이 만료되었습니다. 현재 상태를 확인한 뒤 새 handoff 또는 재시도를 진행하세요.',
            completedAt: new Date().toISOString()
          }
        });
      }
      await resetDirectPublishRuntimeState();
      return;
    }

    let liveWakeTab = null;
    try {
      liveWakeTab = await chrome.tabs.get(startupAction.tabId || directPublishState?.tabId);
    } catch (error) {
      if (directPublishState?.status === 'waiting_browser_handoff') {
        await updateDirectPublishState({
          status: 'editor_not_ready',
          lastCaptchaWait: {
            ...(directPublishState?.lastCaptchaWait || {}),
            enabled: true,
            success: false,
            status: 'editor_not_ready',
            error: '저장된 same-tab CAPTCHA 대기 탭이 사라져 자동 재개를 중단합니다. 새 handoff 또는 재시도가 필요합니다.',
            completedAt: new Date().toISOString()
          }
        });
      }
      await resetDirectPublishRuntimeState();
      return;
    }

    if (looksLikeDirectPublishCompletionUrl(liveWakeTab?.url || '')) {
      await clearDirectPublishState();
      return;
    }

    if (isDirectPublishRuntimeWakeInFlight) {
      return;
    }

    isDirectPublishRuntimeWakeInFlight = true;
    await clearDirectPublishContinuationAlarm();
    await updateDirectPublishRuntimeState({
      active: true,
      nextCheckTimeMs: null
    });

    await runTrackedWakeTask({
      isInFlight: () => isDirectPublishRuntimeWakeInFlight,
      setInFlight: (next) => {
        isDirectPublishRuntimeWakeInFlight = !!next;
      },
      task: async () => {
        try {
          const resumeResponse = await resumeDirectPublishFlow(directPublishState?.requestData || {}, {
            preferredTabId: startupAction.tabId || directPublishState?.tabId || null,
            waitForCaptcha: true,
            waitTimeoutMs: startupAction.remainingTimeoutMs,
            pollIntervalMs: directPublishRuntimeState?.pollIntervalMs,
            postClearDelayMs: directPublishRuntimeState?.postClearDelayMs,
            autoWakeSource: source
          });

          if (!resumeResponse?.success) {
            if (directPublishState?.status === 'waiting_browser_handoff') {
              await updateDirectPublishState({
                status: resumeResponse?.status === 'captcha_required' ? 'captcha_required' : 'editor_not_ready',
                lastCaptchaWait: {
                  ...(directPublishState?.lastCaptchaWait || {}),
                  enabled: true,
                  success: false,
                  status: resumeResponse?.status || 'editor_not_ready',
                  error: resumeResponse?.error || null,
                  completedAt: new Date().toISOString()
                }
              });
            }
            await resetDirectPublishRuntimeState();
          }

          return resumeResponse;
        } catch (error) {
          console.warn('[TistoryAuto BG] direct publish 자동 재개 실패:', error);
          if (directPublishState?.status === 'waiting_browser_handoff') {
            await updateDirectPublishState({
              status: 'captcha_required',
              lastCaptchaWait: {
                ...(directPublishState?.lastCaptchaWait || {}),
                enabled: true,
                success: false,
                status: 'editor_not_ready',
                error: error.message,
                completedAt: new Date().toISOString()
              }
            });
            await resetDirectPublishRuntimeState();
          }
          return null;
        }
      }
    });
    return;
  }

  await clearDirectPublishContinuationAlarm();
}

async function restoreDirectPublishContinuationAfterStartup() {
  await handleDirectPublishContinuationWakeup('startup');
}

async function persistDirectPublishState() {
  if (directPublishState) {
    await chrome.storage.local.set({ [DIRECT_PUBLISH_STATE_KEY]: directPublishState });
  } else {
    await chrome.storage.local.remove(DIRECT_PUBLISH_STATE_KEY);
  }
}

async function setDirectPublishState(state) {
  directPublishState = state ? enrichDirectPublishStateWithSolveHints({ ...state }) : null;
  await persistDirectPublishState();
  return directPublishState;
}

async function clearDirectPublishState() {
  directPublishState = null;
  await persistDirectPublishState();
  await resetDirectPublishRuntimeState();
}

async function updateDirectPublishState(patch = {}) {
  if (!directPublishState) return null;
  directPublishState = enrichDirectPublishStateWithSolveHints({
    ...directPublishState,
    ...patch,
    updatedAt: new Date().toISOString()
  });
  await persistDirectPublishState();
  return directPublishState;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseOptionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function cloneTraceEntries(trace = []) {
  return Array.isArray(trace)
    ? trace.map(entry => (entry && typeof entry === 'object' ? { ...entry } : entry)).filter(Boolean)
    : [];
}

function buildTraceEntry(stage, extra = {}) {
  const entry = {
    stage,
    phase: extra.phase || 'background',
    at: new Date().toISOString()
  };

  for (const [key, value] of Object.entries(extra || {})) {
    if (key === 'phase' || value === undefined) continue;
    entry[key] = value;
  }

  return entry;
}

function buildTransitionPatch(base = {}, stage, extra = {}) {
  const phase = extra.phase || base.phase || 'background';
  const trace = cloneTraceEntries(base.publishTrace);
  const entry = buildTraceEntry(stage, { ...extra, phase });
  trace.push(entry);

  return {
    phase,
    stage,
    publishTrace: trace,
    lastTransition: entry
  };
}

function normalizeStageJitterOptions(options = null) {
  if (!options || options.enabled === false) {
    return { enabled: false, extraRatio: 0, minExtraMs: 0, maxExtraMs: 0 };
  }

  return {
    enabled: true,
    extraRatio: clamp(Number(options.extraRatio) || 0, 0, 1),
    minExtraMs: Math.max(0, Number(options.minExtraMs) || 0),
    maxExtraMs: Math.max(0, Number(options.maxExtraMs) || 0)
  };
}

function getJitterDelay(baseMs, options = null) {
  const normalizedBaseMs = Math.max(0, Number(baseMs) || 0);
  const normalized = normalizeStageJitterOptions(options);

  if (!normalized.enabled || normalizedBaseMs === 0) {
    return {
      enabled: false,
      baseMs: normalizedBaseMs,
      extraMs: 0,
      waitMs: normalizedBaseMs
    };
  }

  const computedExtraMax = Math.min(
    normalized.maxExtraMs || Math.round(normalizedBaseMs * normalized.extraRatio),
    Math.round(normalizedBaseMs * normalized.extraRatio)
  );
  const extraMaxMs = Math.max(0, computedExtraMax);
  const extraMinMs = Math.min(extraMaxMs, normalized.minExtraMs);
  const extraMs = extraMaxMs > 0
    ? extraMinMs + Math.floor(Math.random() * (extraMaxMs - extraMinMs + 1))
    : 0;

  return {
    enabled: true,
    baseMs: normalizedBaseMs,
    extraMs,
    waitMs: normalizedBaseMs + extraMs
  };
}

async function delayWithStageJitter(baseMs, options = null) {
  const jitter = getJitterDelay(baseMs, options);
  await delay(jitter.waitMs);
  return jitter;
}

async function applyPreparationStageDelay(diagnostics, step, baseMs, options = null, extra = {}) {
  const jitter = await delayWithStageJitter(baseMs, options);
  diagnostics?.attempts?.push({
    step,
    outcome: 'settled',
    baseDelayMs: jitter.baseMs,
    jitterExtraMs: jitter.extraMs,
    waitedMs: jitter.waitMs,
    jitterEnabled: jitter.enabled,
    ...extra
  });
  return jitter;
}

function buildManageHomeUrl(blogName) {
  return `https://${blogName}.tistory.com/manage`;
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

function getPersistenceCheck(response) {
  return response?.persistenceCheck
    || response?.results?.publish?.persistenceCheck
    || null;
}

function normalizePublishResponse(response) {
  if (!response || typeof response !== 'object') return response;

  const persistenceCheck = getPersistenceCheck(response);
  if (response.success && response.status === 'published' && persistenceCheck?.confirmed === false) {
    return {
      ...response,
      success: false,
      status: persistenceCheck.status || 'persistence_unverified',
      error: persistenceCheck.error || '발행 persistence 검증에 실패했습니다.'
    };
  }

  return response;
}

function cloneJsonValue(value) {
  if (value == null) return value;

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.warn('[TistoryAuto BG] JSON clone 실패:', error);
    return null;
  }
}

function enrichCaptchaContextWithSolveHints(context = null, extra = {}) {
  if (!context || typeof context !== 'object') {
    return context;
  }

  const next = cloneJsonValue(context) || context || null;
  if (!next || typeof next !== 'object') {
    return next;
  }

  const solveHints = buildCaptchaSolveHints(next, extra);
  if (solveHints) {
    next.solveHints = solveHints;
  } else if ('solveHints' in next) {
    delete next.solveHints;
  }

  return next;
}

function enrichCaptchaArtifactResultWithSolveHints(result = null) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const next = { ...result };
  const solveHintExtra = {
    artifactPreference: result.artifactPreference || null,
    artifactKinds: Object.entries(result.artifacts || {})
      .filter(([, artifact]) => artifact?.dataUrl)
      .map(([key]) => key)
  };

  if (result.captureContext && typeof result.captureContext === 'object') {
    next.captureContext = enrichCaptchaContextWithSolveHints(result.captureContext, solveHintExtra);
  }

  if (result.captchaContext && typeof result.captchaContext === 'object') {
    next.captchaContext = enrichCaptchaContextWithSolveHints(result.captchaContext, solveHintExtra);
  }

  const solveHints = next.captureContext?.solveHints
    || next.captchaContext?.solveHints
    || buildCaptchaSolveHints(result.captureContext || result.captchaContext || null, solveHintExtra);

  if (solveHints) {
    next.solveHints = solveHints;
  } else if ('solveHints' in next) {
    delete next.solveHints;
  }

  return next;
}

function enrichDirectPublishStateWithSolveHints(state = null) {
  if (!state || typeof state !== 'object') {
    return state;
  }

  const next = { ...state };
  if (next.captchaContext && typeof next.captchaContext === 'object') {
    next.captchaContext = enrichCaptchaContextWithSolveHints(next.captchaContext);
  }
  return next;
}

function attachSolveHints(response, preferredContext = null) {
  if (!response || typeof response !== 'object') {
    return response;
  }

  const solveHints = preferredContext?.solveHints
    || response.solveHints
    || response.captchaContext?.solveHints
    || response.captureContext?.solveHints
    || response.directPublish?.captchaContext?.solveHints
    || null;

  if (!solveHints) {
    return response;
  }

  return {
    ...response,
    solveHints
  };
}

function normalizeDirectPublishRequestData(requestData = {}) {
  const cloned = cloneJsonValue(requestData) || {};

  if (!Array.isArray(cloned.tags)) {
    cloned.tags = [];
  }

  if (!Array.isArray(cloned.images)) {
    cloned.images = [];
  }

  return cloned;
}


function compactFallbackText(value = '', maxLength = 160) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

const CAPTCHA_MASK_CHAR_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]/u;
const CAPTCHA_MASK_RUN_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]+/gu;
const CAPTCHA_WORD_MASK_RE = /(?:빈\s*칸|공\s*란)/u;
const CAPTCHA_WORD_MASK_GLOBAL_RE = /(?:빈\s*칸|공\s*란)/gu;
const CAPTCHA_INSTRUCTION_ACTION_RE = /(?:입력|선택|클릭|고르|찾|맞추|완성)(?:해\s*주|해주)?세요/u;
const CAPTCHA_INSTRUCTION_ACTION_GLOBAL_RE = /([가-힣A-Za-z0-9][^.!?\n]{0,120}?(?:입력|선택|클릭|고르|찾|맞추|완성)(?:해\s*주|해주)?세요)/gu;
const CAPTCHA_INSTRUCTION_KEYWORD_RE = /(지도|사진|이미지|화면|캡차|captcha|dkaptcha|있는|보이는|다음|아래|위|간판|명칭|상호|업체|장소|문구|텍스트|번호|주소|이름|병원|약국|한의원|학교|건물|매장|기관|단어|숫자)/iu;
const CAPTCHA_INSTRUCTION_EXACT_IGNORE_RE = /^(?:정답(?:을)?\s*입력해주세요|답(?:을)?\s*입력해주세요|답변\s*제출|새로\s*풀기|음성\s*문제(?:\s*재생)?|dkaptcha(?:\s*\(captcha\s*서비스\))?|captcha\s*서비스)$/iu;
const CAPTCHA_INSTRUCTION_TRAILING_NOISE_RE = /\s*(?:정답(?:을)?\s*입력해주세요|답(?:을)?\s*입력해주세요|새로\s*풀기|음성\s*문제(?:\s*재생)?|답변\s*제출|DKAPTCHA(?:\s*\(CAPTCHA\s*서비스\))?|CAPTCHA\s*서비스).*$/iu;
const CAPTCHA_INSTRUCTION_LEADING_NOISE_RE = /^(?:DKAPTCHA(?:\s*\(CAPTCHA\s*서비스\))?|CAPTCHA(?:\s*서비스)?|보안문자|자동등록방지)\s*/iu;

function normalizeCaptchaChallengeText(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeCaptchaChallengeMaskText(value = '') {
  return normalizeCaptchaChallengeText(value).replace(CAPTCHA_WORD_MASK_GLOBAL_RE, '□');
}

function countCaptchaChallengeSlots(value = '') {
  const normalized = normalizeCaptchaChallengeText(value);
  const explicitMatches = normalized.match(CAPTCHA_MASK_RUN_RE);
  const explicitSlotCount = explicitMatches ? explicitMatches.reduce((sum, token) => sum + token.length, 0) : 0;
  if (explicitSlotCount > 0) return explicitSlotCount;
  return CAPTCHA_WORD_MASK_RE.test(normalized) ? null : 0;
}

function boundCaptchaChallengeText(value = '', maxLength = 80) {
  const normalized = normalizeCaptchaChallengeText(value);
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

function extractMaskedCaptchaChallenge(value = '') {
  const normalized = normalizeCaptchaChallengeText(value);
  const normalizedMaskText = normalizeCaptchaChallengeMaskText(value);
  if (!normalizedMaskText || (!CAPTCHA_MASK_CHAR_RE.test(normalizedMaskText) && !CAPTCHA_WORD_MASK_RE.test(normalized))) {
    return null;
  }

  const snippetMatch = normalizedMaskText.match(/([가-힣A-Za-z0-9]{0,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2}\s*[□▢◻◼⬜⬛◯○●◎◇◆_＿]+\s*(?:[가-힣A-Za-z0-9]{1,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2})?)/u);
  const rawSnippetMatch = normalized.match(/([가-힣A-Za-z0-9]{0,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2}\s*(?:[□▢◻◼⬜⬛◯○●◎◇◆_＿]+|빈\s*칸|공\s*란)\s*(?:[가-힣A-Za-z0-9]{1,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2})?)/u);
  const maskedSnippet = snippetMatch?.[1] ? normalizeCaptchaChallengeText(snippetMatch[1]) : normalizedMaskText;
  const rawSnippet = rawSnippetMatch?.[1] ? normalizeCaptchaChallengeText(rawSnippetMatch[1]) : normalized;

  return {
    text: boundCaptchaChallengeText(rawSnippet, 48),
    maskedText: boundCaptchaChallengeText(maskedSnippet, 48),
    slotCount: countCaptchaChallengeSlots(normalized),
    kind: 'masked',
    matchScore: 24
  };
}

function normalizeCaptchaInstructionCandidate(value = '') {
  let normalized = normalizeCaptchaChallengeText(value);
  if (!normalized) return '';

  normalized = normalized.replace(CAPTCHA_INSTRUCTION_LEADING_NOISE_RE, '').trim();
  normalized = normalized.replace(CAPTCHA_INSTRUCTION_TRAILING_NOISE_RE, '').trim();
  normalized = normalized.replace(/^[-:|]\s*/, '').trim();

  return normalizeCaptchaChallengeText(normalized);
}

function extractInstructionCaptchaChallenge(value = '') {
  const normalized = normalizeCaptchaChallengeText(value);
  if (!normalized) return null;

  const candidates = new Set();
  candidates.add(normalized);
  normalized.split(/\n+/).map(normalizeCaptchaChallengeText).filter(Boolean).forEach((line) => candidates.add(line));
  Array.from(normalized.matchAll(CAPTCHA_INSTRUCTION_ACTION_GLOBAL_RE)).forEach((match) => {
    if (match?.[1]) candidates.add(match[1]);
  });

  let best = null;
  candidates.forEach((candidate) => {
    const cleaned = normalizeCaptchaInstructionCandidate(candidate);
    if (!cleaned || CAPTCHA_INSTRUCTION_EXACT_IGNORE_RE.test(cleaned) || !CAPTCHA_INSTRUCTION_ACTION_RE.test(cleaned)) {
      return;
    }

    let score = 10;
    if (CAPTCHA_INSTRUCTION_KEYWORD_RE.test(cleaned)) score += 10;
    if (/(?:전체|정확한|일치하는|해당|같은)/u.test(cleaned)) score += 4;
    if (/(?:있는|보이는|다음|아래|위)/u.test(cleaned)) score += 4;
    if (cleaned.length >= 12 && cleaned.length <= 56) score += 3;
    if (/^(?:정답|답변)/u.test(cleaned)) score -= 12;
    if (/(?:새로\s*풀기|음성\s*문제|답변\s*제출|captcha\s*서비스|dkaptcha)/iu.test(cleaned)) score -= 18;
    if (score < 16) return;

    const snippet = {
      text: boundCaptchaChallengeText(cleaned, 80),
      maskedText: boundCaptchaChallengeText(cleaned, 80),
      slotCount: null,
      kind: 'instruction',
      matchScore: score
    };

    if (!best || snippet.matchScore > best.matchScore || (snippet.matchScore == best.matchScore && snippet.text.length < best.text.length)) {
      best = snippet;
    }
  });

  return best;
}

function extractCaptchaChallengeEntry(value = '') {
  return extractMaskedCaptchaChallenge(value) || extractInstructionCaptchaChallenge(value);
}

function buildCaptchaChallengeFromEntries(entries = []) {
  const challengeEntries = [];

  const pushValue = (entry) => {
    if (entry == null) return;
    const sourceText = typeof entry === 'string' ? entry : (entry.text ?? entry.value ?? '');
    const source = typeof entry === 'string' ? null : (entry.source || null);
    const baseScore = Number(typeof entry === 'string' ? 0 : entry.score) || 0;
    const snippet = extractCaptchaChallengeEntry(sourceText);
    if (!snippet) return;

    challengeEntries.push({
      text: snippet.text,
      maskedText: snippet.maskedText || snippet.text,
      slotCount: snippet.slotCount,
      source,
      kind: snippet.kind || 'masked',
      score: baseScore + Number(snippet.matchScore || 0) + (snippet.kind === 'instruction' ? 8 : 18)
    });
  };

  (Array.isArray(entries) ? entries : []).forEach(pushValue);

  const deduped = [];
  const seen = new Set();
  challengeEntries.forEach((entry) => {
    const key = `${entry.kind || 'masked'}::${entry.maskedText || entry.text || ''}::${entry.slotCount ?? 'var'}`;
    if (!entry.text || seen.has(key)) return;
    seen.add(key);
    deduped.push(entry);
  });

  deduped.sort((a, b) => (
    (b.score - a.score)
    || ((b.kind === 'masked') - (a.kind === 'masked'))
    || ((a.text || '').length - (b.text || '').length)
  ));

  return {
    challengeText: deduped[0]?.text || null,
    challengeMasked: deduped[0]?.maskedText || deduped[0]?.text || null,
    challengeSlotCount: Number.isFinite(deduped[0]?.slotCount) ? deduped[0].slotCount : null,
    challengeCandidates: deduped.slice(0, 5)
  };
}

function buildCaptchaChallengeFromContext(context = null) {
  if (!context || typeof context !== 'object') {
    return {
      challengeText: null,
      challengeMasked: null,
      challengeSlotCount: null,
      challengeCandidates: []
    };
  }

  const entries = [];
  const pushValue = (value, source, score = 0) => {
    if (!value) return;
    entries.push({ text: value, source, score });
  };
  const pushCandidateText = (candidate, source, score = 0) => {
    if (!candidate || typeof candidate !== 'object') return;
    pushValue(candidate.text, `${source}:text`, score);
    pushValue(candidate.maskedText, `${source}:masked`, score + 4);
    pushValue(candidate.associatedText, `${source}:associated`, score + 2);
  };

  pushValue(context.challengeText, 'context_challenge_text', 48);
  pushValue(context.challengeMasked, 'context_challenge_masked', 52);
  pushValue(context.bodyHint, 'context_body_hint', 36);

  (Array.isArray(context.challengeCandidates) ? context.challengeCandidates : []).forEach((candidate, index) => {
    pushCandidateText(candidate, `context_challenge_candidate:${index}`, 44 - Math.min(index, 4));
  });

  pushCandidateText(context.activeSubmitButton, 'active_submit_button', 42);
  pushCandidateText(context.activeAnswerInput, 'active_answer_input', 26);
  pushCandidateText(context.activeCaptureCandidate, 'active_capture_candidate', 24);

  (Array.isArray(context.submitButtonCandidates) ? context.submitButtonCandidates : []).forEach((candidate, index) => {
    pushCandidateText(candidate, `submit_button_candidate:${index}`, 34 - Math.min(index, 4));
  });
  (Array.isArray(context.answerInputCandidates) ? context.answerInputCandidates : []).forEach((candidate, index) => {
    pushCandidateText(candidate, `answer_input_candidate:${index}`, 18 - Math.min(index, 4));
  });
  (Array.isArray(context.captureCandidates) ? context.captureCandidates : []).forEach((candidate, index) => {
    pushCandidateText(candidate, `capture_candidate:${index}`, 18 - Math.min(index, 4));
  });

  return buildCaptchaChallengeFromEntries(entries);
}

function withFrameMetadata(candidate, frameId) {
  if (!candidate || typeof candidate !== 'object') return candidate || null;
  return {
    ...candidate,
    frameId
  };
}

function buildFrameCandidateScore(entry = {}) {
  const frameContext = entry.frameContext || {};
  let score = Number(frameContext.score) || 0;
  if (entry.frameId !== 0) score += 10;
  if (frameContext.activeAnswerInput) score += 10;
  if (frameContext.activeSubmitButton) score += 8;
  if (frameContext.activeCaptureCandidate) score += 6;
  if (frameContext.captchaLike) score += 12;
  return score;
}

function normalizeCaptchaFrameEntries(injectionResults = []) {
  return (Array.isArray(injectionResults) ? injectionResults : [])
    .map((item) => {
      const payload = item?.result && typeof item.result === 'object'
        ? item.result
        : { success: false, status: 'captcha_frame_result_missing', error: 'frame_result_missing' };
      const frameContext = payload.frameContext || payload.frameContextBefore || payload.captureContext || null;
      return {
        frameId: Number.isFinite(item?.frameId) ? item.frameId : 0,
        documentId: item?.documentId || null,
        payload,
        frameContext,
        score: buildFrameCandidateScore({ frameId: item?.frameId, frameContext })
      };
    })
    .filter((entry) => {
      const frameContext = entry.frameContext || {};
      return !!(
        entry.payload?.success
        || frameContext?.captchaLike
        || frameContext?.candidateCount
        || frameContext?.activeAnswerInput
        || frameContext?.activeSubmitButton
        || frameContext?.activeCaptureCandidate
      );
    })
    .sort((a, b) => b.score - a.score);
}

function summarizeCaptchaFrameEntry(entry = {}) {
  const frameContext = entry.frameContext || {};
  const derivedChallenge = buildCaptchaChallengeFromContext(frameContext);
  const resolvedChallengeText = frameContext.challengeText
    || frameContext.challengeMasked
    || derivedChallenge.challengeText
    || derivedChallenge.challengeMasked
    || null;
  const resolvedChallengeMasked = frameContext.challengeMasked
    || frameContext.challengeText
    || derivedChallenge.challengeMasked
    || derivedChallenge.challengeText
    || null;
  const resolvedChallengeSlotCount = Number(frameContext.challengeSlotCount)
    || Number(derivedChallenge.challengeSlotCount)
    || null;
  const resolvedChallengeCandidates = Array.isArray(frameContext.challengeCandidates) && frameContext.challengeCandidates.length > 0
    ? cloneJsonValue(frameContext.challengeCandidates) || []
    : (cloneJsonValue(derivedChallenge.challengeCandidates) || []);

  return {
    frameId: entry.frameId,
    documentId: entry.documentId || null,
    url: frameContext.url || entry.payload?.url || null,
    origin: frameContext.origin || null,
    title: frameContext.title || null,
    score: Number.isFinite(entry.score) ? entry.score : (Number(frameContext.score) || 0),
    reasons: Array.isArray(frameContext.reasons) ? frameContext.reasons : [],
    candidateCount: Number(frameContext.candidateCount) || 0,
    captchaLike: !!frameContext.captchaLike,
    challengeText: resolvedChallengeText,
    challengeMasked: resolvedChallengeMasked,
    challengeSlotCount: resolvedChallengeSlotCount,
    challengeCandidates: resolvedChallengeCandidates,
    answerLengthHint: normalizeCaptchaAnswerLengthHint(frameContext.answerLengthHint)
      || resolvedChallengeSlotCount
      || null,
    submitApiAvailable: frameContext.submitApiAvailable === true,
    activeAnswerInput: withFrameMetadata(frameContext.activeAnswerInput, entry.frameId),
    activeSubmitButton: withFrameMetadata(frameContext.activeSubmitButton, entry.frameId),
    activeCaptureCandidate: withFrameMetadata(frameContext.activeCaptureCandidate, entry.frameId)
  };
}

function mergeCaptchaContexts(baseContext = null, frameContextResult = null) {
  if (!frameContextResult?.success) {
    return cloneJsonValue(baseContext) || baseContext || null;
  }

  const next = cloneJsonValue(baseContext) || {
    success: true,
    url: frameContextResult.activeFrame?.url || null,
    title: frameContextResult.activeFrame?.title || null,
    captchaPresent: true,
    candidateCount: 0,
    candidates: []
  };

  next.captchaPresent = baseContext?.captchaPresent ?? true;
  next.crossFrameAvailable = true;
  next.frameSolveSupported = true;
  next.frameCaptchaCandidateCount = Number(frameContextResult.frameCandidateCount) || 0;
  next.frameCaptchaCandidates = cloneJsonValue(frameContextResult.frameCandidates) || [];
  next.activeFrame = cloneJsonValue(frameContextResult.activeFrame) || null;
  next.effectiveSolveMode = frameContextResult.preferredSolveMode || next.preferredSolveMode || null;

  if (frameContextResult.preferredSolveMode) {
    next.preferredSolveMode = frameContextResult.preferredSolveMode;
  }

  if (frameContextResult.activeAnswerInput) {
    next.activeAnswerInput = cloneJsonValue(frameContextResult.activeAnswerInput);
  }

  if (frameContextResult.activeSubmitButton) {
    next.activeSubmitButton = cloneJsonValue(frameContextResult.activeSubmitButton);
  }

  if (frameContextResult.submitApiAvailable === true) {
    next.submitApiAvailable = true;
  }

  if (frameContextResult.activeCaptureCandidate) {
    next.activeCaptureCandidate = cloneJsonValue(frameContextResult.activeCaptureCandidate);
  }

  if (frameContextResult.challengeText || frameContextResult.challengeMasked) {
    next.challengeText = frameContextResult.challengeText || frameContextResult.challengeMasked || next.challengeText || null;
    next.challengeMasked = frameContextResult.challengeMasked || frameContextResult.challengeText || next.challengeMasked || null;
  }

  if (Number(frameContextResult.challengeSlotCount) > 0) {
    next.challengeSlotCount = Number(frameContextResult.challengeSlotCount);
  }

  if (Array.isArray(frameContextResult.challengeCandidates) && frameContextResult.challengeCandidates.length > 0) {
    next.challengeCandidates = cloneJsonValue(frameContextResult.challengeCandidates) || [];
  }

  const normalizedAnswerLengthHint = normalizeCaptchaAnswerLengthHint(frameContextResult.answerLengthHint);
  if (normalizedAnswerLengthHint) {
    next.answerLengthHint = normalizedAnswerLengthHint;
  }

  return next;
}

function mergeResolvedCaptchaContext(baseContext = null, resolvedContext = null) {
  const next = {};
  let hasValue = false;

  const apply = (context) => {
    if (!context || typeof context !== 'object') return;

    for (const [key, value] of Object.entries(context)) {
      if (value === undefined || value === null) continue;
      next[key] = cloneJsonValue(value) || value;
      hasValue = true;
    }
  };

  apply(baseContext);
  apply(resolvedContext);

  return hasValue ? enrichCaptchaContextWithSolveHints(next) : null;
}

function isIframeCaptchaCandidate(candidate = null) {
  const kind = String(candidate?.kind || '').toLowerCase();
  const tagName = String(candidate?.tagName || '').toLowerCase();
  return tagName === 'iframe' || kind.includes('iframe');
}

function hasActionableFrameCaptchaCandidate(candidate = null) {
  if (!candidate || typeof candidate !== 'object') return false;

  const frameUrl = String(candidate.url || candidate.origin || '').toLowerCase();
  const hasChallengeSignals = !!(
    candidate.activeCaptureCandidate
    || candidate.challengeText
    || candidate.challengeMasked
    || (Array.isArray(candidate.challengeCandidates) && candidate.challengeCandidates.length > 0)
    || frameUrl.includes('dkaptcha')
  );

  if (candidate.activeAnswerInput || candidate.activeSubmitButton) {
    return hasChallengeSignals;
  }

  return hasChallengeSignals;
}

function hasActionableMainDomCaptcha(context = null) {
  if (!context || typeof context !== 'object') return false;

  const hasChallengeSignals = !!(
    (context.activeCaptureCandidate && !isIframeCaptchaCandidate(context.activeCaptureCandidate))
    || context.challengeText
    || context.challengeMasked
    || (Array.isArray(context.challengeCandidates) && context.challengeCandidates.length > 0)
  );

  if (hasChallengeSignals && (context.activeAnswerInput || context.activeSubmitButton)) {
    return true;
  }

  if (context.activeCaptureCandidate && !isIframeCaptchaCandidate(context.activeCaptureCandidate)) {
    return true;
  }

  return false;
}

function hasActionableFrameCaptcha(context = null, frameContextResult = null) {
  const frameCandidates = [
    ...(Array.isArray(frameContextResult?.frameCandidates) ? frameContextResult.frameCandidates : []),
    ...(Array.isArray(context?.frameCaptchaCandidates) ? context.frameCaptchaCandidates : [])
  ];

  if (frameCandidates.some(hasActionableFrameCaptchaCandidate)) {
    return true;
  }

  return !!(
    frameContextResult?.activeAnswerInput
    || frameContextResult?.activeSubmitButton
    || frameContextResult?.activeCaptureCandidate
    || context?.activeFrame
  );
}

function finalizeResolvedCaptchaContext(baseContext = null, frameContextResult = null) {
  const mergedContext = frameContextResult?.success
    ? mergeCaptchaContexts(baseContext, frameContextResult)
    : (cloneJsonValue(baseContext) || baseContext || null);

  if (!mergedContext || typeof mergedContext !== 'object') {
    return mergedContext;
  }

  const frameScanFailedClosed = !!(
    mergedContext.iframeCaptchaPresent
    && frameContextResult
    && frameContextResult.success === false
    && frameContextResult.status !== 'captcha_frame_not_found'
  );

  const captchaBlocking = hasActionableFrameCaptcha(mergedContext, frameContextResult)
    || hasActionableMainDomCaptcha(mergedContext)
    || frameScanFailedClosed;

  mergedContext.captchaPresent = captchaBlocking;
  mergedContext.captchaBlocking = captchaBlocking;
  mergedContext.iframeShellOnly = !!(mergedContext.iframeCaptchaPresent && !captchaBlocking);

  return enrichCaptchaContextWithSolveHints(mergedContext);
}

async function captchaFrameAction(action, options = {}) {
  const INPUT_HINT_RE = /(captcha|dkaptcha|kcaptcha|보안문자|자동등록방지|인증(?:번호)?|정답|security|answer|response|challenge|verification|code)/i;
  const BUTTON_HINT_RE = /(확인|인증|제출|전송|submit|confirm|verify|ok)/i;
  const IMAGE_HINT_RE = /(captcha|dkaptcha|kcaptcha|security|verify|code|image)/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const compactText = (value = '', maxLength = 160) => {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
  };

  const normalizeText = (value = '') => String(value ?? '').replace(/\s+/g, ' ').trim();
  const normalizeCaptchaAnswerLengthHint = (value = null) => {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 12) {
      return null;
    }
    return Math.floor(normalized);
  };

  const serializeRect = (rect) => {
    if (!rect) return null;
    return {
      left: Math.round(rect.left * 100) / 100,
      top: Math.round(rect.top * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      right: Math.round(rect.right * 100) / 100,
      bottom: Math.round(rect.bottom * 100) / 100
    };
  };

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0.01) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  };

  const getAssociatedText = (element) => {
    const parts = [];

    if (element?.labels?.length) {
      parts.push(...Array.from(element.labels).map((label) => label?.textContent || ''));
    }

    const closestLabel = element?.closest?.('label');
    if (closestLabel) parts.push(closestLabel.textContent || '');
    if (element?.previousElementSibling) parts.push(element.previousElementSibling.textContent || '');
    if (element?.nextElementSibling) parts.push(element.nextElementSibling.textContent || '');
    if (element?.parentElement) parts.push(element.parentElement.textContent || '');

    return compactText(parts.filter(Boolean).join(' '), 160);
  };

  const getDescriptor = (element) => normalizeText([
    element?.getAttribute?.('placeholder'),
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    element?.getAttribute?.('name'),
    element?.id,
    element?.className,
    element?.getAttribute?.('alt'),
    element?.getAttribute?.('src'),
    getAssociatedText(element),
    element?.textContent
  ].filter(Boolean).join(' '));

  const summarizeElement = (element, kind, score, extra = {}) => ({
    kind,
    tagName: element?.tagName?.toLowerCase?.() || null,
    type: element?.getAttribute?.('type') || null,
    id: element?.id || null,
    name: element?.getAttribute?.('name') || null,
    placeholder: compactText(element?.getAttribute?.('placeholder') || '', 80) || null,
    ariaLabel: compactText(element?.getAttribute?.('aria-label') || '', 80) || null,
    title: compactText(element?.getAttribute?.('title') || '', 80) || null,
    text: compactText(element?.textContent || '', 80) || null,
    className: compactText(element?.className || '', 120) || null,
    rect: serializeRect(element?.getBoundingClientRect?.()),
    score,
    ...extra
  });

  const collectInputs = () => Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
    .filter(isVisible)
    .map((element) => {
      const tagName = element.tagName?.toLowerCase?.() || '';
      const inputType = (element.getAttribute?.('type') || '').toLowerCase();
      if (tagName === 'input' && ['hidden', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(inputType)) {
        return null;
      }

      let score = 0;
      const descriptor = getDescriptor(element);
      if (INPUT_HINT_RE.test(descriptor)) score += 18;
      if (tagName === 'textarea' || element.isContentEditable || ['text', 'search', 'tel', 'number'].includes(inputType) || !inputType) score += 8;
      const maxLength = Number(element.getAttribute?.('maxlength') || 0);
      if (maxLength >= 2 && maxLength <= 12) score += 5;
      if (element.disabled) score -= 20;
      if (element.readOnly) score -= 8;
      if (score <= 0) return null;
      if (score < 10) return null;

      return {
        element,
        score,
        summary: summarizeElement(element, 'captcha_answer_input', score, {
          associatedText: getAssociatedText(element),
          maxLength: Number.isFinite(maxLength) && maxLength > 0 ? maxLength : null,
          valueLength: typeof element.value === 'string' ? element.value.length : compactText(element.textContent || '').length
        })
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const collectButtons = () => Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a, div, span'))
    .filter((element) => {
      if (!isVisible(element)) return false;
      const tagName = element.tagName?.toLowerCase?.() || '';
      if (['div', 'span', 'a'].includes(tagName)) {
        const text = normalizeText(element.textContent || '');
        return BUTTON_HINT_RE.test(text);
      }
      return true;
    })
    .map((element) => {
      const descriptor = getDescriptor(element);
      let score = 0;
      if (BUTTON_HINT_RE.test(descriptor)) score += 18;
      if (element.tagName?.toLowerCase?.() === 'button') score += 6;
      if (element.tagName?.toLowerCase?.() === 'input') score += 6;
      if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') score -= 18;
      if (score <= 0) return null;
      if (score < 10) return null;

      return {
        element,
        score,
        summary: summarizeElement(element, 'captcha_submit_button', score)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const collectImages = () => Array.from(document.querySelectorAll('img, canvas, svg'))
    .filter(isVisible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const descriptor = getDescriptor(element);
      let score = 0;
      if (IMAGE_HINT_RE.test(descriptor)) score += 18;
      if (element.tagName?.toLowerCase?.() === 'img') score += 10;
      if (element.tagName?.toLowerCase?.() === 'canvas') score += 8;
      if (rect.width >= 60 && rect.height >= 18) score += 4;
      if (rect.width <= 420 && rect.height <= 220) score += 3;
      if (score <= 0) return null;

      return {
        element,
        score,
        summary: summarizeElement(element, 'captcha_capture_candidate', score, {
          sourceUrl: element.tagName?.toLowerCase?.() === 'img'
            ? (element.currentSrc || element.getAttribute('src') || null)
            : null,
          associatedText: getAssociatedText(element)
        })
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const MASK_CHAR_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]/u;
  const MASK_RUN_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]+/gu;
  const WORD_MASK_RE = /(?:빈\s*칸|공\s*란)/u;
  const WORD_MASK_GLOBAL_RE = /(?:빈\s*칸|공\s*란)/gu;
  const INSTRUCTION_ACTION_RE = /(?:입력|선택|클릭|고르|찾|맞추|완성)(?:해\s*주|해주)?세요/u;
  const INSTRUCTION_ACTION_GLOBAL_RE = /([가-힣A-Za-z0-9][^.!?\n]{0,120}?(?:입력|선택|클릭|고르|찾|맞추|완성)(?:해\s*주|해주)?세요)/gu;
  const INSTRUCTION_KEYWORD_RE = /(지도|사진|이미지|화면|캡차|captcha|dkaptcha|있는|보이는|다음|아래|위|간판|명칭|상호|업체|장소|문구|텍스트|번호|주소|이름|병원|약국|한의원|학교|건물|매장|기관|단어|숫자)/iu;
  const INSTRUCTION_EXACT_IGNORE_RE = /^(?:정답(?:을)?\s*입력해주세요|답(?:을)?\s*입력해주세요|답변\s*제출|새로\s*풀기|음성\s*문제(?:\s*재생)?|dkaptcha(?:\s*\(captcha\s*서비스\))?|captcha\s*서비스)$/iu;
  const INSTRUCTION_TRAILING_NOISE_RE = /\s*(?:정답(?:을)?\s*입력해주세요|답(?:을)?\s*입력해주세요|새로\s*풀기|음성\s*문제(?:\s*재생)?|답변\s*제출|DKAPTCHA(?:\s*\(CAPTCHA\s*서비스\))?|CAPTCHA\s*서비스).*$/iu;
  const INSTRUCTION_LEADING_NOISE_RE = /^(?:DKAPTCHA(?:\s*\(CAPTCHA\s*서비스\))?|CAPTCHA(?:\s*서비스)?|보안문자|자동등록방지)\s*/iu;

  const normalizeChallengeMaskText = (value = '') => normalizeText(value).replace(WORD_MASK_GLOBAL_RE, '□');

  const countMaskSlots = (value = '') => {
    const normalized = normalizeText(value);
    const explicitMatches = normalized.match(MASK_RUN_RE);
    const explicitSlotCount = explicitMatches ? explicitMatches.reduce((sum, token) => sum + token.length, 0) : 0;
    if (explicitSlotCount > 0) return explicitSlotCount;
    return WORD_MASK_RE.test(normalized) ? null : 0;
  };

  const boundChallengeText = (value = '', maxLength = 72) => {
    const normalized = normalizeText(value);
    return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
  };

  const extractMaskedChallengeSnippet = (value = '') => {
    const normalized = normalizeText(value);
    const normalizedMaskText = normalizeChallengeMaskText(value);
    if (!normalizedMaskText || (!MASK_CHAR_RE.test(normalizedMaskText) && !WORD_MASK_RE.test(normalized))) return null;
    const snippetMatch = normalizedMaskText.match(/([가-힣A-Za-z0-9]{0,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2}\s*[□▢◻◼⬜⬛◯○●◎◇◆_＿]+\s*(?:[가-힣A-Za-z0-9]{1,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2})?)/u);
    const rawSnippetMatch = normalized.match(/([가-힣A-Za-z0-9]{0,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2}\s*(?:[□▢◻◼⬜⬛◯○●◎◇◆_＿]+|빈\s*칸|공\s*란)\s*(?:[가-힣A-Za-z0-9]{1,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2})?)/u);
    const maskedSnippet = snippetMatch?.[1] ? normalizeText(snippetMatch[1]) : normalizedMaskText;
    const rawSnippet = rawSnippetMatch?.[1] ? normalizeText(rawSnippetMatch[1]) : normalized;
    return {
      text: boundChallengeText(rawSnippet, 48),
      maskedText: boundChallengeText(maskedSnippet, 48),
      slotCount: countMaskSlots(normalized),
      kind: 'masked',
      matchScore: 24
    };
  };

  const normalizeInstructionCandidate = (value = '') => {
    let normalized = normalizeText(value);
    if (!normalized) return '';
    normalized = normalized.replace(INSTRUCTION_LEADING_NOISE_RE, '').trim();
    normalized = normalized.replace(INSTRUCTION_TRAILING_NOISE_RE, '').trim();
    normalized = normalized.replace(/^[-:|]\s*/, '').trim();
    return normalizeText(normalized);
  };

  const extractInstructionChallengeSnippet = (value = '') => {
    const normalized = normalizeText(value);
    if (!normalized) return null;

    const candidates = new Set();
    normalized.split(/\n+/).map((line) => normalizeText(line)).filter(Boolean).forEach((line) => candidates.add(line));
    Array.from(normalized.matchAll(INSTRUCTION_ACTION_GLOBAL_RE)).forEach((match) => {
      if (match?.[1]) candidates.add(match[1]);
    });

    let best = null;
    candidates.forEach((candidate) => {
      const cleaned = normalizeInstructionCandidate(candidate);
      if (!cleaned || INSTRUCTION_EXACT_IGNORE_RE.test(cleaned) || !INSTRUCTION_ACTION_RE.test(cleaned)) return;

      let score = 10;
      if (INSTRUCTION_KEYWORD_RE.test(cleaned)) score += 10;
      if (/(?:전체|정확한|일치하는|해당|같은)/u.test(cleaned)) score += 4;
      if (/(?:있는|보이는|다음|아래|위)/u.test(cleaned)) score += 4;
      if (cleaned.length >= 12 && cleaned.length <= 56) score += 3;
      if (/^(?:정답|답변)/u.test(cleaned)) score -= 12;
      if (/(?:새로\s*풀기|음성\s*문제|답변\s*제출|captcha\s*서비스|dkaptcha)/iu.test(cleaned)) score -= 18;
      if (score < 16) return;

      const snippet = {
        text: boundChallengeText(cleaned, 80),
        maskedText: boundChallengeText(cleaned, 80),
        slotCount: null,
        kind: 'instruction',
        matchScore: score
      };
      if (!best || snippet.matchScore > best.matchScore || (snippet.matchScore === best.matchScore && snippet.text.length < best.text.length)) {
        best = snippet;
      }
    });

    return best;
  };

  const extractChallengeSnippet = (value = '') => extractMaskedChallengeSnippet(value) || extractInstructionChallengeSnippet(value);

  const buildChallenge = (runtime) => {
    const entries = [];
    const pushEntry = (value, source, score) => {
      const snippet = extractChallengeSnippet(value);
      if (!snippet) return;
      entries.push({
        text: snippet.text,
        maskedText: snippet.maskedText || snippet.text,
        slotCount: snippet.slotCount,
        source,
        kind: snippet.kind || 'masked',
        score: Number(score || 0) + Number(snippet.matchScore || 0) + (snippet.kind === 'instruction' ? 8 : 18)
      });
    };

    (document.body?.innerText || '')
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter(Boolean)
      .forEach((line) => pushEntry(line, 'frame_body_line', 36));

    const descriptorTexts = [
      runtime.bodyHint,
      ...runtime.answerInputs.map((entry) => entry.summary?.associatedText || ''),
      ...runtime.submitButtons.map((entry) => entry.summary?.text || ''),
      ...runtime.captureCandidates.map((entry) => entry.summary?.associatedText || ''),
      ...runtime.captureCandidates.map((entry) => entry.summary?.text || '')
    ];
    descriptorTexts.forEach((value) => pushEntry(value, 'frame_descriptor', 20));

    const deduped = [];
    const seen = new Set();
    entries.forEach((entry) => {
      const key = `${entry.kind || 'masked'}::${entry.maskedText || entry.text || ''}::${entry.slotCount ?? 'var'}`;
      if (!entry.text || seen.has(key)) return;
      seen.add(key);
      deduped.push(entry);
    });
    deduped.sort((a, b) => b.score - a.score || ((b.kind === 'masked') - (a.kind === 'masked')) || a.text.length - b.text.length);

    return {
      challengeText: deduped[0]?.text || deduped[0]?.maskedText || null,
      challengeMasked: deduped[0]?.maskedText || deduped[0]?.text || null,
      challengeSlotCount: Number.isFinite(deduped[0]?.slotCount) ? deduped[0].slotCount : null,
      challengeCandidates: deduped.slice(0, 5)
    };
  };

  const collectRuntime = () => {
    const answerInputs = collectInputs();
    const submitButtons = collectButtons();
    const captureCandidates = collectImages();
    const bodyHint = compactText(document.body?.innerText || '', 360);
    const submitApiAvailable = typeof window.dkaptcha?.submit === 'function';
    const reasons = [];
    let score = 0;

    if (INPUT_HINT_RE.test(bodyHint) || INPUT_HINT_RE.test(window.location.href || '') || INPUT_HINT_RE.test(document.title || '')) {
      score += 20;
      reasons.push('captcha_text_hint');
    }
    if (captureCandidates[0]) {
      score += 12;
      reasons.push('visual_candidate');
    }
    if (answerInputs[0]) {
      score += 14;
      reasons.push('answer_input');
    }
    if (submitButtons[0]) {
      score += 10;
      reasons.push('submit_button');
    }
    if (captureCandidates[0] && answerInputs[0]) {
      score += 8;
      reasons.push('visual_plus_input');
    }
    if (answerInputs[0] && submitButtons[0]) {
      score += 6;
      reasons.push('input_plus_button');
    }

    const candidateCount = answerInputs.length + submitButtons.length + captureCandidates.length;
    return {
      url: window.location.href || null,
      origin: window.location.origin || null,
      title: document.title || null,
      bodyHint,
      reasons,
      score,
      captchaLike: score >= 22 || (!!captureCandidates[0] && !!answerInputs[0] && !!submitButtons[0]),
      candidateCount,
      viewport: {
        innerWidth: window.innerWidth || null,
        innerHeight: window.innerHeight || null,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      submitApiAvailable,
      answerInputs,
      submitButtons,
      captureCandidates
    };
  };

  const toSerializableContext = (runtime) => {
    const challenge = buildChallenge(runtime);
    const answerLengthHint = normalizeCaptchaAnswerLengthHint(runtime.answerInputs[0]?.summary?.maxLength)
      || challenge.challengeSlotCount
      || null;

    return {
      success: true,
      url: runtime.url,
      origin: runtime.origin,
      title: runtime.title,
      bodyHint: runtime.bodyHint,
      reasons: runtime.reasons,
      score: runtime.score,
      captchaLike: runtime.captchaLike,
      candidateCount: runtime.candidateCount,
      answerInputCandidateCount: runtime.answerInputs.length,
      answerInputCandidates: runtime.answerInputs.map((entry) => entry.summary),
      activeAnswerInput: runtime.answerInputs[0]?.summary || null,
      submitButtonCandidateCount: runtime.submitButtons.length,
      submitButtonCandidates: runtime.submitButtons.map((entry) => entry.summary),
      activeSubmitButton: runtime.submitButtons[0]?.summary || null,
      captureCandidateCount: runtime.captureCandidates.length,
      captureCandidates: runtime.captureCandidates.map((entry) => entry.summary),
      activeCaptureCandidate: runtime.captureCandidates[0]?.summary || null,
      challengeText: challenge.challengeText,
      challengeMasked: challenge.challengeMasked,
      challengeSlotCount: challenge.challengeSlotCount,
      challengeCandidates: challenge.challengeCandidates,
      answerLengthHint,
      submitApiAvailable: runtime.submitApiAvailable === true,
      viewport: runtime.viewport
    };
  };

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('frame_blob_read_failed'));
    reader.readAsDataURL(blob);
  });

  const extractArtifact = async () => {
    const runtime = collectRuntime();
    const selected = runtime.captureCandidates[0] || null;
    if (!selected) {
      return {
        success: false,
        status: 'captcha_frame_artifact_not_found',
        error: 'cross-frame CAPTCHA 이미지 후보를 찾지 못했습니다.',
        frameContext: toSerializableContext(runtime)
      };
    }

    const element = selected.element;
    const tagName = element?.tagName?.toLowerCase?.() || null;
    try {
      let dataUrl = null;
      let mimeType = 'image/png';

      if (tagName === 'canvas') {
        dataUrl = element.toDataURL('image/png');
      } else if (tagName === 'img') {
        const sourceUrl = element.currentSrc || element.src || element.getAttribute('src') || null;
        if (!sourceUrl) throw new Error('captcha_frame_image_src_missing');
        if (sourceUrl.startsWith('data:')) {
          dataUrl = sourceUrl;
          mimeType = sourceUrl.slice(5, sourceUrl.indexOf(';')) || mimeType;
        } else {
          try {
            const response = await fetch(sourceUrl, { credentials: 'include', cache: 'no-store' });
            if (!response.ok) throw new Error(`captcha_frame_fetch_${response.status}`);
            const blob = await response.blob();
            mimeType = blob.type || mimeType;
            dataUrl = await blobToDataUrl(blob);
          } catch (fetchError) {
            const canvas = document.createElement('canvas');
            canvas.width = element.naturalWidth || element.width || 1;
            canvas.height = element.naturalHeight || element.height || 1;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw fetchError;
            ctx.drawImage(element, 0, 0);
            dataUrl = canvas.toDataURL('image/png');
            mimeType = 'image/png';
          }
        }
      } else {
        throw new Error(`captcha_frame_unsupported_tag:${tagName || 'unknown'}`);
      }

      return {
        success: true,
        status: 'captcha_frame_artifact_ready',
        frameContext: toSerializableContext(runtime),
        selectedCandidate: selected.summary,
        artifact: {
          kind: 'frame_direct_image',
          mimeType,
          dataUrl,
          width: tagName === 'canvas'
            ? (element.width || null)
            : (element.naturalWidth || element.width || null),
          height: tagName === 'canvas'
            ? (element.height || null)
            : (element.naturalHeight || element.height || null),
          sourceTagName: tagName,
          sourceUrl: tagName === 'img'
            ? (element.currentSrc || element.src || element.getAttribute('src') || null)
            : null,
          rect: selected.summary?.rect || null
        }
      };
    } catch (error) {
      return {
        success: false,
        status: 'captcha_frame_artifact_failed',
        error: error.message,
        selectedCandidate: selected.summary,
        frameContext: toSerializableContext(runtime)
      };
    }
  };

  const simulateClick = (element) => {
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) => {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    if (typeof element.click === 'function') {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  };

  const submitCaptchaChallenge = (button) => {
    const info = {
      submitApiCalled: false,
      submitApiError: null,
      buttonClicked: false
    };

    if (typeof window.dkaptcha?.submit === 'function') {
      try {
        window.dkaptcha.submit();
        info.submitApiCalled = true;
        return info;
      } catch (error) {
        info.submitApiError = error?.message || String(error);
      }
    }

    info.buttonClicked = simulateClick(button);
    return info;
  };

  const applyTextValue = (element, value) => {
    if (!element) return false;

    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();

    if (element.isContentEditable) {
      element.textContent = value;
    } else {
      const prototype = element.tagName?.toLowerCase?.() === 'textarea'
        ? window.HTMLTextAreaElement?.prototype
        : window.HTMLInputElement?.prototype;
      const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
      if (descriptor?.set) {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
      }
    }

    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter' }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Process' }));
    return true;
  };

  const normalizedAnswer = normalizeText(options.answer || '').replace(/\s+/g, '');

  if (action === 'submit') {
    const runtimeBefore = collectRuntime();
    const selectedInput = runtimeBefore.answerInputs[0] || null;

    if (!normalizedAnswer) {
      return {
        success: false,
        status: 'captcha_answer_required',
        error: 'CAPTCHA 답안을 입력하세요.',
        frameContext: toSerializableContext(runtimeBefore)
      };
    }

    if (!selectedInput) {
      return {
        success: false,
        status: 'captcha_frame_input_not_found',
        error: 'cross-frame CAPTCHA 입력창을 찾지 못했습니다.',
        frameContext: toSerializableContext(runtimeBefore)
      };
    }

    applyTextValue(selectedInput.element, normalizedAnswer);
    await sleep(120);
    const appliedValue = selectedInput.element.isContentEditable
      ? normalizeText(selectedInput.element.textContent || '')
      : normalizeText(selectedInput.element.value || selectedInput.element.textContent || '');
    const inputApplied = appliedValue.replace(/\s+/g, '') === normalizedAnswer;
    const runtimeReadyToSubmit = collectRuntime();
    const selectedButton = runtimeReadyToSubmit.submitButtons[0] || runtimeBefore.submitButtons[0] || null;
    const submitApiAvailable = runtimeReadyToSubmit.submitApiAvailable === true || runtimeBefore.submitApiAvailable === true;

    if (!inputApplied) {
      return {
        success: false,
        status: 'captcha_frame_input_not_applied',
        error: 'cross-frame CAPTCHA 답안을 입력창에 적용하지 못했습니다.',
        selectedInput: selectedInput.summary,
        frameContext: toSerializableContext(runtimeReadyToSubmit)
      };
    }

    if (!selectedButton && !submitApiAvailable) {
      return {
        success: false,
        status: 'captcha_frame_submit_not_found',
        error: 'cross-frame CAPTCHA 제출 버튼을 찾지 못했습니다.',
        selectedInput: selectedInput.summary,
        frameContext: toSerializableContext(runtimeReadyToSubmit)
      };
    }

    const submitDispatch = submitCaptchaChallenge(selectedButton?.element || null);
    await sleep(Math.max(300, Number(options.waitMs) || 1200));

    const runtimeAfter = collectRuntime();
    return {
      success: true,
      status: runtimeAfter.captchaLike ? 'captcha_still_present' : 'captcha_submitted',
      url: window.location.href || null,
      clicked: !!submitDispatch.buttonClicked || !!submitDispatch.submitApiCalled,
      submitApiCalled: !!submitDispatch.submitApiCalled,
      submitApiError: submitDispatch.submitApiError || null,
      submitApiAvailable,
      inputApplied,
      answerLength: normalizedAnswer.length,
      captchaStillAppears: runtimeAfter.captchaLike,
      selectedInput: selectedInput.summary,
      selectedButton: selectedButton?.summary || null,
      frameContextBefore: toSerializableContext(runtimeBefore),
      frameContextReadyToSubmit: toSerializableContext(runtimeReadyToSubmit),
      frameContextAfter: toSerializableContext(runtimeAfter),
      frameContext: toSerializableContext(runtimeAfter)
    };
  }

  if (action === 'extract_artifact') {
    return await extractArtifact();
  }

  const runtime = collectRuntime();
  return {
    success: true,
    status: 'captcha_frame_context_ready',
    frameContext: toSerializableContext(runtime)
  };
}

async function executeCaptchaFrameActionOnAllFrames(tabId, action, options = {}) {
  if (!tabId) {
    return {
      success: false,
      status: 'editor_not_ready',
      error: 'cross-frame CAPTCHA 처리를 위한 탭 ID가 없습니다.',
      tabId
    };
  }

  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: captchaFrameAction,
      args: [action, options]
    });
    return {
      success: true,
      status: 'captcha_frame_action_ready',
      tabId,
      frames: normalizeCaptchaFrameEntries(injectionResults)
    };
  } catch (error) {
    return {
      success: false,
      status: 'captcha_frame_action_failed',
      error: error.message,
      tabId
    };
  }
}

async function getCrossFrameCaptchaContextForTab(tabId) {
  const frameScan = await executeCaptchaFrameActionOnAllFrames(tabId, 'inspect');
  if (!frameScan.success) {
    return frameScan;
  }

  const frameEntries = (frameScan.frames || []).filter((entry) => {
    const frameContext = entry.frameContext || {};
    return hasActionableFrameCaptchaCandidate(frameContext);
  });

  if (frameEntries.length === 0) {
    return {
      success: false,
      status: 'captcha_frame_not_found',
      error: 'cross-frame CAPTCHA 후보를 찾지 못했습니다.',
      tabId,
      frameCandidates: []
    };
  }

  const activeEntry = frameEntries[0];
  const activeSummary = summarizeCaptchaFrameEntry(activeEntry);
  const frameCandidates = frameEntries.map(summarizeCaptchaFrameEntry);

  return {
    success: true,
    status: 'captcha_frame_context_ready',
    tabId,
    frameCandidateCount: frameCandidates.length,
    frameCandidates,
    activeFrame: {
      frameId: activeSummary.frameId,
      documentId: activeSummary.documentId,
      url: activeSummary.url,
      origin: activeSummary.origin,
      title: activeSummary.title,
      score: activeSummary.score,
      reasons: activeSummary.reasons,
      candidateCount: activeSummary.candidateCount
    },
    activeAnswerInput: activeSummary.activeAnswerInput,
    activeSubmitButton: activeSummary.activeSubmitButton,
    activeCaptureCandidate: activeSummary.activeCaptureCandidate,
    challengeText: activeSummary.challengeText || activeSummary.challengeMasked || null,
    challengeMasked: activeSummary.challengeMasked || activeSummary.challengeText || null,
    challengeSlotCount: Number(activeSummary.challengeSlotCount) || null,
    challengeCandidates: cloneJsonValue(activeSummary.challengeCandidates) || [],
    answerLengthHint: normalizeCaptchaAnswerLengthHint(activeSummary.answerLengthHint)
      || Number(activeSummary.challengeSlotCount)
      || null,
    submitApiAvailable: activeSummary.submitApiAvailable === true,
    preferredSolveMode: hasActionableCaptchaAnswerPath(activeSummary)
      ? 'extension_frame_dom'
      : 'browser_handoff',
    frameContext: mergeCaptchaContexts(null, {
      success: true,
      frameCandidateCount: frameCandidates.length,
      frameCandidates,
      activeFrame: {
        frameId: activeSummary.frameId,
        documentId: activeSummary.documentId,
        url: activeSummary.url,
        origin: activeSummary.origin,
        title: activeSummary.title,
        score: activeSummary.score,
        reasons: activeSummary.reasons,
        candidateCount: activeSummary.candidateCount
      },
      activeAnswerInput: activeSummary.activeAnswerInput,
      activeSubmitButton: activeSummary.activeSubmitButton,
      activeCaptureCandidate: activeSummary.activeCaptureCandidate,
      challengeText: activeSummary.challengeText || activeSummary.challengeMasked || null,
      challengeMasked: activeSummary.challengeMasked || activeSummary.challengeText || null,
      challengeSlotCount: Number(activeSummary.challengeSlotCount) || null,
      challengeCandidates: cloneJsonValue(activeSummary.challengeCandidates) || [],
      answerLengthHint: normalizeCaptchaAnswerLengthHint(activeSummary.answerLengthHint)
        || Number(activeSummary.challengeSlotCount)
        || null,
      submitApiAvailable: activeSummary.submitApiAvailable === true,
      preferredSolveMode: hasActionableCaptchaAnswerPath(activeSummary)
        ? 'extension_frame_dom'
        : 'browser_handoff'
    })
  };
}

async function getCrossFrameCaptchaArtifactForTab(tabId, options = {}) {
  const frameContextResult = await getCrossFrameCaptchaContextForTab(tabId);
  if (!frameContextResult.success || !frameContextResult.activeFrame?.frameId) {
    return {
      ...frameContextResult,
      tabId
    };
  }

  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameContextResult.activeFrame.frameId] },
      func: captchaFrameAction,
      args: ['extract_artifact', { includeSourceImage: !!options.includeSourceImage }]
    });
    const payload = injectionResults?.[0]?.result || null;
    if (!payload) {
      return {
        success: false,
        status: 'captcha_frame_artifact_failed',
        error: 'cross-frame CAPTCHA 아티팩트 응답이 비어 있습니다.',
        tabId,
        frameId: frameContextResult.activeFrame.frameId,
        frameContextResult
      };
    }

    return {
      ...payload,
      tabId,
      frameId: frameContextResult.activeFrame.frameId,
      selectedCandidate: withFrameMetadata(payload.selectedCandidate, frameContextResult.activeFrame.frameId),
      artifact: payload.artifact
        ? {
            ...payload.artifact,
            frameId: frameContextResult.activeFrame.frameId
          }
        : null,
      frameContext: mergeCaptchaContexts(payload.frameContext || null, frameContextResult),
      frameContextResult
    };
  } catch (error) {
    return {
      success: false,
      status: 'captcha_frame_artifact_failed',
      error: error.message,
      tabId,
      frameId: frameContextResult.activeFrame.frameId,
      frameContextResult
    };
  }
}

async function recoverMissingFrameSubmitResult(tabId, frameContextResult, answer, options = {}) {
  const probeDelayMs = clamp(Number(options.postSubmitProbeDelayMs) || 450, 50, 5000);
  await delay(probeDelayMs);

  let liveTab = null;
  try {
    liveTab = await chrome.tabs.get(tabId);
  } catch (_error) {}

  const tabUrl = liveTab?.url || null;
  let refreshedContextResult = null;

  if (!looksLikeDirectPublishCompletionUrl(tabUrl || '')) {
    try {
      refreshedContextResult = await getCaptchaContextForTab(tabId);
    } catch (_error) {}
  }

  const recovered = classifyRecoveredCaptchaSubmitOutcome({
    tabUrl,
    captchaContext: refreshedContextResult?.success ? refreshedContextResult.captchaContext || null : null
  });

  if (!recovered) {
    return null;
  }

  const recoveredFrameContext = refreshedContextResult?.success
    ? mergeCaptchaContexts(refreshedContextResult.captchaContext || null, frameContextResult)
    : (frameContextResult.frameContext || null);

  return {
    success: true,
    status: recovered.status,
    url: recovered.url || tabUrl || null,
    clicked: true,
    inputApplied: true,
    answerLength: normalizeCaptchaAnswer(answer).value.length,
    captchaStillAppears: !!recovered.captchaStillAppears,
    submitStrategy: 'extension_frame_dom_recovered',
    recoveredAfterMissingResponse: true,
    recoveredReason: recovered.recoveredReason,
    selectedInput: withFrameMetadata(frameContextResult.activeAnswerInput, frameContextResult.activeFrame?.frameId || null),
    selectedButton: withFrameMetadata(frameContextResult.activeSubmitButton, frameContextResult.activeFrame?.frameId || null),
    frameContextBefore: frameContextResult.frameContext || null,
    frameContextAfter: refreshedContextResult?.success ? refreshedContextResult.captchaContext || null : null,
    frameContext: recoveredFrameContext,
    postSubmitProbe: {
      probeDelayMs,
      tabUrl,
      contextStatus: refreshedContextResult?.status || null,
      contextSuccess: !!refreshedContextResult?.success
    },
    frameContextResult
  };
}

async function submitCaptchaViaFrameForTab(tabId, answer, options = {}) {
  const frameContextResult = await getCrossFrameCaptchaContextForTab(tabId);
  if (!frameContextResult.success || !frameContextResult.activeFrame?.frameId) {
    return {
      ...frameContextResult,
      tabId
    };
  }

  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameContextResult.activeFrame.frameId] },
      func: captchaFrameAction,
      args: ['submit', { answer, waitMs: options.waitMs }]
    });
    const payload = injectionResults?.[0]?.result || null;
    if (!payload) {
      const recoveredResult = await recoverMissingFrameSubmitResult(tabId, frameContextResult, answer, options);
      if (recoveredResult) {
        return recoveredResult;
      }

      return {
        success: false,
        status: 'captcha_frame_submit_failed',
        error: 'cross-frame CAPTCHA 제출 응답이 비어 있습니다.',
        tabId,
        frameId: frameContextResult.activeFrame.frameId,
        frameContextResult
      };
    }

    return {
      ...payload,
      tabId,
      frameId: frameContextResult.activeFrame.frameId,
      submitStrategy: 'extension_frame_dom',
      selectedInput: withFrameMetadata(payload.selectedInput, frameContextResult.activeFrame.frameId),
      selectedButton: withFrameMetadata(payload.selectedButton, frameContextResult.activeFrame.frameId),
      frameContext: mergeCaptchaContexts(payload.frameContext || payload.frameContextAfter || payload.frameContextBefore || null, frameContextResult),
      frameContextResult
    };
  } catch (error) {
    const recoveredResult = await recoverMissingFrameSubmitResult(tabId, frameContextResult, answer, options);
    if (recoveredResult) {
      return {
        ...recoveredResult,
        previousError: error.message
      };
    }

    return {
      success: false,
      status: 'captcha_frame_submit_failed',
      error: error.message,
      tabId,
      frameId: frameContextResult.activeFrame.frameId,
      frameContextResult
    };
  }
}

function stripHtmlTags(value = '') {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildExpectedDraftShape(requestData = {}) {
  const normalized = normalizeDirectPublishRequestData(requestData);
  const tags = normalized.tags
    .map(tag => String(tag || '').trim())
    .filter(Boolean);
  const images = normalized.images.filter(Boolean);

  return {
    ...normalized,
    title: String(normalized.title || '').trim(),
    content: String(normalized.content || ''),
    category: normalized.category ? String(normalized.category).trim() : '',
    tags,
    images,
    contentTextLength: stripHtmlTags(normalized.content || '').length
  };
}

function buildDraftRestorePlan(snapshot = {}, requestData = {}) {
  const expected = buildExpectedDraftShape(requestData);
  const tagsLower = new Set((snapshot.tags || []).map(tag => String(tag || '').trim().toLowerCase()).filter(Boolean));
  const missing = [];
  const steps = [];

  if (expected.title && (!snapshot.title || snapshot.title !== expected.title)) {
    missing.push('title');
    steps.push('SET_TITLE');
  }

  if (expected.category && (!snapshot.currentCategory || snapshot.currentCategory !== expected.category)) {
    missing.push('category');
    steps.push('SET_CATEGORY');
  }

  if (expected.content) {
    const snapshotHtmlLength = Number(snapshot.contentHtmlLength) || 0;
    const snapshotTextLength = Number(snapshot.contentTextLength) || 0;
    const expectedHtmlLength = expected.content.trim().length;
    const expectedTextLength = expected.contentTextLength;
    const htmlTooShort = expectedHtmlLength > 0 && snapshotHtmlLength < Math.min(80, expectedHtmlLength);
    const textTooShort = expectedTextLength > 0 && snapshotTextLength < Math.min(40, expectedTextLength);

    if (htmlTooShort || textTooShort) {
      missing.push('content');
      steps.push('SET_CONTENT');
    }
  }

  if (expected.images.length > 0 && (Number(snapshot.imageCount) || 0) < expected.images.length) {
    missing.push('images');
    steps.push('INSERT_IMAGES');
  }

  if (expected.tags.length > 0 && (!snapshot.tags?.length || expected.tags.some(tag => !tagsLower.has(tag.toLowerCase())))) {
    missing.push('tags');
    steps.push('SET_TAGS');
  }

  return {
    expected,
    missing,
    steps: [...new Set(steps)],
    needsRestore: missing.length > 0
  };
}


function formatRecoveryVerificationIssues(issues = []) {
  const messages = {
    recovery_post_missing: '발행 직후 생성된 글을 찾지 못했습니다.',
    recovery_post_title_mismatch: '발행 직후 글 제목이 요청과 일치하지 않습니다.',
    recovery_post_content_missing: '발행 직후 저장된 글 본문이 비어 있습니다.',
    recovery_post_text_too_small: '발행 직후 저장된 글 본문 길이가 기대치보다 너무 짧습니다.',
    recovery_post_images_missing: '발행 직후 저장된 글 이미지가 누락되었습니다.',
    recovery_snapshot_unavailable: '발행 직후 저장된 글 편집 화면을 확인하지 못했습니다.'
  };

  return issues.map((issue) => messages[issue] || issue).join(' ');
}

async function fetchManagePostsListForTab(tabId) {
  if (!tabId) {
    return {
      success: false,
      status: 'editor_not_ready',
      error: 'posts 목록을 읽을 탭 ID가 없습니다.'
    };
  }

  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        try {
          const response = await fetch('/manage/posts.json', { credentials: 'include', cache: 'no-store' });
          const text = await response.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_error) {}

          return {
            ok: response.ok,
            status: response.status,
            json,
            textPreview: typeof text === 'string' ? text.slice(0, 500) : ''
          };
        } catch (error) {
          return {
            ok: false,
            status: 0,
            error: error.message || String(error)
          };
        }
      }
    });

    const result = injectionResults?.[0]?.result || null;
    if (!result?.ok || !result?.json) {
      return {
        success: false,
        status: 'manage_posts_unavailable',
        error: result?.error || `manage/posts.json fetch failed (${result?.status || 'unknown'})`,
        response: result || null
      };
    }

    return {
      success: true,
      status: 'manage_posts_ready',
      items: Array.isArray(result.json.items) ? result.json.items : [],
      totalCount: Number(result.json.totalCount) || 0,
      response: result
    };
  } catch (error) {
    return {
      success: false,
      status: 'manage_posts_unavailable',
      error: error.message,
      response: null
    };
  }
}

async function captureEditPostSnapshotForTab(tabId, blogName, postId) {
  if (!tabId || !blogName || !postId) {
    return {
      success: false,
      status: 'recovery_snapshot_unavailable',
      error: 'edit snapshot에 필요한 정보(tabId/blogName/postId)가 부족합니다.'
    };
  }

  const targetUrl = `https://${blogName}.tistory.com/manage/post/${postId}`;

  try {
    await chrome.tabs.update(tabId, { url: targetUrl, active: true });
    const loadResult = await waitForTabLoadComplete(tabId, 15000);
    if (!loadResult.success) {
      return {
        success: false,
        status: 'recovery_snapshot_unavailable',
        error: loadResult.error || 'edit page load failed',
        url: targetUrl
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const titleCandidates = [
          'input[name="title"]',
          'textarea[name="title"]',
          'input[placeholder*="제목"]',
          'textarea[placeholder*="제목"]'
        ];
        const titleEl = titleCandidates.map((selector) => document.querySelector(selector)).find(Boolean);

        const frames = Array.from(document.querySelectorAll('iframe'));
        let editorBody = null;
        for (const frame of frames) {
          try {
            const doc = frame.contentDocument || frame.contentWindow?.document;
            const body = doc?.body;
            if (body && (body.innerHTML || body.textContent)) {
              editorBody = body;
              break;
            }
          } catch (_error) {}
        }

        const html = (editorBody?.innerHTML || '').trim();
        const text = (editorBody?.innerText || editorBody?.textContent || '').replace(/\s+/g, ' ').trim();

        return {
          url: window.location.href,
          documentTitle: document.title || '',
          title: titleEl?.value?.trim() || titleEl?.textContent?.trim() || '',
          contentHtmlLength: html.length,
          contentTextLength: text.length,
          imageCount: (html.match(/<img\b/gi) || []).length,
          hasMeaningfulContent: text.length > 0 || /<img\b/i.test(html),
          hasImgur: /i\.imgur\.com/i.test(html)
        };
      }
    });

    return {
      success: true,
      status: 'recovery_snapshot_ready',
      postId: String(postId),
      snapshot: injectionResults?.[0]?.result || null,
      url: targetUrl
    };
  } catch (error) {
    return {
      success: false,
      status: 'recovery_snapshot_unavailable',
      error: error.message,
      postId: String(postId),
      url: targetUrl
    };
  }
}

function verifyRecoverySnapshotAgainstRequest({ requestData = {}, item = null, snapshot = null }) {
  const expected = buildExpectedDraftShape(requestData);
  const issues = [];
  const titleFromItem = String(item?.title || '').trim();
  const titleFromSnapshot = String(snapshot?.title || '').trim();
  const expectedTitle = String(expected.title || '').trim();

  if (!item) {
    issues.push('recovery_post_missing');
  }

  if (expectedTitle && titleFromItem !== expectedTitle && titleFromSnapshot !== expectedTitle) {
    issues.push('recovery_post_title_mismatch');
  }

  if (!snapshot) {
    issues.push('recovery_snapshot_unavailable');
  } else {
    if (!snapshot.hasMeaningfulContent) {
      issues.push('recovery_post_content_missing');
    }

    if ((expected.contentTextLength || 0) > 0 && (Number(snapshot.contentTextLength) || 0) < Math.min(40, expected.contentTextLength)) {
      issues.push('recovery_post_text_too_small');
    }

    if ((expected.images || []).length > 0 && (Number(snapshot.imageCount) || 0) < expected.images.length) {
      issues.push('recovery_post_images_missing');
    }
  }

  return {
    confirmed: issues.length === 0,
    issues,
    error: issues.length === 0 ? null : formatRecoveryVerificationIssues(issues),
    expected: {
      title: expectedTitle,
      contentTextLength: expected.contentTextLength,
      imageCount: (expected.images || []).length
    },
    actual: snapshot ? {
      title: titleFromSnapshot || titleFromItem,
      contentTextLength: Number(snapshot.contentTextLength) || 0,
      imageCount: Number(snapshot.imageCount) || 0,
      hasMeaningfulContent: !!snapshot.hasMeaningfulContent,
      hasImgur: !!snapshot.hasImgur
    } : null
  };
}

async function verifyPublishedPostRecovery(tabId, blogName, requestData = {}) {
  const postsResult = await fetchManagePostsListForTab(tabId);
  if (!postsResult.success) {
    return {
      success: false,
      status: 'persistence_unverified',
      error: postsResult.error || '발행 직후 posts 목록을 확인하지 못했습니다.',
      postsResult
    };
  }

  const expected = buildExpectedDraftShape(requestData);
  const items = Array.isArray(postsResult.items) ? postsResult.items : [];
  const candidates = items
    .filter((item) => !expected.title || String(item.title || '').trim() === expected.title)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
    .slice(0, 3);

  if (candidates.length === 0) {
    return {
      success: false,
      status: 'persistence_unverified',
      error: formatRecoveryVerificationIssues(['recovery_post_missing']),
      candidates: []
    };
  }

  const failures = [];
  for (const candidate of candidates) {
    const snapshotResult = await captureEditPostSnapshotForTab(tabId, blogName, candidate.id);
    const verification = verifyRecoverySnapshotAgainstRequest({
      requestData,
      item: candidate,
      snapshot: snapshotResult.success ? snapshotResult.snapshot : null
    });

    if (verification.confirmed) {
      return {
        success: true,
        status: 'confirmed',
        item: candidate,
        snapshot: snapshotResult.snapshot,
        verification,
        permalink: candidate.permalink || null,
        editUrl: snapshotResult.snapshot?.url || snapshotResult.url || null
      };
    }

    failures.push({
      item: candidate,
      snapshot: snapshotResult.success ? snapshotResult.snapshot : null,
      snapshotResult,
      verification
    });
  }

  return {
    success: false,
    status: 'persistence_unverified',
    error: failures[0]?.verification?.error || '발행 직후 생성된 글 본문/이미지 검증에 실패했습니다.',
    candidates: failures
  };
}

function isMissingTabConnectionError(error) {
  return /Could not establish connection|Receiving end does not exist/i.test(error?.message || '');
}

async function recoverPublishedResponseAfterSendMessageFailure(preparation, requestData = {}, options = {}) {
  if (!preparation?.tabId) {
    return null;
  }

  const waitMs = Math.max(0, Number(options.waitMs) || 3000);
  if (waitMs > 0) {
    await delay(waitMs);
  }

  let tabAfter;
  try {
    tabAfter = await chrome.tabs.get(preparation.tabId);
  } catch (_error) {
    return null;
  }

  const urlAfter = tabAfter?.url || '';
  const recoveryBlogName = options.blogName || requestData.blogName || preparation.blogName || getTabBlogName(urlAfter);
  const recoveryBase = {
    tabId: preparation.tabId,
    url: urlAfter,
    blogName: recoveryBlogName,
    diagnostics: preparation.diagnostics
  };

  const buildRecoveredResponse = (recoveryVerification, note) => ({
    ...makePreparationResponse({
      success: true,
      status: 'published',
      tab: tabAfter,
      url: recoveryVerification.permalink || urlAfter,
      blogName: recoveryBlogName,
      diagnostics: preparation.diagnostics
    }),
    recoveryVerification,
    note
  });

  const buildRecoveryFailure = (recoveryVerification) => ({
    ...makePreparationResponse({
      success: false,
      status: recoveryVerification.status || 'persistence_unverified',
      error: recoveryVerification.error || '발행 후 저장된 글 검증에 실패했습니다.',
      ...recoveryBase
    }),
    recoveryVerification
  });

  if (!isNewPostTab(urlAfter) && urlAfter.includes('/manage/')) {
    const recoveryVerification = await verifyPublishedPostRecovery(preparation.tabId, recoveryBlogName, requestData || {});
    return recoveryVerification.success
      ? buildRecoveredResponse(recoveryVerification, '발행 후 페이지 이동 감지 + 저장된 글 본문/이미지 검증 완료')
      : buildRecoveryFailure(recoveryVerification);
  }

  if (!isNewPostTab(urlAfter)) {
    return null;
  }

  let liveness = null;
  try {
    liveness = await probeContentScriptLiveness(tabAfter.id);
  } catch (_error) {
    return null;
  }

  if (!liveness?.success) {
    return null;
  }

  let snapshot = null;
  try {
    snapshot = await sendEditorMessage(tabAfter.id, 'GET_DRAFT_SNAPSHOT');
  } catch (_error) {
    snapshot = null;
  }

  const titlePresent = !!(snapshot?.title && String(snapshot.title).trim());
  const textLength = Number(snapshot?.contentTextLength || 0);
  const imageCount = Number(snapshot?.imageCount || 0);
  const hasMeaningfulContent = titlePresent || textLength > 0 || imageCount > 0;
  const looksLikeSavedEditUrl = /\/manage\/newpost\/\d+/.test(urlAfter);
  const shouldVerifySavedPost = !hasMeaningfulContent || looksLikeSavedEditUrl;

  if (!shouldVerifySavedPost) {
    return null;
  }

  const recoveryVerification = await verifyPublishedPostRecovery(preparation.tabId, recoveryBlogName, requestData || {});
  if (recoveryVerification.success) {
    const note = looksLikeSavedEditUrl
      ? '발행 후 편집 화면 유지 감지 + 저장된 글 본문/이미지 검증 완료'
      : '발행 후 에디터 초기화 감지 + 저장된 글 본문/이미지 검증 완료';
    return buildRecoveredResponse(recoveryVerification, note);
  }

  return buildRecoveryFailure(recoveryVerification);
}

async function injectTistoryContentScripts(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab?.url || '';

  if (!isNewPostTab(url) && !isEditPostTab(url)) {
    return {
      success: false,
      status: 'editor_not_ready',
      error: '콘텐츠 스크립트를 재주입할 수 없는 탭입니다.',
      tabId,
      url
    };
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/selectors.js']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['utils/image-handler.js']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['utils/captcha-challenge.js']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/tistory.js']
  });

  return {
    success: true,
    status: 'content_script_reinjected',
    tabId,
    url
  };
}

async function sendTabMessageWithRecovery(tabId, message, options = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!options.reinjectOnMissing || !isMissingTabConnectionError(error)) {
      throw error;
    }

    const reinjected = await injectTistoryContentScripts(tabId);
    if (!reinjected.success) {
      throw error;
    }

    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function sendEditorMessage(tabId, action, data = {}) {
  await ensurePageWorldVisibilityInterceptor(tabId);
  return await sendTabMessageWithRecovery(tabId, { action, data }, { reinjectOnMissing: true });
}

async function getDraftSnapshotForTab(tabId) {
  if (!tabId) {
    return { success: false, status: 'editor_not_ready', error: 'draft snapshot을 읽을 탭 ID가 없습니다.' };
  }

  try {
    const response = await sendEditorMessage(tabId, 'GET_DRAFT_SNAPSHOT');
    return { ...response, tabId };
  } catch (error) {
    return { success: false, status: 'editor_not_ready', error: error.message, tabId };
  }
}

async function restoreDraftIfNeeded(tabId, requestData = {}) {
  const plan = buildExpectedDraftShape(requestData);
  const hasAnyDraftPayload = !!(plan.title || plan.content || plan.category || plan.tags.length || plan.images.length);
  if (!hasAnyDraftPayload) {
    return {
      success: true,
      skipped: true,
      reason: 'no_request_data'
    };
  }

  const beforeSnapshot = await getDraftSnapshotForTab(tabId);
  if (!beforeSnapshot.success) {
    return {
      ...beforeSnapshot,
      status: beforeSnapshot.status || 'editor_not_ready'
    };
  }

  const restorePlan = buildDraftRestorePlan(beforeSnapshot.snapshot, plan);
  if (!restorePlan.needsRestore) {
    return {
      success: true,
      restored: false,
      snapshot: beforeSnapshot.snapshot,
      missing: []
    };
  }

  const stepResults = {};

  for (const step of restorePlan.steps) {
    switch (step) {
      case 'SET_TITLE':
        stepResults.title = await sendEditorMessage(tabId, 'SET_TITLE', { title: restorePlan.expected.title });
        break;
      case 'SET_CATEGORY':
        stepResults.category = await sendEditorMessage(tabId, 'SET_CATEGORY', { category: restorePlan.expected.category });
        break;
      case 'SET_CONTENT':
        stepResults.content = await sendEditorMessage(tabId, 'SET_CONTENT', { content: restorePlan.expected.content });
        break;
      case 'INSERT_IMAGES':
        stepResults.images = await sendEditorMessage(tabId, 'INSERT_IMAGES', { images: restorePlan.expected.images });
        break;
      case 'SET_TAGS':
        stepResults.tags = await sendEditorMessage(tabId, 'SET_TAGS', { tags: restorePlan.expected.tags });
        break;
      default:
        break;
    }

    const latestResult = Object.values(stepResults).slice(-1)[0];
    if (latestResult && !latestResult.success) {
      return {
        success: false,
        status: latestResult.status || 'draft_restore_failed',
        error: latestResult.error || `${step} 실패`,
        stepResults,
        missing: restorePlan.missing,
        snapshot: beforeSnapshot.snapshot
      };
    }
  }

  const afterSnapshot = await getDraftSnapshotForTab(tabId);
  if (!afterSnapshot.success) {
    return {
      ...afterSnapshot,
      status: afterSnapshot.status || 'editor_not_ready',
      stepResults
    };
  }

  const afterPlan = buildDraftRestorePlan(afterSnapshot.snapshot, plan);
  if (afterPlan.needsRestore) {
    return {
      success: false,
      status: 'draft_restore_failed',
      error: `발행 재개 전 초안 복구가 충분하지 않습니다: ${afterPlan.missing.join(', ')}`,
      stepResults,
      missing: afterPlan.missing,
      snapshot: afterSnapshot.snapshot
    };
  }

  return {
    success: true,
    restored: true,
    stepResults,
    snapshot: afterSnapshot.snapshot,
    missing: []
  };
}

function buildDirectPublishState({ response, preparation, requestData = {}, captchaContext = null }) {
  const normalizedCaptchaContext = enrichCaptchaContextWithSolveHints(captchaContext);
  const phase = response?.phase || 'publish';
  const stage = response?.stage || response?.status || 'captcha_required';
  const publishTrace = cloneTraceEntries(response?.publishTrace);
  const fallbackTransition = buildTraceEntry(stage, {
    phase,
    status: response?.status || 'captcha_required',
    source: 'service_worker_build_state'
  });

  return {
    tabId: response?.tabId ?? preparation?.tabId ?? null,
    blogName: requestData.blogName || response?.blogName || preparation?.blogName || null,
    url: response?.editorUrl || response?.url || preparation?.url || null,
    visibility: requestData.visibility || null,
    status: response?.status || 'captcha_required',
    detectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnostics: preparation?.diagnostics || null,
    captchaContext: normalizedCaptchaContext || null,
    requestData: normalizeDirectPublishRequestData(requestData),
    phase,
    stage,
    publishTrace: publishTrace.length > 0 ? publishTrace : [fallbackTransition],
    lastTransition: cloneJsonValue(response?.lastTransition) || (publishTrace.length > 0 ? publishTrace[publishTrace.length - 1] : fallbackTransition)
  };
}

function attachDirectPublishState(response, state = directPublishState) {
  if (!state) return response;
  const normalizedState = enrichDirectPublishStateWithSolveHints(state);
  return attachSolveHints({
    ...response,
    directPublish: { ...normalizedState }
  }, normalizedState?.captchaContext || null);
}

function attachCaptchaWait(response, captchaWait = null) {
  if (!captchaWait) return response;
  return {
    ...response,
    captchaWait
  };
}

async function getLiveDirectPublishState(options = {}) {
  await ensureRuntimeStateLoaded();
  if (!directPublishState) return null;

  const snapshot = enrichDirectPublishStateWithSolveHints({ ...directPublishState });

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
    const captchaContextResult = await getCaptchaContextForTab(snapshot.tabId);
    if (captchaContextResult.success) {
      const captchaContext = mergeResolvedCaptchaContext(snapshot.captchaContext, captchaContextResult.captchaContext);
      snapshot.captchaContext = captchaContext;
      await updateDirectPublishState({ captchaContext, url: captchaContext?.url || snapshot.url });
    } else if (snapshot.captchaContext && typeof snapshot.captchaContext === 'object') {
      snapshot.captchaContext = enrichCaptchaContextWithSolveHints({
        ...(cloneJsonValue(snapshot.captchaContext) || snapshot.captchaContext),
        liveRefreshStatus: captchaContextResult.status || null,
        liveRefreshError: captchaContextResult.error || null
      });
    } else {
      snapshot.captchaContext = enrichCaptchaContextWithSolveHints({
        success: false,
        status: captchaContextResult.status || 'editor_not_ready',
        error: captchaContextResult.error || 'CAPTCHA 컨텍스트를 새로 읽지 못했습니다.'
      });
    }
  }

  return enrichDirectPublishStateWithSolveHints(snapshot);
}

function getProbeFailureReason(probeResult = null) {
  return probeResult?.reason
    || probeResult?.diagnostics?.reason
    || (probeResult?.diagnostics?.captchaPresent ? 'captcha_present' : null)
    || null;
}

function canReuseBlockedTabForCaptchaWait(probeResult, options = {}) {
  return !!(
    options.allowCaptchaBlocked
    && probeResult
    && probeResult.success === false
    && getProbeFailureReason(probeResult) === 'captcha_present'
  );
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
    entryStrategy: 'resume_saved_editor_tab',
    entryPath: [{ step: 'resume_saved_editor_tab', url: liveState.url || null }],
    attempts: []
  };

  const resumeProbe = await probeTabReady(liveState.tabId, diagnostics, 'probe_saved_direct_publish_tab');
  if (!resumeProbe.success) {
    if (canReuseBlockedTabForCaptchaWait(resumeProbe, options)) {
      try {
        const tab = await chrome.tabs.get(liveState.tabId);
        currentTabId = liveState.tabId;
        return {
          ...makePreparationResponse({
            success: true,
            status: 'captcha_wait_target_ready',
            tab,
            blogName: liveState.blogName || requestedBlogName || null,
            diagnostics
          }),
          waitTargetOnly: true,
          waitTargetReason: getProbeFailureReason(resumeProbe) || 'captcha_present'
        };
      } catch (error) {
        await updateDirectPublishState({
          lastProbeError: error.message,
          lastProbeAt: new Date().toISOString(),
          diagnostics
        });
        return null;
      }
    }

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

  let baseResult = null;
  try {
    const captchaContext = await sendTabMessageWithRecovery(tabId, { action: 'GET_CAPTCHA_CONTEXT' }, { reinjectOnMissing: true });
    baseResult = { success: true, tabId, captchaContext };
  } catch (error) {
    baseResult = { success: false, status: 'editor_not_ready', error: error.message, tabId };
  }

  const shouldTryFrameFallback = !baseResult.success
    || !!baseResult.captchaContext?.iframeCaptchaPresent
    || (!baseResult.captchaContext?.activeAnswerInput && !baseResult.captchaContext?.activeSubmitButton);

  if (!shouldTryFrameFallback) {
    return baseResult.success
      ? {
          ...baseResult,
          captchaContext: finalizeResolvedCaptchaContext(baseResult.captchaContext || null, null)
        }
      : baseResult;
  }

  const frameContextResult = await getCrossFrameCaptchaContextForTab(tabId);
  if (!frameContextResult.success) {
    return baseResult.success
      ? {
          ...baseResult,
          captchaContext: finalizeResolvedCaptchaContext(baseResult.captchaContext || null, frameContextResult),
          frameContextFallback: frameContextResult
        }
      : frameContextResult;
  }

  return {
    success: true,
    tabId,
    captchaContext: finalizeResolvedCaptchaContext(baseResult.captchaContext || null, frameContextResult),
    frameContextResult
  };
}

async function getBlockingCaptchaStateForTab(tabId) {
  const captchaContextResult = await getCaptchaContextForTab(tabId);
  if (!captchaContextResult.success) {
    return captchaContextResult;
  }

  const captchaContext = captchaContextResult.captchaContext || null;
  return {
    success: true,
    status: captchaContext?.captchaPresent ? 'captcha_required' : 'captcha_cleared',
    tabId,
    captchaPresent: !!captchaContext?.captchaPresent,
    iframeCaptchaPresent: !!captchaContext?.iframeCaptchaPresent,
    iframeShellOnly: !!captchaContext?.iframeShellOnly,
    preferredSolveMode: captchaContext?.preferredSolveMode || null,
    captchaContext
  };
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

function collectOcrTextCandidates(data = {}) {
  return normalizeCaptchaOcrCandidateTexts([
    data.ocrText,
    data.ocrCandidate,
    data.ocrResult,
    ...(Array.isArray(data.ocrTexts) ? data.ocrTexts : []),
    ...(Array.isArray(data.ocrCandidates) ? data.ocrCandidates : [])
  ]);
}

async function resolveCaptchaAnswerInput(tabId, data = {}, savedState = null) {
  const explicitAnswer = normalizeCaptchaAnswer(data.answer || data.captchaAnswer || '');
  if (explicitAnswer.value) {
    return {
      success: true,
      source: 'explicit_answer',
      answer: explicitAnswer.value,
      answerNormalization: explicitAnswer.summary,
      answerCandidates: [{
        answer: explicitAnswer.value,
        normalizedAnswer: explicitAnswer.value,
        score: null,
        reasons: ['explicit_answer']
      }],
      inference: null,
      ocrCandidates: []
    };
  }

  const ocrCandidates = collectOcrTextCandidates(data);
  if (ocrCandidates.length === 0) {
    return {
      success: false,
      status: 'captcha_answer_required',
      error: 'CAPTCHA 답안 또는 OCR 후보 텍스트가 필요합니다.',
      ocrCandidates: []
    };
  }

  let captchaContext = savedState?.captchaContext || null;
  if (typeof data.challengeText === 'string' && data.challengeText.trim()) {
    captchaContext = {
      ...(captchaContext && typeof captchaContext === 'object' ? cloneJsonValue(captchaContext) || captchaContext : {}),
      challengeText: data.challengeText.trim(),
      challengeMasked: data.challengeMasked?.trim?.() || data.challengeText.trim(),
      challengeSlotCount: Number(data.challengeSlotCount) || normalizeCaptchaAnswerLengthHint(data.answerLengthHint) || null,
      answerLengthHint: normalizeCaptchaAnswerLengthHint(data.answerLengthHint)
        || Number(data.challengeSlotCount)
        || null
    };
  }

  const shouldRefreshContext = !captchaContext?.challengeText && !captchaContext?.challengeMasked;
  if (tabId && shouldRefreshContext) {
    const contextResult = await getCaptchaContextForTab(tabId);
    if (contextResult.success) {
      captchaContext = contextResult.captchaContext || captchaContext;
    }
  }

  const challenge = getChallengeFromCaptchaContext(captchaContext);
  const fallbackAnswerLengthHint = normalizeCaptchaAnswerLengthHint(data.answerLengthHint)
    || normalizeCaptchaAnswerLengthHint(data.challengeSlotCount)
    || normalizeCaptchaAnswerLengthHint(captchaContext?.answerLengthHint)
    || normalizeCaptchaAnswerLengthHint(captchaContext?.challengeSlotCount)
    || null;
  if (!challenge.challengeText) {
    const directAnswerInference = inferCaptchaDirectAnswer({
      ocrTexts: ocrCandidates,
      answerLengthHint: fallbackAnswerLengthHint
    });

    if (directAnswerInference.success) {
      const inferredAnswer = normalizeCaptchaAnswer(directAnswerInference.answer || '');
      return {
        success: true,
        source: 'ocr_direct_without_challenge',
        answer: inferredAnswer.value,
        answerNormalization: inferredAnswer.summary,
        answerCandidates: (Array.isArray(directAnswerInference.answerCandidates)
          ? directAnswerInference.answerCandidates
          : [])
          .map((candidate) => {
            const normalized = normalizeCaptchaAnswer(candidate.answer || '');
            return normalized.value
              ? {
                  ...candidate,
                  answer: normalized.value,
                  normalizedAnswer: normalized.value,
                  answerNormalization: normalized.summary
                }
              : null;
          })
          .filter(Boolean),
        inference: directAnswerInference,
        captchaContext,
        ocrCandidates
      };
    }

    return {
      success: false,
      status: 'captcha_challenge_context_missing',
      error: 'CAPTCHA 문제 문구를 읽지 못했고 OCR 후보도 하나로 좁혀지지 않았습니다. explicit answer가 필요합니다.',
      captchaContext,
      ocrCandidates,
      inference: directAnswerInference
    };
  }

  const parsedChallenge = parseCaptchaChallengeText(challenge.challengeText);
  if (!parsedChallenge?.hasMask) {
    const normalizedDirectCandidates = ocrCandidates
      .map((candidate) => {
        const normalized = normalizeCaptchaAnswer(candidate || '');
        return normalized.value
          ? {
              answer: normalized.value,
              answerNormalization: normalized.summary,
              sourceText: candidate,
              normalizedSourceText: candidate.replace(/\s+/g, ''),
              score: null,
              reasons: ['ocr_direct_candidate']
            }
          : null;
      })
      .filter(Boolean);
    const uniqueDirectCandidates = normalizedDirectCandidates.filter((candidate, index, list) => (
      list.findIndex((entry) => entry.answer === candidate.answer) === index
    ));

    if (uniqueDirectCandidates.length === 1) {
      return {
        success: true,
        source: 'ocr_direct',
        answer: uniqueDirectCandidates[0].answer,
        answerNormalization: uniqueDirectCandidates[0].answerNormalization,
        answerCandidates: uniqueDirectCandidates,
        inference: null,
        captchaContext,
        ocrCandidates
      };
    }

    const challengeKind = detectCaptchaChallengeKind(challenge.challengeText);
    if (challengeKind === 'instruction') {
      const instructionInference = inferInstructionCaptchaAnswer({
        challengeText: challenge.challengeText,
        ocrTexts: ocrCandidates,
        targetEntity: data.targetEntity || captchaContext?.solveHints?.targetEntity || null
      });

      if (instructionInference.success) {
        const inferredAnswer = normalizeCaptchaAnswer(instructionInference.answer || '');
        const answerCandidates = (Array.isArray(instructionInference.answerCandidates)
          ? instructionInference.answerCandidates
          : [])
          .map((candidate) => {
            const normalized = normalizeCaptchaAnswer(candidate.answer || '');
            return normalized.value
              ? {
                  ...candidate,
                  answer: normalized.value,
                  normalizedAnswer: normalized.value,
                  answerNormalization: normalized.summary
                }
              : null;
          })
          .filter(Boolean);

        return {
          success: true,
          source: 'ocr_instruction_inference',
          answer: inferredAnswer.value,
          answerNormalization: inferredAnswer.summary,
          answerCandidates,
          inference: instructionInference,
          captchaContext,
          ocrCandidates
        };
      }

      return {
        success: false,
        ...instructionInference,
        captchaContext,
        ocrCandidates,
        challenge
      };
    }

    return {
      success: false,
      status: 'captcha_non_masked_challenge_requires_single_answer',
      error: '빈칸형이 아닌 CAPTCHA라 명시적 answer 또는 단일 OCR 후보가 필요합니다.',
      captchaContext,
      ocrCandidates,
      challenge
    };
  }

  const inference = inferCaptchaAnswer({
    challengeText: challenge.challengeText,
    ocrTexts: ocrCandidates,
    answerLengthHint: normalizeCaptchaAnswerLengthHint(data.answerLengthHint)
      || challenge.answerLengthHint
      || challenge.challengeSlotCount
      || null
  });

  if (!inference.success) {
    return {
      success: false,
      ...inference,
      captchaContext,
      ocrCandidates
    };
  }

  const inferredAnswer = normalizeCaptchaAnswer(inference.answer || '');
  const answerCandidates = (Array.isArray(inference.answerCandidates) ? inference.answerCandidates : []).map((candidate) => {
    const normalized = normalizeCaptchaAnswer(candidate.answer || '');
    return {
      ...candidate,
      answer: normalized.value,
      normalizedAnswer: normalized.value,
      answerNormalization: normalized.summary
    };
  }).filter((candidate) => candidate.answer);

  return {
    success: true,
    source: 'ocr_inference',
    answer: inferredAnswer.value,
    answerNormalization: inferredAnswer.summary,
    answerCandidates,
    inference,
    captchaContext,
    ocrCandidates
  };
}

async function hashCaptchaArtifactDataUrl(dataUrl = '') {
  const normalized = typeof dataUrl === 'string' ? dataUrl.trim() : '';
  if (!normalized) return null;

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function buildCaptchaVisualSignature(artifactResult = null, captchaContext = null) {
  const artifact = artifactResult?.artifact || null;
  const normalizedHash = typeof artifactResult?.visualHash === 'string' ? artifactResult.visualHash.trim() : '';
  if (!artifact?.dataUrl || !normalizedHash) return null;

  return [
    artifact.kind || 'artifact',
    `${Number(artifact.width) || 0}x${Number(artifact.height) || 0}`,
    String(artifactResult?.frameId ?? captchaContext?.activeCaptureCandidate?.frameId ?? ''),
    normalizedHash
  ].join('::');
}

async function getCaptchaVisualSignatureForTab(tabId, captchaContext = null) {
  if (!tabId) return null;

  const shouldPreferFrame = captchaContext?.preferredSolveMode === 'extension_frame_dom'
    || !!captchaContext?.iframeCaptchaPresent;

  const attemptFrameArtifact = async () => {
    const frameArtifactResult = await getCrossFrameCaptchaArtifactForTab(tabId);
    if (!frameArtifactResult?.success || !frameArtifactResult.artifact?.dataUrl) return null;

    const visualHash = await hashCaptchaArtifactDataUrl(frameArtifactResult.artifact.dataUrl);
    if (!visualHash) return null;

    return buildCaptchaVisualSignature({
      ...frameArtifactResult,
      visualHash,
      frameId: frameArtifactResult.frameId ?? frameArtifactResult.activeFrame?.frameId ?? null
    }, captchaContext);
  };

  const attemptDirectArtifact = async () => {
    const directImageResult = await getCaptchaImageArtifactForTab(tabId);
    if (!directImageResult?.success || !directImageResult.artifact?.dataUrl) return null;

    const visualHash = await hashCaptchaArtifactDataUrl(directImageResult.artifact.dataUrl);
    if (!visualHash) return null;

    return buildCaptchaVisualSignature({
      ...directImageResult,
      visualHash
    }, captchaContext);
  };

  if (shouldPreferFrame) {
    return await attemptFrameArtifact() || await attemptDirectArtifact();
  }

  return await attemptDirectArtifact() || await attemptFrameArtifact();
}

async function getCaptchaChallengeSignature(tabId, captchaContext = null, options = {}) {
  const signature = buildCaptchaChallengeSignature(captchaContext);
  const needsVisualFallback = options.includeVisualFallback === true
    || (!signature.textSignature && options.allowVisualWhenTextMissing !== false);
  if (!tabId || !needsVisualFallback) {
    return signature;
  }

  const visualSignature = await getCaptchaVisualSignatureForTab(tabId, captchaContext);
  if (!visualSignature) {
    return signature;
  }

  return buildCaptchaChallengeSignature(captchaContext, { visualSignature });
}

async function waitForCaptchaRetryReadyOnTab(tabId, options = {}) {
  if (!tabId) {
    return {
      success: false,
      status: 'editor_not_ready',
      error: 'CAPTCHA 재시도 대기 대상 탭 ID가 없습니다.',
      tabId,
      waitedMs: 0,
      attempts: 0,
      pollIntervalMs: options.pollIntervalMs || CAPTCHA_RETRY_READY_DEFAULTS.pollIntervalMs
    };
  }

  const timeoutMs = clamp(
    Number(options.retryReadyTimeoutMs) || Number(options.timeoutMs) || CAPTCHA_RETRY_READY_DEFAULTS.timeoutMs,
    250,
    15000
  );
  const pollIntervalMs = clamp(
    Number(options.retryReadyPollIntervalMs) || Number(options.pollIntervalMs) || CAPTCHA_RETRY_READY_DEFAULTS.pollIntervalMs,
    100,
    2000
  );
  const startedAt = Date.now();
  let attempts = 0;
  let lastContextResult = null;

  while ((Date.now() - startedAt) <= timeoutMs) {
    attempts += 1;
    lastContextResult = await getCaptchaContextForTab(tabId);
    const captchaContext = lastContextResult?.success ? lastContextResult.captchaContext || null : null;
    const ready = !!(captchaContext?.captchaPresent && hasActionableCaptchaAnswerPath(captchaContext));

    if (ready) {
      return {
        success: true,
        status: 'captcha_retry_ready',
        tabId,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        captchaContext,
        contextResult: lastContextResult
      };
    }

    if (captchaContext && captchaContext.captchaPresent === false) {
      return {
        success: false,
        status: 'captcha_not_present',
        tabId,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        captchaContext,
        contextResult: lastContextResult
      };
    }

    if ((Date.now() - startedAt) >= timeoutMs) break;
    await delay(pollIntervalMs);
  }

  return {
    success: false,
    status: 'captcha_retry_not_ready',
    error: 'CAPTCHA 재시도 입력창이 준비될 때까지 기다렸지만 actionable state를 확보하지 못했습니다.',
    tabId,
    waitedMs: Date.now() - startedAt,
    attempts,
    pollIntervalMs,
    captchaContext: lastContextResult?.success ? lastContextResult.captchaContext || null : null,
    contextResult: lastContextResult
  };
}

async function submitResolvedCaptchaForTab(tabId, answerResolution, options = {}) {
  const answerAttemptPlan = buildCaptchaAnswerAttemptCandidates(answerResolution, options);
  if (answerAttemptPlan.length === 0) {
    return {
      success: false,
      status: 'captcha_answer_required',
      error: 'CAPTCHA 답안 후보를 준비하지 못했습니다.',
      answerResolution,
      answerAttemptPlan: [],
      answerAttemptHistory: [],
      answerRetrySummary: {
        candidateCount: 0,
        attemptedCount: 0,
        retryEnabled: false,
        stoppedReason: 'answer_candidates_missing',
        initialChallengeSignature: null,
        initialChallengeSignatureDetails: null
      }
    };
  }

  const retryEnabled = supportsRankedCaptchaAnswerRetries(answerResolution, options) && answerAttemptPlan.length > 1;
  const initialChallengeSignature = await getCaptchaChallengeSignature(tabId, answerResolution?.captchaContext, {
    includeVisualFallback: retryEnabled
  });
  const answerAttemptHistory = [];
  let lastSubmitResult = null;
  let lastRefreshedContext = null;
  let stoppedReason = retryEnabled ? 'answer_candidates_exhausted' : 'retry_not_enabled';

  for (let index = 0; index < answerAttemptPlan.length; index += 1) {
    const candidate = answerAttemptPlan[index];
    let retryReadyResult = null;

    if (index > 0) {
      retryReadyResult = await waitForCaptchaRetryReadyOnTab(tabId, options);
      if (!retryReadyResult.success) {
        lastRefreshedContext = retryReadyResult.contextResult?.success ? retryReadyResult.contextResult : lastRefreshedContext;
        stoppedReason = retryReadyResult.status === 'captcha_not_present'
          ? 'captcha_cleared_during_retry_wait'
          : 'retry_context_not_ready';
        break;
      }
    }

    const submitResult = await submitCaptchaForTab(tabId, candidate.answer, options);
    const submitCompletedByNavigation = submitResult?.status === 'captcha_submit_tab_navigated'
      || looksLikeDirectPublishCompletionUrl(submitResult?.url || '');
    const refreshedContext = submitCompletedByNavigation
      ? null
      : await refreshDirectPublishCaptchaState(tabId, submitResult);
    const captchaStillAppears = submitCompletedByNavigation
      ? false
      : (refreshedContext?.success
        ? !!refreshedContext.captchaContext?.captchaPresent
        : !!submitResult.captchaStillAppears);
    const refreshedChallengeSignature = captchaStillAppears
      ? await getCaptchaChallengeSignature(
        tabId,
        refreshedContext?.success ? refreshedContext.captchaContext : (submitResult?.preSubmitCaptchaContext || null),
        { includeVisualFallback: retryEnabled }
      )
      : null;
    const challengeComparison = captchaStillAppears
      ? compareCaptchaChallengeSignatures(initialChallengeSignature, refreshedChallengeSignature)
      : {
        stable: true,
        changed: false,
        confidence: 'none',
        comparableKinds: [],
        weakComparableKinds: [],
        matchedKinds: [],
        mismatchedKinds: []
      };
    const challengeStable = !captchaStillAppears
      ? true
      : challengeComparison.stable !== false;

    lastSubmitResult = submitResult;
    lastRefreshedContext = refreshedContext;
    answerAttemptHistory.push({
      attempt: index + 1,
      answer: candidate.answer,
      source: candidate.source,
      sourceText: candidate.sourceText,
      score: candidate.score,
      success: !!submitResult.success,
      status: submitResult.status || null,
      captchaStillAppears,
      challengeStable,
      challengeChanged: !!(captchaStillAppears && challengeComparison.changed),
      challengeSignature: refreshedChallengeSignature?.primary || null,
      challengeSignatureDetails: refreshedChallengeSignature || null,
      challengeComparison,
      retryReady: retryReadyResult
        ? {
            success: !!retryReadyResult.success,
            status: retryReadyResult.status || null,
            waitedMs: Number.isFinite(retryReadyResult.waitedMs) ? retryReadyResult.waitedMs : null,
            attempts: Number.isFinite(retryReadyResult.attempts) ? retryReadyResult.attempts : null,
            pollIntervalMs: Number.isFinite(retryReadyResult.pollIntervalMs) ? retryReadyResult.pollIntervalMs : null
          }
        : null
    });

    if (!submitResult.success) {
      stoppedReason = 'submit_failed';
      break;
    }

    if (!captchaStillAppears) {
      stoppedReason = index === 0 ? 'captcha_cleared' : 'captcha_cleared_after_retry';
      break;
    }

    if (!retryEnabled) {
      stoppedReason = 'retry_not_enabled';
      break;
    }

    if (index >= answerAttemptPlan.length - 1) {
      stoppedReason = 'answer_candidates_exhausted';
      break;
    }

    if (!challengeStable) {
      stoppedReason = 'challenge_changed';
      break;
    }
  }

  const fallbackResult = lastSubmitResult || {
    success: false,
    status: 'captcha_answer_required',
    error: 'CAPTCHA 답안을 제출하지 못했습니다.',
    tabId
  };
  const captchaStillAppears = lastRefreshedContext?.success
    ? !!lastRefreshedContext.captchaContext?.captchaPresent
    : !!fallbackResult.captchaStillAppears;

  return {
    ...fallbackResult,
    tabId,
    answerResolution,
    answerAttemptPlan,
    answerAttemptHistory,
    answerRetrySummary: {
      candidateCount: answerAttemptPlan.length,
      attemptedCount: answerAttemptHistory.length,
      retryEnabled,
      stoppedReason,
      initialChallengeSignature: initialChallengeSignature?.primary || null,
      initialChallengeSignatureDetails: initialChallengeSignature || null
    },
    refreshedCaptchaContext: lastRefreshedContext?.success ? lastRefreshedContext.captchaContext || null : null,
    captchaStillAppears
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

  const preSubmitContextResult = await getCaptchaContextForTab(tabId);
  const preSubmitCaptchaContext = preSubmitContextResult.success ? preSubmitContextResult.captchaContext || null : null;
  const shouldPreferFrameSubmit = preSubmitContextResult.success
    && preSubmitCaptchaContext?.preferredSolveMode === 'extension_frame_dom'
    && !hasActionableMainDomCaptcha(preSubmitCaptchaContext);

  let preferredFrameResult = null;
  if (shouldPreferFrameSubmit) {
    preferredFrameResult = await submitCaptchaViaFrameForTab(tabId, normalization.value, options);
    if (preferredFrameResult.success) {
      return {
        ...preferredFrameResult,
        tabId,
        answerNormalization: normalization.summary,
        preSubmitCaptchaContext,
        previousSubmitResult: null
      };
    }
  }

  let primaryResult = null;
  try {
    const result = await sendTabMessageWithRecovery(tabId, {
      action: 'SUBMIT_CAPTCHA',
      data: {
        answer: normalization.value,
        waitMs: options.waitMs
      }
    });
    primaryResult = {
      ...result,
      tabId,
      answerNormalization: normalization.summary,
      preSubmitCaptchaContext
    };
  } catch (error) {
    primaryResult = {
      success: false,
      status: 'editor_not_ready',
      error: error.message,
      tabId,
      answerNormalization: normalization.summary,
      preSubmitCaptchaContext
    };
  }

  const shouldTryFrameFallback = shouldPreferFrameSubmit
    || primaryResult.status === 'captcha_browser_handoff_required'
    || primaryResult.status === 'captcha_input_not_found'
    || primaryResult.status === 'captcha_submit_not_found'
    || (!!primaryResult.diagnostics?.before?.iframeCaptchaPresent && !primaryResult.success);

  if (!shouldTryFrameFallback) {
    return primaryResult;
  }

  const frameFallback = preferredFrameResult || await submitCaptchaViaFrameForTab(tabId, normalization.value, options);
  if (!frameFallback.success) {
    return {
      ...primaryResult,
      frameSubmitFallback: frameFallback
    };
  }

  return {
    ...frameFallback,
    tabId,
    answerNormalization: normalization.summary,
    preSubmitCaptchaContext,
    previousSubmitResult: primaryResult
  };
}

function normalizeDirectPublishCaptchaWaitOptions(options = {}) {
  const waitTimeoutMs = parseOptionalFiniteNumber(options.waitTimeoutMs);
  const legacyWaitTimeoutMs = parseOptionalFiniteNumber(options.captchaWaitTimeoutMs);
  const pollIntervalMs = parseOptionalFiniteNumber(options.pollIntervalMs);
  const legacyPollIntervalMs = parseOptionalFiniteNumber(options.captchaPollIntervalMs);
  const postClearDelayMs = parseOptionalFiniteNumber(options.postClearDelayMs);
  const legacyPostClearDelayMs = parseOptionalFiniteNumber(options.captchaPostClearDelayMs);
  const waitRequested = options.waitForCaptcha === true
    || options.waitForCaptchaResolution === true
    || waitTimeoutMs > 0
    || legacyWaitTimeoutMs > 0;

  return {
    enabled: waitRequested,
    timeoutMs: clamp(
      Number.isFinite(waitTimeoutMs)
        ? waitTimeoutMs
        : (Number.isFinite(legacyWaitTimeoutMs) ? legacyWaitTimeoutMs : DIRECT_PUBLISH_CAPTCHA_WAIT_DEFAULTS.timeoutMs),
      1000,
      300000
    ),
    pollIntervalMs: clamp(
      Number.isFinite(pollIntervalMs)
        ? pollIntervalMs
        : (Number.isFinite(legacyPollIntervalMs) ? legacyPollIntervalMs : DIRECT_PUBLISH_CAPTCHA_WAIT_DEFAULTS.pollIntervalMs),
      250,
      5000
    ),
    postClearDelayMs: Math.max(
      0,
      Number.isFinite(postClearDelayMs)
        ? postClearDelayMs
        : (Number.isFinite(legacyPostClearDelayMs) ? legacyPostClearDelayMs : DIRECT_PUBLISH_CAPTCHA_WAIT_DEFAULTS.postClearDelayMs)
    ),
    stageJitter: options.stageJitter || DIRECT_PUBLISH_CAPTCHA_WAIT_DEFAULTS.stageJitter
  };
}

function summarizeCaptchaWaitResult(waitResult = null, options = {}) {
  if (!waitResult) return null;

  return {
    enabled: !!options.enabled,
    success: !!waitResult.success,
    status: waitResult.status || null,
    waitedMs: Number.isFinite(waitResult.waitedMs) ? waitResult.waitedMs : null,
    attempts: Number.isFinite(waitResult.attempts) ? waitResult.attempts : null,
    successfulChecks: Number.isFinite(waitResult.successfulChecks) ? waitResult.successfulChecks : null,
    failedChecks: Number.isFinite(waitResult.failedChecks) ? waitResult.failedChecks : null,
    pollIntervalMs: Number.isFinite(waitResult.pollIntervalMs) ? waitResult.pollIntervalMs : null,
    postClearDelayMs: Number.isFinite(waitResult.postClearDelayMs) ? waitResult.postClearDelayMs : null,
    postClearDelayAppliedMs: Number.isFinite(waitResult.postClearDelayAppliedMs) ? waitResult.postClearDelayAppliedMs : null,
    postClearDelayExtraMs: Number.isFinite(waitResult.postClearDelayExtraMs) ? waitResult.postClearDelayExtraMs : null,
    captchaStillPresent: typeof waitResult.captchaStillPresent === 'boolean' ? waitResult.captchaStillPresent : null,
    completedAt: new Date().toISOString()
  };
}

async function waitForCaptchaResolutionOnTab(tabId, options = {}) {
  if (!tabId) {
    return {
      success: false,
      status: 'editor_not_ready',
      error: 'CAPTCHA 해결 대기 대상 탭 ID가 없습니다.',
      tabId,
      waitedMs: 0,
      attempts: 0,
      pollIntervalMs: options.pollIntervalMs || DIRECT_PUBLISH_CAPTCHA_WAIT_DEFAULTS.pollIntervalMs,
      postClearDelayMs: options.postClearDelayMs || 0
    };
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DIRECT_PUBLISH_CAPTCHA_WAIT_DEFAULTS.timeoutMs);
  const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs) || DIRECT_PUBLISH_CAPTCHA_WAIT_DEFAULTS.pollIntervalMs);
  const postClearDelayMs = Math.max(0, Number(options.postClearDelayMs) || 0);
  const postClearJitterOptions = options.stageJitter || DIRECT_PUBLISH_CAPTCHA_WAIT_DEFAULTS.stageJitter;
  const startedAt = Date.now();
  let attempts = 0;
  let lastCheck = null;
  let successfulChecks = 0;
  let failedChecks = 0;

  while ((Date.now() - startedAt) <= timeoutMs) {
    attempts += 1;

    try {
      lastCheck = await getBlockingCaptchaStateForTab(tabId);
    } catch (error) {
      return {
        success: false,
        status: 'editor_not_ready',
        error: error.message,
        tabId,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        postClearDelayMs,
        lastCheck: null
      };
    }

    if (!lastCheck?.success) {
      failedChecks += 1;

      try {
        const liveTab = await chrome.tabs.get(tabId);
        if (looksLikeDirectPublishCompletionUrl(liveTab?.url || '')) {
          return {
            success: true,
            status: 'captcha_wait_completion_url',
            tabId,
            waitedMs: Date.now() - startedAt,
            attempts,
            successfulChecks,
            failedChecks,
            pollIntervalMs,
            postClearDelayMs,
            lastCheck,
            captchaStillPresent: false
          };
        }
      } catch (error) {
        return {
          success: false,
          status: 'editor_not_ready',
          error: 'CAPTCHA 대기 대상 탭이 닫혔거나 더 이상 접근할 수 없습니다.',
          tabId,
          waitedMs: Date.now() - startedAt,
          attempts,
          successfulChecks,
          failedChecks,
          pollIntervalMs,
          postClearDelayMs,
          lastCheck,
          captchaStillPresent: null
        };
      }
    } else {
      successfulChecks += 1;
    }

    if (lastCheck.success && !lastCheck.captchaPresent) {
      let postClearDelay = {
        enabled: false,
        baseMs: postClearDelayMs,
        extraMs: 0,
        waitMs: postClearDelayMs
      };

      if (postClearDelayMs > 0) {
        postClearDelay = await delayWithStageJitter(postClearDelayMs, postClearJitterOptions);
      }

      return {
        success: true,
        status: 'captcha_cleared',
        tabId,
        waitedMs: Date.now() - startedAt,
        attempts,
        successfulChecks,
        failedChecks,
        pollIntervalMs,
        postClearDelayMs,
        postClearDelayAppliedMs: postClearDelay.waitMs,
        postClearDelayExtraMs: postClearDelay.extraMs,
        lastCheck,
        captchaStillPresent: false
      };
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      break;
    }

    await delay(Math.min(pollIntervalMs, remainingMs));
  }

  return {
    success: false,
    status: successfulChecks > 0 ? 'captcha_wait_timeout' : 'editor_not_ready',
    error: successfulChecks > 0
      ? 'CAPTCHA가 아직 표시되어 있습니다. 같은 탭에서 solve 경로를 완료한 뒤 다시 시도하거나 waitTimeoutMs를 늘리세요.'
      : (lastCheck?.error || '같은 탭에서 CAPTCHA 상태를 안정적으로 확인하지 못했습니다. 탭 상태를 점검한 뒤 다시 시도하세요.'),
    tabId,
    waitedMs: Date.now() - startedAt,
    attempts,
    successfulChecks,
    failedChecks,
    pollIntervalMs,
    postClearDelayMs,
    lastCheck,
    captchaStillPresent: lastCheck?.success ? !!lastCheck?.captchaPresent : null
  };
}

async function waitForPostCaptchaCompletionOrResume(preparation, requestData = {}, options = {}) {
  if (!preparation?.tabId) {
    return {
      success: false,
      status: 'editor_not_ready',
      error: 'CAPTCHA 해제 후 상태를 확인할 탭 ID가 없습니다.',
      completed: false,
      waitedMs: 0,
      attempts: 0,
      publishStillInFlight: null,
      lastCaptchaCheck: null,
      lastDraftSnapshot: null
    };
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || POST_CAPTCHA_COMPLETION_WAIT_DEFAULTS.timeoutMs);
  const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs) || POST_CAPTCHA_COMPLETION_WAIT_DEFAULTS.pollIntervalMs);
  const startedAt = Date.now();
  let attempts = 0;
  let lastCaptchaCheck = null;
  let lastDraftSnapshot = null;
  let lastPublishStillInFlight = null;

  while ((Date.now() - startedAt) <= timeoutMs) {
    attempts += 1;

    let liveTab = null;
    try {
      liveTab = await chrome.tabs.get(preparation.tabId);
    } catch (error) {
      return {
        success: false,
        status: 'editor_not_ready',
        error: 'CAPTCHA 해제 후 대상 탭이 닫혔거나 더 이상 접근할 수 없습니다.',
        completed: false,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        publishStillInFlight: lastPublishStillInFlight,
        lastCaptchaCheck,
        lastDraftSnapshot,
        tabId: preparation.tabId
      };
    }

    const liveUrl = liveTab?.url || preparation.url || null;
    if (looksLikeDirectPublishCompletionUrl(liveUrl || '')) {
      const recoveredResponse = await recoverPublishedResponseAfterSendMessageFailure({
        ...preparation,
        tabId: preparation.tabId,
        url: liveUrl,
        blogName: requestData.blogName || preparation.blogName || getTabBlogName(liveUrl) || null
      }, requestData || {}, {
        waitMs: 0,
        blogName: requestData.blogName || preparation.blogName || getTabBlogName(liveUrl) || null
      });

      const fallbackResponse = makePreparationResponse({
        success: true,
        status: 'captcha_submit_tab_navigated',
        tab: liveTab,
        url: liveUrl,
        blogName: requestData.blogName || preparation.blogName || getTabBlogName(liveUrl) || null,
        diagnostics: preparation.diagnostics
      });

      return {
        success: recoveredResponse?.success ?? true,
        status: recoveredResponse?.status || 'captcha_submit_tab_navigated',
        completed: true,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        publishStillInFlight: false,
        lastCaptchaCheck,
        lastDraftSnapshot,
        response: recoveredResponse || fallbackResponse
      };
    }

    try {
      lastCaptchaCheck = await getBlockingCaptchaStateForTab(preparation.tabId);
    } catch (error) {
      lastCaptchaCheck = {
        success: false,
        status: 'editor_not_ready',
        error: error.message,
        tabId: preparation.tabId
      };
    }

    if (lastCaptchaCheck?.success && lastCaptchaCheck.captchaPresent) {
      return {
        success: false,
        status: 'captcha_required',
        error: 'CAPTCHA가 다시 표시되어 자동 재개를 중단합니다.',
        completed: false,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        publishStillInFlight: true,
        lastCaptchaCheck,
        lastDraftSnapshot,
        tabId: preparation.tabId
      };
    }

    if (lastCaptchaCheck?.success) {
      lastPublishStillInFlight = isPostCaptchaPublishStillInFlight(lastCaptchaCheck.captchaContext || null);
    }

    const draftSnapshot = await getDraftSnapshotForTab(preparation.tabId);
    if (draftSnapshot?.success) {
      lastDraftSnapshot = draftSnapshot;
    }

    const draftHasContent = !!(
      (Number(lastDraftSnapshot?.snapshot?.contentHtmlLength) || 0) > 0
      || (Number(lastDraftSnapshot?.snapshot?.contentTextLength) || 0) > 0
      || (Number(lastDraftSnapshot?.snapshot?.imageCount) || 0) > 0
    );
    const editorReady = !!lastDraftSnapshot?.snapshot?.editorReady;
    const publishLayerOpen = !!lastDraftSnapshot?.snapshot?.editorProbe?.publishLayerPresent;

    if (!lastPublishStillInFlight && (editorReady || publishLayerOpen || draftHasContent)) {
      return {
        success: true,
        status: 'resume_ready',
        completed: false,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        publishStillInFlight: false,
        lastCaptchaCheck,
        lastDraftSnapshot,
        tabId: preparation.tabId
      };
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      break;
    }

    await delay(Math.min(pollIntervalMs, remainingMs));
  }

  return {
    success: true,
    status: 'resume_ready_timeout',
    completed: false,
    waitedMs: Date.now() - startedAt,
    attempts,
    pollIntervalMs,
    publishStillInFlight: lastPublishStillInFlight,
    lastCaptchaCheck,
    lastDraftSnapshot,
    tabId: preparation.tabId
  };
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

async function buildPreparationFromPreferredTab(tabId, requestData = {}, options = {}) {
  if (!tabId) return null;

  const diagnostics = {
    requestedBlogName: requestData.blogName || null,
    blogName: requestData.blogName || directPublishState?.blogName || null,
    currentTabId,
    candidateCount: 1,
    source: 'preferred_tab',
    entryStrategy: 'resume_preferred_editor_tab',
    entryPath: [{ step: 'resume_preferred_editor_tab', url: null }],
    attempts: []
  };

  const resumeProbe = await probeTabReady(tabId, diagnostics, 'probe_preferred_direct_publish_tab');
  if (!resumeProbe.success) {
    if (canReuseBlockedTabForCaptchaWait(resumeProbe, options)) {
      try {
        const tab = await chrome.tabs.get(tabId);
        currentTabId = tabId;
        if (Array.isArray(diagnostics.entryPath) && diagnostics.entryPath[0]) {
          diagnostics.entryPath[0].url = tab.url || null;
        }

        return {
          ...makePreparationResponse({
            success: true,
            status: 'captcha_wait_target_ready',
            tab,
            blogName: requestData.blogName || directPublishState?.blogName || getTabBlogName(tab.url) || null,
            diagnostics
          }),
          waitTargetOnly: true,
          waitTargetReason: getProbeFailureReason(resumeProbe) || 'captcha_present'
        };
      } catch (error) {
        diagnostics.attempts.push({
          step: 'probe_preferred_direct_publish_tab_missing',
          error: error.message,
          at: new Date().toISOString()
        });
        return null;
      }
    }

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
    if (Array.isArray(diagnostics.entryPath) && diagnostics.entryPath[0]) {
      diagnostics.entryPath[0].url = tab.url || null;
    }

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

async function ensurePreparationReadyAfterCaptchaWait(preparation, requestData = {}) {
  if (!preparation?.tabId || !preparation.waitTargetOnly) {
    return preparation;
  }

  const diagnostics = preparation.diagnostics || {
    requestedBlogName: requestData.blogName || null,
    blogName: requestData.blogName || preparation.blogName || null,
    currentTabId,
    candidateCount: 1,
    source: 'captcha_wait_target',
    entryStrategy: 'resume_wait_target_after_captcha',
    entryPath: [{ step: 'resume_wait_target_after_captcha', url: preparation.url || null }],
    attempts: []
  };

  const probeResult = await probeTabReady(preparation.tabId, diagnostics, 'probe_wait_cleared_direct_publish_tab');
  const resumableWithOpenPublishLayer = probeResult.reason === 'publish_layer_open';
  if (!probeResult.success && !resumableWithOpenPublishLayer) {
    return makePreparationResponse({
      success: false,
      status: 'editor_not_ready',
      error: probeResult.error || 'CAPTCHA 해제 후 에디터 준비 상태를 확인하지 못했습니다.',
      tabId: preparation.tabId,
      url: preparation.url,
      blogName: requestData.blogName || preparation.blogName || null,
      diagnostics
    });
  }

  try {
    const tab = await chrome.tabs.get(preparation.tabId);
    currentTabId = preparation.tabId;
    return {
      ...makePreparationResponse({
        success: true,
        status: resumableWithOpenPublishLayer ? 'resume_publish_layer_open' : 'editor_ready',
        tab,
        blogName: requestData.blogName || preparation.blogName || getTabBlogName(tab.url) || null,
        diagnostics
      }),
      waitTargetOnly: false,
      waitTargetReason: preparation.waitTargetReason || null
    };
  } catch (error) {
    return makePreparationResponse({
      success: false,
      status: 'editor_not_ready',
      error: error.message,
      tabId: preparation.tabId,
      url: preparation.url,
      blogName: requestData.blogName || preparation.blogName || null,
      diagnostics
    });
  }
}

async function resumeDirectPublishFlow(requestData = {}, options = {}) {
  const liveState = await getLiveDirectPublishState();
  const waitOptions = normalizeDirectPublishCaptchaWaitOptions(options);
  const mergedRequestData = {
    ...(liveState?.requestData || {}),
    ...(directPublishState?.requestData || {}),
    ...normalizeDirectPublishRequestData(requestData)
  };

  mergedRequestData.blogName = mergedRequestData.blogName || liveState?.blogName || directPublishState?.blogName || null;
  mergedRequestData.visibility = mergedRequestData.visibility || liveState?.visibility || directPublishState?.visibility || null;

  let preparation = await buildPreparationFromPreferredTab(options.preferredTabId || null, mergedRequestData, {
    allowCaptchaBlocked: waitOptions.enabled
  });
  if (!preparation) {
    preparation = await buildPreparationFromDirectPublishState({
      blogName: mergedRequestData.blogName || null,
      allowCaptchaBlocked: waitOptions.enabled
    });
  }
  if (!preparation) {
    preparation = await prepareEditorTab({ blogName: mergedRequestData.blogName || directPublishState?.blogName || null });
  }
  if (!preparation.success) {
    return attachCaptchaWait(attachDirectPublishState(preparation));
  }

  let captchaWait = null;

  if (waitOptions.enabled) {
    if (directPublishState?.tabId === preparation.tabId) {
      await updateDirectPublishState({
        ...buildTransitionPatch(directPublishState || {}, 'waiting_browser_handoff', {
          phase: 'captcha_handoff',
          status: 'waiting_browser_handoff',
          tabId: preparation.tabId
        }),
        status: 'waiting_browser_handoff',
        lastCaptchaWait: {
          enabled: true,
          success: false,
          status: 'waiting_browser_handoff',
          timeoutMs: waitOptions.timeoutMs,
          pollIntervalMs: waitOptions.pollIntervalMs,
          postClearDelayMs: waitOptions.postClearDelayMs,
          startedAt: new Date().toISOString(),
          completedAt: null,
          autoWakeSource: options.autoWakeSource || null
        }
      });
      await scheduleDirectPublishContinuation({
        tabId: preparation.tabId,
        timeoutMs: waitOptions.timeoutMs,
        pollIntervalMs: waitOptions.pollIntervalMs,
        postClearDelayMs: waitOptions.postClearDelayMs,
        deadlineMs: directPublishRuntimeState?.deadlineMs || null
      });
    } else {
      await resetDirectPublishRuntimeState();
    }

    isDirectPublishCaptchaWaitInProgress = true;
    try {
      captchaWait = await waitForCaptchaResolutionOnTab(preparation.tabId, waitOptions);
    } finally {
      isDirectPublishCaptchaWaitInProgress = false;
    }
    await resetDirectPublishRuntimeState();
    captchaWait = {
      enabled: true,
      timeoutMs: waitOptions.timeoutMs,
      ...captchaWait
    };

    if (directPublishState?.tabId === preparation.tabId) {
      const nextStatus = captchaWait.success
        ? 'ready_to_resume'
        : (captchaWait.status === 'editor_not_ready' ? 'editor_not_ready' : 'captcha_required');

      await updateDirectPublishState({
        ...buildTransitionPatch(directPublishState || {}, captchaWait.success ? 'captcha_cleared_wait_complete' : 'captcha_wait_failed', {
          phase: 'captcha_handoff',
          status: nextStatus,
          waitStatus: captchaWait.status || null,
          tabId: preparation.tabId
        }),
        status: nextStatus,
        lastCheckedAt: new Date().toISOString(),
        lastCaptchaWait: summarizeCaptchaWaitResult(captchaWait, waitOptions)
      });
    }

    if (!captchaWait.success) {
      const handoff = await captureCaptchaHandoffForTab(preparation.tabId);
      const nextState = liveState || buildDirectPublishState({
        response: { status: captchaWait.status, tabId: preparation.tabId },
        preparation,
        requestData: mergedRequestData,
        captchaContext: handoff.captchaContext || null
      });
      const failedState = {
        ...nextState,
        tabId: preparation.tabId,
        blogName: mergedRequestData.blogName || nextState.blogName || preparation.blogName,
        url: preparation.url || nextState.url,
        status: captchaWait.status === 'editor_not_ready' ? 'editor_not_ready' : 'captcha_required',
        requestData: normalizeDirectPublishRequestData(mergedRequestData),
        captchaContext: handoff.captchaContext || null,
        lastCaptchaArtifactCapture: summarizeCaptchaArtifactCapture(handoff.captchaArtifacts),
        lastCaptchaWait: summarizeCaptchaWaitResult(captchaWait, waitOptions)
      };
      await setDirectPublishState({
        ...failedState,
        ...buildTransitionPatch(failedState, 'captcha_handoff_still_blocked', {
          phase: 'captcha_handoff',
          status: failedState.status,
          waitStatus: captchaWait.status || null,
          tabId: preparation.tabId
        })
      });
      return attachCaptchaWait(attachCaptchaHandoff(attachDirectPublishState(withPreparationDetails({
        success: false,
        error: captchaWait.error || 'CAPTCHA가 아직 표시되어 있습니다.',
        status: captchaWait.status || 'captcha_wait_timeout'
      }, preparation)), handoff), captchaWait);
    }
  } else {
    await resetDirectPublishRuntimeState();
    try {
      const captchaCheck = await getBlockingCaptchaStateForTab(preparation.tabId);
      if (captchaCheck?.captchaPresent) {
        const handoff = await captureCaptchaHandoffForTab(preparation.tabId);
        const nextState = liveState || buildDirectPublishState({
          response: { ...captchaCheck, status: 'captcha_required', tabId: preparation.tabId },
          preparation,
          requestData: mergedRequestData,
          captchaContext: handoff.captchaContext || null
        });
        const blockedState = {
          ...nextState,
          tabId: preparation.tabId,
          blogName: mergedRequestData.blogName || nextState.blogName || preparation.blogName,
          url: preparation.url || nextState.url,
          status: 'captcha_required',
          requestData: normalizeDirectPublishRequestData(mergedRequestData),
          captchaContext: handoff.captchaContext || null,
          lastCaptchaArtifactCapture: summarizeCaptchaArtifactCapture(handoff.captchaArtifacts)
        };
        await setDirectPublishState({
          ...blockedState,
          ...buildTransitionPatch(blockedState, 'captcha_still_present_before_resume', {
            phase: 'captcha_handoff',
            status: 'captcha_required',
            tabId: preparation.tabId
          })
        });
        return attachCaptchaHandoff(attachDirectPublishState(withPreparationDetails({
          success: false,
          error: 'CAPTCHA가 아직 표시되어 있습니다.',
          status: 'captcha_required'
        }, preparation)), handoff);
      }
    } catch (e) { /* 진행 */ }
  }

  const currentStage = liveState?.stage || directPublishState?.stage || null;
  if (captchaWait?.success && currentStage === 'captcha_after_final_confirm') {
    const postCaptchaSettle = await waitForPostCaptchaCompletionOrResume(preparation, mergedRequestData);

    if (postCaptchaSettle.completed && postCaptchaSettle.response) {
      if (postCaptchaSettle.response.success) {
        await clearDirectPublishState();
      } else {
        await updateDirectPublishState({
          ...buildTransitionPatch(directPublishState || {}, 'post_captcha_completion_detected_unverified', {
            phase: 'captcha_handoff',
            status: postCaptchaSettle.response.status || 'persistence_unverified',
            tabId: preparation.tabId,
            waitedMs: postCaptchaSettle.waitedMs,
            attempts: postCaptchaSettle.attempts
          }),
          tabId: preparation.tabId,
          url: postCaptchaSettle.response.url || preparation.url || null,
          requestData: normalizeDirectPublishRequestData(mergedRequestData)
        });
      }

      return attachCaptchaWait(postCaptchaSettle.response, captchaWait);
    }

    if (!postCaptchaSettle.success) {
      const handoff = await captureCaptchaHandoffForTab(preparation.tabId);
      const blockedResponse = withPreparationDetails({
        success: false,
        status: postCaptchaSettle.status || 'captcha_required',
        error: postCaptchaSettle.error || 'CAPTCHA가 다시 표시되어 자동 재개를 중단합니다.'
      }, preparation);
      await setDirectPublishState({
        ...buildDirectPublishState({
          response: blockedResponse,
          preparation,
          requestData: mergedRequestData,
          captchaContext: handoff.captchaContext || postCaptchaSettle.lastCaptchaCheck?.captchaContext || null
        }),
        lastCaptchaWait: captchaWait
          ? summarizeCaptchaWaitResult(captchaWait, waitOptions)
          : (directPublishState?.lastCaptchaWait || null),
        lastCaptchaArtifactCapture: summarizeCaptchaArtifactCapture(handoff.captchaArtifacts)
      });
      return attachCaptchaWait(attachCaptchaHandoff(attachDirectPublishState(blockedResponse), handoff), captchaWait);
    }
  }

  preparation = await ensurePreparationReadyAfterCaptchaWait(preparation, mergedRequestData);
  if (!preparation?.success) {
    await updateDirectPublishState({
      ...buildTransitionPatch(directPublishState || {}, 'post_captcha_wait_probe_failed', {
        phase: 'captcha_handoff',
        status: preparation?.status || 'editor_not_ready',
        tabId: preparation?.tabId || options.preferredTabId || directPublishState?.tabId || null
      }),
      tabId: preparation?.tabId || options.preferredTabId || directPublishState?.tabId || null,
      url: preparation?.url || directPublishState?.url || null,
      requestData: normalizeDirectPublishRequestData(mergedRequestData)
    });
    return attachCaptchaWait(attachDirectPublishState(preparation), captchaWait);
  }

  const draftRestore = await restoreDraftIfNeeded(preparation.tabId, mergedRequestData);
  if (!draftRestore.success) {
    await updateDirectPublishState({
      ...buildTransitionPatch(directPublishState || {}, 'draft_restore_failed', {
        phase: 'resume_publish',
        status: draftRestore.status || 'draft_restore_failed',
        tabId: preparation.tabId
      }),
      tabId: preparation.tabId,
      url: preparation.url,
      requestData: normalizeDirectPublishRequestData(mergedRequestData),
      lastDraftRestore: {
        success: false,
        status: draftRestore.status || 'draft_restore_failed',
        error: draftRestore.error || null,
        missing: draftRestore.missing || [],
        checkedAt: new Date().toISOString()
      }
    });

    return attachCaptchaWait(attachDirectPublishState(withPreparationDetails({
      success: false,
      status: draftRestore.status || 'draft_restore_failed',
      error: draftRestore.error || '발행 재개 전 초안 복구에 실패했습니다.',
      draftRestore
    }, preparation)), captchaWait);
  }

  await updateDirectPublishState({
    ...buildTransitionPatch(directPublishState || {}, 'draft_restore_ready', {
      phase: 'resume_publish',
      status: 'ready_to_resume',
      restored: !!draftRestore.restored,
      tabId: preparation.tabId
    }),
    tabId: preparation.tabId,
    url: preparation.url,
    requestData: normalizeDirectPublishRequestData(mergedRequestData),
    lastDraftRestore: {
      success: true,
      restored: !!draftRestore.restored,
      missing: [],
      checkedAt: new Date().toISOString(),
      snapshot: draftRestore.snapshot || null
    }
  });

  try {
    const response = await sendEditorMessage(preparation.tabId, 'RESUME_PUBLISH', {
      visibility: mergedRequestData.visibility || directPublishState?.visibility || 'public'
    });
    const responseWithPreparation = normalizePublishResponse(withPreparationDetails(response, preparation));

    if (responseWithPreparation.success) {
      await clearDirectPublishState();
      return attachCaptchaWait(responseWithPreparation, captchaWait);
    }

    if (responseWithPreparation.status === 'captcha_required') {
      const handoff = await captureCaptchaHandoffForTab(preparation.tabId);
      await setDirectPublishState({
        ...buildDirectPublishState({
          response: responseWithPreparation,
          preparation,
          requestData: {
            ...mergedRequestData,
            blogName: mergedRequestData.blogName || directPublishState?.blogName || preparation.blogName,
            visibility: mergedRequestData.visibility || directPublishState?.visibility || null
          },
          captchaContext: handoff.captchaContext || responseWithPreparation.captchaContext || null
        }),
        lastDraftRestore: {
          success: true,
          restored: !!draftRestore.restored,
          missing: [],
          checkedAt: new Date().toISOString(),
          snapshot: draftRestore.snapshot || null
        },
        lastCaptchaWait: captchaWait
          ? summarizeCaptchaWaitResult(captchaWait, waitOptions)
          : (directPublishState?.lastCaptchaWait || null),
        lastCaptchaArtifactCapture: summarizeCaptchaArtifactCapture(handoff.captchaArtifacts)
      });
      return attachCaptchaWait(attachCaptchaHandoff(attachDirectPublishState(responseWithPreparation), handoff), captchaWait);
    }

    return attachCaptchaWait(attachDirectPublishState(responseWithPreparation), captchaWait);
  } catch (e) {
    preparation.diagnostics?.attempts?.push({
      step: 'resume_direct_publish_catch_recovery',
      tabId: preparation.tabId,
      originalError: e?.message || String(e),
      at: new Date().toISOString()
    });

    const recoveredResponse = await recoverPublishedResponseAfterSendMessageFailure(preparation, mergedRequestData, {
      blogName: mergedRequestData.blogName || directPublishState?.blogName || preparation.blogName || null
    });

    if (recoveredResponse?.success) {
      await clearDirectPublishState();
      return attachCaptchaWait(recoveredResponse, captchaWait);
    }

    if (recoveredResponse) {
      await updateDirectPublishState({
        ...buildTransitionPatch(directPublishState || {}, 'resume_publish_recovery_failed', {
          phase: 'resume_publish',
          status: recoveredResponse.status || 'persistence_unverified',
          tabId: preparation.tabId
        }),
        tabId: preparation.tabId,
        url: recoveredResponse.url || preparation.url,
        requestData: normalizeDirectPublishRequestData(mergedRequestData)
      });
      return attachCaptchaWait(attachDirectPublishState(recoveredResponse), captchaWait);
    }

    return attachCaptchaWait(attachDirectPublishState(makePreparationResponse({
      success: false,
      status: 'editor_not_ready',
      error: e.message,
      tabId: preparation.tabId,
      url: preparation.url,
      blogName: preparation.blogName,
      diagnostics: preparation.diagnostics
    })), captchaWait);
  }
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
    const result = await sendTabMessageWithRecovery(tabId, { action: 'PREPARE_CAPTCHA_CAPTURE' }, { reinjectOnMissing: true });
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
    const result = await sendTabMessageWithRecovery(tabId, { action: 'GET_CAPTCHA_IMAGE_ARTIFACT' }, { reinjectOnMissing: true });
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
  const normalizedOptions = normalizeCaptchaArtifactCaptureOptions(options);

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

  let captureContext = prepared.captureContext || null;
  let selectedCandidate = captureContext?.activeCaptureCandidate || prepared.selectedCandidate || null;
  const directImageResult = await getCaptchaImageArtifactForTab(tabId);
  const viewportCropResult = await captureCaptchaViewportCrop(tab, captureContext, options);
  const frameArtifactResult = (captureContext?.iframeCaptchaPresent || !directImageResult.success)
    ? await getCrossFrameCaptchaArtifactForTab(tabId, normalizedOptions)
    : null;
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

  if (frameArtifactResult?.success && frameArtifactResult.artifact?.dataUrl) {
    artifacts.frameDirectImage = frameArtifactResult.artifact;
    captureContext = finalizeResolvedCaptchaContext(captureContext, frameArtifactResult.frameContextResult || null);
    selectedCandidate = frameArtifactResult.selectedCandidate || selectedCandidate;
  } else if (frameArtifactResult && !frameArtifactResult.success) {
    captureErrors.push({
      type: 'frame_direct_image',
      status: frameArtifactResult.status || null,
      error: frameArtifactResult.error || 'frame_direct_image_unavailable'
    });
  }

  captureContext = finalizeResolvedCaptchaContext(
    captureContext,
    frameArtifactResult?.frameContextResult || frameArtifactResult || null
  );

  const sourceImageUrl = resolveCaptchaArtifactSourceUrl({
    frameArtifactResult,
    captureContext,
    selectedCandidate,
    directImageResult
  });
  const shouldFetchSourceImage = shouldFetchCaptchaSourceImage({
    sourceImageUrl,
    includeSourceImage: normalizedOptions.includeSourceImage
  });

  if (shouldFetchSourceImage) {
    const sourceImageResult = await fetchCaptchaSourceImageArtifact(sourceImageUrl, {
      blobToDataUrlImpl: blobToDataUrl,
      metadata: {
        width: selectedCandidate?.rect?.width || captureContext?.activeCaptureCandidate?.rect?.width || null,
        height: selectedCandidate?.rect?.height || captureContext?.activeCaptureCandidate?.rect?.height || null,
        rect: selectedCandidate?.rect || captureContext?.activeCaptureCandidate?.rect || null,
        visibleRect: selectedCandidate?.visibleRect || captureContext?.activeCaptureCandidate?.visibleRect || null,
        sourceTagName: selectedCandidate?.tagName || captureContext?.activeCaptureCandidate?.tagName || null,
        frameId: frameArtifactResult?.frameId || selectedCandidate?.frameId || null
      }
    });

    if (sourceImageResult.success && sourceImageResult.artifact?.dataUrl) {
      artifacts.sourceImage = sourceImageResult.artifact;
    } else if (!sourceImageResult.success) {
      captureErrors.push({
        type: 'source_image',
        status: sourceImageResult.status || null,
        error: sourceImageResult.error || 'source_image_unavailable'
      });
    }
  }

  const preferredArtifactKey = choosePreferredCaptchaArtifactKey(artifacts);
  if (!preferredArtifactKey) {
    return enrichCaptchaArtifactResultWithSolveHints({
      success: false,
      status: 'captcha_artifact_capture_failed',
      error: captureErrors[0]?.error || 'CAPTCHA 이미지 아티팩트를 생성하지 못했습니다.',
      tabId,
      url: captureContext?.url || tab.url || null,
      selectedCandidate,
      captureContext,
      captureErrors
    });
  }

  return enrichCaptchaArtifactResultWithSolveHints({
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
  });
}

function summarizeCaptchaArtifactCapture(artifactResult = null) {
  return {
    success: !!artifactResult?.success,
    status: artifactResult?.status || null,
    artifactKind: artifactResult?.artifact?.kind || null,
    artifactPreference: artifactResult?.artifactPreference || null,
    captureErrorCount: Array.isArray(artifactResult?.captureErrors) ? artifactResult.captureErrors.length : 0,
    capturedAt: new Date().toISOString()
  };
}

async function captureCaptchaHandoffForTab(tabId, options = {}) {
  if (!tabId) {
    return {
      tabId: null,
      captchaContext: null,
      captchaArtifacts: {
        success: false,
        status: 'editor_not_ready',
        error: 'CAPTCHA handoff를 준비할 탭 ID가 없습니다.'
      }
    };
  }

  const captchaContextResult = await getCaptchaContextForTab(tabId);
  const captchaArtifacts = await getCaptchaArtifactsForTab(
    tabId,
    normalizeCaptchaArtifactCaptureOptions(options.artifactOptions || {})
  );
  const captchaContext = captchaContextResult.success
    ? captchaContextResult.captchaContext
    : (captchaArtifacts.captureContext || captchaContextResult);

  return {
    tabId,
    captchaContext: enrichCaptchaContextWithSolveHints(captchaContext),
    captchaArtifacts: enrichCaptchaArtifactResultWithSolveHints(captchaArtifacts)
  };
}

function attachCaptchaHandoff(response, handoff = null) {
  if (!handoff) return response;

  const captchaContext = mergeResolvedCaptchaContext(response?.captchaContext, handoff.captchaContext);
  const directPublish = response?.directPublish
    ? enrichDirectPublishStateWithSolveHints({
        ...response.directPublish,
        captchaContext: mergeResolvedCaptchaContext(response.directPublish.captchaContext, handoff.captchaContext)
      })
    : response?.directPublish;
  const captchaArtifacts = enrichCaptchaArtifactResultWithSolveHints(handoff.captchaArtifacts || null);

  return attachSolveHints({
    ...response,
    directPublish,
    captchaContext,
    captchaArtifacts
  }, captchaContext);
}

async function sendTabMessageWithTimeout(tabId, message, timeoutMs = EDITOR_PREPARE_DEFAULTS.pingTimeoutMs) {
  let timerId;

  try {
    return await Promise.race([
      sendTabMessageWithRecovery(tabId, message, { reinjectOnMissing: true }),
      new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error('ping_timeout')), timeoutMs);
      })
    ]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

async function probeContentScriptLiveness(tabId, timeoutMs = Math.min(EDITOR_PREPARE_DEFAULTS.pingTimeoutMs, 800)) {
  try {
    const response = await sendTabMessageWithTimeout(tabId, { action: 'PING' }, timeoutMs);
    return {
      success: !!response?.success,
      response: response || null,
      error: response?.success ? null : (response?.error || 'ping_failed')
    };
  } catch (error) {
    return {
      success: false,
      response: null,
      error: error?.message || 'ping_failed'
    };
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
  const editorProbeWaitMs = options.editorProbeWaitMs || EDITOR_PREPARE_DEFAULTS.editorProbeWaitMs;
  const editorProbeIntervalMs = options.editorProbeIntervalMs || EDITOR_PREPARE_DEFAULTS.editorProbeIntervalMs;
  const editorProbeSettleDelayMs = options.editorProbeSettleDelayMs || EDITOR_PREPARE_DEFAULTS.editorProbeSettleDelayMs;

  let lastError = 'editor_probe_failed';
  let lastReason = null;
  let lastDiagnostics = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const probeResult = await sendTabMessageWithTimeout(tabId, {
        action: 'PROBE_EDITOR_READY',
        data: {
          timeoutMs: editorProbeWaitMs,
          intervalMs: editorProbeIntervalMs,
          settleDelayMs: editorProbeSettleDelayMs
        }
      }, timeoutMs + editorProbeWaitMs + 250);

      if (probeResult?.success) {
        diagnostics.attempts.push({
          step,
          tabId,
          attempt,
          outcome: 'ready',
          waitedMs: probeResult.waitedMs ?? null,
          pollCount: probeResult.pollCount ?? null,
          editorProbe: probeResult.diagnostics || null
        });
        return { success: true, attempts: attempt, diagnostics: probeResult.diagnostics || null };
      }

      lastError = probeResult?.error || 'editor_not_ready';
      lastReason = probeResult?.reason || null;
      lastDiagnostics = probeResult?.diagnostics || null;
      const liveness = await probeContentScriptLiveness(tabId, timeoutMs);
      diagnostics.attempts.push({
        step,
        tabId,
        attempt,
        outcome: 'not_ready',
        error: lastError,
        reason: lastReason,
        waitedMs: probeResult?.waitedMs ?? null,
        pollCount: probeResult?.pollCount ?? null,
        contentScriptAlive: liveness.success,
        pingError: liveness.error,
        editorProbe: lastDiagnostics || liveness.response?.editorProbe || null
      });
    } catch (error) {
      lastError = error?.message || 'editor_probe_failed';
      const liveness = await probeContentScriptLiveness(tabId, timeoutMs);
      lastReason = liveness.response?.editorProbe?.reason || null;
      lastDiagnostics = liveness.response?.editorProbe || null;
      diagnostics.attempts.push({
        step,
        tabId,
        attempt,
        outcome: 'not_ready',
        error: lastError,
        reason: lastReason,
        contentScriptAlive: liveness.success,
        pingError: liveness.error,
        editorProbe: lastDiagnostics
      });
    }

    if (attempt < retries) {
      await applyPreparationStageDelay(
        diagnostics,
        `${step}_retry_wait`,
        intervalMs,
        EDITOR_PREPARE_DEFAULTS.stageJitter,
        { tabId, attempt }
      );
    }
  }

  return {
    success: false,
    error: lastError,
    reason: lastReason,
    diagnostics: lastDiagnostics
  };
}

/**
 * 큐에서 글 하나를 발행
 */
async function processNextInQueue() {
  if (isProcessing) return;
  if (publishQueue.length === 0) {
    await resetQueueRuntimeState();
    return;
  }

  const pendingIndex = publishQueue.findIndex(item => item.status === 'pending');
  if (pendingIndex === -1) {
    isProcessing = false;
    await resetQueueRuntimeState();
    return;
  }

  isProcessing = true;
  await clearQueueContinuationAlarm();
  await updateQueueRuntimeState({
    active: true,
    scheduledTimeMs: null,
    requestedDelayMs: null
  });
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

      let responseWithPreparation;
      try {
        const response = await sendEditorMessage(preparation.tabId, 'WRITE_POST', { ...item.data, autoPublish: true });
        responseWithPreparation = normalizePublishResponse(withPreparationDetails(response, preparation));
      } catch (error) {
        preparation.diagnostics.attempts.push({
          step: 'queue_write_post_catch_recovery',
          tabId: preparation.tabId,
          originalError: error?.message || String(error),
          at: new Date().toISOString()
        });

        const recoveredResponse = await recoverPublishedResponseAfterSendMessageFailure(preparation, item.data || {});
        if (!recoveredResponse) {
          throw error;
        }

        responseWithPreparation = normalizePublishResponse(recoveredResponse);
      }

      if (responseWithPreparation.success) {
        item.status = 'completed';
        item.completedAt = new Date().toISOString();
        item.publishStatus = responseWithPreparation.status || 'published';
      } else if (responseWithPreparation.status === 'captcha_required') {
        // CAPTCHA 감지 — 실패가 아닌 일시정지 상태로 보존 (에디터 내용 유지됨)
        const handoff = await captureCaptchaHandoffForTab(currentTabId);
        Object.assign(item, buildQueueCaptchaPauseState({
          existingItem: item,
          tabId: currentTabId,
          response: responseWithPreparation,
          handoff,
          error: 'CAPTCHA 감지 — 같은 탭에서 solve 후 재개'
        }));
        console.warn('[TistoryAuto BG] CAPTCHA 감지 — 큐 일시정지 (captcha_paused). tabId:', currentTabId);
        await saveQueueState();
        isProcessing = false;
        await resetQueueRuntimeState();
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

  await scheduleNextPendingQueueItem();
}

async function resumeQueueItemAfterCaptcha(item, options = {}) {
  const tabId = options.tabId || item?.captchaTabId || currentTabId;
  if (!tabId) {
    return { success: false, error: '에디터 탭을 찾을 수 없음. 페이지를 새로 열어주세요.', status: 'editor_not_ready' };
  }

  const resumeDiagnostics = {
    requestedBlogName: item?.data?.blogName || null,
    blogName: item?.data?.blogName || null,
    currentTabId,
    candidateCount: 1,
    attempts: []
  };

  const resumeProbe = await probeTabReady(tabId, resumeDiagnostics, 'probe_resume_tab');
  const resumeAction = decideQueueCaptchaResumeProbeAction({
    probeResult: resumeProbe,
    captchaStage: item?.captchaStage || null
  });
  if (resumeAction.action === 'editor_not_ready') {
    return {
      success: false,
      error: '에디터 탭이 닫혔거나 새로고침됨. RETRY로 처음부터 다시 시도하세요.',
      status: 'editor_not_ready',
      tabId,
      diagnostics: resumeDiagnostics
    };
  }
  if (resumeAction.action === 'captcha_required') {
    return {
      success: false,
      error: resumeAction.error || 'CAPTCHA가 아직 표시되어 있습니다. 먼저 해결해주세요.',
      status: 'captcha_required',
      tabId,
      diagnostics: resumeDiagnostics
    };
  }

  let resumePreparation = null;
  try {
    const resumeTab = await chrome.tabs.get(tabId);
    currentTabId = tabId;
    resumePreparation = makePreparationResponse({
      success: true,
      status: resumeAction.status || 'editor_ready',
      tab: resumeTab,
      blogName: item?.data?.blogName || getTabBlogName(resumeTab.url) || null,
      diagnostics: resumeDiagnostics
    });
  } catch (error) {
    return {
      success: false,
      error: error.message || '에디터 탭이 닫혔거나 새로고침됨. RETRY로 처음부터 다시 시도하세요.',
      status: 'editor_not_ready',
      tabId,
      diagnostics: resumeDiagnostics
    };
  }

  try {
    const captchaCheck = await getBlockingCaptchaStateForTab(tabId);
    if (captchaCheck?.captchaPresent) {
      return { success: false, error: 'CAPTCHA가 아직 표시되어 있습니다. 먼저 해결해주세요.', status: 'captcha_required' };
    }
  } catch (_error) {
    // 확인 실패 시 발행 시도는 계속 진행
  }

  const previousQueueCaptchaSnapshot = cloneJsonValue(item) || { ...item };
  Object.assign(item, clearQueueCaptchaPauseState());
  item.status = 'processing';
  isProcessing = true;
  await clearQueueContinuationAlarm();
  await updateQueueRuntimeState({
    active: true,
    scheduledTimeMs: null,
    requestedDelayMs: null
  });
  await saveQueueState();

  const handleQueueResumeResponse = async (normalizedResponse) => {
    if (normalizedResponse.success) {
      item.status = 'completed';
      item.error = null;
      item.completedAt = new Date().toISOString();
      item.publishStatus = normalizedResponse.status || 'published';
      Object.assign(item, clearQueueCaptchaPauseState());
      await saveQueueState();
      isProcessing = false;
      const queueContinuation = await scheduleNextPendingQueueItem();
      return {
        success: true,
        status: normalizedResponse.status || 'published',
        url: normalizedResponse.url || null,
        queueContinuation
      };
    }

    if (normalizedResponse.status === 'captcha_required') {
      const handoff = await captureCaptchaHandoffForTab(tabId);
      Object.assign(item, buildQueueCaptchaPauseState({
        existingItem: previousQueueCaptchaSnapshot,
        tabId,
        response: normalizedResponse,
        handoff,
        error: 'CAPTCHA 재발생 — 같은 탭에서 다시 해결 후 재개'
      }));
      await saveQueueState();
      isProcessing = false;
      await resetQueueRuntimeState();
      return normalizedResponse;
    }

    item.status = 'failed';
    item.error = normalizedResponse.error || '재개 후 발행 실패';
    item.publishStatus = normalizedResponse.status;
    Object.assign(item, clearQueueCaptchaPauseState());
    await saveQueueState();
    isProcessing = false;
    await resetQueueRuntimeState();
    return normalizedResponse;
  };

  try {
    if (resumeAction.action === 'wait_for_post_captcha_settle') {
      const postCaptchaSettle = await waitForPostCaptchaCompletionOrResume(resumePreparation, item.data || {});
      if (postCaptchaSettle.completed && postCaptchaSettle.response) {
        return handleQueueResumeResponse(normalizePublishResponse(postCaptchaSettle.response));
      }
      if (!postCaptchaSettle.success) {
        return handleQueueResumeResponse(normalizePublishResponse({
          success: false,
          error: postCaptchaSettle.error || 'CAPTCHA가 다시 표시되어 자동 재개를 중단합니다.',
          status: postCaptchaSettle.status || 'captcha_required',
          tabId,
          diagnostics: resumeDiagnostics,
          captchaStage: item?.captchaStage || null
        }));
      }
    }

    const draftRestore = await restoreDraftIfNeeded(tabId, item.data || {});
    if (!draftRestore.success) {
      item.status = 'failed';
      item.error = draftRestore.error || '발행 재개 전 초안 복구 실패';
      item.publishStatus = draftRestore.status || 'draft_restore_failed';
      Object.assign(item, clearQueueCaptchaPauseState());
      await saveQueueState();
      isProcessing = false;
      await resetQueueRuntimeState();
      return draftRestore;
    }

    let normalizedResponse;
    try {
      const response = await sendEditorMessage(tabId, 'RESUME_PUBLISH', {
        visibility: item.data?.visibility || 'public'
      });
      normalizedResponse = normalizePublishResponse(response);
    } catch (error) {
      resumeDiagnostics.attempts.push({
        step: 'resume_after_captcha_catch_recovery',
        tabId,
        originalError: error?.message || String(error),
        at: new Date().toISOString()
      });

      const recoveredResponse = await recoverPublishedResponseAfterSendMessageFailure({
        ...resumePreparation,
        status: resumeAction.status || resumePreparation?.status || 'editor_ready'
      }, item.data || {}, {
        blogName: item.data?.blogName || null
      });

      if (!recoveredResponse) {
        throw error;
      }

      normalizedResponse = normalizePublishResponse(recoveredResponse);
    }

    return handleQueueResumeResponse(normalizedResponse);
  } catch (error) {
    item.status = 'failed';
    item.error = error.message;
    Object.assign(item, clearQueueCaptchaPauseState());
    await saveQueueState();
    isProcessing = false;
    await resetQueueRuntimeState();
    return { success: false, error: error.message };
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
    return sameBlogA - sameBlogB || pageA - pageB || trackedA - trackedB || accessA - accessB;
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
    },
    managePostSequence: 0,
    lastManagePostDiag: null
  });

  const MANAGE_POST_LOG_KEY = '__blog_auto_last_manage_post_diag';
  const MANAGE_POST_DIAG_ATTR = 'data-blog-auto-last-manage-post-diag';
  const MANAGE_POST_SEQ_ATTR = 'data-blog-auto-last-manage-post-seq';
  const CAPTCHA_PAYLOAD_LOG_KEY = '__blog_auto_last_captcha_payload';
  const CAPTCHA_KEY_RE = /(recaptchaValue|g-recaptcha-response|challengeCode)/i;

  const now = () => new Date().toISOString();

  const normalizeText = (value) => {
    if (value == null) return null;
    const text = typeof value === 'string' ? value : String(value);
    const trimmed = text.trim();
    return trimmed || null;
  };

  const stripHtml = (value = '') => String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const readStringByKey = (value, matcher, depth = 0) => {
    if (value == null || depth > 4) return null;

    if (typeof value === 'string') return null;

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = readStringByKey(item, matcher, depth + 1);
        if (nested) return nested;
      }
      return null;
    }

    if (typeof value !== 'object') return null;

    for (const [key, nestedValue] of Object.entries(value)) {
      if (!key) continue;
      if (matcher.test(key) && typeof nestedValue === 'string' && normalizeText(nestedValue)) {
        return nestedValue;
      }
    }

    for (const nestedValue of Object.values(value)) {
      const nested = readStringByKey(nestedValue, matcher, depth + 1);
      if (nested) return nested;
    }

    return null;
  };

  const extractManagePostHtml = (payload) => {
    return readStringByKey(payload, /^(content|html|body|post|editorContent)$/i)
      || readStringByKey(payload, /(content|html|body)/i)
      || '';
  };

  const extractManagePostTitle = (payload) => {
    return readStringByKey(payload, /^(title|subject)$/i)
      || readStringByKey(payload, /(title|subject)/i)
      || null;
  };

  const countMatches = (value, pattern) => (String(value || '').match(pattern) || []).length;

  const persistRequestDiag = (diag) => {
    pageState.lastManagePostDiag = diag;

    try {
      const serialized = JSON.stringify(diag);
      localStorage.setItem(MANAGE_POST_LOG_KEY, serialized);
      document.documentElement.setAttribute(MANAGE_POST_DIAG_ATTR, serialized);
      document.documentElement.setAttribute(MANAGE_POST_SEQ_ATTR, String(diag.sequence || 0));
    } catch (_) {}
  };

  const buildManagePostDiag = (payload, meta = {}) => {
    const html = extractManagePostHtml(payload);
    const text = stripHtml(html);
    const sequence = (pageState.managePostSequence || 0) + 1;
    pageState.managePostSequence = sequence;

    return {
      at: now(),
      sequence,
      url: meta.url || null,
      method: meta.method || null,
      changed: !!meta.changed,
      visibility: payload?.visibility ?? null,
      title: extractManagePostTitle(payload),
      htmlLength: String(html || '').trim().length,
      textLength: text.length,
      imageCount: countMatches(html, /<img\b/gi),
      dataImageCount: countMatches(html, /<img\b[^>]*src=["']data:image\//gi),
      blobImageCount: countMatches(html, /<img\b[^>]*src=["']blob:/gi),
      hasRecaptchaValue: !!normalizeText(payload?.recaptchaValue),
      hasChallengeCode: !!normalizeText(payload?.challengeCode)
    };
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

  const MAIN_WORLD_REQUEST_EVENT = 'blog-auto-main-world-request';
  const MAIN_WORLD_RESPONSE_EVENT = 'blog-auto-main-world-response';

  const getMainWorldEditor = () => {
    try {
      if (window.tinymce?.activeEditor) return window.tinymce.activeEditor;
      if (window.tinymce?.editors?.length > 0) return window.tinymce.editors[0];
    } catch (_error) {}
    return null;
  };

  const summarizeMainWorldEditor = (editor) => {
    if (!editor) {
      return {
        hasEditor: false,
        htmlLength: 0,
        textLength: 0,
        textPreview: '',
        imageCount: 0
      };
    }

    try {
      const html = String(editor.getContent({ format: 'html' }) || '');
      const text = stripHtml(html);
      return {
        hasEditor: true,
        htmlLength: html.trim().length,
        textLength: text.length,
        textPreview: text.slice(0, 160),
        imageCount: countMatches(html, /<img\b/gi)
      };
    } catch (error) {
      return {
        hasEditor: true,
        htmlLength: 0,
        textLength: 0,
        textPreview: '',
        imageCount: 0,
        error: error.message || String(error)
      };
    }
  };

  const installConfirmBypass = () => {
    if (window.__blogAutoConfirmBypassInstalled) {
      return;
    }

    window.__blogAutoConfirmBypassInstalled = true;
    const originalConfirm = window.confirm;
    window.confirm = function(message) {
      if (message && /저장된 글이 있습니다|이어서 작성/.test(String(message))) {
        try {
          console.log('[TistoryAuto:page] draft restore confirm auto-dismiss:', message);
        } catch (_error) {}
        return false;
      }

      return originalConfirm.call(this, message);
    };
  };

  installConfirmBypass();

  const handleMainWorldEditorAction = (detail = {}) => {
    const action = detail.action || null;

    if (action === 'GET_EDITOR_SNAPSHOT') {
      const editor = getMainWorldEditor();
      return {
        success: true,
        status: editor ? 'main_world_snapshot_ready' : 'main_world_editor_missing',
        snapshot: summarizeMainWorldEditor(editor)
      };
    }

    if (action === 'SET_EDITOR_CONTENT') {
      const editor = getMainWorldEditor();
      if (!editor) {
        return {
          success: false,
          status: 'main_world_editor_missing',
          error: 'MAIN world tinymce editor를 찾지 못했습니다.'
        };
      }

      try {
        const html = String(detail.html || '');
        editor.focus?.();
        editor.setContent(html);
        editor.setDirty?.(true);
        editor.nodeChanged?.();
        editor.save?.();
        editor.fire?.('change');
        editor.fire?.('input');

        const textarea = editor.getElement?.();
        if (textarea && 'value' in textarea) {
          textarea.value = html;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return {
          success: true,
          status: 'main_world_content_set',
          snapshot: summarizeMainWorldEditor(editor)
        };
      } catch (error) {
        return {
          success: false,
          status: 'main_world_content_set_failed',
          error: error.message || String(error),
          snapshot: summarizeMainWorldEditor(editor)
        };
      }
    }

    return {
      success: false,
      status: 'main_world_action_unknown',
      error: `지원하지 않는 MAIN world action: ${action || 'unknown'}`
    };
  };

  if (!window.__blogAutoMainWorldRequestHandlerInstalled) {
    window.__blogAutoMainWorldRequestHandlerInstalled = true;
    window.addEventListener(MAIN_WORLD_REQUEST_EVENT, (event) => {
      const requestId = event?.detail?.requestId || null;
      const result = handleMainWorldEditorAction(event?.detail || {});
      window.dispatchEvent(new CustomEvent(MAIN_WORLD_RESPONSE_EVENT, {
        detail: {
          requestId,
          result
        }
      }));
    }, true);
  }

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
      ...buildManagePostDiag(nextPayload, { changed }),
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

async function navigateTabToUrl(tab, targetUrl, diagnostics, options = {}) {
  const sameTarget = normalizeUrl(tab.url) === normalizeUrl(targetUrl);
  const step = options.step || (sameTarget ? 'reuse_loaded_target' : 'navigate_tab');

  diagnostics.attempts.push({
    step,
    tabId: tab.id,
    fromUrl: tab.url || null,
    toUrl: targetUrl,
    sameTarget
  });

  try {
    if (!sameTarget) {
      await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    }
  } catch (error) {
    diagnostics.attempts.push({
      step: `${step}_result`,
      tabId: tab.id,
      outcome: 'failed',
      error: error.message
    });
    return { success: false, error: error.message, tab };
  }

  const loadResult = await waitForTabLoadComplete(tab.id);
  diagnostics.attempts.push({
    step: options.loadStep || 'wait_for_load',
    tabId: tab.id,
    outcome: loadResult.success ? 'complete' : 'failed',
    error: loadResult.error || null,
    targetUrl
  });

  if (!loadResult.success) {
    return { success: false, error: loadResult.error, tab };
  }

  await applyPreparationStageDelay(
    diagnostics,
    options.settleStep || `${step}_settle`,
    options.settleDelayMs || EDITOR_PREPARE_DEFAULTS.postLoadDelayMs,
    options.jitterOptions || EDITOR_PREPARE_DEFAULTS.stageJitter,
    {
      tabId: tab.id,
      targetUrl,
      sameTarget
    }
  );

  return { success: true, tab: loadResult.tab || tab };
}

async function navigateTabToEditorViaManage(tab, blogName, diagnostics, options = {}) {
  const manageUrl = buildManageHomeUrl(blogName);
  const editorUrl = buildNewPostUrl(blogName);

  diagnostics.entryPath = diagnostics.entryPath || [];
  diagnostics.entryPath.push({ step: 'manage_home', url: manageUrl });

  const manageNavigation = await navigateTabToUrl(tab, manageUrl, diagnostics, {
    step: options.manageStep || 'navigate_manage_home',
    loadStep: options.manageLoadStep || 'wait_for_manage_home_load',
    settleStep: options.manageSettleStep || 'settle_manage_home'
  });
  if (!manageNavigation.success) {
    return manageNavigation;
  }

  const manageTab = manageNavigation.tab || tab;
  diagnostics.entryPath.push({ step: 'newpost', url: editorUrl });

  return navigateTabToUrl(manageTab, editorUrl, diagnostics, {
    step: options.editorStep || 'navigate_newpost',
    loadStep: options.editorLoadStep || 'wait_for_newpost_load',
    settleStep: options.editorSettleStep || 'settle_newpost'
  });
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
    diagnostics.entryStrategy = diagnostics.entryStrategy || 'reuse_ready_tab';
    diagnostics.entryPath = diagnostics.entryPath?.length
      ? diagnostics.entryPath
      : [{ step: 'reuse_existing_editor', url: tab.url || null }];
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

  // 탭이 이미 /manage/newpost 에 있고 content script 가 살아 있더라도,
  // PROBE_EDITOR_READY 가 실패했다면 곧바로 editor_ready 로 간주하면 안 된다.
  // (예: CAPTCHA 잔존, publish layer 잔류, stale TinyMCE state)
  // 이 경우에는 같은 탭을 manage → newpost 로 다시 태워 실제 회복을 시도한다.
  if (isNewPostTab(tab.url)) {
    const liveness = await probeContentScriptLiveness(tab.id);
    diagnostics.attempts.push({
      step: 'liveness_check_before_navigation',
      tabId: tab.id,
      url: tab.url,
      alive: liveness.success,
      probeFailedReason: initialProbe.reason || null
    });
    if (liveness.success) {
      diagnostics.entryPath = diagnostics.entryPath?.length
        ? diagnostics.entryPath
        : [{
            step: 'live_newpost_probe_failed_continue_recovery',
            url: tab.url,
            reason: initialProbe.reason || null
          }];
    }
  }

  diagnostics.entryStrategy = diagnostics.entryStrategy || 'candidate_manage_home_to_newpost';
  const navigation = await navigateTabToEditorViaManage(tab, targetBlogName, diagnostics, {
    manageStep: 'candidate_manage_home',
    manageLoadStep: 'candidate_manage_home_load',
    manageSettleStep: 'candidate_manage_home_settle',
    editorStep: 'candidate_newpost',
    editorLoadStep: 'candidate_newpost_load',
    editorSettleStep: 'candidate_newpost_settle'
  });
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
  const manageUrl = buildManageHomeUrl(blogName);
  let createdTab;

  diagnostics.entryStrategy = diagnostics.entryStrategy || 'fresh_manage_home_to_newpost';
  diagnostics.attempts.push({
    step: 'open_fresh_tab',
    toUrl: manageUrl
  });

  try {
    createdTab = await chrome.tabs.create({ url: manageUrl, active: true });
  } catch (error) {
    diagnostics.attempts.push({
      step: 'open_fresh_tab_result',
      outcome: 'failed',
      error: error.message
    });
    return { success: false, error: error.message };
  }

  const navigation = await navigateTabToEditorViaManage(createdTab, blogName, diagnostics, {
    manageStep: 'fresh_manage_home',
    manageLoadStep: 'wait_for_fresh_manage_home_load',
    manageSettleStep: 'fresh_manage_home_settle',
    editorStep: 'fresh_newpost',
    editorLoadStep: 'wait_for_fresh_newpost_load',
    editorSettleStep: 'fresh_newpost_settle'
  });
  if (!navigation.success) {
    return { success: false, error: navigation.error, tab: navigation.tab || createdTab };
  }

  const preparedTab = navigation.tab || createdTab;
  const probeResult = await probeTabReady(preparedTab.id, diagnostics, 'probe_fresh_tab');
  if (!probeResult.success) {
    return { success: false, error: probeResult.error, tab: preparedTab };
  }

  currentTabId = preparedTab.id;
  return makePreparationResponse({
    success: true,
    status: 'editor_ready',
    tab: preparedTab,
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
    entryStrategy: null,
    entryPath: [],
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
    error: '실제 에디터 본문이 준비된 티스토리 글쓰기 탭을 확보하지 못했습니다. diagnostics를 확인하세요.',
    tab: freshTabResult.tab || lastFailure?.tab || null,
    blogName,
    diagnostics
  });
}

// ── 공통 메시지 처리 함수 ──────────────────────────
async function handleMessage(message, sender) {
  await ensureRuntimeStateLoaded();

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
        const response = await sendEditorMessage(preparation.tabId, message.action, message.data);
        const responseWithPreparation = normalizePublishResponse(withPreparationDetails(response, preparation));

        if (responseWithPreparation.status === 'captcha_required') {
          const handoff = await captureCaptchaHandoffForTab(preparation.tabId);
          await setDirectPublishState({
            ...buildDirectPublishState({
              response: responseWithPreparation,
              preparation,
              requestData: message.data || {},
              captchaContext: handoff.captchaContext || responseWithPreparation.captchaContext || null
            }),
            lastCaptchaArtifactCapture: summarizeCaptchaArtifactCapture(handoff.captchaArtifacts)
          });
          return attachCaptchaHandoff(attachDirectPublishState(responseWithPreparation), handoff);
        }

        if (responseWithPreparation.success) {
          await clearDirectPublishState();
        }

        return responseWithPreparation;
      } catch (err) {
        console.warn('[TistoryAuto BG] WRITE_POST sendEditorMessage error:', err?.message || err);
        preparation.diagnostics.attempts.push({
          step: 'write_post_catch_recovery',
          tabId: preparation.tabId,
          originalError: err?.message || String(err)
        });

        const recoveredResponse = await recoverPublishedResponseAfterSendMessageFailure(preparation, message.data || {});
        if (recoveredResponse) {
          return recoveredResponse;
        }

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
        const response = await sendEditorMessage(preparation.tabId, message.action, message.data);
        return normalizePublishResponse(withPreparationDetails(response, preparation));
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
    case 'START_QUEUE': {
      await scheduleImmediateQueueWake('start_queue');
      return {
        success: true,
        message: '큐 처리를 시작합니다.',
        wakeStarted: false,
        wakeSkipped: false,
        wakeScheduled: true
      };
    }

    // 큐 상태 조회
    case 'GET_QUEUE':
      return { success: true, queue: publishQueue, isProcessing, queueRuntimeState };

    // 큐 항목 삭제
    case 'REMOVE_FROM_QUEUE': {
      publishQueue = publishQueue.filter(item => item.id !== message.data.id);
      await saveQueueState();
      if (publishQueue.length === 0 || !publishQueue.some(item => item.status === 'pending')) {
        await resetQueueRuntimeState();
      }
      return { success: true };
    }

    // 큐 전체 초기화
    case 'CLEAR_QUEUE':
      publishQueue = [];
      await saveQueueState();
      await resetQueueRuntimeState();
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
      return attachSolveHints({
        success: true,
        directPublish: state,
        directPublishRuntimeState
      }, state?.captchaContext || null);
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

      return attachSolveHints({
        success: true,
        tabId,
        captchaContext: captchaContextResult.captchaContext,
        directPublish: savedState?.tabId === tabId ? enrichDirectPublishStateWithSolveHints({ ...directPublishState }) : null
      }, captchaContextResult.captchaContext);
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
          lastCaptchaArtifactCapture: summarizeCaptchaArtifactCapture(artifactResult)
        });
      }

      return attachSolveHints({
        ...artifactResult,
        directPublish: savedState?.tabId === tabId ? enrichDirectPublishStateWithSolveHints({ ...directPublishState }) : null
      }, artifactResult.captureContext || null);
    }

    case 'INFER_CAPTCHA_ANSWER': {
      const explicitTabId = message.data?.tabId || null;
      const savedState = explicitTabId ? null : await getLiveDirectPublishState({ includeCaptchaContext: true });
      const tabId = explicitTabId || savedState?.tabId || currentTabId;
      const answerResolution = await resolveCaptchaAnswerInput(tabId, message.data || {}, savedState);

      return {
        ...answerResolution,
        tabId,
        directPublish: savedState?.tabId === tabId ? { ...directPublishState } : null
      };
    }

    case 'SUBMIT_CAPTCHA': {
      const explicitTabId = message.data?.tabId || null;
      const savedState = explicitTabId ? null : await getLiveDirectPublishState({ includeCaptchaContext: true });
      const tabId = explicitTabId || savedState?.tabId || currentTabId;
      const answerResolution = await resolveCaptchaAnswerInput(tabId, message.data || {}, savedState);
      if (!answerResolution.success) {
        return {
          ...answerResolution,
          tabId,
          directPublish: savedState?.tabId === tabId ? { ...directPublishState } : null
        };
      }

      const submitResult = await submitResolvedCaptchaForTab(tabId, answerResolution, {
        waitMs: message.data?.waitMs,
        maxAnswerAttempts: message.data?.maxAnswerAttempts
      });
      const captchaStillAppears = !!submitResult.captchaStillAppears;

      if (!submitResult.success || captchaStillAppears) {
        const handoff = await captureCaptchaHandoffForTab(tabId);
        if (directPublishState?.tabId === tabId) {
          await updateDirectPublishState({
            url: handoff.captchaContext?.url || directPublishState?.url || null,
            captchaContext: handoff.captchaContext || directPublishState?.captchaContext || null,
            lastCheckedAt: new Date().toISOString(),
            lastCaptchaArtifactCapture: summarizeCaptchaArtifactCapture(handoff.captchaArtifacts)
          });
        }

        return attachCaptchaHandoff({
          ...submitResult,
          answerResolution,
          captchaStillAppears,
          directPublish: directPublishState?.tabId === tabId ? { ...directPublishState } : null
        }, handoff);
      }

      return {
        ...submitResult,
        answerResolution,
        captchaStillAppears,
        directPublish: directPublishState?.tabId === tabId ? { ...directPublishState } : null
      };
    }

    case 'SUBMIT_CAPTCHA_AND_RESUME': {
      const explicitItemId = typeof message.data?.id === 'string' ? message.data.id.trim() : '';
      const explicitTabId = message.data?.tabId || null;
      const savedState = explicitTabId ? null : await getLiveDirectPublishState({ includeCaptchaContext: true });
      const queueSelection = summarizeQueueCaptchaSelection(publishQueue, {
        itemId: explicitItemId || null,
        tabId: explicitTabId
      });
      const shouldResolveQueueByDefault = !explicitItemId && !explicitTabId && !savedState;
      const queueCaptchaItem = (explicitItemId || explicitTabId || shouldResolveQueueByDefault)
        ? findQueueCaptchaItem(publishQueue, {
            itemId: explicitItemId || null,
            tabId: explicitTabId
          })
        : null;
      const queueSelectionFailure = getQueueCaptchaSelectionFailure({
        queue: publishQueue,
        itemId: explicitItemId || null,
        tabId: explicitTabId,
        matchedItem: queueCaptchaItem,
        directPublishTabId: savedState?.tabId || directPublishState?.tabId || null
      });
      if (queueSelectionFailure) {
        return {
          success: false,
          status: queueSelectionFailure.status,
          error: queueSelectionFailure.error,
          resumed: false,
          submitResult: null,
          resumeResult: null,
          queueItemId: null,
          queueSelection,
          directPublish: savedState?.tabId ? { ...directPublishState } : null
        };
      }
      const tabId = queueCaptchaItem?.captchaTabId || explicitTabId || savedState?.tabId || currentTabId;
      const answerResolutionState = queueCaptchaItem
        ? buildQueueCaptchaSavedStateForAnswerResolution({
            queueItem: queueCaptchaItem,
            directPublishState: savedState
          })
        : savedState;
      const answerResolution = await resolveCaptchaAnswerInput(tabId, message.data || {}, answerResolutionState);
      if (!answerResolution.success) {
        return {
          ...answerResolution,
          tabId,
          resumed: false,
          submitResult: null,
          resumeResult: null,
          queueItemId: queueCaptchaItem?.id || null,
          queueSelection,
          directPublish: savedState?.tabId === tabId ? { ...directPublishState } : null
        };
      }

      const submitResult = await submitResolvedCaptchaForTab(tabId, answerResolution, {
        waitMs: message.data?.waitMs,
        maxAnswerAttempts: message.data?.maxAnswerAttempts
      });
      const captchaStillAppears = !!submitResult.captchaStillAppears;

      if (!submitResult.success || captchaStillAppears) {
        const handoff = await captureCaptchaHandoffForTab(tabId);
        if (queueCaptchaItem) {
          Object.assign(queueCaptchaItem, buildQueueCaptchaPauseState({
            existingItem: queueCaptchaItem,
            tabId,
            handoff,
            submitResult,
            error: 'CAPTCHA가 아직 표시되어 있습니다. 같은 탭에서 다시 해결 후 재개하세요.'
          }));
          await saveQueueState();
        }
        if (directPublishState?.tabId === tabId) {
          await updateDirectPublishState({
            url: handoff.captchaContext?.url || directPublishState?.url || null,
            captchaContext: handoff.captchaContext || directPublishState?.captchaContext || null,
            lastCheckedAt: new Date().toISOString(),
            lastCaptchaArtifactCapture: summarizeCaptchaArtifactCapture(handoff.captchaArtifacts)
          });
        }

        return attachCaptchaHandoff({
          ...submitResult,
          resumed: false,
          submitResult,
          resumeResult: null,
          queueItemId: queueCaptchaItem?.id || null,
          queueSelection,
          directPublish: directPublishState?.tabId === tabId ? { ...directPublishState } : null
        }, handoff);
      }

      const submitCompletedByNavigation = submitResult?.status === 'captcha_submit_tab_navigated'
        || looksLikeDirectPublishCompletionUrl(submitResult?.url || '');
      if (submitCompletedByNavigation) {
        if (queueCaptchaItem) {
          queueCaptchaItem.status = 'completed';
          queueCaptchaItem.error = null;
          queueCaptchaItem.completedAt = new Date().toISOString();
          queueCaptchaItem.publishStatus = submitResult.status || 'captcha_submit_tab_navigated';
          Object.assign(queueCaptchaItem, clearQueueCaptchaPauseState());
          await saveQueueState();
          const queueContinuation = await scheduleNextPendingQueueItem();
          return {
            ...submitResult,
            success: true,
            status: submitResult.status || 'captcha_submit_tab_navigated',
            url: submitResult.url || null,
            resumed: false,
            completedDuringSubmit: true,
            submitResult,
            resumeResult: null,
            queueItemId: queueCaptchaItem.id,
            queueSelection,
            queueContinuation,
            directPublish: null
          };
        }

        if (directPublishState?.tabId === tabId) {
          await clearDirectPublishState();
        }

        return {
          ...submitResult,
          success: true,
          status: submitResult.status || 'captcha_submit_tab_navigated',
          url: submitResult.url || null,
          resumed: false,
          completedDuringSubmit: true,
          submitResult,
          resumeResult: null,
          queueItemId: null,
          queueSelection,
          directPublish: null
        };
      }

      if (queueCaptchaItem) {
        const resumeResult = await resumeQueueItemAfterCaptcha(queueCaptchaItem, { tabId });
        return {
          ...resumeResult,
          resumed: !!resumeResult?.success,
          submitResult,
          resumeResult,
          queueItemId: queueCaptchaItem.id,
          queueSelection,
          directPublish: null
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
        resumeResult,
        queueItemId: null,
        queueSelection
      };
    }

    // CAPTCHA 해결 후 발행 재개 (큐 항목)
    case 'RESUME_AFTER_CAPTCHA': {
      const queueSelection = summarizeQueueCaptchaSelection(publishQueue, {
        itemId: message.data?.id || null,
        tabId: message.data?.tabId || null
      });
      const item = findQueueCaptchaItem(publishQueue, {
        itemId: message.data?.id || null,
        tabId: message.data?.tabId || null
      });
      const queueSelectionFailure = getQueueCaptchaSelectionFailure({
        queue: publishQueue,
        itemId: message.data?.id || null,
        tabId: message.data?.tabId || null,
        matchedItem: item,
        directPublishTabId: null
      });
      if (queueSelectionFailure) {
        return {
          success: false,
          error: queueSelectionFailure.error,
          status: queueSelectionFailure.status,
          queueSelection
        };
      }

      const resumeResult = await resumeQueueItemAfterCaptcha(item, {
        tabId: message.data?.tabId || item.captchaTabId || currentTabId
      });
      return {
        ...resumeResult,
        queueItemId: item.id,
        queueSelection
      };
    }

    // 실패/일시정지 항목 처음부터 재시도
    case 'RETRY_ITEM': {
      const itemId = message.data?.id;
      const item = publishQueue.find(i => i.id === itemId);
      if (!item) return { success: false, error: '항목을 찾을 수 없음' };
      item.status = 'pending';
      item.error = null;
      Object.assign(item, clearQueueCaptchaPauseState());
      item.completedAt = null;
      item.publishStatus = null;
      await saveQueueState();
      return { success: true };
    }

    // CAPTCHA 해결 후 직접 발행 재개 (큐 외부, 팝업/API 직접 발행)
    case 'RESUME_DIRECT_PUBLISH':
      return await resumeDirectPublishFlow(message.data || {}, {
        preferredTabId: message.data?.tabId || null,
        waitForCaptcha: message.data?.waitForCaptcha ?? message.data?.waitForCaptchaResolution,
        waitTimeoutMs: message.data?.waitTimeoutMs ?? message.data?.captchaWaitTimeoutMs,
        pollIntervalMs: message.data?.pollIntervalMs ?? message.data?.captchaPollIntervalMs,
        postClearDelayMs: message.data?.postClearDelayMs ?? message.data?.captchaPostClearDelayMs
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

// ── runtime continuation alarms ─────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (![QUEUE_CONTINUATION_ALARM, DIRECT_PUBLISH_CONTINUATION_ALARM].includes(alarm.name)) return;

  ensureRuntimeStateLoaded()
    .then(async () => {
      if (alarm.name === QUEUE_CONTINUATION_ALARM) {
        if (!queueRuntimeState?.active) {
          await clearQueueContinuationAlarm();
          return;
        }

        await wakeQueueProcessing('alarm');
        return;
      }

      await handleDirectPublishContinuationWakeup('alarm');
    })
    .catch((error) => {
      const label = alarm.name === DIRECT_PUBLISH_CONTINUATION_ALARM
        ? 'direct publish continuation alarm'
        : '큐 continuation alarm';
      console.warn(`[TistoryAuto BG] ${label} 처리 실패:`, error);
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (directPublishState?.tabId !== tabId) return;
  if (!['captcha_required', 'ready_to_resume', 'resuming', 'waiting_browser_handoff'].includes(directPublishState?.status)) return;

  const nextUrl = changeInfo.url || tab?.url || '';
  if (!looksLikeDirectPublishCompletionUrl(nextUrl)) return;

  clearDirectPublishState().then(() => {
    console.log('[TistoryAuto BG] directPublishState 자동 정리:', nextUrl);
  }).catch((error) => {
    console.warn('[TistoryAuto BG] directPublishState 자동 정리 실패:', error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (directPublishState?.tabId === tabId) {
    clearDirectPublishState().catch((error) => {
      console.warn('[TistoryAuto BG] directPublishState 정리 실패:', error);
    });
  }
});

// ── 초기화 ──────────────────────────────────
ensureRuntimeStateLoaded().then(() => {
  console.log('[TistoryAuto BG] Service Worker 시작 ✅, 큐 항목:', publishQueue.length, 'directPublishState:', !!directPublishState);
}).catch((error) => {
  console.warn('[TistoryAuto BG] 초기 상태 로드 실패:', error);
});
