import test from 'node:test';
import assert from 'node:assert/strict';

import {
  choosePreferredCaptchaArtifactKey,
  fetchCaptchaSourceImageArtifact,
  isAllowedCaptchaSourceUrl,
  normalizeCaptchaArtifactCaptureOptions,
  resolveCaptchaArtifactSourceUrl,
  shouldFetchCaptchaSourceImage
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

test('normalizeCaptchaArtifactCaptureOptions enables source image capture by default', () => {
  assert.deepEqual(normalizeCaptchaArtifactCaptureOptions(), {
    includeSourceImage: true
  });
  assert.deepEqual(normalizeCaptchaArtifactCaptureOptions({ viewportPadding: 24 }), {
    includeSourceImage: true,
    viewportPadding: 24
  });
  assert.deepEqual(normalizeCaptchaArtifactCaptureOptions({ includeSourceImage: undefined, viewportPadding: 8 }), {
    includeSourceImage: true,
    viewportPadding: 8
  });
  assert.deepEqual(normalizeCaptchaArtifactCaptureOptions({ includeSourceImage: null, viewportPadding: 16 }), {
    includeSourceImage: true,
    viewportPadding: 16
  });
  assert.deepEqual(normalizeCaptchaArtifactCaptureOptions({ includeSourceImage: false, viewportPadding: 12 }), {
    includeSourceImage: false,
    viewportPadding: 12
  });
});

test('shouldFetchCaptchaSourceImage honors explicit source-image opt-out', () => {
  assert.equal(shouldFetchCaptchaSourceImage({
    sourceImageUrl: 'https://example.com/captcha.jpg',
    includeSourceImage: true
  }), true);
  assert.equal(shouldFetchCaptchaSourceImage({
    sourceImageUrl: 'https://example.com/captcha.jpg',
    includeSourceImage: true
  }), true);
  assert.equal(shouldFetchCaptchaSourceImage({
    sourceImageUrl: 'https://example.com/captcha.jpg',
    includeSourceImage: false
  }), false);
  assert.equal(shouldFetchCaptchaSourceImage({
    sourceImageUrl: 'https://example.com/captcha.jpg',
    includeSourceImage: false
  }), false);
  assert.equal(shouldFetchCaptchaSourceImage({
    sourceImageUrl: '',
    includeSourceImage: true
  }), false);
});

test('isAllowedCaptchaSourceUrl only allows expected captcha image origins', () => {
  assert.equal(isAllowedCaptchaSourceUrl('data:image/png;base64,abc'), true);
  assert.equal(isAllowedCaptchaSourceUrl('data:text/html;base64,abc'), false);
  assert.equal(isAllowedCaptchaSourceUrl('https://t1.kakaocdn.net/dkaptcha/example.jpg'), true);
  assert.equal(isAllowedCaptchaSourceUrl('https://img1.daumcdn.net/images/captcha/example.png'), true);
  assert.equal(isAllowedCaptchaSourceUrl('https://nakseo-dev.tistory.com/images/captcha/example.png'), true);
  assert.equal(isAllowedCaptchaSourceUrl('https://nakseo-dev.tistory.com/manage/newpost'), false);
  assert.equal(isAllowedCaptchaSourceUrl('https://example.com/captcha.jpg'), false);
  assert.equal(isAllowedCaptchaSourceUrl('javascript:alert(1)'), false);
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

test('fetchCaptchaSourceImageArtifact rejects disallowed source origins before fetching', async () => {
  let fetchCalled = false;
  const result = await fetchCaptchaSourceImageArtifact('https://example.com/captcha.jpg', {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('should_not_fetch');
    },
    blobToDataUrlImpl: async () => 'data:image/jpeg;base64,unused'
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.success, false);
  assert.equal(result.status, 'captcha_source_image_unavailable');
  assert.equal(result.error, 'captcha_source_image_url_disallowed');
});

test('fetchCaptchaSourceImageArtifact rejects non-image data urls before returning', async () => {
  const result = await fetchCaptchaSourceImageArtifact('data:text/html;base64,PGgxPm5vdCBhbiBpbWFnZTwvaDE+');

  assert.equal(result.success, false);
  assert.equal(result.status, 'captcha_source_image_unavailable');
  assert.equal(result.error, 'captcha_source_image_url_disallowed');
});

test('fetchCaptchaSourceImageArtifact rejects non-image responses from allowed origins', async () => {
  const result = await fetchCaptchaSourceImageArtifact('https://t1.kakaocdn.net/dkaptcha/example.jpg', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(['<html></html>'], { type: 'text/html' })
    }),
    blobToDataUrlImpl: async () => 'data:text/html;base64,PGh0bWw+PC9odG1sPg=='
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'captcha_source_image_unavailable');
  assert.equal(result.error, 'captcha_source_image_not_image');
});
