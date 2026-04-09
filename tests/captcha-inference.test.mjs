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
