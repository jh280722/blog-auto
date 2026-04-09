import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRecoveredCaptchaSubmitOutcome,
  looksLikeDirectPublishCompletionUrl
} from '../utils/captcha-submit-recovery.js';

test('looksLikeDirectPublishCompletionUrl recognizes manage posts and permalink urls', () => {
  assert.equal(looksLikeDirectPublishCompletionUrl('https://nakseo-dev.tistory.com/manage/posts/'), true);
  assert.equal(looksLikeDirectPublishCompletionUrl('https://nakseo-dev.tistory.com/180'), true);
  assert.equal(looksLikeDirectPublishCompletionUrl('https://nakseo-dev.tistory.com/manage/newpost'), false);
  assert.equal(looksLikeDirectPublishCompletionUrl('https://example.com/manage/posts/'), false);
});

test('classifyRecoveredCaptchaSubmitOutcome treats completion navigation as a successful recovery', () => {
  const result = classifyRecoveredCaptchaSubmitOutcome({
    tabUrl: 'https://nakseo-dev.tistory.com/manage/posts/'
  });

  assert.deepEqual(result, {
    success: true,
    status: 'captcha_submit_tab_navigated',
    url: 'https://nakseo-dev.tistory.com/manage/posts/',
    captchaStillAppears: false,
    recoveredReason: 'tab_navigated_to_completion'
  });
});

test('classifyRecoveredCaptchaSubmitOutcome maps refreshed captcha context to submitted state', () => {
  const result = classifyRecoveredCaptchaSubmitOutcome({
    tabUrl: 'https://nakseo-dev.tistory.com/manage/newpost',
    captchaContext: {
      url: 'https://nakseo-dev.tistory.com/manage/newpost',
      captchaPresent: false
    }
  });

  assert.deepEqual(result, {
    success: true,
    status: 'captcha_submitted',
    url: 'https://nakseo-dev.tistory.com/manage/newpost',
    captchaStillAppears: false,
    recoveredReason: 'captcha_context_probe'
  });
});

test('classifyRecoveredCaptchaSubmitOutcome keeps still-present captcha as a successful attempted submit', () => {
  const result = classifyRecoveredCaptchaSubmitOutcome({
    tabUrl: 'https://nakseo-dev.tistory.com/manage/newpost',
    captchaContext: {
      url: 'https://nakseo-dev.tistory.com/manage/newpost',
      captchaPresent: true
    }
  });

  assert.deepEqual(result, {
    success: true,
    status: 'captcha_still_present',
    url: 'https://nakseo-dev.tistory.com/manage/newpost',
    captchaStillAppears: true,
    recoveredReason: 'captcha_context_probe'
  });
});

test('classifyRecoveredCaptchaSubmitOutcome returns null when no completion clue exists', () => {
  assert.equal(classifyRecoveredCaptchaSubmitOutcome({
    tabUrl: 'https://nakseo-dev.tistory.com/manage/newpost'
  }), null);
});
