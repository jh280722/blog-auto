const CAPTCHA_MASK_CHAR_CLASS = '□▢◻◼⬜⬛◯○●◎◇◆_＿';
const CAPTCHA_MASK_CHAR_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]/u;
const CAPTCHA_MASK_RUN_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]+/gu;
const CAPTCHA_PLACEHOLDER_WORD_RE = /(?:빈\s*칸|공\s*란)/gu;
const VARIABLE_MASK_CHAR = '¤';
const ANY_MASK_RUN_RE = /(?:¤+|[□▢◻◼⬜⬛◯○●◎◇◆_＿]+)/gu;
const COMPARABLE_TEXT_RE = new RegExp(`[^\\p{L}\\p{N}${CAPTCHA_MASK_CHAR_CLASS}${VARIABLE_MASK_CHAR}]`, 'gu');

function normalizeChallengePlaceholders(value = '', options = {}) {
  const preserveVariableMask = !!options.preserveVariableMask;
  const replacement = preserveVariableMask ? VARIABLE_MASK_CHAR : '□';

  return String(value ?? '').replace(CAPTCHA_PLACEHOLDER_WORD_RE, replacement);
}

export function normalizeComparableCaptchaText(value = '', options = {}) {
  return normalizeChallengePlaceholders(String(value ?? ''), options)
    .replace(/\s+/g, '')
    .replace(COMPARABLE_TEXT_RE, '')
    .trim();
}

export function normalizeCaptchaAnswerLengthHint(value = null, options = {}) {
  const maxReasonableLength = Number(options.maxReasonableLength) || 12;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > maxReasonableLength) {
    return null;
  }

  return Math.floor(normalized);
}

export function countCaptchaMaskSlots(value = '') {
  return parseCaptchaChallengeText(value).slotCount || 0;
}

export function parseCaptchaChallengeText(challengeText = '') {
  const raw = String(challengeText ?? '').trim();
  const parsingNormalized = normalizeComparableCaptchaText(raw, { preserveVariableMask: true });
  const normalized = parsingNormalized.replaceAll(VARIABLE_MASK_CHAR, '□');
  const maskRuns = [];
  let match;

  ANY_MASK_RUN_RE.lastIndex = 0;
  while ((match = ANY_MASK_RUN_RE.exec(parsingNormalized))) {
    const isVariableLength = match[0].includes(VARIABLE_MASK_CHAR);
    maskRuns.push({
      text: match[0].replaceAll(VARIABLE_MASK_CHAR, '□'),
      start: match.index,
      end: match.index + match[0].length,
      length: isVariableLength ? null : match[0].length,
      variableLength: isVariableLength
    });
  }

  const segments = parsingNormalized
    .split(ANY_MASK_RUN_RE)
    .map((segment) => segment.replaceAll(VARIABLE_MASK_CHAR, '□'));

  return {
    raw,
    normalized,
    parsingNormalized,
    hasMask: maskRuns.length > 0,
    hasVariableMask: maskRuns.some((run) => run.variableLength),
    slotCount: maskRuns.reduce((sum, run) => sum + (Number(run.length) || 0), 0),
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
    answer,
    matchStrategy: 'exact_segment_match'
  };
}

function computeLevenshteinDistance(source = '', target = '', maxDistance = Infinity) {
  if (source === target) return 0;
  if (!source.length) return target.length;
  if (!target.length) return source.length;
  if (Math.abs(source.length - target.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: target.length + 1 }, (_, index) => index);

  for (let row = 1; row <= source.length; row += 1) {
    let current = [row];
    let rowMin = current[0];

    for (let col = 1; col <= target.length; col += 1) {
      const substitutionCost = source[row - 1] === target[col - 1] ? 0 : 1;
      const value = Math.min(
        previous[col] + 1,
        current[col - 1] + 1,
        previous[col - 1] + substitutionCost
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }

    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }

    previous = current;
  }

  return previous[target.length];
}

