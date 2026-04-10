const CAPTCHA_MASK_CHAR_CLASS = '□▢◻◼⬜⬛◯○●◎◇◆_＿';
const CAPTCHA_MASK_CHAR_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]/u;
const CAPTCHA_MASK_RUN_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]+/gu;
const CAPTCHA_PLACEHOLDER_WORD_RE = /(?:빈\s*칸|공\s*란)/gu;
const VARIABLE_MASK_CHAR = '¤';
const ANY_MASK_RUN_RE = /(?:¤+|[□▢◻◼⬜⬛◯○●◎◇◆_＿]+)/gu;
const COMPARABLE_TEXT_RE = new RegExp(`[^\\p{L}\\p{N}${CAPTCHA_MASK_CHAR_CLASS}${VARIABLE_MASK_CHAR}]`, 'gu');
const OCR_CANDIDATE_BULLET_RE = /^[\s>*\-–—•·▪▫◦‣⁃]+/u;
const OCR_CANDIDATE_LIST_PREFIX_RE = /^\s*(?:\d+[).:\-]|[A-Za-z][).:\-])\s*/u;
const OCR_CANDIDATE_META_RE = /(?:정답(?:을)?\s*입력해주세요|답(?:을)?\s*입력해주세요|새로\s*풀기|음성\s*문제(?:\s*재생)?|답변\s*제출|DKAPTCHA(?:\s*\(CAPTCHA\s*서비스\))?|CAPTCHA\s*서비스)/iu;
const INSTRUCTION_ACTION_RE = /(?:입력|선택|클릭|고르|찾|맞추|완성)(?:해\s*주|해주)?세요/u;
const INSTRUCTION_TARGET_RE = /(?:지도|사진|이미지|화면)(?:에|에서)?\s*(?:있는|보이는)?\s*([^.,!?\n]{1,32}?)(?:의\s*(?:전체\s*)?(?:명칭|이름|상호|문구|텍스트|번호|주소)|을|를)\s*(?:정확한\s*)?(?:전체\s*)?(?:명칭|이름|상호|문구|텍스트|번호|주소)?\s*(?:을|를)?\s*(?:입력|선택|클릭|고르|찾|맞추|완성)/u;
const INSTRUCTION_TRAILING_NOISE_RE = /\s*(?:정답(?:을)?\s*입력해주세요|답(?:을)?\s*입력해주세요|새로\s*풀기|음성\s*문제(?:\s*재생)?|답변\s*제출|DKAPTCHA(?:\s*\(CAPTCHA\s*서비스\))?|CAPTCHA\s*서비스).*$/iu;
const CAPTCHA_TEXT_VARIANT_RULES = [
  [/슈퍼/gu, '수퍼']
];

function normalizeChallengePlaceholders(value = '', options = {}) {
  const preserveVariableMask = !!options.preserveVariableMask;
  const replacement = preserveVariableMask ? VARIABLE_MASK_CHAR : '□';

  return String(value ?? '').replace(CAPTCHA_PLACEHOLDER_WORD_RE, replacement);
}

function applyComparableTextVariants(value = '') {
  return CAPTCHA_TEXT_VARIANT_RULES.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    String(value ?? '')
  );
}

