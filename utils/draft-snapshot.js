(function(root, factory) {
  const api = factory();

  if (root) {
    root.__BLOG_AUTO_DRAFT_SNAPSHOT__ = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function normalizeDraftText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function getLocalDraftMetrics(contentHtml = '', contentText = '') {
    const html = String(contentHtml || '');
    const normalizedText = normalizeDraftText(contentText);
    return {
      contentHtmlLength: html.trim().length,
      contentTextLength: normalizedText.length,
      imageCount: (html.match(/<img\b/gi) || []).length,
      contentPreview: normalizedText.slice(0, 160)
    };
  }

  function shouldReadMainWorldSnapshot({ editorReady = false, localHtmlLength = 0, localTextLength = 0 } = {}) {
    return !editorReady || localHtmlLength === 0 || localTextLength === 0;
  }

  function mergeDraftSnapshotMetrics({
    localMetrics = {},
    mainWorldSnapshot = null
  } = {}) {
    const local = {
      contentHtmlLength: Number(localMetrics.contentHtmlLength) || 0,
      contentTextLength: Number(localMetrics.contentTextLength) || 0,
      imageCount: Number(localMetrics.imageCount) || 0,
      contentPreview: String(localMetrics.contentPreview || '')
    };

    const mainWorld = {
      contentHtmlLength: Number(mainWorldSnapshot?.htmlLength) || 0,
      contentTextLength: Number(mainWorldSnapshot?.textLength) || 0,
      imageCount: Number(mainWorldSnapshot?.imageCount) || 0,
      contentPreview: normalizeDraftText(mainWorldSnapshot?.textPreview || '')
    };

    return {
      contentHtmlLength: Math.max(local.contentHtmlLength, mainWorld.contentHtmlLength),
      contentTextLength: Math.max(local.contentTextLength, mainWorld.contentTextLength),
      imageCount: Math.max(local.imageCount, mainWorld.imageCount),
      contentPreview: local.contentPreview || mainWorld.contentPreview || ''
    };
  }

  return {
    normalizeDraftText,
    getLocalDraftMetrics,
    shouldReadMainWorldSnapshot,
    mergeDraftSnapshotMetrics
  };
});
