import { hasActionableCaptchaAnswerPath } from './captcha-submit-capability.js';

function normalizePositiveInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

export function decideCaptchaTargetSelection({
  explicitTabId = null,
  savedTabId = null,
  currentTabId = null,
  currentTabContext = null,
  requireActionablePath = false
} = {}) {
  const normalizedExplicitTabId = normalizePositiveInteger(explicitTabId);
  if (normalizedExplicitTabId !== null) {
    return {
      success: true,
      source: 'explicit_tab',
      tabId: normalizedExplicitTabId
    };
  }

  const normalizedSavedTabId = normalizePositiveInteger(savedTabId);
  if (normalizedSavedTabId !== null) {
    return {
      success: true,
      source: 'saved_state',
      tabId: normalizedSavedTabId
    };
  }

  const normalizedCurrentTabId = normalizePositiveInteger(currentTabId);
  const currentTabHasCaptcha = !!(currentTabContext && currentTabContext.captchaPresent === true);
  const currentTabHasAnswerPath = hasActionableCaptchaAnswerPath(currentTabContext);

  if (normalizedCurrentTabId !== null && currentTabHasCaptcha && (!requireActionablePath || currentTabHasAnswerPath)) {
    return {
      success: true,
      source: 'current_tab',
      tabId: normalizedCurrentTabId
    };
  }

  return {
    success: false,
    status: 'captcha_target_not_found',
    source: 'unresolved',
    tabId: null,
    diagnostics: {
      explicitTabId: normalizedExplicitTabId,
      savedTabId: normalizedSavedTabId,
      currentTabId: normalizedCurrentTabId,
      currentTabHasCaptcha,
      currentTabHasAnswerPath,
      requireActionablePath: !!requireActionablePath
    }
  };
}
