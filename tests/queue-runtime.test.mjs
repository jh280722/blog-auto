import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MV3_MIN_ALARM_DELAY_MS,
  QUEUE_CONTINUATION_ALARM,
  buildQueueContinuationPlan,
  decideQueueStartupAction,
  normalizeLoadedQueueState
} from '../utils/queue-runtime.js';

test('normalizeLoadedQueueState fail-closes in-flight items after a service worker restart', () => {
  const recoveredAt = '2026-04-15T01:30:00.000Z';
  const { queue, recoveredCount } = normalizeLoadedQueueState([
    { id: 'done', status: 'completed' },
    { id: 'stuck', status: 'processing', error: null },
    { id: 'paused', status: 'captcha_paused', error: 'captcha' }
  ], { recoveredAt });

  assert.equal(recoveredCount, 1);
  assert.equal(queue[0].status, 'completed');
  assert.equal(queue[1].status, 'failed');
  assert.equal(queue[1].publishStatus, 'worker_restarted_during_publish');
  assert.match(queue[1].error, /verify whether tistory already saved it/i);
  assert.deepEqual(queue[1].recovery, {
    recoveredAt,
    reason: 'service_worker_restarted_during_publish',
    previousStatus: 'processing',
    previousPublishStatus: null,
    previousError: null
  });
  assert.equal(queue[2].status, 'captcha_paused');
});

test('normalizeLoadedQueueState overwrites stale captcha failure markers when a resumed item crashes mid-publish', () => {
  const recoveredAt = '2026-04-15T01:45:00.000Z';
  const { queue } = normalizeLoadedQueueState([
    {
      id: 'resumed',
      status: 'processing',
      publishStatus: 'captcha_required',
      error: 'CAPTCHA 재발생 — 다시 해결 후 Resume 클릭'
    }
  ], { recoveredAt });

  assert.equal(queue[0].status, 'failed');
  assert.equal(queue[0].publishStatus, 'worker_restarted_during_publish');
  assert.match(queue[0].error, /verify whether tistory already saved it/i);
  assert.deepEqual(queue[0].recovery, {
    recoveredAt,
    reason: 'service_worker_restarted_during_publish',
    previousStatus: 'processing',
    previousPublishStatus: 'captcha_required',
    previousError: 'CAPTCHA 재발생 — 다시 해결 후 Resume 클릭'
  });
});

test('normalizeLoadedQueueState scrubs transient queue CAPTCHA metadata when a resumed publish crashes mid-flight', () => {
  const { queue } = normalizeLoadedQueueState([
    {
      id: 'resumed-with-captcha-state',
      status: 'processing',
      captchaTabId: 404,
      captchaStage: 'after_final_confirm',
      captchaContext: { preferredSolveMode: 'extension_frame_dom' },
      solveHints: { submitField: 'ocrTexts' },
      lastCaptchaArtifactCapture: { artifactPreference: 'sourceImage' },
      lastCaptchaSubmitResult: { status: 'captcha_still_present' },
      lastCheckedAt: '2026-04-20T01:05:06.000Z'
    }
  ]);

  assert.equal(queue[0].status, 'failed');
  assert.equal(queue[0].captchaTabId, null);
  assert.equal(queue[0].captchaStage, null);
  assert.equal(queue[0].captchaContext, null);
  assert.equal(queue[0].solveHints, null);
  assert.equal(queue[0].lastCaptchaArtifactCapture, null);
  assert.equal(queue[0].lastCaptchaSubmitResult, null);
  assert.equal(queue[0].lastCheckedAt, null);
});

test('buildQueueContinuationPlan keeps short in-memory pacing but clamps the wake-up alarm for MV3', () => {
  const nowMs = Date.UTC(2026, 3, 15, 1, 30, 0);
  const plan = buildQueueContinuationPlan({ intervalMs: 5000, nowMs });

  assert.equal(plan.alarmName, QUEUE_CONTINUATION_ALARM);
  assert.equal(plan.requestedDelayMs, 5000);
  assert.equal(plan.inMemoryDelayMs, 5000);
  assert.equal(plan.alarmDelayMs, MV3_MIN_ALARM_DELAY_MS);
  assert.equal(plan.scheduledTimeMs, nowMs + MV3_MIN_ALARM_DELAY_MS);
});

test('buildQueueContinuationPlan preserves longer publish intervals without extra clamping', () => {
  const nowMs = Date.UTC(2026, 3, 15, 1, 30, 0);
  const plan = buildQueueContinuationPlan({ intervalMs: 45000, nowMs });

  assert.equal(plan.requestedDelayMs, 45000);
  assert.equal(plan.inMemoryDelayMs, 45000);
  assert.equal(plan.alarmDelayMs, 45000);
  assert.equal(plan.scheduledTimeMs, nowMs + 45000);
});

test('decideQueueStartupAction resumes immediately when a persisted queue schedule is already overdue', () => {
  const nowMs = Date.UTC(2026, 3, 15, 2, 0, 0);
  const action = decideQueueStartupAction({
    nowMs,
    queue: [{ id: 'next', status: 'pending' }],
    queueRuntimeState: {
      active: true,
      scheduledTimeMs: nowMs - 1000
    }
  });

  assert.deepEqual(action, {
    action: 'resume_now',
    alarmName: QUEUE_CONTINUATION_ALARM,
    scheduledTimeMs: nowMs - 1000
  });
});

test('decideQueueStartupAction recreates the alarm when a future queue schedule survives only in storage', () => {
  const nowMs = Date.UTC(2026, 3, 15, 2, 0, 0);
  const action = decideQueueStartupAction({
    nowMs,
    queue: [{ id: 'next', status: 'pending' }],
    queueRuntimeState: {
      active: true,
      scheduledTimeMs: nowMs + 42000,
      requestedDelayMs: 12000
    }
  });

  assert.equal(action.action, 'recreate_alarm');
  assert.equal(action.alarmName, QUEUE_CONTINUATION_ALARM);
  assert.equal(action.scheduledTimeMs, nowMs + 42000);
  assert.equal(action.alarmDelayMs, 42000);
});

test('decideQueueStartupAction stays idle when no pending work remains after crash recovery', () => {
  const action = decideQueueStartupAction({
    nowMs: Date.UTC(2026, 3, 15, 2, 0, 0),
    queue: [{ id: 'recovered', status: 'failed', publishStatus: 'worker_restarted_during_publish' }],
    queueRuntimeState: {
      active: true,
      scheduledTimeMs: Date.UTC(2026, 3, 15, 2, 0, 30)
    }
  });

  assert.deepEqual(action, { action: 'none' });
});

test('decideQueueStartupAction stays idle when the queue was never explicitly started', () => {
  const action = decideQueueStartupAction({
    nowMs: Date.UTC(2026, 3, 15, 2, 0, 0),
    queue: [{ id: 'draft', status: 'pending' }],
    queueRuntimeState: {
      active: false,
      scheduledTimeMs: null
    }
  });

  assert.deepEqual(action, { action: 'none' });
});
