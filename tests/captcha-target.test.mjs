import test from 'node:test';
import assert from 'node:assert/strict';

import { decideCaptchaTargetSelection } from '../utils/captcha-target.js';

test('decideCaptchaTargetSelection prefers an explicit tab id over saved or current tab fallbacks', () => {
  const decision = decideCaptchaTargetSelection({
    explicitTabId: 111,
    savedTabId: 222,
    currentTabId: 333,
    currentTabContext: {
      captchaPresent: true,
      activeAnswerInput: { kind: 'captcha_answer_input' },
      submitApiAvailable: true
    },
    requireActionablePath: true
  });

  assert.deepEqual(decision, {
    success: true,
    source: 'explicit_tab',
    tabId: 111
  });
});

test('decideCaptchaTargetSelection reuses the saved direct-publish tab when present', () => {
  const decision = decideCaptchaTargetSelection({
    savedTabId: 222,
    currentTabId: 333,
    currentTabContext: {
      captchaPresent: true,
      activeAnswerInput: { kind: 'captcha_answer_input' },
      activeSubmitButton: { kind: 'captcha_submit_button' }
    },
    requireActionablePath: true
  });

  assert.deepEqual(decision, {
    success: true,
    source: 'saved_state',
    tabId: 222
  });
});

test('decideCaptchaTargetSelection allows current-tab fallback for context reads when a live captcha is visible', () => {
  const decision = decideCaptchaTargetSelection({
    currentTabId: 333,
    currentTabContext: {
      captchaPresent: true,
      activeAnswerInput: null,
      activeSubmitButton: null,
      iframeCaptchaPresent: true
    },
    requireActionablePath: false
  });

  assert.deepEqual(decision, {
    success: true,
    source: 'current_tab',
    tabId: 333
  });
});

test('decideCaptchaTargetSelection requires an actionable answer path before using current-tab submit fallback', () => {
  const decision = decideCaptchaTargetSelection({
    currentTabId: 333,
    currentTabContext: {
      captchaPresent: true,
      activeAnswerInput: null,
      activeSubmitButton: null,
      iframeCaptchaPresent: true
    },
    requireActionablePath: true
  });

  assert.deepEqual(decision, {
    success: false,
    status: 'captcha_target_not_found',
    source: 'unresolved',
    tabId: null,
    diagnostics: {
      explicitTabId: null,
      savedTabId: null,
      currentTabId: 333,
      currentTabHasCaptcha: true,
      currentTabHasAnswerPath: false,
      requireActionablePath: true
    }
  });
});

test('decideCaptchaTargetSelection fails closed when currentTabId has no live captcha context', () => {
  const decision = decideCaptchaTargetSelection({
    currentTabId: 333,
    currentTabContext: {
      captchaPresent: false,
      activeAnswerInput: { kind: 'captcha_answer_input' },
      activeSubmitButton: { kind: 'captcha_submit_button' }
    },
    requireActionablePath: false
  });

  assert.deepEqual(decision, {
    success: false,
    status: 'captcha_target_not_found',
    source: 'unresolved',
    tabId: null,
    diagnostics: {
      explicitTabId: null,
      savedTabId: null,
      currentTabId: 333,
      currentTabHasCaptcha: false,
      currentTabHasAnswerPath: true,
      requireActionablePath: false
    }
  });
});
