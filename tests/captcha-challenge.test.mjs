import test from 'node:test';
import assert from 'node:assert/strict';

await import('../utils/captcha-challenge.js');

const {
  extractCaptchaInstructionSnippet,
  extractCaptchaMaskedSnippet,
  buildCaptchaChallengeFromTexts
} = globalThis.__BLOG_AUTO_CAPTCHA_CHALLENGE__;

test('extractCaptchaMaskedSnippet keeps blank-style challenges', () => {
  const snippet = extractCaptchaMaskedSnippet('관양2동 빈칸 복지센터');
  assert.equal(snippet.text, '관양2동 빈칸 복지센터');
  assert.equal(snippet.maskedText, '관양2동 □ 복지센터');
  assert.equal(snippet.slotCount, null);
  assert.equal(snippet.kind, 'masked');
});

test('extractCaptchaInstructionSnippet pulls the real prompt out of DKAPTCHA frame text', () => {
  const snippet = extractCaptchaInstructionSnippet(
    'DKAPTCHA (CAPTCHA 서비스) 지도에 있는 한의원의 전체 명칭을 입력해주세요 정답을 입력해주세요 새로 풀기 음성 문제 재생 답변 제출'
  );

  assert.equal(snippet.text, '지도에 있는 한의원의 전체 명칭을 입력해주세요');
  assert.equal(snippet.maskedText, '지도에 있는 한의원의 전체 명칭을 입력해주세요');
  assert.equal(snippet.slotCount, null);
  assert.equal(snippet.kind, 'instruction');
});


test('buildCaptchaChallengeFromTexts extracts the live DKAPTCHA office-tel prompt from noisy button copy', () => {
  const challenge = buildCaptchaChallengeFromTexts([
    {
      text: 'DKAPTCHA (CAPTCHA 서비스) 지도에 있는 오피스텔의 전체 명칭을 입력해주세요 정답을 입력해주세요 새로 풀기 음성 문제 재생 답변 …',
      source: 'submit_button_text',
      score: 32
    },
    {
      text: '정답을 입력해주세요 정답을 입력해주세요 정답을 입력해주세요',
      source: 'answer_input_associated',
      score: 20
    }
  ]);

  assert.equal(challenge.challengeText, '지도에 있는 오피스텔의 전체 명칭을 입력해주세요');
  assert.equal(challenge.challengeMasked, '지도에 있는 오피스텔의 전체 명칭을 입력해주세요');
  assert.equal(challenge.challengeSlotCount, null);
  assert.equal(challenge.challengeCandidates[0].kind, 'instruction');
});

test('buildCaptchaChallengeFromTexts returns instruction prompts when no masked challenge exists', () => {
  const challenge = buildCaptchaChallengeFromTexts([
    { text: 'DKAPTCHA (CAPTCHA 서비스) 지도에 있는 한의원의 전체 명칭을 입력해주세요 정답을 입력해주세요', source: 'frame_body_line', score: 36 },
    { text: '정답을 입력해주세요', source: 'frame_descriptor', score: 20 }
  ]);

  assert.equal(challenge.challengeText, '지도에 있는 한의원의 전체 명칭을 입력해주세요');
  assert.equal(challenge.challengeMasked, '지도에 있는 한의원의 전체 명칭을 입력해주세요');
  assert.equal(challenge.challengeSlotCount, null);
  assert.equal(challenge.challengeCandidates[0].kind, 'instruction');
});

test('buildCaptchaChallengeFromTexts still prefers masked challenges when both exist', () => {
  const challenge = buildCaptchaChallengeFromTexts([
    { text: '사진에 보이는 상호를 입력해주세요', source: 'frame_body_line', score: 36 },
    { text: '백촌오피스□', source: 'frame_body_line', score: 36 }
  ]);

  assert.equal(challenge.challengeText, '백촌오피스□');
  assert.equal(challenge.challengeCandidates[0].kind, 'masked');
});
