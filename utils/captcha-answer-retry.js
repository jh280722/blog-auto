const RANKED_CAPTCHA_RETRY_SOURCES = new Set([
  'ocr_inference',
  'ocr_instruction_inference'
]);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeCaptchaAnswer(answer) {
  const raw = String(answer ?? '');
  const trimmed = raw.trim();
  const withoutWhitespace = trimmed.replace(/\s+/g, '');
  const value = withoutWhitespace || trimmed;
  const summary = {
    changed: value !== raw,
    strategy: !trimmed ? 'empty' : (value !== trimmed ? 'remove_whitespace' : (trimmed !== raw ? 'trim' : 'none')),
    originalLength: raw.length,
    normalizedLength: value.length
  };

  return {
    value,
    summary
  };
}

export function supportsRankedCaptchaAnswerRetries(answerResolution = {}, options = {}) {
  if (options.allowExplicitAnswerRetries === true || options.retryExplicitAnswer === true) {
    return true;
  }

  return RANKED_CAPTCHA_RETRY_SOURCES.has(answerResolution?.source);
}

export function buildCaptchaAnswerAttemptCandidates(answerResolution, options = {}) {
  const retryCapable = supportsRankedCaptchaAnswerRetries(answerResolution, options);
  const defaultMaxAttempts = retryCapable ? 3 : 1;
  const maxAttempts = clamp(Number(options.maxAnswerAttempts) || defaultMaxAttempts, 1, 5);
  const candidates = [];
  const seenAnswers = new Set();

  const pushCandidate = (candidate = {}, sourceFallback = null) => {
    const normalized = normalizeCaptchaAnswer(candidate.answer || '');
    if (!normalized.value || seenAnswers.has(normalized.value)) return;
    seenAnswers.add(normalized.value);
    candidates.push({
      answer: normalized.value,
      answerNormalization: candidate.answerNormalization || normalized.summary,
      source: candidate.source || sourceFallback || answerResolution?.source || null,
      sourceText: candidate.sourceText || null,
      normalizedSourceText: candidate.normalizedSourceText || null,
      score: Number.isFinite(candidate.score) ? candidate.score : null,
      reasons: Array.isArray(candidate.reasons) ? candidate.reasons : []
    });
  };

  pushCandidate({
    answer: answerResolution?.answer,
    answerNormalization: answerResolution?.answerNormalization,
    source: answerResolution?.source,
    reasons: [answerResolution?.source || 'primary_answer']
  }, 'primary_answer');

  if (retryCapable) {
    const rankedCandidates = Array.isArray(answerResolution?.answerCandidates) && answerResolution.answerCandidates.length > 0
      ? answerResolution.answerCandidates
      : (Array.isArray(answerResolution?.inference?.answerCandidates) ? answerResolution.inference.answerCandidates : []);
    rankedCandidates.forEach((candidate) => pushCandidate(candidate, 'ocr_inference_candidate'));
  }

  return candidates.slice(0, maxAttempts);
}
