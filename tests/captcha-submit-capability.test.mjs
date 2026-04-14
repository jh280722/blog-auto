import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasActionableCaptchaAnswerPath,
  hasCaptchaSubmitCapability
} from '../utils/captcha-submit-capability.js';

test('hasCaptchaSubmitCapability treats dkaptcha submit API as a valid submit path', () => {
  assert.equal(hasCaptchaSubmitCapability({ submitApiAvailable: true }), true);
  assert.equal(hasCaptchaSubmitCapability({ submitApiCallable: true }), true);
  assert.equal(hasCaptchaSubmitCapability({ activeSubmitButton: { kind: 'captcha_submit_button' } }), true);
  assert.equal(hasCaptchaSubmitCapability({}), false);
});

test('hasActionableCaptchaAnswerPath accepts answer input plus submit API without a visible button', () => {
  assert.equal(hasActionableCaptchaAnswerPath({
    activeAnswerInput: { kind: 'captcha_answer_input' },
    submitApiAvailable: true,
    activeSubmitButton: null
  }), true);

  assert.equal(hasActionableCaptchaAnswerPath({
    activeAnswerInput: { kind: 'captcha_answer_input' },
    activeSubmitButton: { kind: 'captcha_submit_button' }
  }), true);

  assert.equal(hasActionableCaptchaAnswerPath({
    submitApiAvailable: true,
    activeSubmitButton: null
  }), false);
});
