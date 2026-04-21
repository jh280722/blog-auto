import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQueueCaptchaPauseState,
  buildQueueCaptchaSavedStateForAnswerResolution,
  clearQueueCaptchaPauseState,
  decideQueueCaptchaResumeProbeAction,
  findQueueCaptchaItem,
  getQueueCaptchaSelectionFailure,
  summarizeQueueCaptchaSelection
} from '../utils/queue-captcha.js';

function buildQueue() {
  return [
    { id: 'pending', status: 'pending' },
    { id: 'paused-a', status: 'captcha_paused', captchaTabId: 101 },
    { id: 'paused-b', status: 'captcha_paused', captchaTabId: 202 },
    { id: 'done', status: 'completed', captchaTabId: 303 }
  ];
}

test('findQueueCaptchaItem prefers an explicit paused queue item id', () => {
  const item = findQueueCaptchaItem(buildQueue(), { itemId: 'paused-b' });
  assert.equal(item?.id, 'paused-b');
  assert.equal(item?.captchaTabId, 202);
});

test('findQueueCaptchaItem resolves a unique paused queue item by captcha tab id', () => {
  const item = findQueueCaptchaItem(buildQueue(), { tabId: 101 });
  assert.equal(item?.id, 'paused-a');
});

test('findQueueCaptchaItem auto-selects the only paused queue item when id and tabId are omitted', () => {
  const item = findQueueCaptchaItem([
    { id: 'pending', status: 'pending' },
    { id: 'paused-only', status: 'captcha_paused', captchaTabId: 777 }
  ]);

  assert.equal(item?.id, 'paused-only');
});

test('findQueueCaptchaItem stays fail-closed when multiple paused items exist and no selector is provided', () => {
  const item = findQueueCaptchaItem(buildQueue());
  assert.equal(item, null);
});

test('findQueueCaptchaItem stays fail-closed when a tab id matches multiple paused items', () => {
  const item = findQueueCaptchaItem([
    { id: 'paused-a', status: 'captcha_paused', captchaTabId: 555 },
    { id: 'paused-b', status: 'captcha_paused', captchaTabId: '555' }
  ], { tabId: 555 });

  assert.equal(item, null);
});

test('findQueueCaptchaItem does not auto-select when an explicit tab id is invalid', () => {
  const item = findQueueCaptchaItem([
    { id: 'paused-only', status: 'captcha_paused', captchaTabId: 777 }
  ], { tabId: 'abc' });

  assert.equal(item, null);
});

test('summarizeQueueCaptchaSelection reports paused queue metadata for diagnostics', () => {
  const summary = summarizeQueueCaptchaSelection(buildQueue(), { tabId: '202' });

  assert.deepEqual(summary, {
    pausedCount: 2,
    requestedItemId: null,
    requestedTabId: 202,
    pausedItemIds: ['paused-a', 'paused-b'],
    pausedTabIds: [101, 202]
  });
});

test('getQueueCaptchaSelectionFailure fail-closes an explicit queue item id miss', () => {
  const failure = getQueueCaptchaSelectionFailure({
    queue: buildQueue(),
    itemId: 'missing',
    matchedItem: null,
    directPublishTabId: null
  });

  assert.deepEqual(failure, {
    status: 'item_not_found',
    error: '지정한 captcha_paused 큐 항목을 찾지 못했습니다.',
    queueSelection: {
      pausedCount: 2,
      requestedItemId: 'missing',
      requestedTabId: null,
      pausedItemIds: ['paused-a', 'paused-b'],
      pausedTabIds: [101, 202]
    }
  });
});

test('getQueueCaptchaSelectionFailure fail-closes mismatched explicit id and tab id selectors', () => {
  const matchedItem = findQueueCaptchaItem(buildQueue(), { itemId: 'paused-a', tabId: 202 });
  const failure = getQueueCaptchaSelectionFailure({
    queue: buildQueue(),
    itemId: 'paused-a',
    tabId: 202,
    matchedItem,
    directPublishTabId: null
  });

  assert.deepEqual(failure, {
    status: 'queue_captcha_target_required',
    error: '지정한 id와 captchaTabId가 같은 captcha_paused 큐 항목을 가리키지 않습니다.',
    queueSelection: {
      pausedCount: 2,
      requestedItemId: 'paused-a',
      requestedTabId: 202,
      pausedItemIds: ['paused-a', 'paused-b'],
      pausedTabIds: [101, 202]
    }
  });
});

