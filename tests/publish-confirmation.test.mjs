import test from 'node:test';
import assert from 'node:assert/strict';

await import('../utils/publish-confirmation.js');

const {
  hasPublishProgressText,
  normalizePublishConfirmationState,
  buildUnobservedPublishRequestFailure
} = globalThis.__BLOG_AUTO_PUBLISH_CONFIRMATION__;

test('hasPublishProgressText recognizes Korean and English publish progress labels', () => {
  assert.equal(hasPublishProgressText('저장중'), true);
  assert.equal(hasPublishProgressText(' 발행 중 '), true);
  assert.equal(hasPublishProgressText('Publishing...'), true);
  assert.equal(hasPublishProgressText('공개 발행'), false);
});

test('normalizePublishConfirmationState treats open actionable layer as retryable final confirm', () => {
  const state = normalizePublishConfirmationState({
    publishLayerPresent: true,
    confirmButtonPresent: true,
    confirmButtonText: '공개 발행',
    confirmButtonDisabled: false
  });

  assert.equal(state.state, 'confirm_ready');
  assert.equal(state.safeToRetryFinalConfirm, true);
  assert.equal(state.recommendedAction, 'retry_final_confirm_same_tab');
});

test('normalizePublishConfirmationState treats disabled/progress controls as in-flight', () => {
  const state = normalizePublishConfirmationState({
    publishLayerPresent: true,
    confirmButtonPresent: true,
    confirmButtonText: '저장중',
    confirmButtonDisabled: true
  });

  assert.equal(state.state, 'confirm_in_flight');
  assert.equal(state.safeToRetryFinalConfirm, false);
  assert.equal(state.safeToPollSameTab, true);
  assert.equal(state.recommendedAction, 'poll_same_tab_before_retry');
});

test('buildUnobservedPublishRequestFailure returns retryable unresolved state before opening a fresh tab', () => {
  const failure = buildUnobservedPublishRequestFailure({
    requestObserved: false,
    confirmationState: {
      publishLayerPresent: true,
      confirmButtonPresent: true,
      confirmButtonText: '비공개 저장',
      confirmButtonDisabled: false
    }
  });

  assert.equal(failure.status, 'publish_confirm_unresolved');
  assert.equal(failure.retryable, true);
  assert.equal(failure.sameTabRequired, true);
  assert.equal(failure.confirmationState.state, 'confirm_ready');
});

test('buildUnobservedPublishRequestFailure asks callers to poll when publish looks in-flight', () => {
  const failure = buildUnobservedPublishRequestFailure({
    requestObserved: false,
    confirmationState: {
      publishLayerPresent: true,
      confirmButtonPresent: true,
      confirmButtonText: '발행중',
      confirmButtonDisabled: true
    }
  });

  assert.equal(failure.status, 'publish_confirm_in_flight');
  assert.equal(failure.retryable, false);
  assert.equal(failure.sameTabRequired, true);
});

test('buildUnobservedPublishRequestFailure does not override ordinary missing request when layer is closed', () => {
  const failure = buildUnobservedPublishRequestFailure({
    requestObserved: false,
    confirmationState: {
      publishLayerPresent: false,
      confirmButtonPresent: false
    }
  });

  assert.equal(failure, null);
});
