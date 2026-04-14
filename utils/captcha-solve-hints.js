import {
  detectCaptchaChallengeKind,
  extractInstructionTargetEntity,
  normalizeCaptchaAnswerLengthHint,
  parseCaptchaChallengeText
} from './captcha-inference.js';

function normalizeText(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function buildMaskedPrompt({ challengeText, challengeMasked, answerLengthHint }) {
  const slotHint = Number(answerLengthHint) > 0
    ? `빈칸 글자 수 힌트: ${answerLengthHint}자.`
    : '빈칸 길이는 확정되지 않았을 수 있습니다.';

  return [
    '이 이미지는 티스토리 DKAPTCHA입니다.',
    `문제 문구: "${challengeText || challengeMasked}"`,
    slotHint,
    '이미지에서 보이는 전체 상호/텍스트 후보를 1개 이상 정확히 읽어주세요.',
    '빈칸만 추측하지 말고, 이미지에 실제로 보이는 전체 후보 텍스트만 줄바꿈으로 반환하세요.',
    '설명은 쓰지 말고 후보 텍스트만 출력하세요.'
  ].join(' ');
}

function buildInstructionPrompt({ challengeText, targetEntity }) {
  const targetHint = targetEntity ? `대상 유형: ${targetEntity}.` : '';

  return [
    '이 이미지는 티스토리 DKAPTCHA입니다.',
    `지시문: "${challengeText}"`,
    targetHint,
    '지시문과 일치하는 대상 하나를 이미지에서 찾은 뒤 그 대상의 전체 명칭을 정확히 읽어주세요.',
    '정답 후보를 여러 줄로 읽었다면 그대로 줄바꿈 목록으로 넘겨도 됩니다.',
    '답변은 전체 명칭만 한 줄로 출력하고 설명은 쓰지 마세요.'
  ].filter(Boolean).join(' ');
}

function buildDirectAnswerPrompt({ answerLengthHint }) {
  const lengthHint = Number(answerLengthHint) > 0
    ? `정답 길이 힌트: ${answerLengthHint}자.`
    : '정답 길이 힌트는 확정되지 않았을 수 있습니다.';

  return [
    '이 이미지는 티스토리 DKAPTCHA입니다.',
    '문제 문구를 DOM에서 읽지 못했습니다.',
    lengthHint,
    '이미지 전체를 보고 최종 정답을 직접 판단해 주세요.',
    '여러 상호 후보를 나열하지 말고 제출해야 할 정답만 한 줄로 출력하세요.',
    'OCR 후보만 있는 경우에도 정답이 하나로 확실할 때만 답을 출력하세요.'
  ].join(' ');
}

export function buildCaptchaSolveHints(captchaContext = null, extra = {}) {
  if (!captchaContext || typeof captchaContext !== 'object') {
    return null;
  }

  const challengeText = normalizeText(captchaContext.challengeText || captchaContext.challengeMasked || '');
  const challengeMasked = normalizeText(captchaContext.challengeMasked || captchaContext.challengeText || '');
  const answerLengthHint = normalizeCaptchaAnswerLengthHint(captchaContext.answerLengthHint)
    || normalizeCaptchaAnswerLengthHint(captchaContext.challengeSlotCount)
    || null;
  const fallbackSupported = !challengeText
    && !challengeMasked
    && (
      answerLengthHint
      || captchaContext.activeCaptureCandidate
      || captchaContext.captureCandidateCount
      || captchaContext.preferredSolveMode
      || captchaContext.effectiveSolveMode
      || extra.artifactPreference
      || (Array.isArray(extra.artifactKinds) && extra.artifactKinds.length > 0)
    );
  if (!challengeText && !challengeMasked && !fallbackSupported) {
    return null;
  }

  const challengeKind = detectCaptchaChallengeKind(challengeText || challengeMasked || '');
  const targetEntity = challengeKind === 'instruction'
    ? extractInstructionTargetEntity(challengeText || challengeMasked)
    : null;

  const common = {
    challengeKind,
    challengeText: challengeText || null,
    challengeMasked: challengeMasked || null,
    answerLengthHint,
    preferredSolveMode: captchaContext.preferredSolveMode || captchaContext.effectiveSolveMode || null,
    artifactPreference: extra.artifactPreference || null,
    artifactKinds: Array.isArray(extra.artifactKinds) ? extra.artifactKinds : []
  };

  if (!challengeText && !challengeMasked) {
    return {
      ...common,
      answerMode: 'vision_direct_answer',
      submitField: 'answer',
      useInferenceApi: false,
      supportsOcrCandidates: true,
      ocrCandidateSelection: 'single_candidate_if_unambiguous',
      prompt: buildDirectAnswerPrompt({ answerLengthHint }),
      responseFormat: 'single_line_exact_answer',
      nextAction: 'SUBMIT_CAPTCHA_AND_RESUME with answer (or ocrTexts when a single candidate is unambiguous)'
    };
  }

  if (challengeKind === 'masked') {
    return {
      ...common,
      answerMode: 'ocr_candidates_then_infer',
      submitField: 'ocrTexts',
      useInferenceApi: true,
      maxCandidates: 3,
      prompt: buildMaskedPrompt({ challengeText, challengeMasked, answerLengthHint }),
      responseFormat: 'newline_candidates_only',
      nextAction: 'INFER_CAPTCHA_ANSWER or SUBMIT_CAPTCHA_AND_RESUME with ocrTexts'
    };
  }

  if (challengeKind === 'instruction') {
    return {
      ...common,
      answerMode: 'read_target_full_text',
      submitField: 'answer',
      useInferenceApi: false,
      supportsOcrCandidates: true,
      ocrCandidateSelection: 'prefer_target_entity_match',
      targetEntity,
      prompt: buildInstructionPrompt({ challengeText, targetEntity }),
      responseFormat: 'single_line_exact_name',
      nextAction: 'SUBMIT_CAPTCHA_AND_RESUME with answer (or ocrTexts fallback)'
    };
  }

  return {
    ...common,
    answerMode: 'read_exact_text',
    submitField: 'answer',
    useInferenceApi: false,
    prompt: [
      '이 이미지는 티스토리 DKAPTCHA입니다.',
      `보이는 정답 텍스트를 정확히 읽어주세요. 문제 문구: "${challengeText || challengeMasked}"`,
      '답변만 한 줄로 출력하고 설명은 쓰지 마세요.'
    ].join(' '),
    responseFormat: 'single_line_exact_text',
    nextAction: 'SUBMIT_CAPTCHA_AND_RESUME with answer'
  };
}
