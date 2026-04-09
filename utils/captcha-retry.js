function normalizeOptionalText(value = '') {
  return typeof value === 'string' ? value.trim() : '';
}

function roundRectValue(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function serializeRectSignature(rect = null) {
  if (!rect || typeof rect !== 'object') return null;

  const values = [
    roundRectValue(rect.left),
    roundRectValue(rect.top),
    roundRectValue(rect.width),
    roundRectValue(rect.height)
  ];

  return values.every((value) => value === null)
    ? null
    : values.map((value) => (value === null ? '' : String(value))).join(':');
}

export function getChallengeFromCaptchaContext(captchaContext = null) {
  if (!captchaContext || typeof captchaContext !== 'object') {
    return {
      challengeText: null,
      challengeSlotCount: null,
      answerLengthHint: null,
      challengeCandidates: []
    };
  }

  const challengeCandidates = [];
  const pushCandidate = (entry) => {
    if (!entry) return;
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (!trimmed) return;
      challengeCandidates.push({ text: trimmed, maskedText: trimmed });
      return;
    }

    const text = String(entry.maskedText || entry.text || '').trim();
    if (!text) return;
    challengeCandidates.push({
      text,
      maskedText: String(entry.maskedText || entry.text || '').trim(),
      slotCount: Number(entry.slotCount) || null,
      source: entry.source || null,
      score: Number(entry.score) || null
    });
  };

  pushCandidate(captchaContext.challengeText);
  pushCandidate(captchaContext.challengeMasked);
  if (Array.isArray(captchaContext.challengeCandidates)) {
    captchaContext.challengeCandidates.forEach(pushCandidate);
  }

  const uniqueCandidates = [];
  const seenByMaskedText = new Map();
  challengeCandidates.forEach((entry) => {
    const key = String(entry.maskedText || entry.text || '').trim();
    if (!key) return;

    const existing = seenByMaskedText.get(key);
    if (!existing) {
      const candidate = { ...entry };
      uniqueCandidates.push(candidate);
      seenByMaskedText.set(key, candidate);
      return;
    }

    if (!existing.slotCount && entry.slotCount) {
      existing.slotCount = Number(entry.slotCount) || existing.slotCount || null;
    }
    if (!existing.source && entry.source) {
      existing.source = entry.source;
    }
    if (!existing.score && entry.score) {
      existing.score = entry.score;
    }
  });

  const fallbackSlotCount = Number(uniqueCandidates.find((entry) => Number(entry?.slotCount) > 0)?.slotCount) || null;

  return {
    challengeText: uniqueCandidates[0]?.maskedText || uniqueCandidates[0]?.text || null,
    challengeSlotCount: Number(captchaContext.challengeSlotCount) || fallbackSlotCount,
    answerLengthHint: Number(captchaContext.answerLengthHint) || Number(captchaContext.challengeSlotCount) || fallbackSlotCount,
    challengeCandidates: uniqueCandidates
  };
}

function buildTextSignature(challenge = {}, captchaContext = null) {
  const challengeText = normalizeOptionalText(challenge.challengeText);
  if (!challengeText) return null;

  return [
    challengeText,
    Number(challenge.challengeSlotCount) || Number(challenge.answerLengthHint) || 0,
    normalizeOptionalText(captchaContext?.preferredSolveMode || ''),
    String(captchaContext?.activeCaptureCandidate?.frameId ?? '')
  ].join('::');
}

function buildCandidateSignature(captchaContext = null) {
  const candidate = captchaContext?.activeCaptureCandidate;
  if (!candidate || typeof candidate !== 'object') return null;

  const sourceUrl = normalizeOptionalText(candidate.sourceUrl || '');
  const rectSignature = serializeRectSignature(candidate.rect);
  const tagName = normalizeOptionalText(candidate.tagName || '');
  const frameId = String(candidate.frameId ?? '');

  if (!sourceUrl && !rectSignature && !tagName && !frameId) {
    return null;
  }

  return [tagName, frameId, sourceUrl, rectSignature || ''].join('::');
}

function normalizeSignatureValue(value = null) {
  return normalizeOptionalText(value || '') || null;
}

export function buildCaptchaChallengeSignature(captchaContext = null, options = {}) {
  const challenge = getChallengeFromCaptchaContext(captchaContext);
  const textSignature = buildTextSignature(challenge, captchaContext);
  const visualSignature = normalizeSignatureValue(options.visualSignature);
  const candidateSignature = buildCandidateSignature(captchaContext);
  const comparableKinds = [
    textSignature ? 'text' : null,
    visualSignature ? 'visual' : null,
    candidateSignature ? 'candidate' : null
  ].filter(Boolean);

  return {
    challengeText: challenge.challengeText || null,
    challengeSlotCount: Number(challenge.challengeSlotCount) || Number(challenge.answerLengthHint) || null,
    textSignature,
    visualSignature,
    candidateSignature,
    comparableKinds,
    primary: textSignature || visualSignature || candidateSignature || null
  };
}

export function compareCaptchaChallengeSignatures(initialSignature = null, refreshedSignature = null) {
  const strongKinds = ['textSignature', 'visualSignature'];
  const weakKinds = ['candidateSignature'];
  const matches = [];
  const mismatches = [];
  const comparableKinds = [];

  strongKinds.forEach((kind) => {
    const initialValue = normalizeSignatureValue(initialSignature?.[kind]);
    const refreshedValue = normalizeSignatureValue(refreshedSignature?.[kind]);
    if (!initialValue || !refreshedValue) return;
    const name = kind.replace(/Signature$/, '');
    comparableKinds.push(name);
    if (initialValue === refreshedValue) {
      matches.push(name);
    } else {
      mismatches.push(name);
    }
  });

  const weakComparableKinds = [];
  if (comparableKinds.length === 0) {
    weakKinds.forEach((kind) => {
      const initialValue = normalizeSignatureValue(initialSignature?.[kind]);
      const refreshedValue = normalizeSignatureValue(refreshedSignature?.[kind]);
      if (!initialValue || !refreshedValue) return;
      const name = kind.replace(/Signature$/, '');
      weakComparableKinds.push(name);
      if (initialValue === refreshedValue) {
        matches.push(name);
      } else {
        mismatches.push(name);
      }
    });
  }

  let stable = null;
  let confidence = 'none';
  if (comparableKinds.length > 0) {
    if (matches.length > 0) {
      stable = true;
    } else {
      stable = false;
    }
    confidence = 'strong';
  } else if (weakComparableKinds.length > 0) {
    stable = null;
    confidence = 'weak';
  }

  return {
    stable,
    changed: stable === false,
    confidence,
    comparableKinds,
    weakComparableKinds,
    matchedKinds: matches,
    mismatchedKinds: mismatches
  };
}
