import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasPublishProgressText,
  isPostCaptchaPublishStillInFlight,
  isStableCaptchaClearAfterDelay
} from '../utils/captcha-post-submit-settle.js';

test('hasPublishProgressText recognizes common publish progress labels', () => {
  assert.equal(hasPublishProgressText('저장중'), true);
  assert.equal(hasPublishProgressText(' 발행중 '), true);
  assert.equal(hasPublishProgressText('답변 제출'), false);
});

test('isPostCaptchaPublishStillInFlight requires a visible publish layer', () => {
  assert.equal(isPostCaptchaPublishStillInFlight(null), false);
  assert.equal(isPostCaptchaPublishStillInFlight({ publishLayerPresent: false, confirmButtonText: '저장중' }), false);
});

test('isPostCaptchaPublishStillInFlight detects disabled saving controls in the publish layer', () => {
  assert.equal(isPostCaptchaPublishStillInFlight({
    publishLayerPresent: true,
    confirmButtonText: '저장중',
    confirmButton: { disabled: true }
  }), true);

  assert.equal(isPostCaptchaPublishStillInFlight({
    publishLayerPresent: true,
    completeButtonText: '발행중',
    completeButton: { disabled: true }
  }), true);
});

test('isPostCaptchaPublishStillInFlight ignores ready-to-submit publish layers', () => {
  assert.equal(isPostCaptchaPublishStillInFlight({
    publishLayerPresent: true,
    confirmButtonText: '발행',
    confirmButton: { disabled: false },
    completeButtonText: '완료',
    completeButton: { disabled: false }
  }), false);
});

test('isStableCaptchaClearAfterDelay requires the delayed check to remain clear', () => {
  assert.equal(isStableCaptchaClearAfterDelay(
    { success: true, captchaPresent: false },
    { success: true, captchaPresent: false }
  ), true);

  assert.equal(isStableCaptchaClearAfterDelay(
    { success: true, captchaPresent: false },
    { success: true, captchaPresent: true }
  ), false);

  assert.equal(isStableCaptchaClearAfterDelay(
    { success: true, captchaPresent: false },
    { success: false, status: 'editor_not_ready' }
  ), false);
});