export function normalizeComparableCaptchaText(value = '', options = {}) {
  return applyComparableTextVariants(normalizeChallengePlaceholders(String(value ?? ''), options))
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

function normalizeInstructionText(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function detectCaptchaChallengeKind(challengeText = '') {
  const parsed = parseCaptchaChallengeText(challengeText);
  if (parsed.hasMask) return 'masked';
  if (INSTRUCTION_ACTION_RE.test(normalizeInstructionText(challengeText))) return 'instruction';
  return null;
}

export function extractInstructionTargetEntity(challengeText = '') {
  const normalized = normalizeInstructionText(challengeText).replace(INSTRUCTION_TRAILING_NOISE_RE, '').trim();
  if (!normalized) return null;

  const match = normalized.match(INSTRUCTION_TARGET_RE);
  if (!match?.[1]) return null;

  const target = normalizeInstructionText(match[1]).replace(/^(?:있는|보이는)\s*/u, '').trim();
  return target || null;
}

function splitRawOcrCandidateText(value = '') {
  return String(value ?? '')
    .split(/\r?\n+/)
    .map((entry) => entry.replace(OCR_CANDIDATE_LIST_PREFIX_RE, '').replace(OCR_CANDIDATE_BULLET_RE, '').trim())
    .filter(Boolean);
}

export function normalizeCaptchaOcrCandidateTexts(values = []) {
  const inputs = Array.isArray(values) ? values : [values];
  const deduped = [];
  const seen = new Set();

  inputs.forEach((value) => {
    if (typeof value !== 'string') return;
    splitRawOcrCandidateText(value).forEach((candidate) => {
      const normalized = normalizeComparableCaptchaText(candidate);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      deduped.push(candidate);
    });
  });

  return deduped;
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

function buildInstructionTargetForms(targetEntity = '') {
  const normalized = normalizeComparableCaptchaText(targetEntity);
  if (!normalized) return [];

  const variants = new Set([normalized]);
  if (normalized.endsWith('의원') && normalized.length > 2) {
    variants.add(normalized.slice(0, -2));
  }

  return Array.from(variants).filter(Boolean);
}

function scoreInstructionAnswerCandidate(candidateText = '', targetForms = []) {
  const sourceText = String(candidateText ?? '').trim();
  const normalizedSourceText = normalizeComparableCaptchaText(sourceText);
  if (!normalizedSourceText) {
    return {
      success: false,
      sourceText,
      normalizedSourceText,
      inferredAnswer: '',
      score: -1,
      reasons: ['candidate_empty']
    };
  }

  let score = 18;
  const reasons = [];
  const trimmedWithoutNoise = sourceText.replace(INSTRUCTION_TRAILING_NOISE_RE, '').trim();
  const normalizedInstructionNoise = normalizeComparableCaptchaText(trimmedWithoutNoise);

  if (OCR_CANDIDATE_META_RE.test(sourceText) || /^(?:답변제출|새로풀기|음성문제|정답입력해주세요|답입력해주세요)$/u.test(normalizedSourceText)) {
    score -= 28;
    reasons.push('ui_meta_noise');
  }

  if (normalizedInstructionNoise && normalizedInstructionNoise !== normalizedSourceText) {
    score -= 8;
    reasons.push('trailing_meta_noise');
  }

  if (normalizedSourceText.length >= 4 && normalizedSourceText.length <= 18) {
    score += 8;
    reasons.push('reasonable_length');
  } else if (normalizedSourceText.length <= 2) {
    score -= 18;
    reasons.push('too_short');
  } else if (normalizedSourceText.length > 24) {
    score -= 10;
    reasons.push('too_long');
  }

  if (targetForms.length > 0) {
    const exactTarget = targetForms.find((target) => normalizedSourceText === target);
    const suffixTarget = targetForms.find((target) => normalizedSourceText.length > target.length && normalizedSourceText.endsWith(target));
    const containsTarget = !suffixTarget && targetForms.find((target) => normalizedSourceText.length > target.length && normalizedSourceText.includes(target));

    if (suffixTarget) {
      score += 32;
      reasons.push('target_suffix_match');
    } else if (containsTarget) {
      score += 24;
      reasons.push('target_contains_match');
    } else if (exactTarget) {
      score -= 14;
      reasons.push('target_only');
    } else {
      score -= 4;
      reasons.push('target_missing');
    }
  }

  return {
    success: score >= 18,
    sourceText,
    normalizedSourceText,
    inferredAnswer: sourceText,
    score,
    reasons
  };
}

export function inferInstructionCaptchaAnswer({ challengeText = '', ocrText = '', ocrTexts = [], targetEntity = null } = {}) {
  const challengeKind = detectCaptchaChallengeKind(challengeText);
  const resolvedTargetEntity = targetEntity || extractInstructionTargetEntity(challengeText) || null;
  const targetForms = buildInstructionTargetForms(resolvedTargetEntity);
  const candidates = normalizeCaptchaOcrCandidateTexts([...ocrTexts, ocrText]);

  if (challengeKind !== 'instruction') {
    return {
      success: false,
      status: 'captcha_instruction_challenge_missing',
      error: 'instruction/map CAPTCHA 문제 문구를 찾지 못했습니다.',
      challengeKind,
      targetEntity: resolvedTargetEntity,
      candidates: [],
      answerCandidates: []
    };
  }

  if (candidates.length === 0) {
    return {
      success: false,
      status: 'captcha_ocr_candidate_missing',
      error: 'OCR 후보 텍스트가 비어 있습니다.',
      challengeKind,
      targetEntity: resolvedTargetEntity,
      candidates: [],
      answerCandidates: []
    };
  }

  const evaluated = candidates
    .map((candidate) => scoreInstructionAnswerCandidate(candidate, targetForms))
    .sort((left, right) => (right.score || 0) - (left.score || 0));

  const answerCandidates = buildUniqueAnswerCandidates(evaluated);
  const best = evaluated.find((candidate) => candidate.success && candidate.inferredAnswer) || null;
  const runnerUp = evaluated.find((candidate) => candidate !== best && candidate.success && candidate.inferredAnswer) || null;

  if (!best || !best.inferredAnswer) {
    return {
      success: false,
      status: 'captcha_instruction_answer_inference_failed',
      error: 'instruction/map CAPTCHA 대상 명칭을 OCR 후보에서 고르지 못했습니다.',
      challengeKind,
      targetEntity: resolvedTargetEntity,
      candidates: evaluated,
      answerCandidates
    };
  }

  const bestHasStrongTargetMatch = best.reasons.includes('target_suffix_match') || best.reasons.includes('target_contains_match');
  const scoreGap = runnerUp ? ((best.score || 0) - (runnerUp.score || 0)) : Infinity;
  if (runnerUp && !bestHasStrongTargetMatch && scoreGap < 6) {
    return {
      success: false,
      status: 'captcha_instruction_answer_ambiguous',
      error: 'instruction/map CAPTCHA OCR 후보가 여러 개라 정답을 하나로 좁히지 못했습니다.',
      challengeKind,
      targetEntity: resolvedTargetEntity,
      chosenCandidate: best,
      candidates: evaluated,
      answerCandidates
    };
  }

  return {
    success: true,
    status: 'captcha_instruction_answer_inferred',
    answer: best.inferredAnswer,
    challengeKind,
    targetEntity: resolvedTargetEntity,
    chosenCandidate: best,
    candidates: evaluated,
    answerCandidates
  };
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

  const rawCandidates = normalizeCaptchaOcrCandidateTexts([...ocrTexts, ocrText]).map((raw) => ({
    raw,
    normalized: normalizeComparableCaptchaText(raw)
  }));

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
