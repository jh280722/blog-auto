import test from 'node:test';
import assert from 'node:assert/strict';

import {
  choosePreferredCaptchaArtifactKey,
  fetchCaptchaSourceImageArtifact,
  resolveCaptchaArtifactSourceUrl
} from '../utils/captcha-artifacts.js';

test('choosePreferredCaptchaArtifactKey prioritizes source image over viewport crops', () => {
  assert.equal(choosePreferredCaptchaArtifactKey({
    viewportCrop: { dataUrl: 'data:image/png;base64,viewport' },
    sourceImage: { dataUrl: 'data:image/jpeg;base64,source' }
  }), 'sourceImage');
});

test('resolveCaptchaArtifactSourceUrl prefers the active capture candidate source url', () => {
  assert.equal(resolveCaptchaArtifactSourceUrl({
    captureContext: {
      activeCaptureCandidate: {
        sourceUrl: 'https://t1.kakaocdn.net/dkaptcha/example.jpg'
      }
    },
    selectedCandidate: {
      sourceUrl: 'https://fallback.example/image.png'
    }
  }), 'https://t1.kakaocdn.net/dkaptcha/example.jpg');
});

test('fetchCaptchaSourceImageArtifact converts fetched blobs into source image artifacts', async () => {
  const calls = [];
  const result = await fetchCaptchaSourceImageArtifact('https://t1.kakaocdn.net/dkaptcha/example.jpg', {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(['fake-image'], { type: 'image/jpeg' })
      };
    },
    blobToDataUrlImpl: async (blob) => `data:${blob.type};base64,ZmFrZS1pbWFnZQ==`,
    metadata: {
      width: 320,
      height: 180
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: 'https://t1.kakaocdn.net/dkaptcha/example.jpg',
    options: { credentials: 'include', cache: 'no-store' }
  });
  assert.equal(result.success, true);
  assert.equal(result.status, 'captcha_source_image_ready');
  assert.equal(result.artifact.kind, 'source_image');
  assert.equal(result.artifact.mimeType, 'image/jpeg');
  assert.equal(result.artifact.dataUrl, 'data:image/jpeg;base64,ZmFrZS1pbWFnZQ==');
  assert.equal(result.artifact.width, 320);
  assert.equal(result.artifact.height, 180);
});

test('fetchCaptchaSourceImageArtifact fails cleanly on fetch errors', async () => {
  const result = await fetchCaptchaSourceImageArtifact('https://t1.kakaocdn.net/dkaptcha/example.jpg', {
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      blob: async () => new Blob([], { type: 'image/jpeg' })
    }),
    blobToDataUrlImpl: async () => 'data:image/jpeg;base64,unused'
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'captcha_source_image_unavailable');
  assert.equal(result.error, 'captcha_source_image_fetch_403');
});
