export const QUEUE_CONTINUATION_ALARM = 'publish-queue-continuation';
export const MV3_MIN_ALARM_DELAY_MS = 30_000;

function normalizeDelayMs(intervalMs) {
  const numeric = Number(intervalMs);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 5_000;
  }
  return Math.max(0, Math.round(numeric));
}

function clearRecoveredQueueCaptchaState() {
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

export function normalizeLoadedQueueState(queue = [], { recoveredAt = new Date().toISOString() } = {}) {
  const source = Array.isArray(queue) ? queue : [];
  let recoveredCount = 0;

  const normalizedQueue = source.map((item) => {
    if (!item || typeof item !== 'object') {
      return item;
    }
    if (item.status !== 'processing') {
      return { ...item };
    }

    recoveredCount += 1;
    return {
      ...item,
      ...clearRecoveredQueueCaptchaState(),
      status: 'failed',
      publishStatus: 'worker_restarted_during_publish',
      error: 'Manifest V3 service worker restarted while this queue item was publishing. Verify whether Tistory already saved it before retrying.',
      recovery: {
        recoveredAt,
        reason: 'service_worker_restarted_during_publish',
        previousStatus: item.status || null,
        previousPublishStatus: item.publishStatus || null,
        previousError: item.error || null
      }
    };
  });

  return {
    queue: normalizedQueue,
    recoveredCount
  };
}

export function buildQueueContinuationPlan({ intervalMs, nowMs = Date.now() } = {}) {
  const requestedDelayMs = normalizeDelayMs(intervalMs);
  const inMemoryDelayMs = requestedDelayMs;
  const alarmDelayMs = Math.max(requestedDelayMs, MV3_MIN_ALARM_DELAY_MS);

  return {
    alarmName: QUEUE_CONTINUATION_ALARM,
    requestedDelayMs,
    inMemoryDelayMs,
    alarmDelayMs,
    scheduledTimeMs: nowMs + alarmDelayMs
  };
}

export function decideQueueStartupAction({ queue = [], queueRuntimeState = null, nowMs = Date.now() } = {}) {
  const hasPendingItems = Array.isArray(queue) && queue.some((item) => item?.status === 'pending');
  if (!hasPendingItems || !queueRuntimeState?.active) {
    return { action: 'none' };
  }

  const scheduledTimeMs = Number(queueRuntimeState.scheduledTimeMs) || null;
  if (!scheduledTimeMs || scheduledTimeMs <= nowMs) {
    return {
      action: 'resume_now',
      alarmName: QUEUE_CONTINUATION_ALARM,
      scheduledTimeMs
    };
  }

  return {
    action: 'recreate_alarm',
    alarmName: QUEUE_CONTINUATION_ALARM,
    scheduledTimeMs,
    alarmDelayMs: scheduledTimeMs - nowMs
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
