import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECT_PUBLISH_CONTINUATION_ALARM,
  buildDirectPublishContinuationPlan,
  decideDirectPublishStartupAction,
  runTrackedWakeTask
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

test('runTrackedWakeTask keeps the wake in-flight until the async resume task settles', async () => {
  let inFlight = false;
  let resolveTask;
  let taskCalls = 0;
  const taskPromise = new Promise((resolve) => {
    resolveTask = resolve;
  });

  const wakePromise = runTrackedWakeTask({
    isInFlight: () => inFlight,
    setInFlight: (next) => {
      inFlight = next;
    },
    task: async () => {
      taskCalls += 1;
      return taskPromise;
    }
  });

  let settled = false;
  wakePromise.then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(taskCalls, 1);
  assert.equal(inFlight, true);
  assert.equal(settled, false);

  resolveTask('resumed');
  const outcome = await wakePromise;

  assert.deepEqual(outcome, {
    started: true,
    result: 'resumed'
  });
  assert.equal(inFlight, false);
});

test('runTrackedWakeTask skips duplicate wakeups while another resume is already running', async () => {
  let taskCalls = 0;

  const outcome = await runTrackedWakeTask({
    isInFlight: () => true,
    setInFlight: () => {
      throw new Error('setInFlight should not run for duplicate wakeups');
    },
    task: async () => {
      taskCalls += 1;
      return 'unexpected';
    }
  });

  assert.deepEqual(outcome, {
    started: false,
    skipped: true
  });
  assert.equal(taskCalls, 0);
});

test('runTrackedWakeTask clears the in-flight flag after a resume failure', async () => {
  let inFlight = false;
  const error = new Error('resume failed');

  await assert.rejects(
    runTrackedWakeTask({
      isInFlight: () => inFlight,
      setInFlight: (next) => {
        inFlight = next;
      },
      task: async () => {
        throw error;
      }
    }),
    error
  );

  assert.equal(inFlight, false);
});