test('getQueueCaptchaSelectionFailure fail-closes an explicit queue tab id miss when no direct publish target matches', () => {
  const failure = getQueueCaptchaSelectionFailure({
    queue: buildQueue(),
    tabId: 999,
    matchedItem: null,
    directPublishTabId: null
  });

  assert.deepEqual(failure, {
    status: 'item_not_found',
    error: '지정한 captchaTabId와 일치하는 captcha_paused 큐 항목을 찾지 못했습니다.',
    queueSelection: {
      pausedCount: 2,
      requestedItemId: null,
      requestedTabId: 999,
      pausedItemIds: ['paused-a', 'paused-b'],
      pausedTabIds: [101, 202]
    }
  });
});

test('getQueueCaptchaSelectionFailure fail-closes an explicit but invalid queue tab id', () => {
  const failure = getQueueCaptchaSelectionFailure({
    queue: [{ id: 'paused-only', status: 'captcha_paused', captchaTabId: 777 }],
    tabId: 'abc',
    matchedItem: null,
    directPublishTabId: null
  });

  assert.deepEqual(failure, {
    status: 'item_not_found',
    error: '유효한 captchaTabId를 지정하세요.',
    queueSelection: {
      pausedCount: 1,
      requestedItemId: null,
      requestedTabId: null,
      pausedItemIds: ['paused-only'],
      pausedTabIds: [777]
    }
  });
});

test('getQueueCaptchaSelectionFailure allows an explicit tab id when it matches the direct publish target', () => {
  const failure = getQueueCaptchaSelectionFailure({
    queue: buildQueue(),
    tabId: 999,
    matchedItem: null,
    directPublishTabId: 999
  });

  assert.equal(failure, null);
});

test('getQueueCaptchaSelectionFailure requires a selector when multiple paused queue items exist and no direct publish target is active', () => {
  const failure = getQueueCaptchaSelectionFailure({
    queue: buildQueue(),
    matchedItem: null,
    directPublishTabId: null
  });

  assert.deepEqual(failure, {
    status: 'queue_captcha_target_required',
    error: 'captcha_paused 큐 항목이 여러 개입니다. id 또는 tabId를 지정하세요.',
    queueSelection: {
      pausedCount: 2,
      requestedItemId: null,
      requestedTabId: null,
      pausedItemIds: ['paused-a', 'paused-b'],
      pausedTabIds: [101, 202]
    }
  });
});

test('decideQueueCaptchaResumeProbeAction waits for post-submit settle when the publish layer stays open after final confirm', () => {
  const action = decideQueueCaptchaResumeProbeAction({
    probeResult: {
      success: false,
      reason: 'publish_layer_open',
      error: '발행 레이어가 열린 상태라 새 쓰기를 시작할 수 없습니다.'
    },
    captchaStage: 'after_final_confirm'
  });

  assert.deepEqual(action, {
    action: 'wait_for_post_captcha_settle',
    status: 'resume_post_captcha_settle',
    reason: 'publish_layer_open',
    error: '발행 레이어가 열린 상태라 새 쓰기를 시작할 수 없습니다.'
  });
});

test('decideQueueCaptchaResumeProbeAction allows same-tab resume when the publish layer stays open before final confirm', () => {
  const action = decideQueueCaptchaResumeProbeAction({
    probeResult: {
      success: false,
      reason: 'publish_layer_open',
      error: '발행 레이어가 열린 상태라 새 쓰기를 시작할 수 없습니다.'
    },
    captchaStage: 'after_open_publish_layer'
  });

  assert.deepEqual(action, {
    action: 'resume_publish_layer_open',
    status: 'resume_publish_layer_open',
    reason: 'publish_layer_open',
    error: '발행 레이어가 열린 상태라 새 쓰기를 시작할 수 없습니다.'
  });
});

test('decideQueueCaptchaResumeProbeAction stays conservative when publish layer state has no trusted captcha stage', () => {
  const action = decideQueueCaptchaResumeProbeAction({
    probeResult: {
      success: false,
      reason: 'publish_layer_open',
      error: '발행 레이어가 열린 상태라 새 쓰기를 시작할 수 없습니다.'
    },
    captchaStage: null
  });

  assert.deepEqual(action, {
    action: 'wait_for_post_captcha_settle',
    status: 'resume_post_captcha_settle',
    reason: 'publish_layer_open',
    error: '발행 레이어가 열린 상태라 새 쓰기를 시작할 수 없습니다.'
  });
});

test('decideQueueCaptchaResumeProbeAction keeps explicit captcha blockers as captcha_required', () => {
  const action = decideQueueCaptchaResumeProbeAction({
    probeResult: {
      success: false,
      reason: 'captcha_present',
      error: '현재 탭에 CAPTCHA가 떠 있어 새 쓰기를 시작할 수 없습니다.'
    },
    captchaStage: 'after_final_confirm'
  });

  assert.deepEqual(action, {
    action: 'captcha_required',
    status: 'captcha_required',
    reason: 'captcha_present',
    error: '현재 탭에 CAPTCHA가 떠 있어 새 쓰기를 시작할 수 없습니다.'
  });
});

