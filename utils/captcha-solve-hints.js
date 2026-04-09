import { normalizeCaptchaAnswerLengthHint, parseCaptchaChallengeText } from './captcha-inference.js';

const INSTRUCTION_ACTION_RE = /(?:입력|선택|클릭|고르|찾|맞추|완성)(?:해\s*주|해주)?세요/u;
const INSTRUCTION_TARGET_RE = /(?:지도|사진|이미지|화면)(?:에|에서)?\s*(?:있는|보이는)?\s*([^.,!?\n]{1,32}?)(?:의\s*(?:전체\s*)?(?:명칭|이름|상호|문구|텍스트|번호|주소)|을|를)\s*(?:정확한\s*)?(?:전체\s*)?(?:명칭|이름|상호|문구|텍스트|번호|주소)?\s*(?:을|를)?\s*(?:입력|선택|클릭|고르|찾|맞추|완성)/u;
const TRAILING_NOISE_RE = /\s*(?:정답(?:을)?\s*입력해주세요|답(?:을)?\s*입력해주세요|새로\s*풀기|음성\s*문제(?:\s*재생)?|답변\s*제출|DKAPTCHA(?:\s*\(CAPTCHA\s*서비스\))?|CAPTCHA\s*서비스).*$/iu;

function normalizeText(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function detectChallengeKind(challengeText = '', challengeMasked = '') {
  const parsed = parseCaptchaChallengeText(challengeText || challengeMasked || '');
  if (parsed.hasMask) return 'masked';
  if (INSTRUCTION_ACTION_RE.test(normalizeText(challengeText || challengeMasked))) return 'instruction';
  return null;
}

function extractInstructionTarget(challengeText = '') {
  const normalized = normalizeText(challengeText).replace(TRAILING_NOISE_RE, '').trim();
  if (!normalized) return null;

  const match = normalized.match(INSTRUCTION_TARGET_RE);
  if (!match?.[1]) return null;

  const target = normalizeText(match[1]).replace(/^(?:있는|보이는)\s*/u, '').trim();
  return target || null;
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
    '답변은 전체 명칭만 한 줄로 출력하고 설명은 쓰지 마세요.'
  ].filter(Boolean).join(' ');
}

export function buildCaptchaSolveHints(captchaContext = null, extra = {}) {
  if (!captchaContext || typeof captchaContext !== 'object') {
    return null;
  }

  const challengeText = normalizeText(captchaContext.challengeText || captchaContext.challengeMasked || '');
  const challengeMasked = normalizeText(captchaContext.challengeMasked || captchaContext.challengeText || '');
  if (!challengeText && !challengeMasked) {
    return null;
  }

  const challengeKind = detectChallengeKind(challengeText, challengeMasked);
  const answerLengthHint = normalizeCaptchaAnswerLengthHint(captchaContext.answerLengthHint)
    || normalizeCaptchaAnswerLengthHint(captchaContext.challengeSlotCount)
    || null;
  const targetEntity = challengeKind === 'instruction'
    ? extractInstructionTarget(challengeText || challengeMasked)
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
      targetEntity,
      prompt: buildInstructionPrompt({ challengeText, targetEntity }),
      responseFormat: 'single_line_exact_name',
      nextAction: 'SUBMIT_CAPTCHA_AND_RESUME with answer'
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
