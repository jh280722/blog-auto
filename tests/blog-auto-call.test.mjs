import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBridgeTimeoutResult,
  buildTimeoutDiagnosticFailurePayload,
  classifyBridgeTimeoutCause,
  parseCliArgs,
  pickDiagnosticCaptchaTarget,
  summarizeQueueStateForDiagnostics,
  summarizeCaptchaArtifactsForDiagnostics
} from '../utils/blog-auto-call.js';

test('classifyBridgeTimeoutCause surfaces direct-publish captcha waits before generic bridge failures', () => {
  const cause = classifyBridgeTimeoutCause({
    action: 'WRITE_POST',
    directState: {
      success: true,
      directPublish: {
        tabId: 321,
        captchaContext: {
          captchaPresent: true,
          preferredSolveMode: 'extension_frame_dom'
        }
      },
      directPublishRuntimeState: {
        active: true,
        nextCheckTimeMs: Date.UTC(2026, 3, 23, 11, 0, 0)
      }
    },
    queueState: {
      success: true,
      queue: [],
      queueRuntimeState: { active: false }
    }
  });

  assert.equal(cause, 'direct_publish_captcha_wait_active');
});

test('classifyBridgeTimeoutCause reports paused queue captcha items when queue resume is blocked', () => {
  const cause = classifyBridgeTimeoutCause({
    action: 'SUBMIT_CAPTCHA_AND_RESUME',
    directState: {
      success: true,
      directPublish: null,
      directPublishRuntimeState: { active: false }
    },
    queueState: {
      success: true,
      queue: [
        { id: 'done', status: 'completed' },
        {
          id: 'paused-1',
          status: 'captcha_paused',
          captchaTabId: 555,
          solveHints: { submitField: 'ocrTexts' },
          captchaContext: { preferredSolveMode: 'extension_dom' }
        }
      ],
      queueRuntimeState: { active: true, scheduledTimeMs: Date.UTC(2026, 3, 23, 11, 5, 0) }
    }
  });

  assert.equal(cause, 'queue_captcha_paused');
});

test('summarizeQueueStateForDiagnostics keeps queue diagnostics compact but actionable', () => {
  const summary = summarizeQueueStateForDiagnostics({
    success: true,
    isProcessing: false,
    queueRuntimeState: { active: true, scheduledTimeMs: 12345 },
    queue: [
      { id: 'pending-1', status: 'pending' },
      { id: 'processing-1', status: 'processing' },
      {
        id: 'paused-1',
        status: 'captcha_paused',
        captchaTabId: 404,
        captchaStage: 'after_final_confirm',
        solveHints: { submitField: 'ocrTexts' },
        captchaContext: { preferredSolveMode: 'extension_frame_dom' }
      },
      { id: 'failed-1', status: 'failed', error: 'boom' },
      { id: 'done-1', status: 'completed' }
    ]
  });

  assert.deepEqual(summary.counts, {
    pending: 1,
    processing: 1,
    captcha_paused: 1,
    failed: 1,
    completed: 1
  });
  assert.equal(summary.total, 5);
  assert.equal(summary.captchaPausedItems.length, 1);
  assert.deepEqual(summary.captchaPausedItems[0], {
    id: 'paused-1',
    status: 'captcha_paused',
    captchaTabId: 404,
    captchaStage: 'after_final_confirm',
    preferredSolveMode: 'extension_frame_dom',
    submitField: 'ocrTexts'
  });
  assert.equal(summary.recentItems.length, 5);
});

test('summarizeCaptchaArtifactsForDiagnostics strips bulky image payloads but keeps artifact metadata', () => {
  const summary = summarizeCaptchaArtifactsForDiagnostics({
    success: true,
    tabId: 321,
    artifactPreference: 'sourceImage',
    artifact: {
      dataUrl: 'data:image/png;base64,AAAA',
      kind: 'source_image',
      width: 320,
      height: 120,
      mimeType: 'image/png'
    },
    artifacts: {
      sourceImage: {
        dataUrl: 'data:image/png;base64,BBBB',
        kind: 'source_image',
        width: 320,
        height: 120
      },
      viewportCrop: {
        dataUrl: 'data:image/png;base64,CCCC',
        kind: 'viewport_crop',
        width: 640,
        height: 360
      }
    }
  });

  assert.equal(summary.artifact.dataUrl, undefined);
  assert.equal(summary.artifact.kind, 'source_image');
  assert.equal(summary.artifacts.sourceImage.dataUrl, undefined);
  assert.equal(summary.artifacts.viewportCrop.dataUrl, undefined);
  assert.equal(summary.artifacts.viewportCrop.width, 640);
});

