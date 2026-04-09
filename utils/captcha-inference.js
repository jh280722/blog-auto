const CAPTCHA_MASK_CHAR_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]/u;
const CAPTCHA_MASK_RUN_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]+/gu;
const COMPARABLE_TEXT_RE = /[^\p{L}\p{N}□▢◻◼⬜⬛◯○●◎◇◆_＿]/gu;

export function normalizeComparableCaptchaText(value = '') {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(COMPARABLE_TEXT_RE, '')
    .trim();
}

export function countCaptchaMaskSlots(value = '') {
  const matches = String(value ?? '').match(CAPTCHA_MASK_RUN_RE);
  return matches ? matches.reduce((sum, match) => sum + match.length, 0) : 0;
}

export function parseCaptchaChallengeText(challengeText = '') {
  const raw = String(challengeText ?? '').trim();
  const normalized = normalizeComparableCaptchaText(raw);
  const maskRuns = [];
  let match;

  CAPTCHA_MASK_RUN_RE.lastIndex = 0;
  while ((match = CAPTCHA_MASK_RUN_RE.exec(normalized))) {
    maskRuns.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      length: match[0].length
    });
  }

  const segments = normalized.split(CAPTCHA_MASK_RUN_RE);

  return {
    raw,
    normalized,
    hasMask: maskRuns.length > 0,
    slotCount: maskRuns.reduce((sum, run) => sum + run.length, 0),
    maskRunCount: maskRuns.length,
    maskRuns,
    segments
  };
}

function resolveAnswerPartsFromCandidate(parsedChallenge, candidateText = '') {
  const candidateRaw = String(candidateText ?? '').trim();
  const normalizedCandidate = normalizeComparableCaptchaText(candidateRaw);

  if (!parsedChallenge?.hasMask || !normalizedCandidate) {
    return {
      success: false,
      error: 'challenge_or_candidate_missing',
      candidateRaw,
      candidateNormalized: normalizedCandidate,
      answerParts: [],
      answer: ''
    };
  }

  const segments = Array.isArray(parsedChallenge.segments) ? parsedChallenge.segments : [];
  const maskRuns = Array.isArray(parsedChallenge.maskRuns) ? parsedChallenge.maskRuns : [];
  const answerParts = [];
  let cursor = 0;

  if (segments[0]) {
    if (!normalizedCandidate.startsWith(segments[0])) {
      return {
        success: false,
        error: 'prefix_mismatch',
        candidateRaw,
        candidateNormalized: normalizedCandidate,
        answerParts: [],
        answer: ''
      };
    }
    cursor = segments[0].length;
  }

  for (let index = 0; index < maskRuns.length; index += 1) {
    const nextSegment = segments[index + 1] || '';
    if (!nextSegment) {
      answerParts.push(normalizedCandidate.slice(cursor));
      cursor = normalizedCandidate.length;
      continue;
    }

    const nextIndex = normalizedCandidate.indexOf(nextSegment, cursor);
    if (nextIndex === -1) {
      return {
        success: false,
        error: 'suffix_mismatch',
        candidateRaw,
        candidateNormalized: normalizedCandidate,
        answerParts,
        answer: answerParts.join('')
      };
    }

    answerParts.push(normalizedCandidate.slice(cursor, nextIndex));
    cursor = nextIndex + nextSegment.length;
  }

  if (segments.at(-1) && !normalizedCandidate.endsWith(segments.at(-1))) {
    return {
      success: false,
      error: 'ending_mismatch',
      candidateRaw,
      candidateNormalized: normalizedCandidate,
      answerParts,
      answer: answerParts.join('')
    };
  }

  const answer = answerParts.join('');
  if (!answer || answerParts.some((part) => !part)) {
    return {
      success: false,
      error: 'empty_answer_part',
      candidateRaw,
      candidateNormalized: normalizedCandidate,
      answerParts,
      answer
    };
  }

  return {
    success: true,
    candidateRaw,
    candidateNormalized: normalizedCandidate,
    answerParts,
    answer
  };
}

