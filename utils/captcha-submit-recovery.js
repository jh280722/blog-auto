export function looksLikeDirectPublishCompletionUrl(url = '') {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname || '';
    const path = parsed.pathname || '';
    if (!host.endsWith('.tistory.com')) return false;
    return path.startsWith('/manage/posts') || /^\/\d+$/.test(path);
  } catch {
    return false;
  }
}

export function classifyRecoveredCaptchaSubmitOutcome({ tabUrl = '', captchaContext = null } = {}) {
  if (looksLikeDirectPublishCompletionUrl(tabUrl)) {
    return {
      success: true,
      status: 'captcha_submit_tab_navigated',
      url: tabUrl,
      captchaStillAppears: false,
      recoveredReason: 'tab_navigated_to_completion'
    };
  }

  if (captchaContext && typeof captchaContext === 'object' && typeof captchaContext.captchaPresent === 'boolean') {
    return {
      success: true,
      status: captchaContext.captchaPresent ? 'captcha_still_present' : 'captcha_submitted',
      url: captchaContext.url || tabUrl || null,
      captchaStillAppears: captchaContext.captchaPresent,
      recoveredReason: 'captcha_context_probe'
    };
  }

  return null;
}