test('buildBridgeTimeoutResult packages structured diagnostics for cron callers', () => {
  const timedOutAt = '2026-04-23T11:11:11.000Z';
  const result = buildBridgeTimeoutResult({
    action: 'WRITE_POST',
    runtimeTimeoutMs: 90000,
    timedOutAt,
    startedAt: '2026-04-23T11:09:41.000Z',
    apiTarget: {
      id: 'target-1',
      title: 'Tistory Auto Publisher - API',
      url: 'chrome-extension://example/api/api-page.html'
    },
    directState: {
      success: true,
      directPublish: {
        tabId: 321,
        blogName: 'nakseo-dev',
        captchaContext: {
          captchaPresent: true,
          preferredSolveMode: 'extension_frame_dom'
        }
      },
      directPublishRuntimeState: {
        active: true,
        nextCheckTimeMs: 1234567890
      }
    },
    queueState: {
      success: true,
      isProcessing: false,
      queueRuntimeState: { active: false },
      queue: []
    },
    captchaContext: {
      success: true,
      tabId: 321,
      preferredSolveMode: 'extension_frame_dom'
    },
    captchaArtifacts: {
      success: true,
      artifactPreference: 'sourceImage',
      artifact: {
        dataUrl: 'data:image/png;base64,AAAA',
        kind: 'source_image'
      }
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'bridge_timeout');
  assert.match(result.error, /WRITE_POST/);
  assert.equal(result.bridgeDiagnostics.inferredCause, 'direct_publish_captcha_wait_active');
  assert.equal(result.bridgeDiagnostics.apiTarget.id, 'target-1');
  assert.equal(result.bridgeDiagnostics.timedOutAt, timedOutAt);
  assert.equal(result.bridgeDiagnostics.captchaArtifacts.artifact.dataUrl, undefined);
});

test('buildTimeoutDiagnosticFailurePayload preserves the original timeout report when follow-up diagnostics fail', () => {
  const failure = buildTimeoutDiagnosticFailurePayload(new Error('DevTools websocket closed'));

  assert.deepEqual(failure, {
    directState: {
      success: false,
      status: 'bridge_diagnostic_error',
      error: 'DevTools websocket closed'
    },
    queueState: {
      success: false,
      status: 'bridge_diagnostic_error',
      error: 'DevTools websocket closed'
    },
    captchaContext: {
      success: false,
      status: 'bridge_diagnostic_error',
      error: 'DevTools websocket closed'
    },
    captchaArtifacts: {
      success: false,
      status: 'bridge_diagnostic_error',
      error: 'DevTools websocket closed'
    }
  });
});

test('parseCliArgs rejects value-taking flags when the next token is another flag', () => {
  assert.throws(
    () => parseCliArgs(['--action', '--stdin'], { env: {} }),
    /requires a value/
  );
  assert.throws(
    () => parseCliArgs(['--action', 'GET_QUEUE', '--timeout-ms', '--stdin'], { env: {} }),
    /requires a value/
  );
  assert.throws(
    () => parseCliArgs(['--action', 'GET_QUEUE', '--data-file', '--stdin'], { env: {} }),
    /requires a value/
  );
});

test('parseCliArgs accepts stdin payload mode without mis-parsing neighboring flags', () => {
  const parsed = parseCliArgs(['--action', 'GET_QUEUE', '--stdin', '--timeout-ms', '1500'], { env: {} });

  assert.equal(parsed.action, 'GET_QUEUE');
  assert.equal(parsed.dataStdin, true);
  assert.equal(parsed.runtimeTimeoutMs, 1500);
});

test('pickDiagnosticCaptchaTarget prefers the active direct-publish tab over unrelated paused queue items', () => {
  const target = pickDiagnosticCaptchaTarget({
    action: 'WRITE_POST',
    originalData: {},
    directState: {
      directPublish: {
        tabId: 321
      }
    },
    queueState: {
      queue: [
        {
          id: 'paused-1',
          status: 'captcha_paused',
          captchaTabId: 999
        }
      ]
    }
  });

  assert.deepEqual(target, { tabId: 321 });
});

test('pickDiagnosticCaptchaTarget falls back to the only paused queue item when no direct-publish tab exists', () => {
  const target = pickDiagnosticCaptchaTarget({
    action: 'WRITE_POST',
    originalData: {},
    directState: {
      directPublish: null
    },
    queueState: {
      queue: [
        {
          id: 'paused-1',
          status: 'captcha_paused',
          captchaTabId: 999
        }
      ]
    }
  });

  assert.deepEqual(target, { id: 'paused-1' });
});