test('decideQueueCaptchaResumeProbeAction fail-closes non-resumable editor readiness misses', () => {
  const action = decideQueueCaptchaResumeProbeAction({
    probeResult: {
      success: false,
      reason: 'editor_body_missing',
      error: '에디터 본문 영역을 아직 찾지 못했습니다.'
    },
    captchaStage: 'after_open_publish_layer'
  });

  assert.deepEqual(action, {
    action: 'editor_not_ready',
    status: 'editor_not_ready',
    reason: 'editor_body_missing',
    error: '에디터 본문 영역을 아직 찾지 못했습니다.'
  });
});

test('buildQueueCaptchaPauseState stores fresh handoff metadata for captcha_paused queue items', () => {
  const pausedState = buildQueueCaptchaPauseState({
    tabId: 202,
    response: {
      captchaStage: 'after_final_confirm',
      diagnostics: { attempts: [{ step: 'probe_resume_tab' }] },
      solveHints: {
        prompt: '오래된 힌트',
        submitField: 'answer'
      }
    },
    handoff: {
      captchaContext: {
        preferredSolveMode: 'extension_frame_dom',
        challengeText: '백촌오피스□',
        solveHints: {
          prompt: '이미지에서 전체 후보 텍스트를 읽으세요.',
          submitField: 'ocrTexts'
        }
      },
      captchaArtifacts: {
        success: true,
        status: 'captcha_artifacts_ready',
        artifactPreference: 'sourceImage',
        artifact: { kind: 'sourceImage' },
        captureErrors: [{ status: 'tainted_canvas' }]
      }
    },
    error: 'CAPTCHA 감지 — 같은 탭에서 solve 후 재개',
    nowIso: '2026-04-20T01:02:03.000Z'
  });

  assert.deepEqual(pausedState, {
    status: 'captcha_paused',
    error: 'CAPTCHA 감지 — 같은 탭에서 solve 후 재개',
    publishStatus: 'captcha_required',
    captchaTabId: 202,
    captchaStage: 'after_final_confirm',
    diagnostics: { attempts: [{ step: 'probe_resume_tab' }] },
    captchaContext: {
      preferredSolveMode: 'extension_frame_dom',
      challengeText: '백촌오피스□',
      solveHints: {
        prompt: '이미지에서 전체 후보 텍스트를 읽으세요.',
        submitField: 'ocrTexts'
      }
    },
    solveHints: {
      prompt: '이미지에서 전체 후보 텍스트를 읽으세요.',
      submitField: 'ocrTexts'
    },
    lastCaptchaArtifactCapture: {
      success: true,
      status: 'captcha_artifacts_ready',
      artifactKind: 'sourceImage',
      artifactPreference: 'sourceImage',
      captureErrorCount: 1,
      capturedAt: '2026-04-20T01:02:03.000Z'
    },
    lastCaptchaSubmitResult: null,
    lastCheckedAt: '2026-04-20T01:02:03.000Z'
  });
});

test('buildQueueCaptchaPauseState refreshes submit summary while preserving prior queue captcha context', () => {
  const pausedState = buildQueueCaptchaPauseState({
    existingItem: {
      captchaTabId: 101,
      captchaStage: 'after_open_publish_layer',
      diagnostics: { attempts: [{ step: 'existing_probe' }] },
      captchaContext: {
        preferredSolveMode: 'extension_dom',
        challengeText: '새열린약□',
        solveHints: {
          prompt: 'DOM에서 전체 후보 텍스트를 읽으세요.',
          submitField: 'ocrTexts'
        }
      },
      solveHints: {
        prompt: 'DOM에서 전체 후보 텍스트를 읽으세요.',
        submitField: 'ocrTexts'
      },
      lastCaptchaArtifactCapture: {
        success: true,
        status: 'captcha_artifacts_ready',
        artifactKind: 'viewportCrop',
        artifactPreference: 'viewportCrop',
        captureErrorCount: 0,
        capturedAt: '2026-04-20T00:59:00.000Z'
      }
    },
    tabId: 303,
    submitResult: {
      success: true,
      status: 'captcha_still_present',
      captchaStillAppears: true,
      answerLength: 5,
      answerNormalization: '새열린약국'
    },
    error: 'CAPTCHA가 아직 표시되어 있습니다. 같은 탭에서 다시 해결 후 재개하세요.',
    nowIso: '2026-04-20T01:05:06.000Z'
  });

  assert.deepEqual(pausedState, {
    status: 'captcha_paused',
    error: 'CAPTCHA가 아직 표시되어 있습니다. 같은 탭에서 다시 해결 후 재개하세요.',
    publishStatus: 'captcha_required',
    captchaTabId: 303,
    captchaStage: 'after_open_publish_layer',
    diagnostics: { attempts: [{ step: 'existing_probe' }] },
    captchaContext: {
      preferredSolveMode: 'extension_dom',
      challengeText: '새열린약□',
      solveHints: {
        prompt: 'DOM에서 전체 후보 텍스트를 읽으세요.',
        submitField: 'ocrTexts'
      }
    },
    solveHints: {
      prompt: 'DOM에서 전체 후보 텍스트를 읽으세요.',
      submitField: 'ocrTexts'
    },
    lastCaptchaArtifactCapture: {
      success: true,
      status: 'captcha_artifacts_ready',
      artifactKind: 'viewportCrop',
      artifactPreference: 'viewportCrop',
      captureErrorCount: 0,
      capturedAt: '2026-04-20T00:59:00.000Z'
    },
    lastCaptchaSubmitResult: {
      success: true,
      status: 'captcha_still_present',
      captchaStillAppears: true,
      answerLength: 5,
      normalization: '새열린약국',
      updatedAt: '2026-04-20T01:05:06.000Z'
    },
    lastCheckedAt: '2026-04-20T01:05:06.000Z'
  });
});

