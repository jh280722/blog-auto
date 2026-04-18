export function choosePreferredCaptchaArtifactKey(artifacts = {}) {
  const priority = ['sourceImage', 'frameDirectImage', 'viewportCrop', 'directImage'];
  return priority.find((key) => artifacts?.[key]?.dataUrl) || null;
}

export function normalizeCaptchaArtifactCaptureOptions(options = {}) {
  return {
    ...options,
    includeSourceImage: options?.includeSourceImage !== false
  };
}

export function shouldFetchCaptchaSourceImage({
  sourceImageUrl = '',
  includeSourceImage = true
} = {}) {
  const normalizedSourceImageUrl = typeof sourceImageUrl === 'string' ? sourceImageUrl.trim() : '';
  if (!normalizedSourceImageUrl) {
    return false;
  }

  return includeSourceImage !== false;
}

export function isAllowedCaptchaSourceUrl(sourceUrl = '') {
  const normalizedSourceUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  if (!normalizedSourceUrl) {
    return false;
  }

  const dataUrlMatch = normalizedSourceUrl.match(/^data:([^;,]+)[;,]/i);
  if (dataUrlMatch) {
    return /^image\//i.test(dataUrlMatch[1] || '');
  }

  let url;
  try {
    url = new URL(normalizedSourceUrl);
  } catch (_error) {
    return false;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return false;
  }

  const host = url.hostname.toLowerCase();
  const allowedSuffixes = [
    'tistory.com',
    'kakaocdn.net',
    'daumcdn.net'
  ];
  const isAllowedHost = allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!isAllowedHost) {
    return false;
  }

  const pathname = url.pathname.toLowerCase();
  const looksLikeCaptchaPath = pathname.includes('captcha') || pathname.includes('dkaptcha');
  const looksLikeImagePath = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(pathname);

  return looksLikeCaptchaPath || looksLikeImagePath;
}

export function resolveCaptchaArtifactSourceUrl({
  frameArtifactResult = null,
  captureContext = null,
  selectedCandidate = null,
  directImageResult = null
} = {}) {
  const candidates = [
    frameArtifactResult?.artifact?.sourceUrl,
    frameArtifactResult?.selectedCandidate?.sourceUrl,
    captureContext?.activeCaptureCandidate?.sourceUrl,
    selectedCandidate?.sourceUrl,
    directImageResult?.artifact?.sourceUrl
  ];

  for (const candidate of candidates) {
    const normalized = typeof candidate === 'string' ? candidate.trim() : '';
    if (!normalized) continue;
    if (normalized.startsWith('data:')) return normalized;
    if (/^https?:\/\//i.test(normalized)) return normalized;
  }

  return null;
}

export async function fetchCaptchaSourceImageArtifact(sourceUrl, {
  fetchImpl = globalThis.fetch,
  blobToDataUrlImpl,
  metadata = {},
  kind = 'source_image'
} = {}) {
  const normalizedSourceUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  if (!normalizedSourceUrl) {
    return {
      success: false,
      status: 'captcha_source_image_unavailable',
      error: 'captcha_source_image_missing'
    };
  }

  if (normalizedSourceUrl.startsWith('data:')) {
    if (!isAllowedCaptchaSourceUrl(normalizedSourceUrl)) {
      return {
        success: false,
        status: 'captcha_source_image_unavailable',
        error: 'captcha_source_image_url_disallowed',
        sourceUrl: normalizedSourceUrl
      };
    }

    const mimeMatch = normalizedSourceUrl.match(/^data:([^;,]+)[;,]/i);
    return {
      success: true,
      status: 'captcha_source_image_ready',
      artifact: {
        kind,
        mimeType: mimeMatch?.[1] || 'application/octet-stream',
        dataUrl: normalizedSourceUrl,
        sourceUrl: normalizedSourceUrl,
        ...metadata
      }
    };
  }

  if (!isAllowedCaptchaSourceUrl(normalizedSourceUrl)) {
    return {
      success: false,
      status: 'captcha_source_image_unavailable',
      error: 'captcha_source_image_url_disallowed',
      sourceUrl: normalizedSourceUrl
    };
  }

  if (typeof fetchImpl !== 'function') {
    return {
      success: false,
      status: 'captcha_source_image_unavailable',
      error: 'captcha_source_image_fetch_unavailable'
    };
  }

  if (typeof blobToDataUrlImpl !== 'function') {
    return {
      success: false,
      status: 'captcha_source_image_unavailable',
      error: 'captcha_source_image_blob_encoder_missing'
    };
  }

  try {
    const response = await fetchImpl(normalizedSourceUrl, { credentials: 'include', cache: 'no-store' });
    if (!response?.ok) {
      throw new Error(`captcha_source_image_fetch_${response?.status || 'failed'}`);
    }

    const blob = await response.blob();
    if (!/^image\//i.test(blob.type || '')) {
      throw new Error('captcha_source_image_not_image');
    }
    const dataUrl = await blobToDataUrlImpl(blob);

    return {
      success: true,
      status: 'captcha_source_image_ready',
      artifact: {
        kind,
        mimeType: blob.type || 'application/octet-stream',
        dataUrl,
        sourceUrl: normalizedSourceUrl,
        ...metadata
      }
    };
  } catch (error) {
    return {
      success: false,
      status: 'captcha_source_image_unavailable',
      error: error?.message || 'captcha_source_image_fetch_failed',
      sourceUrl: normalizedSourceUrl
    };
  }
}
