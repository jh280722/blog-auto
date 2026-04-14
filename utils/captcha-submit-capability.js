export function hasCaptchaSubmitCapability(context = null) {
  if (!context || typeof context !== 'object') return false;

  return !!(
    context.activeSubmitButton
    || context.submitApiAvailable === true
    || context.submitApiCallable === true
  );
}

export function hasActionableCaptchaAnswerPath(context = null) {
  if (!context || typeof context !== 'object') return false;
  return !!context.activeAnswerInput && hasCaptchaSubmitCapability(context);
}
