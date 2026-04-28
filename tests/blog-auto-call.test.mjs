import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBridgeSetupFailureResult,
  buildBridgeTimeoutResult,
  buildSetupDiagnosticFailurePayload,
  buildTimeoutDiagnosticFailurePayload,
  classifyBridgeSetupFailure,
  classifyBridgeTimeoutCause,
  parseCliArgs,
  pickDiagnosticCaptchaTarget,
  summarizeBrowserVersionForDiagnostics,
  summarizeQueueStateForDiagnostics,
  summarizeCaptchaArtifactsForDiagnostics,
  summarizeDebugTargetsForDiagnostics
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

test('classifyBridgeTimeoutCause surfaces direct publish confirmation recovery before generic runtime causes', () => {
  const cause = classifyBridgeTimeoutCause({
    action: 'RESUME_DIRECT_PUBLISH',
    directState: {
      success: true,
      directPublish: {
        tabId: 321,
        phase: 'publish_confirmation',
        status: 'publish_confirm_in_flight',
        publishConfirmationRecovery: {
          status: 'publish_confirm_in_flight',
          recommendedAction: 'poll_same_tab_before_retry'
        }
      },
      directPublishRuntimeState: { active: true }
    },
    queueState: { success: true, queue: [], queueRuntimeState: { active: false } }
  });

  assert.equal(cause, 'direct_publish_confirmation_pending');
});

test('classifyBridgeTimeoutCause reports queue publish confirmation pauses before generic queue runtime causes', () => {
  const cause = classifyBridgeTimeoutCause({
    action: 'RESUME_AFTER_PUBLISH_CONFIRMATION',
    directState: { success: true, directPublish: null, directPublishRuntimeState: { active: false } },
    queueState: {
      success: true,
      queue: [
        { id: 'done', status: 'completed' },
        {
          id: 'confirm-1',
          status: 'publish_confirm_paused',
          publishConfirmTabId: 777,
          confirmationState: { state: 'confirm_in_flight' },
          publishConfirmationRecovery: { recommendedAction: 'poll_same_tab_before_retry' }
        }
      ],
      isProcessing: true,
      queueRuntimeState: { active: true }
    }
  });

  assert.equal(cause, 'queue_publish_confirmation_paused');
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
      {
        id: 'confirm-1',
        status: 'publish_confirm_paused',
        publishStatus: 'publish_confirm_in_flight',
        publishConfirmTabId: 505,
        confirmationState: { state: 'confirm_in_flight', recommendedAction: 'poll_same_tab_before_retry' },
        publishConfirmationRecovery: { status: 'publish_confirm_in_flight', recommendedAction: 'poll_same_tab_before_retry' }
      },
      { id: 'failed-1', status: 'failed', error: 'boom' },
      { id: 'done-1', status: 'completed' }
    ]
  });

  assert.deepEqual(summary.counts, {
    pending: 1,
    processing: 1,
    captcha_paused: 1,
    publish_confirm_paused: 1,
    failed: 1,
    completed: 1
  });
  assert.equal(summary.total, 6);
  assert.equal(summary.captchaPausedItems.length, 1);
  assert.deepEqual(summary.captchaPausedItems[0], {
    id: 'paused-1',
    status: 'captcha_paused',
    captchaTabId: 404,
    captchaStage: 'after_final_confirm',
    preferredSolveMode: 'extension_frame_dom',
    submitField: 'ocrTexts'
  });
  assert.deepEqual(summary.publishConfirmPausedItems[0], {
    id: 'confirm-1',
    status: 'publish_confirm_paused',
    publishStatus: 'publish_confirm_in_flight',
    publishConfirmTabId: 505,
    confirmationState: 'confirm_in_flight',
    recommendedAction: 'poll_same_tab_before_retry'
  });
  assert.equal(summary.recentItems.length, 5);
  assert.equal(summary.recentItems.at(-3).publishConfirmTabId, 505);
  assert.equal(summary.recentItems.at(-3).confirmationState, 'confirm_in_flight');
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

