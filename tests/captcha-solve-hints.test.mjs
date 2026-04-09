import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCaptchaSolveHints } from '../utils/captcha-solve-hints.js';

test('buildCaptchaSolveHints returns OCR-first guidance for masked DKAPTCHA', () => {
  const hints = buildCaptchaSolveHints({
    challengeText: '백촌오피스□',
    challengeMasked: '백촌오피스□',
    challengeSlotCount: 1,
    preferredSolveMode: 'extension_frame_dom'
  }, {
    artifactPreference: 'frameDirectImage',
    artifactKinds: ['frameDirectImage', 'viewportCrop']
  });

  assert.equal(hints.challengeKind, 'masked');
  assert.equal(hints.answerMode, 'ocr_candidates_then_infer');
  assert.equal(hints.submitField, 'ocrTexts');
  assert.equal(hints.useInferenceApi, true);
  assert.equal(hints.answerLengthHint, 1);
  assert.equal(hints.preferredSolveMode, 'extension_frame_dom');
  assert.equal(hints.artifactPreference, 'frameDirectImage');
  assert.match(hints.prompt, /전체 상호\/텍스트 후보/);
  assert.match(hints.nextAction, /SUBMIT_CAPTCHA_AND_RESUME/);
});

test('buildCaptchaSolveHints returns full-name guidance for instruction map DKAPTCHA', () => {
  const hints = buildCaptchaSolveHints({
    challengeText: '지도에 있는 한의원의 전체 명칭을 입력해주세요',
    challengeMasked: '지도에 있는 한의원의 전체 명칭을 입력해주세요',
    preferredSolveMode: 'extension_frame_dom'
  }, {
    artifactPreference: 'frameDirectImage'
  });

  assert.equal(hints.challengeKind, 'instruction');
  assert.equal(hints.answerMode, 'read_target_full_text');
  assert.equal(hints.submitField, 'answer');
  assert.equal(hints.useInferenceApi, false);
  assert.equal(hints.targetEntity, '한의원');
  assert.match(hints.prompt, /대상 유형: 한의원/);
  assert.match(hints.prompt, /전체 명칭만 한 줄/);
  assert.equal(hints.responseFormat, 'single_line_exact_name');
});
