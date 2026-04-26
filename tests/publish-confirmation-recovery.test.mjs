import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDirectPublishConfirmationRecoveryPatch,
  buildQueuePublishConfirmationPauseState,
  findQueuePublishConfirmationItem,
  getQueuePublishConfirmationSelectionFailure,
  isPublishConfirmationRecoveryStatus,
  summarizeQueuePublishConfirmationSelection
} from '../utils/publish-confirmation-recovery.js';

test('isPublishConfirmationRecoveryStatus only matches same-tab publish confirmation blockers', () => {
  assert.equal(isPublishConfirmationRecoveryStatus('publish_confirm_unresolved'), true);
  assert.equal(isPublishConfirmationRecoveryStatus('publish_confirm_in_flight'), true);
  assert.equal(isPublishConfirmationRecoveryStatus('captcha_required'), false);
  assert.equal(isPublishConfirmationRecoveryStatus('published'), false);
});

test('buildDirectPublishConfirmationRecoveryPatch preserves confirmation state for same-tab resume', () => {
  const patch = buildDirectPublishConfirmationRecoveryPatch({
    response: {
      status: 'publish_confirm_unresolved',
      retryable: true,
      sameTabRequired: true,
      recommendedAction: 'retry_final_confirm_same_tab',
      confirmationState: {
        state: 'confirm_ready',
        publishLayerPresent: true,
        confirmButtonPresent: true,
        confirmButtonText: '공개 발행',
        confirmButtonDisabled: false,
        snapshot: { titleLength: 12, contentTextLength: 450, contentPreview: '민감한 본문 미리보기' }
      }
    },
    nowIso: '2026-04-26T01:00:00.000Z'
  });

  assert.deepEqual(patch, {
    phase: 'publish_confirmation',
    stage: 'confirm_ready',
    status: 'publish_confirm_unresolved',
    confirmationState: {
      state: 'confirm_ready',
      publishLayerPresent: true,
      confirmButtonPresent: true,
      confirmButtonText: '공개 발행',
      confirmButtonDisabled: false,
      completeButtonPresent: false,
      completeButtonText: null,
      completeButtonDisabled: false,
      progressTextPresent: false,
      captchaPresent: false,
      safeToRetryFinalConfirm: false,
      safeToPollSameTab: false,
      recommendedAction: null
    },
    publishConfirmationRecovery: {
      status: 'publish_confirm_unresolved',
      retryable: true,
      sameTabRequired: true,
      recommendedAction: 'retry_final_confirm_same_tab',
      updatedAt: '2026-04-26T01:00:00.000Z'
    }
  });
});

test('buildQueuePublishConfirmationPauseState pauses a queue item without CAPTCHA metadata or next-item continuation', () => {
  const pauseState = buildQueuePublishConfirmationPauseState({
    existingItem: { id: 'item-1', diagnostics: { attempts: [{ step: 'old' }] } },
    tabId: 432,
    response: {
      status: 'publish_confirm_in_flight',
      error: '저장중 상태입니다.',
      retryable: false,
      sameTabRequired: true,
      recommendedAction: 'poll_same_tab_before_retry',
      confirmationState: {
        state: 'confirm_in_flight',
        publishLayerPresent: true,
        confirmButtonPresent: true,
        confirmButtonText: '저장중',
        confirmButtonDisabled: true,
        safeToPollSameTab: true
      },
      diagnostics: { attempts: [{ step: 'new' }] }
    },
    nowIso: '2026-04-26T01:02:03.000Z'
  });

  assert.deepEqual(pauseState, {
    status: 'publish_confirm_paused',
    error: '저장중 상태입니다.',
    publishStatus: 'publish_confirm_in_flight',
    publishConfirmTabId: 432,
    confirmationState: {
      state: 'confirm_in_flight',
      publishLayerPresent: true,
      confirmButtonPresent: true,
      confirmButtonText: '저장중',
      confirmButtonDisabled: true,
      completeButtonPresent: false,
      completeButtonText: null,
      completeButtonDisabled: false,
      progressTextPresent: false,
      captchaPresent: false,
      safeToRetryFinalConfirm: false,
      safeToPollSameTab: true,
      recommendedAction: null
    },
    publishConfirmationRecovery: {
      status: 'publish_confirm_in_flight',
      retryable: false,
      sameTabRequired: true,
      recommendedAction: 'poll_same_tab_before_retry',
      updatedAt: '2026-04-26T01:02:03.000Z'
    },
    diagnostics: { attempts: [{ step: 'new' }] },
    lastCheckedAt: '2026-04-26T01:02:03.000Z'
  });
});

test('findQueuePublishConfirmationItem selects only publish_confirm_paused queue entries by id or same tab', () => {
  const queue = [
    { id: 'a', status: 'captcha_paused', captchaTabId: 111 },
    { id: 'b', status: 'publish_confirm_paused', publishConfirmTabId: 222 },
    { id: 'c', status: 'publish_confirm_paused', publishConfirmTabId: 333 }
  ];

  assert.equal(findQueuePublishConfirmationItem(queue, { itemId: 'b' })?.id, 'b');
  assert.equal(findQueuePublishConfirmationItem(queue, { tabId: 333 })?.id, 'c');
  assert.equal(findQueuePublishConfirmationItem(queue, { tabId: 111 }), null);

  assert.deepEqual(summarizeQueuePublishConfirmationSelection(queue), {
    pausedCount: 2,
    requestedItemId: null,
    requestedTabId: null,
    pausedItemIds: ['b', 'c'],
    pausedTabIds: [222, 333]
  });
});

test('getQueuePublishConfirmationSelectionFailure requires explicit target when multiple confirmation pauses exist', () => {
  const queue = [
    { id: 'b', status: 'publish_confirm_paused', publishConfirmTabId: 222 },
    { id: 'c', status: 'publish_confirm_paused', publishConfirmTabId: 333 }
  ];

  const failure = getQueuePublishConfirmationSelectionFailure({ queue, matchedItem: null });

  assert.equal(failure.status, 'queue_publish_confirm_target_required');
  assert.match(failure.error, /publish_confirm_paused/);
  assert.equal(failure.queueSelection.pausedCount, 2);
});