test('summarizeDebugTargetsForDiagnostics highlights the extension API target without dumping every tab', () => {
  const summary = summarizeDebugTargetsForDiagnostics([
    {
      id: 'page-1',
      type: 'page',
      title: 'Example App',
      url: 'https://example.com',
      attached: false,
      webSocketDebuggerUrl: 'ws://example/page-1'
    },
    {
      id: 'page-2',
      type: 'page',
      title: 'Tistory Auto Publisher - API',
      url: 'chrome-extension://ext/api/api-page.html',
      attached: true,
      webSocketDebuggerUrl: 'ws://example/page-2'
    },
    {
      id: 'worker-1',
      type: 'service_worker',
      title: 'Service Worker',
      url: 'chrome-extension://ext/background.js'
    }
  ], 'chrome-extension://ext/api/api-page.html');

  assert.equal(summary.success, true);
  assert.equal(summary.total, 3);
  assert.equal(summary.pageTargetCount, 2);
  assert.equal(summary.otherPageTargetCount, 1);
  assert.deepEqual(summary.apiTarget, {
    present: true,
    id: 'page-2',
    title: 'Tistory Auto Publisher - API',
    url: 'chrome-extension://ext/api/api-page.html',
    attached: true,
    hasWebSocketDebuggerUrl: true
  });
  assert.equal('sampleTargets' in summary, false);
});

test('buildSetupDiagnosticFailurePayload mirrors setup probe failures across browser and target diagnostics', () => {
  const failure = buildSetupDiagnosticFailurePayload(new Error('fetch failed'));

  assert.deepEqual(failure, {
    browserVersion: {
      success: false,
      status: 'bridge_diagnostic_error',
      error: 'fetch failed'
    },
    debugTargets: {
      success: false,
      status: 'bridge_diagnostic_error',
      error: 'fetch failed'
    }
  });
});

test('classifyBridgeSetupFailure maps unreachable DevTools into a stable inferred cause', () => {
  const cause = classifyBridgeSetupFailure({
    stage: 'ensure_api_target',
    error: new Error('fetch failed'),
    browserVersion: { success: false, status: 'bridge_diagnostic_error', error: 'fetch failed' },
    debugTargets: { success: false, status: 'bridge_diagnostic_error', error: 'fetch failed' }
  });

  assert.equal(cause, 'devtools_unreachable');
});

test('classifyBridgeSetupFailure keeps transport-specific causes even when follow-up probes also fail', () => {
  const cause = classifyBridgeSetupFailure({
    stage: 'call_extension_action',
    error: new Error('Chrome DevTools websocket closed before the command resolved'),
    apiTarget: {
      id: 'page-2',
      title: 'Tistory Auto Publisher - API',
      url: 'chrome-extension://ext/api/api-page.html',
      webSocketDebuggerUrl: 'ws://example/page-2'
    },
    browserVersion: { success: false, status: 'bridge_diagnostic_error', error: 'fetch failed' },
    debugTargets: { success: false, status: 'bridge_diagnostic_error', error: 'fetch failed' }
  });

  assert.equal(cause, 'devtools_websocket_closed');
});

test('buildBridgeSetupFailureResult packages setup-stage diagnostics for cron callers', () => {
  const browserVersion = summarizeBrowserVersionForDiagnostics({
    Browser: 'Chrome/145.0.0.0',
    'Protocol-Version': '1.3',
    'User-Agent': 'Chrome/145.0.0.0',
    webSocketDebuggerUrl: 'ws://example/browser'
  });
  const debugTargets = summarizeDebugTargetsForDiagnostics([
    {
      id: 'page-1',
      type: 'page',
      title: 'Other page',
      url: 'https://example.com',
      attached: false,
      webSocketDebuggerUrl: 'ws://example/page-1'
    }
  ], 'chrome-extension://ext/api/api-page.html');

  const result = buildBridgeSetupFailureResult({
    action: 'GET_QUEUE',
    stage: 'ensure_api_target',
    error: new Error('Failed to create or discover API page target for chrome-extension://ext/api/api-page.html'),
    runtimeTimeoutMs: 90000,
    startedAt: '2026-04-24T01:00:00.000Z',
    failedAt: '2026-04-24T01:00:05.000Z',
    chromeDebugBaseUrl: 'http://127.0.0.1:18800',
    apiPageUrl: 'chrome-extension://ext/api/api-page.html',
    apiTarget: null,
    browserVersion,
    debugTargets
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'bridge_setup_error');
  assert.equal(result.bridgeDiagnostics.stage, 'ensure_api_target');
  assert.equal(result.bridgeDiagnostics.inferredCause, 'api_page_target_missing');
  assert.equal(result.bridgeDiagnostics.browserVersion.browser, 'Chrome/145.0.0.0');
  assert.equal(result.bridgeDiagnostics.debugTargets.apiTarget.present, false);
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
