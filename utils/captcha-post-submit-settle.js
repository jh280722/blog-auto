const PUBLISH_PROGRESS_TEXT_RE = /(저장중|발행중|게시중|처리중|업로드중|publishing|saving|processing)/i;

function normalizeCompactText(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function hasPublishProgressText(value = '') {
  return PUBLISH_PROGRESS_TEXT_RE.test(normalizeCompactText(value));
}

export function isPostCaptchaPublishStillInFlight(captchaContext = null) {
  if (!captchaContext || typeof captchaContext !== 'object') {
    return false;
  }

  if (!captchaContext.publishLayerPresent) {
    return false;
  }

  const confirmText = normalizeCompactText(captchaContext.confirmButtonText || captchaContext.confirmButton?.text || '');
  const completeText = normalizeCompactText(captchaContext.completeButtonText || captchaContext.completeButton?.text || '');
  const confirmDisabled = !!captchaContext.confirmButton?.disabled;
  const completeDisabled = !!captchaContext.completeButton?.disabled;

  return hasPublishProgressText(confirmText)
    || hasPublishProgressText(completeText)
    || ((confirmDisabled || completeDisabled) && !!(confirmText || completeText));
}
