(() => {
  const root = typeof globalThis !== 'undefined' ? globalThis : window;
  if (root.__BLOG_AUTO_CAPTCHA_CHALLENGE__) return;

  const CAPTCHA_MASK_CHAR_CLASS = '□▢◻◼⬜⬛◯○●◎◇◆_＿';
  const CAPTCHA_MASK_CHAR_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]/u;
  const CAPTCHA_MASK_RUN_RE = /[□▢◻◼⬜⬛◯○●◎◇◆_＿]+/gu;
  const CAPTCHA_WORD_MASK_RE = /(?:빈\s*칸|공\s*란)/u;
  const CAPTCHA_WORD_MASK_GLOBAL_RE = /(?:빈\s*칸|공\s*란)/gu;
  const CAPTCHA_INSTRUCTION_ACTION_RE = /(?:입력|선택|클릭|고르|찾|맞추|완성)(?:해\s*주|해주)?세요/u;
  const CAPTCHA_INSTRUCTION_ACTION_GLOBAL_RE = /([가-힣A-Za-z0-9][^.!?\n]{0,120}?(?:입력|선택|클릭|고르|찾|맞추|완성)(?:해\s*주|해주)?세요)/gu;
  const CAPTCHA_INSTRUCTION_KEYWORD_RE = /(지도|사진|이미지|화면|캡차|captcha|dkaptcha|있는|보이는|다음|아래|위|간판|명칭|상호|업체|장소|문구|텍스트|번호|주소|이름|병원|약국|한의원|학교|건물|매장|기관|단어|숫자)/iu;
  const CAPTCHA_INSTRUCTION_EXACT_IGNORE_RE = /^(?:정답(?:을)?\s*입력해주세요|답(?:을)?\s*입력해주세요|답변\s*제출|새로\s*풀기|음성\s*문제(?:\s*재생)?|dkaptcha(?:\s*\(captcha\s*서비스\))?|captcha\s*서비스)$/iu;
  const CAPTCHA_INSTRUCTION_TRAILING_NOISE_RE = /\s*(?:정답(?:을)?\s*입력해주세요|답(?:을)?\s*입력해주세요|새로\s*풀기|음성\s*문제(?:\s*재생)?|답변\s*제출|DKAPTCHA(?:\s*\(CAPTCHA\s*서비스\))?|CAPTCHA\s*서비스).*$/iu;
  const CAPTCHA_INSTRUCTION_LEADING_NOISE_RE = /^(?:DKAPTCHA(?:\s*\(CAPTCHA\s*서비스\))?|CAPTCHA(?:\s*서비스)?|보안문자|자동등록방지)\s*/iu;

  function normalizeText(value = '') {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function normalizeCaptchaChallengeMaskText(text = '') {
    return normalizeText(text).replace(CAPTCHA_WORD_MASK_GLOBAL_RE, '□');
  }

  function countCaptchaMaskSlots(text = '') {
    const normalized = normalizeText(text);
    const matches = normalized.match(CAPTCHA_MASK_RUN_RE);
    const explicitSlotCount = matches ? matches.reduce((sum, match) => sum + match.length, 0) : 0;
    if (explicitSlotCount > 0) return explicitSlotCount;
    return CAPTCHA_WORD_MASK_RE.test(normalized) ? null : 0;
  }

  function boundSnippet(text = '', maxLength = 72) {
    const normalized = normalizeText(text);
    return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
  }

  function extractCaptchaMaskedSnippet(text = '') {
    const normalized = normalizeText(text);
    const normalizedMaskText = normalizeCaptchaChallengeMaskText(text);
    if (!normalizedMaskText || (!CAPTCHA_MASK_CHAR_RE.test(normalizedMaskText) && !CAPTCHA_WORD_MASK_RE.test(normalized))) {
      return null;
    }

    const snippetMatch = normalizedMaskText.match(/([가-힣A-Za-z0-9]{0,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2}\s*[□▢◻◼⬜⬛◯○●◎◇◆_＿]+\s*(?:[가-힣A-Za-z0-9]{1,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2})?)/u);
    const rawSnippetMatch = normalized.match(/([가-힣A-Za-z0-9]{0,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2}\s*(?:[□▢◻◼⬜⬛◯○●◎◇◆_＿]+|빈\s*칸|공\s*란)\s*(?:[가-힣A-Za-z0-9]{1,20}(?:\s+[가-힣A-Za-z0-9]{1,20}){0,2})?)/u);
    const maskedSnippet = snippetMatch?.[1] ? normalizeText(snippetMatch[1]) : normalizedMaskText;
    const rawSnippet = rawSnippetMatch?.[1] ? normalizeText(rawSnippetMatch[1]) : normalized;

    return {
      text: boundSnippet(rawSnippet, 48),
      maskedText: boundSnippet(maskedSnippet, 48),
      slotCount: countCaptchaMaskSlots(normalized),
      kind: 'masked',
      matchScore: 24
    };
  }

  function normalizeInstructionCandidate(text = '') {
    let normalized = normalizeText(text);
    if (!normalized) return '';

    normalized = normalized.replace(CAPTCHA_INSTRUCTION_LEADING_NOISE_RE, '').trim();
    normalized = normalized.replace(CAPTCHA_INSTRUCTION_TRAILING_NOISE_RE, '').trim();
    normalized = normalized.replace(/^[-:|]\s*/, '').trim();

    return normalizeText(normalized);
  }

  function scoreInstructionCandidate(text = '') {
    const normalized = normalizeInstructionCandidate(text);
    if (!normalized || CAPTCHA_INSTRUCTION_EXACT_IGNORE_RE.test(normalized)) return null;
    if (!CAPTCHA_INSTRUCTION_ACTION_RE.test(normalized)) return null;

    let score = 10;
    if (CAPTCHA_INSTRUCTION_KEYWORD_RE.test(normalized)) score += 10;
    if (/(?:전체|정확한|일치하는|해당|같은)/u.test(normalized)) score += 4;
    if (/(?:있는|보이는|다음|아래|위)/u.test(normalized)) score += 4;
    if (normalized.length >= 12 && normalized.length <= 56) score += 3;
    if (/^(?:정답|답변)/u.test(normalized)) score -= 12;
    if (/(?:새로\s*풀기|음성\s*문제|답변\s*제출|captcha\s*서비스|dkaptcha)/iu.test(normalized)) score -= 18;
    if (score < 16) return null;

    return {
      text: boundSnippet(normalized, 80),
      maskedText: boundSnippet(normalized, 80),
      slotCount: null,
      kind: 'instruction',
      matchScore: score
    };
  }

  function extractCaptchaInstructionSnippet(text = '') {
    const normalized = normalizeText(text);
    if (!normalized) return null;

    const candidates = new Set();
    normalized.split(/\n+/).map(normalizeText).filter(Boolean).forEach((line) => candidates.add(line));
    Array.from(normalized.matchAll(CAPTCHA_INSTRUCTION_ACTION_GLOBAL_RE)).forEach((match) => {
      if (match?.[1]) candidates.add(match[1]);
    });

    let best = null;
    candidates.forEach((candidate) => {
      const scored = scoreInstructionCandidate(candidate);
      if (!scored) return;
      if (!best || scored.matchScore > best.matchScore || (scored.matchScore === best.matchScore && scored.text.length < best.text.length)) {
        best = scored;
      }
    });

    return best;
  }

  function extractCaptchaChallengeSnippet(text = '') {
    return extractCaptchaMaskedSnippet(text) || extractCaptchaInstructionSnippet(text);
  }

  function buildCaptchaChallengeFromTexts(entries = [], options = {}) {
    const challengeEntries = [];
    const maskedBonus = Number(options.maskedBonusScore) || 18;
    const instructionBonus = Number(options.instructionBonusScore) || 8;

    const pushValue = (entry) => {
      if (entry == null) return;
      const sourceText = typeof entry === 'string' ? entry : (entry.text ?? entry.value ?? '');
      const source = typeof entry === 'string' ? null : (entry.source || null);
      const baseScore = Number(typeof entry === 'string' ? 0 : entry.score) || 0;
      const snippet = extractCaptchaChallengeSnippet(sourceText);
      if (!snippet) return;

      challengeEntries.push({
        text: snippet.text,
        maskedText: snippet.maskedText || snippet.text,
        slotCount: snippet.slotCount,
        source,
        kind: snippet.kind || 'masked',
        score: baseScore + Number(snippet.matchScore || 0) + (snippet.kind === 'instruction' ? instructionBonus : maskedBonus)
      });
    };

    (Array.isArray(entries) ? entries : []).forEach(pushValue);

    const deduped = [];
    const seen = new Set();
    challengeEntries.forEach((entry) => {
      const key = [entry.kind, entry.maskedText || entry.text || '', entry.slotCount ?? 'var'].join('::');
      if (!entry.text || seen.has(key)) return;
      seen.add(key);
      deduped.push(entry);
    });

    deduped.sort((a, b) => (
      (b.score - a.score)
      || ((b.kind === 'masked') - (a.kind === 'masked'))
      || ((a.text || '').length - (b.text || '').length)
    ));

    return {
      challengeText: deduped[0]?.text || null,
      challengeMasked: deduped[0]?.maskedText || deduped[0]?.text || null,
      challengeSlotCount: Number.isFinite(deduped[0]?.slotCount) ? deduped[0].slotCount : null,
      challengeKind: deduped[0]?.kind || null,
      challengeCandidates: deduped.slice(0, 5)
    };
  }

  root.__BLOG_AUTO_CAPTCHA_CHALLENGE__ = {
    normalizeCaptchaChallengeMaskText,
    countCaptchaMaskSlots,
    extractCaptchaMaskedSnippet,
    extractCaptchaInstructionSnippet,
    extractCaptchaChallengeSnippet,
    buildCaptchaChallengeFromTexts
  };
})();