function resolveAnswerPartsFromCandidateWithFuzzyAnchor(parsedChallenge, candidateText = '', options = {}) {
  if (!parsedChallenge?.hasMask || parsedChallenge.maskRunCount !== 1) {
    return null;
  }

  const candidateRaw = String(candidateText ?? '').trim();
  const normalizedCandidate = normalizeComparableCaptchaText(candidateRaw);
  if (!normalizedCandidate) return null;

  const prefix = parsedChallenge.segments?.[0] || '';
  const suffix = parsedChallenge.segments?.[1] || '';
  const maxPrefixDistance = prefix
    ? Math.max(1, Math.min(2, Math.ceil(prefix.length * 0.25)))
    : 0;
  const answerLengthHint = normalizeCaptchaAnswerLengthHint(options.answerLengthHint);
  let best = null;

  const considerCandidate = (candidatePrefix, answer, baseReasons = [], matchStrategy = 'fuzzy_single_mask_suffix_anchor') => {
    if (!answer) return;

    const prefixDistance = prefix
      ? computeLevenshteinDistance(candidatePrefix, prefix, maxPrefixDistance)
      : 0;
    if (prefix && prefixDistance > maxPrefixDistance) return;

    let score = 38;
    const reasons = [...baseReasons];

    if (prefix) {
      if (prefixDistance === 0) {
        score += 16;
        reasons.push('prefix_anchor_exact');
      } else {
        score += Math.max(2, 14 - (prefixDistance * 6));
        reasons.push('prefix_anchor_fuzzy');
      }
    }

    if (answerLengthHint) {
      if (answer.length === answerLengthHint) {
        score += 10;
        reasons.push('answer_length_hint_match');
      } else {
        score -= Math.min(10, Math.abs(answer.length - answerLengthHint) * 3);
        reasons.push('answer_length_hint_mismatch');
      }
    }

    if (!prefix && suffix) {
      score += 4;
      reasons.push('leading_blank_suffix_anchor');
    }

    const candidate = {
      success: true,
      candidateRaw,
      candidateNormalized: normalizedCandidate,
      answerParts: [answer],
      answer,
      fuzzyPrefixDistance: prefixDistance,
      matchStrategy,
      fuzzyReasons: reasons,
      fuzzyScore: score
    };

    if (!best || candidate.fuzzyScore > best.fuzzyScore) {
      best = candidate;
    }
  };

  if (suffix) {
    const suffixIndexes = [];
    let cursor = 0;

    while (cursor <= normalizedCandidate.length) {
      const nextIndex = normalizedCandidate.indexOf(suffix, cursor);
      if (nextIndex === -1) break;
      suffixIndexes.push(nextIndex);
      cursor = nextIndex + 1;
    }

    suffixIndexes.forEach((suffixIndex) => {
      const prefixAndAnswer = normalizedCandidate.slice(0, suffixIndex);
      for (let splitIndex = 0; splitIndex <= prefixAndAnswer.length; splitIndex += 1) {
        const candidatePrefix = prefixAndAnswer.slice(0, splitIndex);
        const answer = prefixAndAnswer.slice(splitIndex);
        considerCandidate(candidatePrefix, answer, ['suffix_anchor_exact'], 'fuzzy_single_mask_suffix_anchor');
      }
    });
  } else if (prefix) {
    for (let splitIndex = 0; splitIndex <= normalizedCandidate.length; splitIndex += 1) {
      const candidatePrefix = normalizedCandidate.slice(0, splitIndex);
      const answer = normalizedCandidate.slice(splitIndex);
      considerCandidate(candidatePrefix, answer, ['trailing_blank'], 'fuzzy_single_mask_trailing_blank');
    }
  }

  return best;
}

