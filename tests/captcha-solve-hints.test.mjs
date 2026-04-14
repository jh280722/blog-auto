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
  assert.equal(hints.supportsOcrCandidates, true);
  assert.equal(hints.ocrCandidateSelection, 'prefer_target_entity_match');
  assert.equal(hints.targetEntity, '한의원');
  assert.match(hints.prompt, /대상 유형: 한의원/);
  assert.match(hints.prompt, /줄바꿈 목록으로 넘겨도 됩니다/);
  assert.match(hints.nextAction, /ocrTexts fallback/);
  assert.match(hints.prompt, /전체 명칭만 한 줄/);
  assert.equal(hints.responseFormat, 'single_line_exact_name');
});

test('buildCaptchaSolveHints returns direct-answer fallback guidance when challenge text is unavailable', () => {
  const hints = buildCaptchaSolveHints({
    preferredSolveMode: 'extension_frame_dom',
    answerLengthHint: 2,
    activeCaptureCandidate: {
      kind: 'captcha_capture_candidate'
    }
  }, {
    artifactPreference: 'sourceImage',
    artifactKinds: ['sourceImage']
  });

  assert.equal(hints.challengeKind, null);
  assert.equal(hints.answerMode, 'vision_direct_answer');
  assert.equal(hints.submitField, 'answer');
  assert.equal(hints.useInferenceApi, false);
  assert.equal(hints.supportsOcrCandidates, true);
  assert.equal(hints.ocrCandidateSelection, 'single_candidate_if_unambiguous');
  assert.equal(hints.answerLengthHint, 2);
  assert.equal(hints.artifactPreference, 'sourceImage');
  assert.match(hints.prompt, /문제 문구를 DOM에서 읽지 못했습니다/);
  assert.match(hints.prompt, /정답 길이 힌트: 2자/);
  assert.match(hints.prompt, /정답만 한 줄로 출력/);
  assert.match(hints.nextAction, /answer/);
});