test('buildQueueCaptchaSavedStateForAnswerResolution prefers persisted queue captcha context for OCR inference', () => {
  const savedState = buildQueueCaptchaSavedStateForAnswerResolution({
    directPublishState: {
      tabId: 999,
      captchaContext: {
        challengeText: '다른문제□',
        challengeMasked: '다른문제□',
        solveHints: {
          prompt: 'stale direct publish prompt',
          submitField: 'ocrTexts'
        }
      }
    },
    queueItem: {
      id: 'paused-item',
      status: 'captcha_paused',
      captchaTabId: 303,
      captchaContext: {
        preferredSolveMode: 'extension_frame_dom',
        challengeText: '새열린약□',
        challengeMasked: '새열린약□'
      },
      solveHints: {
        prompt: 'queue OCR prompt',
        submitField: 'ocrTexts'
      }
    }
  });

  assert.deepEqual(savedState, {
    tabId: 999,
    captchaContext: {
      challengeText: '새열린약□',
      challengeMasked: '새열린약□',
      solveHints: {
        prompt: 'queue OCR prompt',
        submitField: 'ocrTexts'
      },
      preferredSolveMode: 'extension_frame_dom'
    }
  });
});

test('buildQueueCaptchaSavedStateForAnswerResolution does not leak stale direct-publish solve hints into queue context', () => {
  const savedState = buildQueueCaptchaSavedStateForAnswerResolution({
    directPublishState: {
      tabId: 999,
      captchaContext: {
        challengeText: '다른문제□',
        challengeMasked: '다른문제□',
        solveHints: {
          prompt: 'stale direct publish prompt',
          submitField: 'answer',
          targetEntity: '약국'
        }
      }
    },
    queueItem: {
      id: 'paused-item',
      status: 'captcha_paused',
      captchaTabId: 303,
      captchaContext: {
        preferredSolveMode: 'extension_frame_dom',
        challengeText: '새열린약□',
        challengeMasked: '새열린약□'
      },
      solveHints: null
    }
  });

  assert.deepEqual(savedState, {
    tabId: 999,
    captchaContext: {
      challengeText: '새열린약□',
      challengeMasked: '새열린약□',
      preferredSolveMode: 'extension_frame_dom'
    }
  });
});

test('buildQueueCaptchaSavedStateForAnswerResolution does not leak stale direct-publish challenge text when queue metadata only has solve hints', () => {
  const savedState = buildQueueCaptchaSavedStateForAnswerResolution({
    directPublishState: {
      tabId: 999,
      captchaContext: {
        challengeText: '다른문제□',
        challengeMasked: '다른문제□',
        solveHints: {
          prompt: 'stale direct publish prompt',
          submitField: 'answer',
          targetEntity: '약국'
        }
      }
    },
    queueItem: {
      id: 'paused-item',
      status: 'captcha_paused',
      captchaTabId: 303,
      captchaContext: null,
      solveHints: {
        prompt: 'queue OCR prompt',
        submitField: 'ocrTexts'
      }
    }
  });

  assert.deepEqual(savedState, {
    tabId: 999,
    captchaContext: {
      solveHints: {
        prompt: 'queue OCR prompt',
        submitField: 'ocrTexts'
      }
    }
  });
});

test('clearQueueCaptchaPauseState drops transient captcha metadata after completion or retry', () => {
  assert.deepEqual(clearQueueCaptchaPauseState(), {
    captchaTabId: null,
    captchaStage: null,
    captchaContext: null,
    solveHints: null,
    lastCaptchaArtifactCapture: null,
    lastCaptchaSubmitResult: null,
    lastCheckedAt: null
  });
});
