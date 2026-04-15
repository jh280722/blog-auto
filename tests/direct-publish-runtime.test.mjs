import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECT_PUBLISH_CONTINUATION_ALARM,
  buildDirectPublishContinuationPlan,
  decideDirectPublishStartupAction
} from '../utils/direct-publish-runtime.js';

test('buildDirectPublishContinuationPlan schedules MV3-safe rechecks before the final CAPTCHA wait deadline', () => {
  const nowMs = Date.UTC(2026, 3, 15, 12, 0, 0);
  const plan = buildDirectPublishContinuationPlan({
    timeoutMs: 120000,
    pollIntervalMs: 1000,
    nowMs
  });

  assert.equal(plan.alarmName, DIRECT_PUBLISH_CONTINUATION_ALARM);
  assert.equal(plan.pollIntervalMs, 1000);
  assert.equal(plan.deadlineMs, nowMs + 120000);
  assert.equal(plan.remainingMs, 120000);
  assert.equal(plan.alarmDelayMs, 30000);
  assert.equal(plan.scheduledTimeMs, nowMs + 30000);
});

test('buildDirectPublishContinuationPlan respects an explicit remaining deadline that is shorter than the MV3 wake-up window', () => {
  const nowMs = Date.UTC(2026, 3, 15, 12, 0, 0);
  const plan = buildDirectPublishContinuationPlan({
    timeoutMs: 120000,
    pollIntervalMs: 1000,
    nowMs,
    deadlineMs: nowMs + 12000
  });

  assert.equal(plan.deadlineMs, nowMs + 12000);
  assert.equal(plan.remainingMs, 12000);
  assert.equal(plan.alarmDelayMs, 12000);
  assert.equal(plan.scheduledTimeMs, nowMs + 12000);
});

test('decideDirectPublishStartupAction resumes immediately when the persisted CAPTCHA wait checkpoint is overdue', () => {
  const nowMs = Date.UTC(2026, 3, 15, 12, 5, 0);
  const action = decideDirectPublishStartupAction({
    nowMs,
    directPublishState: {
      tabId: 321,
      status: 'waiting_browser_handoff'
    },
    directPublishRuntimeState: {
      active: true,
      tabId: 321,
      deadlineMs: nowMs + 45000,
      nextCheckTimeMs: nowMs - 1000,
      timeoutMs: 120000,
      pollIntervalMs: 1000,
      postClearDelayMs: 1200
    }
  });

  assert.deepEqual(action, {
    action: 'resume_now',
    alarmName: DIRECT_PUBLISH_CONTINUATION_ALARM,
    remainingTimeoutMs: 45000,
    tabId: 321
  });
});

test('decideDirectPublishStartupAction recreates the alarm when the persisted browser-handoff wait is still in the future', () => {
  const nowMs = Date.UTC(2026, 3, 15, 12, 5, 0);
  const action = decideDirectPublishStartupAction({
    nowMs,
    directPublishState: {
      tabId: 321,
      status: 'waiting_browser_handoff'
    },
    directPublishRuntimeState: {
      active: true,
      tabId: 321,
      deadlineMs: nowMs + 70000,
      nextCheckTimeMs: nowMs + 25000,
      timeoutMs: 120000,
      pollIntervalMs: 1000,
      postClearDelayMs: 1200
    }
  });

  assert.deepEqual(action, {
    action: 'recreate_alarm',
    alarmName: DIRECT_PUBLISH_CONTINUATION_ALARM,
    scheduledTimeMs: nowMs + 25000,
    tabId: 321
  });
});

test('decideDirectPublishStartupAction clears stale runtime when no matching waiting direct-publish state remains', () => {
  const nowMs = Date.UTC(2026, 3, 15, 12, 5, 0);
  const action = decideDirectPublishStartupAction({
    nowMs,
    directPublishState: {
      tabId: 999,
      status: 'captcha_required'
    },
    directPublishRuntimeState: {
      active: true,
      tabId: 321,
      deadlineMs: nowMs + 70000,
      nextCheckTimeMs: nowMs + 25000,
      timeoutMs: 120000,
      pollIntervalMs: 1000,
      postClearDelayMs: 1200
    }
  });

  assert.deepEqual(action, {
    action: 'clear_runtime',
    alarmName: DIRECT_PUBLISH_CONTINUATION_ALARM
  });
});

test('decideDirectPublishStartupAction resumes immediately when the timeout deadline already elapsed during worker downtime', () => {
  const nowMs = Date.UTC(2026, 3, 15, 12, 5, 0);
  const action = decideDirectPublishStartupAction({
    nowMs,
    directPublishState: {
      tabId: 321,
      status: 'waiting_browser_handoff'
    },
    directPublishRuntimeState: {
      active: true,
      tabId: 321,
      deadlineMs: nowMs - 1,
      nextCheckTimeMs: nowMs + 25000,
      timeoutMs: 120000,
      pollIntervalMs: 1000,
      postClearDelayMs: 1200
    }
  });

  assert.deepEqual(action, {
    action: 'resume_now',
    alarmName: DIRECT_PUBLISH_CONTINUATION_ALARM,
    remainingTimeoutMs: 0,
    tabId: 321
  });
});
