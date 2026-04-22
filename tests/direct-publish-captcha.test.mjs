import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMergedDirectPublishCaptchaState,
  summarizeDirectPublishCaptchaArtifactCapture,
  summarizeDirectPublishCaptchaSubmitResult
} from '../utils/direct-publish-captcha.js';

test('buildMergedDirectPublishCaptchaState preserves prior direct-publish captcha context when a later handoff loses live context', () => {
  const nextState = buildMergedDirectPublishCaptchaState({
    existingState: {
      tabId: 321,
      status: 'captcha_required',
      url: 'https://nakseo-dev.tistory.com/manage/newpost',
      captchaContext: {
        challengeText: '백촌오피스□',
        challengeMasked: '백촌오피스□',
        solveHints: {
          prompt: '이미지에서 전체 후보 텍스트를 읽으세요.',
          submitField: 'ocrTexts'
        }
      },
      lastCaptchaArtifactCapture: {
        success: true,
        status: 'captcha_artifacts_ready',
        artifactKind: 'sourceImage',
        artifactPreference: 'sourceImage',
        captureErrorCount: 0,
        capturedAt: '2026-04-22T00:00:00.000Z'
      }
    },
    tabId: 321,
    status: 'captcha_required',
    requestData: {
      title: 'private smoke',
      visibility: 'private'
    },
    handoff: {
      captchaContext: null,
      captchaArtifacts: null
    },
    nowIso: '2026-04-22T01:02:03.000Z'
  });

  assert.deepEqual(nextState, {
    tabId: 321,
    status: 'captcha_required',
    url: 'https://nakseo-dev.tistory.com/manage/newpost',
    captchaContext: {
      challengeText: '백촌오피스□',
      challengeMasked: '백촌오피스□',
      solveHints: {
        prompt: '이미지에서 전체 후보 텍스트를 읽으세요.',
        submitField: 'ocrTexts'
      }
    },
    lastCaptchaArtifactCapture: {
      success: true,
      status: 'captcha_artifacts_ready',
      artifactKind: 'sourceImage',
      artifactPreference: 'sourceImage',
      captureErrorCount: 0,
      capturedAt: '2026-04-22T00:00:00.000Z'
    },
    requestData: {
      title: 'private smoke',
      visibility: 'private'
    },
    lastCaptchaSubmitResult: null,
    lastCheckedAt: '2026-04-22T01:02:03.000Z'
  });
});

test('buildMergedDirectPublishCaptchaState ignores stale direct-publish captcha metadata from another tab', () => {
  const nextState = buildMergedDirectPublishCaptchaState({
    existingState: {
      tabId: 111,
      status: 'captcha_required',
      url: 'https://nakseo-dev.tistory.com/manage/newpost',
      captchaContext: {
        challengeText: '다른문제□',
        solveHints: {
          prompt: 'stale prompt',
          submitField: 'ocrTexts'
        }
      },
      lastCaptchaArtifactCapture: {
        success: true,
        status: 'captcha_artifacts_ready',
        artifactKind: 'viewportCrop',
        artifactPreference: 'viewportCrop',
        captureErrorCount: 0,
        capturedAt: '2026-04-22T00:58:00.000Z'
      }
    },
    tabId: 222,
    status: 'captcha_required',
    handoff: {
      captchaContext: {
        preferredSolveMode: 'extension_frame_dom'
      },
      captchaArtifacts: null
    },
    nowIso: '2026-04-22T01:07:08.000Z'
  });

  assert.deepEqual(nextState, {
    tabId: 222,
    status: 'captcha_required',
    url: 'https://nakseo-dev.tistory.com/manage/newpost',
    captchaContext: {
      preferredSolveMode: 'extension_frame_dom'
    },
    requestData: null,
    lastCaptchaArtifactCapture: null,
    lastCaptchaSubmitResult: null,
    lastCheckedAt: '2026-04-22T01:07:08.000Z'
  });
});

