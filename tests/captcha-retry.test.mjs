import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCaptchaChallengeSignature,
  compareCaptchaChallengeSignatures,
  getChallengeFromCaptchaContext
} from '../utils/captcha-retry.js';

test('getChallengeFromCaptchaContext dedupes masked challenge candidates', () => {
  const challenge = getChallengeFromCaptchaContext({
    challengeText: '백촌오피스□',
    challengeCandidates: [
      { maskedText: '백촌오피스□', slotCount: 1 },
      { maskedText: '백촌오피스□', slotCount: 1 },
      { maskedText: '백촌오피스□□', slotCount: 2 }
    ]
  });

  assert.equal(challenge.challengeText, '백촌오피스□');
  assert.equal(challenge.challengeSlotCount, 1);
  assert.deepEqual(
    challenge.challengeCandidates.map((candidate) => `${candidate.maskedText}:${candidate.slotCount}`),
    ['백촌오피스□:1', '백촌오피스□□:2']
  );
});

test('compareCaptchaChallengeSignatures treats matching visual fallback as stable', () => {
  const initial = buildCaptchaChallengeSignature({
    challengeText: '백촌오피스□',
    challengeSlotCount: 1,
    preferredSolveMode: 'extension_frame_dom',
    activeCaptureCandidate: {
      frameId: 7,
      tagName: 'img',
      sourceUrl: 'https://captcha.example/challenge.png'
    }
  }, {
    visualSignature: 'frameDirectImage::120x40::7::abcd1234'
  });

  const refreshed = buildCaptchaChallengeSignature({
    preferredSolveMode: 'extension_frame_dom',
    activeCaptureCandidate: {
      frameId: 7,
      tagName: 'img',
      sourceUrl: 'https://captcha.example/challenge.png'
    }
  }, {
    visualSignature: 'frameDirectImage::120x40::7::abcd1234'
  });

  const comparison = compareCaptchaChallengeSignatures(initial, refreshed);
  assert.equal(comparison.stable, true);
  assert.equal(comparison.changed, false);
  assert.deepEqual(comparison.matchedKinds, ['visual']);
  assert.equal(comparison.confidence, 'strong');
});

test('compareCaptchaChallengeSignatures returns changed when all strong signatures differ', () => {
  const initial = buildCaptchaChallengeSignature({
    challengeText: '백촌오피스□',
    challengeSlotCount: 1
  }, {
    visualSignature: 'frameDirectImage::120x40::7::abcd1234'
  });

  const refreshed = buildCaptchaChallengeSignature({
    challengeText: '용진유□',
    challengeSlotCount: 1
  }, {
    visualSignature: 'frameDirectImage::120x40::7::ffff9999'
  });

  const comparison = compareCaptchaChallengeSignatures(initial, refreshed);
  assert.equal(comparison.stable, false);
  assert.equal(comparison.changed, true);
  assert.deepEqual(comparison.matchedKinds, []);
  assert.deepEqual(comparison.mismatchedKinds.sort(), ['text', 'visual']);
  assert.equal(comparison.confidence, 'strong');
});

test('compareCaptchaChallengeSignatures keeps state unknown when only weak candidate identity is comparable', () => {
  const initial = buildCaptchaChallengeSignature({
    activeCaptureCandidate: {
      frameId: 7,
      tagName: 'img',
      sourceUrl: 'https://captcha.example/challenge.png',
      rect: { left: 10, top: 20, width: 120, height: 40 }
    }
  });

  const refreshed = buildCaptchaChallengeSignature({
    activeCaptureCandidate: {
      frameId: 7,
      tagName: 'img',
      sourceUrl: 'https://captcha.example/challenge.png',
      rect: { left: 10, top: 20, width: 120, height: 40 }
    }
  });

  const comparison = compareCaptchaChallengeSignatures(initial, refreshed);
  assert.equal(comparison.stable, null);
  assert.equal(comparison.changed, false);
  assert.deepEqual(comparison.weakComparableKinds, ['candidate']);
  assert.equal(comparison.confidence, 'weak');
});
