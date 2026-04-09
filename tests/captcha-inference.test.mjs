import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countCaptchaMaskSlots,
  inferCaptchaAnswer,
  normalizeComparableCaptchaText,
  parseCaptchaChallengeText
} from '../utils/captcha-inference.js';

test('normalizeComparableCaptchaText removes whitespace and punctuation noise', () => {
  assert.equal(normalizeComparableCaptchaText(' 용□ 유리 '), '용□유리');
  assert.equal(normalizeComparableCaptchaText('"백촌오피스□"'), '백촌오피스□');
});

test('parseCaptchaChallengeText extracts mask runs and slots', () => {
  const parsed = parseCaptchaChallengeText('가인□네오');
  assert.equal(parsed.hasMask, true);
  assert.equal(parsed.slotCount, 1);
  assert.equal(parsed.maskRunCount, 1);
  assert.deepEqual(parsed.segments, ['가인', '네오']);
  assert.equal(countCaptchaMaskSlots('□□빌네오'), 2);
});

test('parseCaptchaChallengeText keeps word-based blanks as variable-length masks', () => {
  const parsed = parseCaptchaChallengeText('관양2동 빈칸 복지센터');
  assert.equal(parsed.hasMask, true);
  assert.equal(parsed.hasVariableMask, true);
  assert.equal(parsed.slotCount, 0);
  assert.equal(parsed.maskRunCount, 1);
  assert.deepEqual(parsed.segments, ['관양2동', '복지센터']);
});

test('inferCaptchaAnswer handles a trailing missing character', () => {
  const result = inferCaptchaAnswer({
    challengeText: '백촌오피스□',
    ocrTexts: ['백촌오피스텔']
  });

  assert.equal(result.success, true);
  assert.equal(result.answer, '텔');
});

test('inferCaptchaAnswer handles a middle missing character with spaces', () => {
  const result = inferCaptchaAnswer({
    challengeText: '용□ 유리',
    ocrTexts: ['용진유리']
  });

  assert.equal(result.success, true);
  assert.equal(result.answer, '진');
});

test('inferCaptchaAnswer handles multiple leading slots', () => {
  const result = inferCaptchaAnswer({
    challengeText: '□□빌네오',
    ocrTexts: ['가인빌네오'],
    answerLengthHint: 2
  });

  assert.equal(result.success, true);
  assert.equal(result.answer, '가인');
});

test('inferCaptchaAnswer chooses the best OCR candidate by slot alignment', () => {
  const result = inferCaptchaAnswer({
    challengeText: '용□유리',
    ocrTexts: ['용산유리', '용진유리'],
    answerLengthHint: 1
  });

  assert.equal(result.success, true);
  assert.equal(result.answer, '산');
  assert.equal(result.chosenCandidate.sourceText, '용산유리');
  assert.deepEqual(result.answerCandidates.map((candidate) => candidate.answer), ['산', '진']);
});

test('inferCaptchaAnswer handles word-based blanks with fuzzy OCR on anchored text', () => {
  const result = inferCaptchaAnswer({
    challengeText: '관양2동 빈칸 복지센터',
    ocrTexts: ['관양동행정복지센터'],
    answerLengthHint: 50
  });

  assert.equal(result.success, true);
  assert.equal(result.answer, '행정');
  assert.equal(result.chosenCandidate.matchStrategy, 'fuzzy_single_mask_suffix_anchor');
  assert.equal(result.answerLengthHint, null);
});

test('inferCaptchaAnswer handles trailing word-based blanks with fuzzy OCR', () => {
  const result = inferCaptchaAnswer({
    challengeText: '신세대빌 빈칸',
    ocrTexts: ['신재대빌라']
  });

  assert.equal(result.success, true);
  assert.equal(result.answer, '라');
  assert.equal(result.chosenCandidate.matchStrategy, 'fuzzy_single_mask_trailing_blank');
});

test('inferCaptchaAnswer dedupes ranked answer candidates that resolve to the same answer', () => {
  const result = inferCaptchaAnswer({
    challengeText: '백촌오피스□',
    ocrTexts: ['백촌오피스텔', '백촌 오피스텔', '백촌오피스탤']
  });

  assert.equal(result.success, true);
  assert.equal(result.answer, '텔');
  assert.deepEqual(result.answerCandidates.map((candidate) => candidate.answer), ['텔', '탤']);
  assert.equal(result.answerCandidates[0].sourceText, '백촌오피스텔');
});

test('inferCaptchaAnswer fails cleanly when the OCR text does not match the challenge', () => {
  const result = inferCaptchaAnswer({
    challengeText: '용□유리',
    ocrTexts: ['백촌오피스텔']
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'captcha_answer_inference_failed');
  assert.deepEqual(result.answerCandidates, []);
});