function scoreResolvedAnswer(parsedChallenge, resolution, options = {}) {
  if (!resolution?.success) {
    return { score: -1, reasons: [] };
  }

  const answerLengthHint = normalizeCaptchaAnswerLengthHint(options.answerLengthHint);
  const answerLength = resolution.answer.length;
  let score = typeof resolution.fuzzyScore === 'number' ? resolution.fuzzyScore : 50;
  const reasons = typeof resolution.fuzzyScore === 'number'
    ? [...(resolution.fuzzyReasons || []), 'pattern_match']
    : ['pattern_match'];

  if ((parsedChallenge.slotCount || 0) > 0) {
    if (answerLength === parsedChallenge.slotCount) {
      score += 24;
      reasons.push('slot_count_match');
    } else {
      score -= Math.min(20, Math.abs(answerLength - parsedChallenge.slotCount) * 4);
      reasons.push('slot_count_mismatch');
    }
  } else if (parsedChallenge.hasVariableMask) {
    reasons.push('variable_length_blank');
  }

  if (answerLengthHint > 0) {
    if (answerLength === answerLengthHint) {
      score += 18;
      reasons.push('answer_length_hint_match');
    } else if (!reasons.includes('answer_length_hint_mismatch')) {
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

  if (resolution.matchStrategy === 'exact_segment_match' && resolution.candidateNormalized.length === parsedChallenge.normalized.length - parsedChallenge.slotCount + answerLength) {
    score += 4;
    reasons.push('normalized_length_consistent');
  }

  return { score, reasons };
}

function buildUniqueAnswerCandidates(evaluatedCandidates = [], limit = null) {
  const uniqueAnswers = [];
  const seenAnswers = new Set();

  evaluatedCandidates.forEach((candidate) => {
    if (!candidate?.success || !candidate?.inferredAnswer) return;

    const normalizedAnswer = normalizeComparableCaptchaText(candidate.inferredAnswer);
    if (!normalizedAnswer || seenAnswers.has(normalizedAnswer)) return;
    seenAnswers.add(normalizedAnswer);

    uniqueAnswers.push({
      answer: candidate.inferredAnswer,
      normalizedAnswer,
      sourceText: candidate.sourceText,
      normalizedSourceText: candidate.normalizedSourceText,
      inferredAnswerParts: candidate.inferredAnswerParts || [],
      score: candidate.score,
      reasons: candidate.reasons || []
    });
  });

  if (Number.isFinite(limit) && limit > 0) {
    return uniqueAnswers.slice(0, limit);
  }

  return uniqueAnswers;
}

export function inferCaptchaAnswer({ challengeText = '', ocrText = '', ocrTexts = [], answerLengthHint = null } = {}) {
  const parsedChallenge = parseCaptchaChallengeText(challengeText);
  const normalizedAnswerLengthHint = normalizeCaptchaAnswerLengthHint(answerLengthHint);

  if (!parsedChallenge.hasMask) {
    return {
      success: false,
      status: 'captcha_challenge_mask_missing',
      error: '빈칸이 포함된 CAPTCHA 문제 문구를 찾지 못했습니다.',
      challenge: parsedChallenge,
      candidates: [],
      answerCandidates: []
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
      candidates: [],
      answerCandidates: []
    };
  }

  const evaluated = rawCandidates.map((candidate) => {
    const exactResolution = resolveAnswerPartsFromCandidate(parsedChallenge, candidate.raw);
    const resolution = exactResolution.success
      ? exactResolution
      : (resolveAnswerPartsFromCandidateWithFuzzyAnchor(parsedChallenge, candidate.raw, { answerLengthHint: normalizedAnswerLengthHint }) || exactResolution);
    const scored = scoreResolvedAnswer(parsedChallenge, resolution, { answerLengthHint: normalizedAnswerLengthHint });

    return {
      sourceText: candidate.raw,
      normalizedSourceText: candidate.normalized,
      success: resolution.success,
      error: resolution.error || null,
      inferredAnswer: resolution.answer || '',
      inferredAnswerParts: resolution.answerParts || [],
      score: scored.score,
      reasons: scored.reasons || [],
      matchStrategy: resolution.matchStrategy || null,
      fuzzyPrefixDistance: Number.isFinite(resolution.fuzzyPrefixDistance) ? resolution.fuzzyPrefixDistance : null
    };
  }).sort((a, b) => b.score - a.score);

  const answerCandidates = buildUniqueAnswerCandidates(evaluated);
  const best = evaluated[0] || null;
  if (!best || !best.success || !best.inferredAnswer) {
    return {
      success: false,
      status: 'captcha_answer_inference_failed',
      error: 'OCR 후보에서 CAPTCHA 답안을 안정적으로 추론하지 못했습니다.',
      challenge: parsedChallenge,
      candidates: evaluated,
      answerCandidates
    };
  }

  return {
    success: true,
    status: 'captcha_answer_inferred',
    answer: best.inferredAnswer,
    challenge: parsedChallenge,
    chosenCandidate: best,
    candidates: evaluated,
    answerCandidates,
    answerLength: best.inferredAnswer.length,
    answerLengthHint: normalizedAnswerLengthHint
  };
}