test('buildMergedDirectPublishCaptchaState drops stale metadata when the prior direct-publish state has no trusted tab id', () => {
  const nextState = buildMergedDirectPublishCaptchaState({
    existingState: {
      status: 'captcha_required',
      url: 'https://nakseo-dev.tistory.com/manage/newpost',
      captchaContext: {
        challengeText: '신뢰할수없는이전문제□',
        solveHints: {
          prompt: 'stale prompt',
          submitField: 'ocrTexts'
        }
      },
      lastCaptchaArtifactCapture: {
        success: true,
        status: 'captcha_artifacts_ready',
        artifactKind: 'viewportCrop',
        artifactPreference: 'viewportCrop',
        captureErrorCount: 0,
        capturedAt: '2026-04-22T00:57:00.000Z'
      }
    },
    tabId: 222,
    handoff: {
      captchaContext: {
        preferredSolveMode: 'extension_dom'
      },
      captchaArtifacts: null
    },
    nowIso: '2026-04-22T01:08:09.000Z'
  });

  assert.deepEqual(nextState, {
    tabId: 222,
    status: 'captcha_required',
    url: 'https://nakseo-dev.tistory.com/manage/newpost',
    captchaContext: {
      preferredSolveMode: 'extension_dom'
    },
    requestData: null,
    lastCaptchaArtifactCapture: null,
    lastCaptchaSubmitResult: null,
    lastCheckedAt: '2026-04-22T01:08:09.000Z'
  });
});

test('buildMergedDirectPublishCaptchaState refreshes submit summary while keeping prior direct-publish hints when solve retries stay on the same tab', () => {
  const nextState = buildMergedDirectPublishCaptchaState({
    existingState: {
      tabId: 321,
      status: 'captcha_required',
      url: 'https://nakseo-dev.tistory.com/manage/newpost',
      captchaContext: {
        preferredSolveMode: 'extension_frame_dom',
        challengeText: '지도에 있는 약국의 전체 명칭을 입력해주세요',
        solveHints: {
          prompt: '지도에서 약국 전체 명칭을 읽으세요.',
          submitField: 'answer',
          targetEntity: '약국'
        }
      },
      lastCaptchaSubmitResult: {
        success: false,
        status: 'captcha_still_present',
        captchaStillAppears: true,
        answerLength: 5,
        normalization: '새열린약국',
        updatedAt: '2026-04-22T00:59:00.000Z'
      }
    },
    tabId: 321,
    handoff: {
      captchaContext: {
        preferredSolveMode: 'extension_frame_dom'
      },
      captchaArtifacts: {
        success: true,
        status: 'captcha_artifacts_ready',
        artifactPreference: 'sourceImage',
        artifact: { kind: 'sourceImage' },
        captureErrors: []
      }
    },
    submitResult: {
      success: true,
      status: 'captcha_still_present',
      captchaStillAppears: true,
      answerLength: 6,
      answerNormalization: '새열린약국'
    },
    nowIso: '2026-04-22T01:05:06.000Z'
  });

  assert.deepEqual(nextState, {
    tabId: 321,
    status: 'captcha_required',
    url: 'https://nakseo-dev.tistory.com/manage/newpost',
    captchaContext: {
      preferredSolveMode: 'extension_frame_dom',
      challengeText: '지도에 있는 약국의 전체 명칭을 입력해주세요',
      solveHints: {
        prompt: '지도에서 약국 전체 명칭을 읽으세요.',
        submitField: 'answer',
        targetEntity: '약국'
      }
    },
    lastCaptchaArtifactCapture: {
      success: true,
      status: 'captcha_artifacts_ready',
      artifactKind: 'sourceImage',
      artifactPreference: 'sourceImage',
      captureErrorCount: 0,
      capturedAt: '2026-04-22T01:05:06.000Z'
    },
    requestData: null,
    lastCaptchaSubmitResult: {
      success: true,
      status: 'captcha_still_present',
      captchaStillAppears: true,
      answerLength: 6,
      normalization: '새열린약국',
      updatedAt: '2026-04-22T01:05:06.000Z'
    },
    lastCheckedAt: '2026-04-22T01:05:06.000Z'
  });
});

test('summarizeDirectPublishCaptchaArtifactCapture and summarizeDirectPublishCaptchaSubmitResult stay null-safe', () => {
  assert.equal(summarizeDirectPublishCaptchaArtifactCapture(null), null);
  assert.equal(summarizeDirectPublishCaptchaSubmitResult(null), null);
});
