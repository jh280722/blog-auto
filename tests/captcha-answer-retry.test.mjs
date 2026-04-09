import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCaptchaAnswerAttemptCandidates,
  supportsRankedCaptchaAnswerRetries
} from '../utils/captcha-answer-retry.js';

test('supportsRankedCaptchaAnswerRetries enables ranked retries for masked OCR inference', () => {
  assert.equal(supportsRankedCaptchaAnswerRetries({ source: 'ocr_inference' }), true);
});

test('supportsRankedCaptchaAnswerRetries enables ranked retries for instruction OCR inference', () => {
  assert.equal(supportsRankedCaptchaAnswerRetries({ source: 'ocr_instruction_inference' }), true);
});

test('buildCaptchaAnswerAttemptCandidates keeps ranked instruction candidates for same-challenge retry', () => {
  const attempts = buildCaptchaAnswerAttemptCandidates({
    source: 'ocr_instruction_inference',
    answer: '새열린약국',
    answerCandidates: [
      { answer: '새열린약국', score: 82, reasons: ['target_suffix_match'] },
      { answer: '씨에치약국', score: 61, reasons: ['target_suffix_match'] },
      { answer: '우리내과의원', score: 30, reasons: ['target_missing'] }
    ]
  });

  assert.deepEqual(
    attempts.map((candidate) => candidate.answer),
    ['새열린약국', '씨에치약국', '우리내과의원']
  );
});

test('buildCaptchaAnswerAttemptCandidates keeps explicit answers single-shot by default', () => {
  const attempts = buildCaptchaAnswerAttemptCandidates({
    source: 'explicit_answer',
    answer: '정답'
  });

  assert.deepEqual(attempts.map((candidate) => candidate.answer), ['정답']);
});

test('buildCaptchaAnswerAttemptCandidates dedupes repeated instruction answers', () => {
  const attempts = buildCaptchaAnswerAttemptCandidates({
    source: 'ocr_instruction_inference',
    answer: '새열린약국',
    answerCandidates: [
      { answer: '새열린약국', score: 82 },
      { answer: '새 열린 약국', score: 80 },
      { answer: '씨에치약국', score: 61 }
    ]
  });

  assert.deepEqual(attempts.map((candidate) => candidate.answer), ['새열린약국', '씨에치약국']);
});