function scoreResolvedAnswer(parsedChallenge, resolution, options = {}) {
  if (!resolution?.success) return -1;

  const answerLengthHint = Number(options.answerLengthHint) || 0;
  const answerLength = resolution.answer.length;
  let score = 50;
  const reasons = ['pattern_match'];

  if ((parsedChallenge.slotCount || 0) > 0) {
    if (answerLength === parsedChallenge.slotCount) {
      score += 24;
      reasons.push('slot_count_match');
    } else {
      score -= Math.min(20, Math.abs(answerLength - parsedChallenge.slotCount) * 4);
      reasons.push('slot_count_mismatch');
    }
  }

  if (answerLengthHint > 0) {
    if (answerLength === answerLengthHint) {
      score += 18;
      reasons.push('answer_length_hint_match');
    } else {
      score -= Math.min(18, Math.abs(answerLength - answerLengthHint) * 5);
      reasons.push('answer_length_hint_mismatch');
    }
  }

  if (parsedChallenge.segments[0]) {
    score += 6;
    reasons.push('anchored_prefix');
  }

  if (parsedChallenge.segments.at(-1)) {
    score += 6;
    reasons.push('anchored_suffix');
  }

  if (resolution.candidateNormalized.length === parsedChallenge.normalized.length - parsedChallenge.slotCount + answerLength) {
    score += 4;
    reasons.push('normalized_length_consistent');
  }

  return { score, reasons };
}

export function inferCaptchaAnswer({ challengeText = '', ocrText = '', ocrTexts = [], answerLengthHint = null } = {}) {
  const parsedChallenge = parseCaptchaChallengeText(challengeText);
  if (!parsedChallenge.hasMask) {
    return {
      success: false,
      status: 'captcha_challenge_mask_missing',
      error: '빈칸이 포함된 CAPTCHA 문제 문구를 찾지 못했습니다.',
      challenge: parsedChallenge,
      candidates: []
    };
  }

  const rawCandidates = [];
  const seen = new Set();
  [...ocrTexts, ocrText].forEach((entry) => {
    const raw = String(entry ?? '').trim();
    if (!raw) return;
    const normalized = normalizeComparableCaptchaText(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rawCandidates.push({ raw, normalized });
  });

  if (rawCandidates.length === 0) {
    return {
      success: false,
      status: 'captcha_ocr_candidate_missing',
      error: 'OCR 후보 텍스트가 비어 있습니다.',
      challenge: parsedChallenge,
      candidates: []
    };
  }

  const evaluated = rawCandidates.map((candidate) => {
    const resolution = resolveAnswerPartsFromCandidate(parsedChallenge, candidate.raw);
    const scored = scoreResolvedAnswer(parsedChallenge, resolution, { answerLengthHint });

    return {
      sourceText: candidate.raw,
      normalizedSourceText: candidate.normalized,
      success: resolution.success,
      error: resolution.error || null,
      inferredAnswer: resolution.answer || '',
      inferredAnswerParts: resolution.answerParts || [],
      score: scored.score,
      reasons: scored.reasons || []
    };
  }).sort((a, b) => b.score - a.score);

  const best = evaluated[0] || null;
  if (!best || !best.success || !best.inferredAnswer) {
    return {
      success: false,
      status: 'captcha_answer_inference_failed',
      error: 'OCR 후보에서 CAPTCHA 답안을 안정적으로 추론하지 못했습니다.',
      challenge: parsedChallenge,
      candidates: evaluated
    };
  }

  return {
    success: true,
    status: 'captcha_answer_inferred',
    answer: best.inferredAnswer,
    challenge: parsedChallenge,
    chosenCandidate: best,
    candidates: evaluated,
    answerLength: best.inferredAnswer.length,
    answerLengthHint: Number(answerLengthHint) || null
  };
}
