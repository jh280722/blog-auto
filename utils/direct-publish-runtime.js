import { MV3_MIN_ALARM_DELAY_MS } from './queue-runtime.js';

export const DIRECT_PUBLISH_CONTINUATION_ALARM = 'direct-publish-continuation';
const WAITING_DIRECT_PUBLISH_STATUSES = new Set(['waiting_browser_handoff']);

function normalizeTabId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeDelayMs(value, fallbackMs) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackMs;
  }
  return Math.max(0, Math.round(numeric));
}

export function buildDirectPublishContinuationPlan({
  timeoutMs,
  pollIntervalMs,
  nowMs = Date.now(),
  deadlineMs = null
} = {}) {
  const normalizedTimeoutMs = Math.max(1000, normalizeDelayMs(timeoutMs, 120_000));
  const normalizedPollIntervalMs = Math.max(250, normalizeDelayMs(pollIntervalMs, 1_000));
  const resolvedDeadlineMs = deadlineMs !== null && deadlineMs !== undefined && Number.isFinite(Number(deadlineMs))
    ? Math.round(Number(deadlineMs))
    : (nowMs + normalizedTimeoutMs);
  const remainingMs = Math.max(0, resolvedDeadlineMs - nowMs);
  const maxAlarmStepMs = Math.max(MV3_MIN_ALARM_DELAY_MS, normalizedPollIntervalMs);
  const alarmDelayMs = remainingMs > 0
    ? Math.min(remainingMs, maxAlarmStepMs)
    : 0;

  return {
    alarmName: DIRECT_PUBLISH_CONTINUATION_ALARM,
    timeoutMs: normalizedTimeoutMs,
    pollIntervalMs: normalizedPollIntervalMs,
    deadlineMs: resolvedDeadlineMs,
    remainingMs,
    alarmDelayMs,
    scheduledTimeMs: nowMs + alarmDelayMs,
    nextCheckTimeMs: nowMs + alarmDelayMs
  };
}

export function decideDirectPublishStartupAction({
  directPublishState = null,
  directPublishRuntimeState = null,
  nowMs = Date.now()
} = {}) {
  if (!directPublishRuntimeState?.active) {
    return { action: 'none' };
  }

  const runtimeTabId = normalizeTabId(directPublishRuntimeState.tabId);
  const stateTabId = normalizeTabId(directPublishState?.tabId);
  const stateStatus = directPublishState?.status || null;
  if (!directPublishState || !WAITING_DIRECT_PUBLISH_STATUSES.has(stateStatus) || runtimeTabId === null || stateTabId !== runtimeTabId) {
    return {
      action: 'clear_runtime',
      alarmName: DIRECT_PUBLISH_CONTINUATION_ALARM
    };
  }

  const deadlineMs = Number(directPublishRuntimeState.deadlineMs) || null;
  const nextCheckTimeMs = Number(directPublishRuntimeState.nextCheckTimeMs) || null;
  const remainingTimeoutMs = deadlineMs === null ? null : Math.max(0, deadlineMs - nowMs);

  if (deadlineMs !== null && deadlineMs <= nowMs) {
    return {
      action: 'resume_now',
      alarmName: DIRECT_PUBLISH_CONTINUATION_ALARM,
      remainingTimeoutMs,
      tabId: runtimeTabId
    };
  }

  if (!nextCheckTimeMs || nextCheckTimeMs <= nowMs) {
    return {
      action: 'resume_now',
      alarmName: DIRECT_PUBLISH_CONTINUATION_ALARM,
      remainingTimeoutMs,
      tabId: runtimeTabId
    };
  }

  return {
    action: 'recreate_alarm',
    alarmName: DIRECT_PUBLISH_CONTINUATION_ALARM,
    scheduledTimeMs: nextCheckTimeMs,
    tabId: runtimeTabId
  };
}

export async function runTrackedWakeTask({
  isInFlight = () => false,
  setInFlight = () => {},
  task
} = {}) {
  if (typeof task !== 'function') {
    throw new TypeError('runTrackedWakeTask requires a task function');
  }

  if (isInFlight()) {
    return {
      started: false,
      skipped: true
    };
  }

  setInFlight(true);
  try {
    return {
      started: true,
      result: await task()
    };
  } finally {
    setInFlight(false);
  }
}
