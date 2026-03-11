/**
 * 티스토리 에디터 DOM 조작 Content Script
 * 실제 티스토리 에디터(2025년 기준) DOM 구조에 맞게 작성됨
 * 티스토리 글쓰기 페이지에서 자동으로 실행됩니다.
 */

(() => {
  'use strict';

  const S = window.__TISTORY_SELECTORS || SELECTORS;
  const IMG = window.__IMAGE_HANDLER || ImageHandler;
  const MANAGE_POST_DIAG_KEY = '__blog_auto_last_manage_post_diag';
  const MANAGE_POST_DIAG_ATTR = 'data-blog-auto-last-manage-post-diag';
  const MANAGE_POST_SEQ_ATTR = 'data-blog-auto-last-manage-post-seq';
  const STAGE_JITTER_DEFAULTS = {
    enabled: true,
    extraRatio: 0.18,
    minExtraMs: 20,
    maxExtraMs: 450
  };

  function visibilityToNumber(visibility = 'public') {
    return visibility === 'private' ? 0 : visibility === 'protected' ? 15 : 20;
  }

  function installPostVisibilityInterceptor() {
    chrome.runtime.sendMessage({ action: 'INJECT_MAIN_WORLD_VISIBILITY_HELPER' })
      .catch((error) => {
        console.warn('[TistoryAuto] MAIN world interceptor 초기 주입 실패:', error);
      });
  }

  // 유틸: 요소 대기 (최대 timeout ms)
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`[TistoryAuto] 요소를 찾을 수 없음: ${selector}`));
      }, timeout);
    });
  }

  // 유틸: 여러 셀렉터 중 존재하는 요소 반환
  function findElement(primary, fallback) {
    let el = document.querySelector(primary);
    if (!el && fallback) {
      const selectors = fallback.split(',').map(s => s.trim());
      for (const sel of selectors) {
        try {
          el = document.querySelector(sel);
          if (el) break;
        } catch (e) { /* invalid selector, skip */ }
      }
    }
    return el;
  }

  // 유틸: 짧은 딜레이
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function normalizeStageJitterOptions(options = null) {
    if (!options || options.enabled === false) {
      return { enabled: false, extraRatio: 0, minExtraMs: 0, maxExtraMs: 0 };
    }

    return {
      enabled: true,
      extraRatio: clamp(Number(options.extraRatio) || 0, 0, 1),
      minExtraMs: Math.max(0, Number(options.minExtraMs) || 0),
      maxExtraMs: Math.max(0, Number(options.maxExtraMs) || 0)
    };
  }

  function getJitterDelay(baseMs, options = null) {
    const normalizedBaseMs = Math.max(0, Number(baseMs) || 0);
    const normalized = normalizeStageJitterOptions(options);

    if (!normalized.enabled || normalizedBaseMs === 0) {
      return {
        enabled: false,
        baseMs: normalizedBaseMs,
        extraMs: 0,
        waitMs: normalizedBaseMs
      };
    }

    const computedExtraMax = Math.min(
      normalized.maxExtraMs || Math.round(normalizedBaseMs * normalized.extraRatio),
      Math.round(normalizedBaseMs * normalized.extraRatio)
    );
    const extraMaxMs = Math.max(0, computedExtraMax);
    const extraMinMs = Math.min(extraMaxMs, normalized.minExtraMs);
    const extraMs = extraMaxMs > 0
      ? extraMinMs + Math.floor(Math.random() * (extraMaxMs - extraMinMs + 1))
      : 0;

    return {
      enabled: true,
      baseMs: normalizedBaseMs,
      extraMs,
      waitMs: normalizedBaseMs + extraMs
    };
  }

  async function delayWithStageJitter(baseMs, options = null) {
    const jitter = getJitterDelay(baseMs, options);
    await delay(jitter.waitMs);
    return jitter;
  }

  function cloneTraceEntries(trace = []) {
    return Array.isArray(trace)
      ? trace.map(entry => (entry && typeof entry === 'object' ? { ...entry } : entry)).filter(Boolean)
      : [];
  }

  function buildTraceEntry(stage, extra = {}) {
    const entry = {
      stage,
      phase: extra.phase || 'content',
      at: new Date().toISOString()
    };

    for (const [key, value] of Object.entries(extra || {})) {
      if (key === 'phase' || value === undefined) continue;
      entry[key] = value;
    }

    return entry;
  }

  function pushTraceEntry(trace, stage, extra = {}) {
    const entry = buildTraceEntry(stage, extra);
    trace.push(entry);
    return entry;
  }

  function attachTraceMetadata(response, traceKey, trace, stage, phase, extra = {}) {
    const normalizedTrace = cloneTraceEntries(trace);
    const lastTransition = normalizedTrace.length > 0 ? normalizedTrace[normalizedTrace.length - 1] : null;

    return {
      ...response,
      ...extra,
      phase,
      stage,
      lastTransition,
      [traceKey]: normalizedTrace
    };
  }

  function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function safeJsonParse(value) {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }

  function getLastManagePostDiag() {
    const attrValue = document.documentElement.getAttribute(MANAGE_POST_DIAG_ATTR);
    const attrDiag = safeJsonParse(attrValue);
    if (attrDiag) return attrDiag;

    try {
      return safeJsonParse(localStorage.getItem(MANAGE_POST_DIAG_KEY));
    } catch (_) {
      return null;
    }
  }

  function getLastManagePostSeq() {
    const diag = getLastManagePostDiag();
    if (Number.isFinite(Number(diag?.sequence))) {
      return Number(diag.sequence);
    }

    const attrSeq = Number(document.documentElement.getAttribute(MANAGE_POST_SEQ_ATTR));
    return Number.isFinite(attrSeq) ? attrSeq : 0;
  }

  function clearLastManagePostDiag() {
    document.documentElement.removeAttribute(MANAGE_POST_DIAG_ATTR);
    document.documentElement.removeAttribute(MANAGE_POST_SEQ_ATTR);

    try {
      localStorage.removeItem(MANAGE_POST_DIAG_KEY);
    } catch (_) {}
  }

  async function waitForNextManagePostDiag(previousSeq = 0, timeout = 15000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const diag = getLastManagePostDiag();
      const sequence = Number(diag?.sequence || 0);
      if (diag && sequence > previousSeq) {
        return diag;
      }
      await delay(250);
    }

    return null;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function summarizeHtmlContent(html = '') {
    const rawHtml = String(html ?? '');
    const parserDoc = document.implementation.createHTMLDocument('tistory-auto');
    const container = parserDoc.createElement('div');
    container.innerHTML = rawHtml;

    const images = Array.from(container.querySelectorAll('img'));
    const text = normalizeText(container.textContent || '');

    return {
      htmlLength: rawHtml.trim().length,
      textLength: text.length,
      imageCount: images.length,
      dataImageCount: images.filter((img) => /^data:image\//i.test(img.getAttribute('src') || '')).length,
      blobImageCount: images.filter((img) => /^blob:/i.test(img.getAttribute('src') || '')).length,
      remoteImageCount: images.filter((img) => /^https?:\/\//i.test(img.getAttribute('src') || '')).length,
      hasMeaningfulContent: text.length > 0 || images.length > 0
    };
  }

  function getMinimumAcceptedTextLength(textLength) {
    const length = Number(textLength) || 0;
    if (length <= 0) return 0;
    if (length <= 20) return 1;
    if (length <= 80) return Math.max(8, Math.floor(length * 0.6));
    return Math.max(24, Math.floor(length * 0.7));
  }

  function getEditorTextareaElement(editor = getTinyMCEEditor()) {
    const element = editor?.getElement?.();
    if (element && element.tagName === 'TEXTAREA') return element;
    return document.querySelector('textarea[name="content"], textarea[id*="editor"], textarea[style*="display: none"]');
  }

  function getEditorTextareaValue(editor = getTinyMCEEditor()) {
    const textarea = getEditorTextareaElement(editor);
    return textarea && 'value' in textarea ? String(textarea.value || '') : '';
  }

  function getEditorHtml(editor = getTinyMCEEditor()) {
    if (editor) {
      try {
        return editor.getContent({ format: 'html' }) || '';
      } catch (_) {}
    }

    const editorDoc = getEditorDocument();
    const body = editorDoc ? getEditorBody(editorDoc) : null;
    return body?.innerHTML || '';
  }

  function getEditorSnapshot() {
    const editor = getTinyMCEEditor();
    const html = getEditorHtml(editor);
    const summary = summarizeHtmlContent(html);
    const textareaValue = getEditorTextareaValue(editor);
    const textareaSummary = summarizeHtmlContent(textareaValue);
    const textareaSynced = !editor || !summary.hasMeaningfulContent || (
      textareaSummary.htmlLength > 0
      && (summary.textLength === 0 || textareaSummary.textLength >= getMinimumAcceptedTextLength(summary.textLength))
      && textareaSummary.imageCount >= summary.imageCount
    );

    return {
      ...summary,
      hasTinyMce: !!editor,
      textareaHtmlLength: textareaSummary.htmlLength,
      textareaTextLength: textareaSummary.textLength,
      textareaImageCount: textareaSummary.imageCount,
      textareaSynced
    };
  }

  function compareContentSummaries(expected = {}, actual = {}) {
    const issues = [];

    if (expected.hasMeaningfulContent && !actual.hasMeaningfulContent) {
      issues.push('editor_content_missing');
    }

    if ((expected.textLength || 0) > 0) {
      const minTextLength = getMinimumAcceptedTextLength(expected.textLength);
      if ((actual.textLength || 0) < minTextLength) {
        issues.push('text_length_too_small');
      }
    }

    if ((expected.imageCount || 0) > 0 && (actual.imageCount || 0) < expected.imageCount) {
      issues.push('image_count_too_small');
    }

    return issues;
  }

  function summarizeSnapshotForLog(snapshot) {
    return {
      textLength: snapshot?.textLength || 0,
      imageCount: snapshot?.imageCount || 0,
      dataImageCount: snapshot?.dataImageCount || 0,
      blobImageCount: snapshot?.blobImageCount || 0,
      textareaTextLength: snapshot?.textareaTextLength || 0,
      textareaImageCount: snapshot?.textareaImageCount || 0,
      textareaSynced: !!snapshot?.textareaSynced
    };
  }

  function formatPersistenceIssues(issues = []) {
    const messages = {
      editor_content_missing: '에디터 본문이 비어 있습니다.',
      text_length_too_small: '에디터 본문 길이가 기대치보다 너무 짧습니다.',
      image_count_too_small: '에디터 이미지 개수가 기대치보다 적습니다.',
      editor_textarea_not_synced: 'TinyMCE 내부 textarea 동기화가 확인되지 않았습니다.',
      publish_request_missing: '발행 요청(payload)을 확인하지 못했습니다.',
      publish_request_empty: '발행 payload가 비어 있습니다.',
      publish_request_text_too_small: '발행 payload 본문이 기대치보다 너무 짧습니다.',
      publish_request_images_missing: '발행 payload에서 이미지가 누락되었습니다.',
      publish_request_transient_images: '발행 payload에 data/blob 이미지가 남아 있습니다.'
    };

    return issues.map((issue) => messages[issue] || issue).join(' ');
  }

  async function syncEditorState(reason = 'sync') {
    const editor = getTinyMCEEditor();
    if (editor) {
      try { editor.save(); } catch (_) {}
      try { editor.fire('input'); } catch (_) {}
      try { editor.fire('change'); } catch (_) {}
    }

    const editorDoc = getEditorDocument();
    const body = editorDoc ? getEditorBody(editorDoc) : null;
    if (body) {
      body.dispatchEvent(new Event('input', { bubbles: true }));
      body.dispatchEvent(new Event('change', { bubbles: true }));
    }

    await delay(250);
    const snapshot = getEditorSnapshot();
    console.log('[TistoryAuto] 에디터 동기화:', reason, summarizeSnapshotForLog(snapshot));
    return snapshot;
  }

  async function waitForEditorCondition(predicate, options = {}) {
    const timeout = options.timeout ?? 10000;
    const interval = options.interval ?? 300;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const snapshot = getEditorSnapshot();
      if (predicate(snapshot)) {
        return snapshot;
      }
      await delay(interval);
    }

    return null;
  }

  async function ensureEditorStatePersistence(expectedSummary = null, options = {}) {
    const snapshot = await syncEditorState(options.reason || 'sync');
    const issues = expectedSummary ? compareContentSummaries(expectedSummary, snapshot) : [];

    if (snapshot.hasMeaningfulContent && !snapshot.textareaSynced) {
      issues.push('editor_textarea_not_synced');
    }

    const success = issues.length === 0;
    return {
      success,
      snapshot,
      issues,
      status: issues.includes('editor_textarea_not_synced')
        ? 'content_not_synced'
        : (issues.includes('editor_content_missing') ? 'content_empty' : 'verification_failed'),
      error: success ? null : formatPersistenceIssues(issues)
    };
  }

  function verifyPublishRequestPersistence(expectedSnapshot, requestDiag) {
    const issues = [];

    if (!requestDiag) {
      issues.push('publish_request_missing');
      return {
        confirmed: false,
        status: 'persistence_unverified',
        issues,
        error: formatPersistenceIssues(issues),
        requestDiag: null
      };
    }

    const requestHasContent = (requestDiag.textLength || 0) > 0 || (requestDiag.imageCount || 0) > 0;
    if (!requestHasContent) {
      issues.push('publish_request_empty');
    }

    if ((expectedSnapshot?.textLength || 0) > 0) {
      const minTextLength = getMinimumAcceptedTextLength(expectedSnapshot.textLength);
      if ((requestDiag.textLength || 0) < minTextLength) {
        issues.push('publish_request_text_too_small');
      }
    }

    if ((expectedSnapshot?.imageCount || 0) > 0 && (requestDiag.imageCount || 0) < expectedSnapshot.imageCount) {
      issues.push('publish_request_images_missing');
    }

    if ((requestDiag.dataImageCount || 0) > 0 || (requestDiag.blobImageCount || 0) > 0) {
      issues.push('publish_request_transient_images');
    }

    return {
      confirmed: issues.length === 0,
      status: issues.length === 0 ? 'confirmed' : 'persistence_unverified',
      issues,
      error: issues.length === 0 ? null : formatPersistenceIssues(issues),
      requestDiag
    };
  }

  function matchesVisibilityText(text, visibility = 'public') {
    const normalized = normalizeText(text);
    if (!normalized) return false;

    if (visibility === 'private') {
      return /비공개/.test(normalized);
    }

    if (visibility === 'protected') {
      return /보호/.test(normalized);
    }

    return /공개/.test(normalized) && !/비공개|보호/.test(normalized);
  }

  function isActionText(text) {
    return /(발행|저장|닫기|취소|완료|확인)/.test(normalizeText(text));
  }

  function getVisibilitySpec(visibility = 'public') {
    switch (visibility) {
      case 'private':
        return { expectedValue: '0', visibility };
      case 'protected':
        return { expectedValue: '15', visibility };
      case 'public':
      default:
        return { expectedValue: '20', visibility: 'public' };
    }
  }

  function getVisiblePublishLayer() {
    const selectors = [
      '.publish-layer',
      '#publish-layer',
      '.layer-publish',
      '.ReactModal__Content',
      '[role="dialog"]',
      '[class*="publish"][class*="layer"]'
    ];

    for (const selector of selectors) {
      const candidates = document.querySelectorAll(selector);
      for (const candidate of candidates) {
        if (isVisibleElement(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  function getAssociatedText(element) {
    if (!element) return '';

    const parts = [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.textContent
    ];

    if (element.matches?.('input, textarea, select')) {
      parts.push(element.value);

      const closestLabel = element.closest('label');
      if (closestLabel) {
        parts.push(closestLabel.textContent);
      }

      if (element.id) {
        const linkedLabel = document.querySelector(`label[for="${element.id}"]`);
        if (linkedLabel) {
          parts.push(linkedLabel.textContent);
        }
      }

      parts.push(element.parentElement?.textContent || '');
    }

    return normalizeText(parts.filter(Boolean).join(' '));
  }

  function getConfirmButton() {
    return findElement(S.publish.confirmButton, null)
      || Array.from(document.querySelectorAll('button')).find((button) => {
        const text = normalizeText(button.textContent);
        return /(발행|저장)/.test(text) && button.closest('.layer_foot, .wrap_btn, .ReactModal__Content, .publish-layer, #publish-layer, .layer-publish');
      })
      || null;
  }

  function resolveVisibilityControl(scope, visibility = 'public') {
    const spec = getVisibilitySpec(visibility);
    const radios = Array.from(scope.querySelectorAll('input[type="radio"]'));

    const radio = radios.find((candidate) => normalizeText(candidate.value) === spec.expectedValue)
      || radios.find((candidate) => matchesVisibilityText(getAssociatedText(candidate), visibility));

    if (radio) {
      const linkedLabel = radio.id ? document.querySelector(`label[for="${radio.id}"]`) : null;
      const closestLabel = radio.closest('label');
      return {
        radio,
        clickTarget: linkedLabel || closestLabel || radio,
        source: linkedLabel || closestLabel ? 'label' : 'radio'
      };
    }

    const clickables = Array.from(scope.querySelectorAll('label, [role="radio"], button, [aria-checked], [aria-pressed]'));
    const clickable = clickables.find((candidate) => {
      const text = getAssociatedText(candidate);
      if (!matchesVisibilityText(text, visibility)) return false;
      if (isActionText(text)) return false;
      return isVisibleElement(candidate) || isVisibleElement(candidate.parentElement) || isVisibleElement(candidate.closest('label, div, li'));
    });

    if (!clickable) return null;

    const linkedRadio = clickable.getAttribute?.('for')
      ? document.getElementById(clickable.getAttribute('for'))
      : clickable.querySelector?.('input[type="radio"]')
        || clickable.closest('label')?.querySelector?.('input[type="radio"]')
        || null;

    return {
      radio: linkedRadio || null,
      clickTarget: clickable,
      source: 'clickable'
    };
  }

  function verifyVisibilitySelection(visibility = 'public') {
    const spec = getVisibilitySpec(visibility);
    const publishLayer = getVisiblePublishLayer() || document;
    const checkedRadio = Array.from(document.querySelectorAll('input[type="radio"]:checked')).find((candidate) => {
      return normalizeText(candidate.value) === spec.expectedValue
        || matchesVisibilityText(getAssociatedText(candidate), visibility);
    });

    const statefulMatch = Array.from(publishLayer.querySelectorAll('[role="radio"][aria-checked="true"], [aria-pressed="true"], .selected, .active, .checked')).find((candidate) => {
      const text = getAssociatedText(candidate);
      return matchesVisibilityText(text, visibility) && !isActionText(text);
    });

    const confirmBtn = getConfirmButton();
    const publishBtnText = normalizeText(confirmBtn?.textContent || '');
    const buttonMatches = matchesVisibilityText(publishBtnText, visibility);
    const checkedValue = normalizeText(checkedRadio?.value || '');

    return {
      success: !!(checkedRadio || statefulMatch || buttonMatches),
      checkedValue: checkedValue || null,
      expectedValue: spec.expectedValue,
      publishBtnText: publishBtnText || null
    };
  }

  function triggerVisibilityClick(target) {
    if (!target) return;
    target.focus?.();
    if (typeof target.click === 'function') {
      target.click();
    } else {
      target.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  }

  // 유틸: input/textarea 이벤트 시뮬레이션 (React/Vue 호환)
  function simulateInput(element, value) {
    const nextValue = value == null ? '' : String(value);

    if (element.isContentEditable) {
      element.focus?.();
      element.textContent = nextValue;
    } else {
      const proto = element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;

      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(element, nextValue);
      } else {
        element.value = nextValue;
      }

      if (typeof element.setSelectionRange === 'function') {
        element.setSelectionRange(nextValue.length, nextValue.length);
      }
    }

    element.dispatchEvent(new Event('beforeinput', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  /**
   * 제목 입력 (textarea#post-title-inp)
   */
  async function setTitle(title) {
    try {
      const titleEl = findElement(S.title.input, S.title.fallback);
      if (!titleEl) throw new Error('제목 입력 요소를 찾을 수 없음');

      titleEl.focus();
      await delay(100);
      simulateInput(titleEl, title);
      // 추가 이벤트: 티스토리가 keyup으로 제목 변경을 감지할 수 있음
      titleEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      titleEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
      await delay(100);
      titleEl.blur();
      console.log('[TistoryAuto] 제목 입력 완료:', title);
      return { success: true };
    } catch (error) {
      console.error('[TistoryAuto] 제목 입력 실패:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * TinyMCE iframe 에디터의 내부 document 가져오기
   */
  function getEditorDocument() {
    // 1차: 알려진 TinyMCE iframe
    const iframe = document.querySelector(S.editor.iframe);
    if (iframe) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) return doc;
      } catch (e) { /* cross-origin */ }
    }

    // 2차: 다른 iframe에서 tinymce body 찾기
    const iframes = document.querySelectorAll('iframe');
    for (const f of iframes) {
      try {
        const doc = f.contentDocument || f.contentWindow?.document;
        if (doc) {
          const body = doc.querySelector(S.editor.contentArea) || doc.body;
          if (body && (body.id === 'tinymce' || body.getAttribute('contenteditable') === 'true')) {
            return doc;
          }
        }
      } catch (e) { /* cross-origin iframe, skip */ }
    }

    // 3차: contenteditable 직접 탐색
    const editable = document.querySelector('[contenteditable="true"]');
    if (editable) return document;

    return null;
  }

  /**
   * 에디터 본문 영역 가져오기
   */
  function getEditorBody(editorDoc) {
    return editorDoc.querySelector(S.editor.contentArea)
      || editorDoc.querySelector('.mce-content-body')
      || editorDoc.body;
  }

  /**
   * TinyMCE activeEditor 가져오기 (안전하게)
   */
  function getTinyMCEEditor() {
    if (window.tinymce?.activeEditor) return window.tinymce.activeEditor;
    try {
      const iframe = document.querySelector(S.editor.iframe);
      const win = iframe?.contentWindow;
      if (win?.tinymce?.activeEditor) return win.tinymce.activeEditor;
    } catch (e) { /* cross-origin */ }
    try {
      if (window.tinymce?.editors?.length > 0) return window.tinymce.editors[0];
    } catch (e) { /* not available */ }
    return null;
  }

  function deriveEditorNotReadyReason(probe) {
    if (!probe.isEditorPage) return 'not_editor_page';
    if (probe.captchaPresent) return 'captcha_present';
    if (probe.publishLayerPresent) return 'publish_layer_open';
    if (!probe.titleInputPresent) return 'title_input_missing';
    if (!probe.editorDocumentPresent) {
      if (probe.editorIframePresent && !probe.editorIframeAccessible) return 'editor_iframe_inaccessible';
      if (probe.editorIframePresent) return 'editor_iframe_loading';
      if (probe.fallbackEditablePresent) return 'fallback_editor_not_ready';
      return probe.documentReadyState !== 'complete' ? 'document_loading' : 'editor_document_missing';
    }
    if (!probe.editorBodyPresent) return 'editor_body_missing';
    if (!probe.editorBodyContentEditable) return 'editor_body_not_editable';
    if (probe.tinyMceActiveEditorPresent && !probe.tinyMceInitialized) return 'tinymce_not_initialized';
    if (probe.tinyMceActiveEditorPresent && !probe.tinyMceBodyPresent) return 'tinymce_body_missing';
    if (probe.documentReadyState !== 'complete') return 'document_loading';
    return null;
  }

  function formatEditorNotReadyMessage(reason, probe) {
    const messages = {
      not_editor_page: '현재 탭이 티스토리 글쓰기 페이지가 아닙니다.',
      captcha_present: '현재 탭에 CAPTCHA가 떠 있어 새 쓰기를 시작할 수 없습니다.',
      publish_layer_open: '발행 레이어가 열린 상태라 새 쓰기를 시작할 수 없습니다.',
      title_input_missing: '제목 입력란이 아직 준비되지 않았습니다.',
      editor_iframe_inaccessible: '에디터 iframe에 접근할 수 없습니다.',
      editor_iframe_loading: '에디터 iframe이 아직 로드되지 않았습니다.',
      fallback_editor_not_ready: 'fallback contenteditable 에디터가 아직 준비되지 않았습니다.',
      document_loading: '페이지 문서가 아직 완전히 로드되지 않았습니다.',
      editor_document_missing: '에디터 document를 아직 찾지 못했습니다.',
      editor_body_missing: '에디터 본문 영역을 아직 찾지 못했습니다.',
      editor_body_not_editable: '에디터 본문이 아직 편집 가능한 상태가 아닙니다.',
      tinymce_not_initialized: 'TinyMCE가 아직 초기화되지 않았습니다.',
      tinymce_body_missing: 'TinyMCE body가 아직 연결되지 않았습니다.'
    };

    const base = messages[reason] || '실제 에디터가 아직 준비되지 않았습니다.';
    const pageUrl = probe?.url ? ` (${probe.url})` : '';
    return `${base}${pageUrl}`;
  }

  function getEditorReadinessProbe() {
    const titleEl = findElement(S.title.input, S.title.fallback);
    const editorIframe = document.querySelector(S.editor.iframe);
    let editorIframeAccessible = false;
    let editorIframeReadyState = null;
    let editorIframeBody = null;

    if (editorIframe) {
      try {
        const iframeDoc = editorIframe.contentDocument || editorIframe.contentWindow?.document || null;
        editorIframeAccessible = !!iframeDoc;
        editorIframeReadyState = iframeDoc?.readyState || null;
        editorIframeBody = iframeDoc ? getEditorBody(iframeDoc) : null;
      } catch (error) {
        editorIframeAccessible = false;
        editorIframeReadyState = error?.name || 'iframe_access_failed';
      }
    }

    const editorDoc = getEditorDocument();
    const editorBody = editorDoc ? getEditorBody(editorDoc) : null;
    const fallbackEditable = document.querySelector(S.editor.fallback);
    const tinyEditor = getTinyMCEEditor();
    let tinyMceInitialized = false;
    let tinyMceBody = null;

    if (tinyEditor) {
      try {
        tinyMceInitialized = tinyEditor.initialized !== false;
      } catch (_) {
        tinyMceInitialized = true;
      }

      try {
        tinyMceBody = typeof tinyEditor.getBody === 'function' ? tinyEditor.getBody() : null;
      } catch (_) {
        tinyMceBody = null;
      }
    }

    const editorBodyContentEditable = !!(editorBody && (
      editorBody.isContentEditable
      || editorBody.getAttribute('contenteditable') === 'true'
      || editorBody.id === 'tinymce'
      || editorBody.classList?.contains('mce-content-body')
    ));

    const probe = {
      url: window.location.href,
      title: document.title,
      documentReadyState: document.readyState,
      isNewPost: window.location.pathname.includes(S.page.newPost),
      isEditPost: window.location.pathname.includes(S.page.editPost),
      isEditorPage: window.location.pathname.includes(S.page.newPost) || window.location.pathname.includes(S.page.editPost),
      titleInputPresent: !!titleEl,
      editorIframePresent: !!editorIframe,
      editorIframeAccessible,
      editorIframeReadyState,
      editorIframeBodyPresent: !!editorIframeBody,
      editorDocumentPresent: !!editorDoc,
      editorDocumentReadyState: editorDoc?.readyState || null,
      editorBodyPresent: !!editorBody,
      editorBodyTagName: editorBody?.tagName?.toLowerCase() || null,
      editorBodyId: editorBody?.id || null,
      editorBodyContentEditable,
      fallbackEditablePresent: !!fallbackEditable,
      fallbackEditableVisible: !!(fallbackEditable && isVisibleElement(fallbackEditable)),
      tinyMcePresent: !!window.tinymce,
      tinyMceEditorCount: Array.isArray(window.tinymce?.editors) ? window.tinymce.editors.length : 0,
      tinyMceActiveEditorPresent: !!tinyEditor,
      tinyMceInitialized,
      tinyMceBodyPresent: !!tinyMceBody,
      tinyMceBodyEditable: !!(tinyMceBody && (
        tinyMceBody.isContentEditable
        || tinyMceBody.getAttribute('contenteditable') === 'true'
      )),
      publishLayerPresent: !!getVisiblePublishLayer(),
      confirmButtonPresent: !!getConfirmButton(),
      captchaPresent: detectCaptcha()
    };

    probe.ready = !!(
      probe.isEditorPage
      && probe.titleInputPresent
      && probe.editorDocumentPresent
      && probe.editorBodyPresent
      && probe.editorBodyContentEditable
      && (!probe.tinyMceActiveEditorPresent || (probe.tinyMceInitialized && probe.tinyMceBodyPresent))
      && !probe.publishLayerPresent
      && !probe.captchaPresent
    );
    probe.reason = probe.ready ? null : deriveEditorNotReadyReason(probe);
    probe.reasonMessage = probe.ready ? null : formatEditorNotReadyMessage(probe.reason, probe);

    return probe;
  }

  async function waitForEditorReady(options = {}) {
    const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
    const intervalMs = Math.max(100, Number(options.intervalMs) || 250);
    const settleDelayMs = Math.max(0, Number(options.settleDelayMs) || 0);
    const startedAt = Date.now();
    let pollCount = 0;
    let probe = getEditorReadinessProbe();
    pollCount += 1;

    while (!probe.ready && Date.now() - startedAt < timeoutMs) {
      await delay(intervalMs);
      probe = getEditorReadinessProbe();
      pollCount += 1;
    }

    if (probe.ready && settleDelayMs > 0) {
      await delay(settleDelayMs);
      probe = getEditorReadinessProbe();
      pollCount += 1;
    }

    const waitedMs = Date.now() - startedAt;
    if (probe.ready) {
      return {
        success: true,
        status: 'editor_ready',
        waitedMs,
        pollCount,
        diagnostics: probe
      };
    }

    return {
      success: false,
      status: 'editor_not_ready',
      error: probe.reasonMessage || formatEditorNotReadyMessage(probe.reason, probe),
      reason: probe.reason,
      waitedMs,
      pollCount,
      diagnostics: probe
    };
  }

  /**
   * 본문 입력 (HTML) — TinyMCE API 우선, DOM fallback
   * TinyMCE setContent + save를 사용하여 내부 textarea 동기화 보장
   */
  async function setContent(htmlContent) {
    try {
      if (!htmlContent || htmlContent.trim().length === 0) {
        return { success: false, error: '본문 내용이 비어있습니다.', status: 'content_empty' };
      }

      const expectedSummary = summarizeHtmlContent(htmlContent);

      await delay(500);

      let contentSet = false;

      // 1차: TinyMCE API (가장 안전한 경로 — 내부 textarea 동기화 포함)
      const editor = getTinyMCEEditor();
      if (editor) {
        try {
          editor.setContent(htmlContent);
          editor.setDirty?.(true);
          editor.nodeChanged?.();
          editor.save();
          editor.fire('change');
          contentSet = true;
          console.log('[TistoryAuto] TinyMCE API로 본문 입력 완료');
        } catch (e) {
          console.warn('[TistoryAuto] TinyMCE setContent 실패, fallback 시도:', e);
        }
      }

      // 2차: DOM fallback (TinyMCE API 불가 시 — 에디터 body에 직접 삽입)
      if (!contentSet) {
        const editorDoc = getEditorDocument();
        if (!editorDoc) {
          return { success: false, error: '에디터를 찾을 수 없음', status: 'editor_not_ready' };
        }
        const body = getEditorBody(editorDoc);
        if (!body) {
          return { success: false, error: '에디터 본문 영역을 찾을 수 없음', status: 'editor_not_ready' };
        }
        // DOM 조작으로 콘텐츠 설정 (사용자 입력 HTML을 에디터에 반영)
        body.textContent = '';
        const temp = editorDoc.createElement('div');
        temp.innerHTML = htmlContent; // eslint-disable-line -- 사용자 본인의 HTML 콘텐츠
        while (temp.firstChild) {
          body.appendChild(temp.firstChild);
        }
        body.dispatchEvent(new Event('input', { bubbles: true }));
        body.dispatchEvent(new Event('change', { bubbles: true }));
        contentSet = true;
        console.log('[TistoryAuto] DOM fallback으로 본문 입력 완료');
      }

      const persistenceResult = await ensureEditorStatePersistence(expectedSummary, { reason: 'set_content' });
      if (!persistenceResult.success) {
        return {
          success: false,
          error: persistenceResult.error || '본문이 에디터에 안정적으로 반영되지 않았습니다.',
          status: persistenceResult.status,
          snapshot: summarizeSnapshotForLog(persistenceResult.snapshot)
        };
      }

      return { success: true, snapshot: summarizeSnapshotForLog(persistenceResult.snapshot) };
    } catch (error) {
      console.error('[TistoryAuto] 본문 입력 실패:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 카테고리 선택 (.mce-menu-item 기반)
   */
  async function setCategory(categoryName) {
    try {
      // 카테고리 버튼 클릭하여 드롭다운 열기
      const categoryBtn = findElement(S.category.button, S.category.fallback);
      if (!categoryBtn) throw new Error('카테고리 버튼을 찾을 수 없음');

      categoryBtn.click();
      await delay(500);

      // 카테고리 목록에서 해당 이름 찾기 (.mce-menu-item)
      const items = document.querySelectorAll(S.category.items);
      let found = false;
      for (const item of items) {
        const text = item.textContent.trim();
        if (text === categoryName || text.includes(categoryName)) {
          item.click();
          found = true;
          break;
        }
      }

      // 숫자 ID로도 시도
      if (!found && !isNaN(categoryName)) {
        const byId = document.querySelector(`#category-item-${categoryName}`);
        if (byId) {
          byId.click();
          found = true;
        }
      }

      if (!found) {
        // 드롭다운 닫기
        categoryBtn.click();
        throw new Error(`카테고리를 찾을 수 없음: ${categoryName}`);
      }

      console.log('[TistoryAuto] 카테고리 선택 완료:', categoryName);
      return { success: true };
    } catch (error) {
      console.error('[TistoryAuto] 카테고리 선택 실패:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 태그 입력 (#tagText)
   */
  async function setTags(tags) {
    try {
      if (!tags || tags.length === 0) return { success: true };

      const tagInput = findElement(S.tag.input, S.tag.fallback);
      if (!tagInput) throw new Error('태그 입력 요소를 찾을 수 없음');

      for (const tag of tags) {
        tagInput.focus();
        await delay(150);

        // 값 입력
        simulateInput(tagInput, tag);
        await delay(150);

        // Enter 키로 태그 확정
        const enterEvent = (type) => new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        });
        tagInput.dispatchEvent(enterEvent('keydown'));
        tagInput.dispatchEvent(enterEvent('keypress'));
        tagInput.dispatchEvent(enterEvent('keyup'));
        await delay(300);
      }

      console.log('[TistoryAuto] 태그 입력 완료:', tags);
      return { success: true };
    } catch (error) {
      console.error('[TistoryAuto] 태그 입력 실패:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 공개 설정
   */
  async function setVisibility(visibility = 'public') {
    try {
      const publishLayer = getVisiblePublishLayer() || document;
      const scopes = [publishLayer, document].filter((scope, index, array) => scope && array.indexOf(scope) === index);

      let resolved = null;
      for (const scope of scopes) {
        resolved = resolveVisibilityControl(scope, visibility);
        if (resolved) break;
      }

      if (!resolved) {
        const fallbackVerification = verifyVisibilitySelection(visibility);
        if (fallbackVerification.success) {
          console.log('[TistoryAuto] 공개 설정 UI 직접 클릭 없이 확인됨:', visibility, fallbackVerification);
          return fallbackVerification;
        }

        return { success: false, error: `공개 설정 라디오를 찾을 수 없음: ${visibility}` };
      }

      triggerVisibilityClick(resolved.clickTarget);

      if (resolved.radio && 'checked' in resolved.radio) {
        resolved.radio.checked = true;
        resolved.radio.dispatchEvent(new Event('input', { bubbles: true }));
        resolved.radio.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await delay(300);

      let verification = verifyVisibilitySelection(visibility);
      if (!verification.success && resolved.radio && resolved.clickTarget !== resolved.radio) {
        triggerVisibilityClick(resolved.radio);
        resolved.radio.dispatchEvent(new Event('input', { bubbles: true }));
        resolved.radio.dispatchEvent(new Event('change', { bubbles: true }));
        await delay(250);
        verification = verifyVisibilitySelection(visibility);
      }

      console.log('[TistoryAuto] 공개 설정 완료:', visibility, {
        source: resolved.source,
        checkedValue: verification.checkedValue,
        publishBtnText: verification.publishBtnText
      });

      return verification;
    } catch (error) {
      console.error('[TistoryAuto] 공개 설정 실패:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 이미지 업로드 (티스토리 자체 업로더 사용)
   * 방법 1: 숨겨진 file input에 파일 주입
   * 방법 2: 첨부 → 사진 클릭하여 file input 트리거
   */
  function buildInlineImageHtml(image = {}) {
    const src = escapeHtml(image.url || image.src || '');
    const alt = escapeHtml(image.alt || '');
    return [
      '<figure data-ke-type="image" data-ke-mobilestyle="widthContent">',
      `<img src="${src}" alt="${alt}" style="max-width: 100%;" />`,
      alt ? `<figcaption>${alt}</figcaption>` : '',
      '</figure>',
      '<p>&nbsp;</p>'
    ].join('');
  }

  async function uploadImageViaTistory(imageBlob, filename = 'image.png') {
    try {
      const beforeSnapshot = getEditorSnapshot();

      // 첨부 버튼 클릭
      const attachBtn = findElement(S.image.attachButton, null);
      if (attachBtn) {
        attachBtn.click();
        await delay(300);
      }

      // "사진" 메뉴 클릭
      const photoItem = findElement(S.image.photoMenuItem, null);
      if (photoItem) {
        photoItem.click();
        await delay(500);
      }

      // file input 찾기
      const fileInput = findElement(S.image.fileInput, S.image.fallback);
      if (!fileInput) throw new Error('파일 input을 찾을 수 없음');

      // File 객체 생성 및 주입
      const file = new File([imageBlob], filename, { type: imageBlob.type || 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;

      // change 이벤트 발생
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));

      console.log('[TistoryAuto] 티스토리 업로더로 이미지 업로드 트리거:', filename);
      const insertedSnapshot = await waitForEditorCondition(
        (snapshot) => snapshot.imageCount > beforeSnapshot.imageCount,
        { timeout: 15000, interval: 400 }
      );

      if (!insertedSnapshot) {
        return {
          success: false,
          error: `이미지 업로드 후 에디터 반영을 확인하지 못했습니다: ${filename}`,
          status: 'image_upload_unverified'
        };
      }

      const persistenceResult = await ensureEditorStatePersistence(insertedSnapshot, { reason: 'upload_image' });
      if (!persistenceResult.success) {
        return {
          success: false,
          error: persistenceResult.error || `이미지 업로드 직후 동기화가 불안정합니다: ${filename}`,
          status: persistenceResult.status,
          snapshot: summarizeSnapshotForLog(persistenceResult.snapshot)
        };
      }

      return {
        success: true,
        snapshot: summarizeSnapshotForLog(persistenceResult.snapshot)
      };
    } catch (error) {
      console.error('[TistoryAuto] 티스토리 업로더 실패:', error);
      return { success: false, error: error.message, status: 'image_upload_failed' };
    }
  }

  /**
   * 이미지 삽입
   * - base64/URL → 에디터에 <img> 태그 삽입 (외부 이미지)
   * - blob/file → 티스토리 자체 업로더 사용 (로컬 이미지)
   */
  async function insertImages(images) {
    try {
      if (!images || images.length === 0) return { success: true };

      const initialSnapshot = getEditorSnapshot();
      let uploadCount = 0;
      let inlineCount = 0;

      for (const image of images) {
        // base64 데이터가 있으면 → 티스토리 업로더로 실제 업로드 시도
        if (image.base64) {
          const blob = IMG.base64ToBlob(image.base64);
          const filename = image.alt || `image_${Date.now()}.png`;
          const uploadResult = await uploadImageViaTistory(blob, filename);
          if (!uploadResult.success) {
            return uploadResult;
          }

          uploadCount++;
        }
        // URL만 있으면 → 에디터에 <img> 태그로 직접 삽입
        else if (image.url || image.src) {
          const beforeSnapshot = getEditorSnapshot();
          const inlineHtml = buildInlineImageHtml(image);
          const editor = getTinyMCEEditor();

          if (editor) {
            editor.insertContent(inlineHtml);
            editor.setDirty?.(true);
            editor.nodeChanged?.();
            editor.save();
            editor.fire('change');
          } else {
            const editorDoc = getEditorDocument();
            const body = editorDoc ? getEditorBody(editorDoc) : null;
            if (!body) {
              return { success: false, error: '이미지 삽입용 에디터를 찾을 수 없음', status: 'editor_not_ready' };
            }

            const temp = editorDoc.createElement('div');
            temp.innerHTML = inlineHtml;
            while (temp.firstChild) {
              body.appendChild(temp.firstChild);
            }
            body.dispatchEvent(new Event('input', { bubbles: true }));
            body.dispatchEvent(new Event('change', { bubbles: true }));
          }

          const insertedSnapshot = await waitForEditorCondition(
            (snapshot) => snapshot.imageCount > beforeSnapshot.imageCount,
            { timeout: 5000, interval: 250 }
          );

          if (!insertedSnapshot) {
            return {
              success: false,
              error: `외부 이미지 삽입 후 에디터 반영을 확인하지 못했습니다: ${image.url || image.src}`,
              status: 'verification_failed'
            };
          }

          const persistenceResult = await ensureEditorStatePersistence(insertedSnapshot, { reason: 'insert_inline_image' });
          if (!persistenceResult.success) {
            return {
              success: false,
              error: persistenceResult.error || '이미지 삽입 후 동기화에 실패했습니다.',
              status: persistenceResult.status,
              snapshot: summarizeSnapshotForLog(persistenceResult.snapshot)
            };
          }

          inlineCount++;
        }

        await delay(500);
      }

      const finalExpectedSnapshot = {
        ...initialSnapshot,
        imageCount: initialSnapshot.imageCount + uploadCount + inlineCount,
        hasMeaningfulContent: initialSnapshot.hasMeaningfulContent || uploadCount + inlineCount > 0
      };
      const finalPersistence = await ensureEditorStatePersistence(finalExpectedSnapshot, { reason: 'insert_images_final' });
      if (!finalPersistence.success) {
        return {
          success: false,
          error: finalPersistence.error || '이미지 삽입 후 최종 동기화에 실패했습니다.',
          status: finalPersistence.status,
          snapshot: summarizeSnapshotForLog(finalPersistence.snapshot)
        };
      }

      console.log(`[TistoryAuto] 이미지 삽입 완료: 업로드 ${uploadCount}개, 인라인 ${inlineCount}개`);
      return {
        success: true,
        uploaded: uploadCount,
        inline: inlineCount,
        snapshot: summarizeSnapshotForLog(finalPersistence.snapshot)
      };
    } catch (error) {
      console.error('[TistoryAuto] 이미지 삽입 실패:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * CAPTCHA/차단 상태 감지
   */
  const CAPTCHA_SELECTOR_SPECS = [
    { selector: '#dkaptcha', kind: 'captcha_root' },
    { selector: '.dkaptcha', kind: 'captcha_root' },
    { selector: '.captcha-wrap', kind: 'captcha_root' },
    { selector: '[class*="captcha"]', kind: 'captcha_generic' },
    { selector: '[id*="captcha"]', kind: 'captcha_generic' },
    { selector: '.g-recaptcha', kind: 'captcha_root' },
    { selector: '#recaptcha', kind: 'captcha_root' },
    { selector: 'iframe[src*="dkaptcha"]', kind: 'captcha_iframe' },
    { selector: 'iframe[src*="captcha"]', kind: 'captcha_iframe' },
    { selector: '#captchaImg', kind: 'captcha_image' }
  ];

  const CAPTCHA_INPUT_SELECTOR_SPECS = [
    { selector: 'input[type="text"]', kind: 'text_input' },
    { selector: 'input:not([type])', kind: 'text_input' },
    { selector: 'input[type="search"]', kind: 'search_input' },
    { selector: 'input[type="tel"]', kind: 'tel_input' },
    { selector: 'input[type="number"]', kind: 'number_input' },
    { selector: 'textarea', kind: 'textarea' },
    { selector: '[contenteditable="true"]', kind: 'contenteditable' }
  ];

  const CAPTCHA_BUTTON_SELECTOR_SPECS = [
    { selector: 'button', kind: 'button' },
    { selector: 'input[type="submit"]', kind: 'submit_input' },
    { selector: 'input[type="button"]', kind: 'button_input' },
    { selector: '[role="button"]', kind: 'role_button' }
  ];

  const CAPTCHA_INPUT_HINT_RE = /(captcha|dkaptcha|보안|인증|문자|코드|정답|answer|response|challenge)/i;
  const CAPTCHA_BUTTON_HINT_RE = /(확인|인증|제출|전송|완료|ok|submit|confirm|verify)/i;
  const PUBLISH_BUTTON_HINT_RE = /(발행|저장|공개\s*발행|비공개\s*발행|publish|save)/i;
  const EDITOR_FIELD_HINT_RE = /(title|subject|제목|tag|태그|category|카테고리|search|검색)/i;

  function hasStrongCaptchaInputEvidence(reasons = []) {
    return reasons.includes('captcha_hint_text')
      || reasons.includes('inside_target')
      || reasons.includes('same_form');
  }

  function hasStrongCaptchaButtonEvidence(reasons = []) {
    return reasons.includes('captcha_action_text')
      || reasons.includes('inside_target')
      || reasons.includes('same_form');
  }

  function detectCaptcha() {
    return buildCaptchaRoots().length > 0;
  }

  function isVisibleElement(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function compactText(value, maxLength = 160) {
    if (!value) return null;
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    return normalized.slice(0, maxLength);
  }

  function serializeRect(rect) {
    if (!rect) return null;
    return {
      left: Math.round(rect.left * 100) / 100,
      top: Math.round(rect.top * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      right: Math.round(rect.right * 100) / 100,
      bottom: Math.round(rect.bottom * 100) / 100
    };
  }

  function rectArea(rect) {
    if (!rect) return 0;
    return Math.max(0, Number(rect.width) || 0) * Math.max(0, Number(rect.height) || 0);
  }

  function buildViewportSnapshot() {
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  function clipRectToViewport(rect, viewport = buildViewportSnapshot()) {
    if (!rect || !viewport?.innerWidth || !viewport?.innerHeight) return null;

    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(viewport.innerWidth, rect.right);
    const bottom = Math.min(viewport.innerHeight, rect.bottom);

    if (right <= left || bottom <= top) return null;

    return serializeRect({
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    });
  }

  function buildDomPath(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (el.id) return `#${el.id}`;

    const parts = [];
    let current = el;

    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4 && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const classNames = Array.from(current.classList || []).slice(0, 2).join('.');
      let part = classNames ? `${tag}.${classNames}` : tag;

      if (current.parentElement) {
        const sameTagSiblings = Array.from(current.parentElement.children)
          .filter((sibling) => sibling.tagName === current.tagName);
        if (sameTagSiblings.length > 1) {
          part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
        }
      }

      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(' > ') || null;
  }

  function collectVisibleMatches(specs) {
    const matches = new Map();

    specs.forEach((spec) => {
      document.querySelectorAll(spec.selector).forEach((el) => {
        if (!isVisibleElement(el)) return;
        if (typeof spec.filter === 'function' && !spec.filter(el)) return;

        let entry = matches.get(el);
        if (!entry) {
          entry = { element: el, matchedSelectors: [], kinds: [] };
          matches.set(el, entry);
        }

        if (!entry.matchedSelectors.includes(spec.selector)) {
          entry.matchedSelectors.push(spec.selector);
        }

        if (spec.kind && !entry.kinds.includes(spec.kind)) {
          entry.kinds.push(spec.kind);
        }
      });
    });

    return Array.from(matches.values());
  }

  function summarizeElement(el, selector, kind = 'captcha_candidate', extra = {}) {
    return {
      kind,
      selector,
      matchedSelectors: extra.matchedSelectors || (selector ? [selector] : []),
      tagName: el.tagName?.toLowerCase() || null,
      id: el.id || null,
      className: compactText(el.className || '', 120),
      text: compactText(el.textContent || '', 220),
      ariaLabel: el.getAttribute?.('aria-label') || null,
      title: el.getAttribute?.('title') || null,
      name: el.getAttribute?.('name') || null,
      type: el.getAttribute?.('type') || null,
      placeholder: el.getAttribute?.('placeholder') || null,
      valuePreview: el.matches?.('input, textarea') ? compactText(el.value || '', 80) : null,
      disabled: !!el.disabled,
      readOnly: !!el.readOnly,
      src: (el.tagName === 'IFRAME' || el.tagName === 'IMG') ? (el.getAttribute('src') || null) : null,
      domPath: buildDomPath(el),
      rect: serializeRect(el.getBoundingClientRect()),
      ...extra
    };
  }

  function rectsAreNear(rectA, rectB, maxGap = 220) {
    if (!rectA || !rectB) return false;

    const horizontalGap = Math.max(rectB.left - rectA.right, rectA.left - rectB.right, 0);
    const verticalGap = Math.max(rectB.top - rectA.bottom, rectA.top - rectB.bottom, 0);
    return horizontalGap <= maxGap && verticalGap <= maxGap;
  }

  function findBestRelation(candidate, targets, options = {}) {
    const insideBonus = options.insideBonus ?? 16;
    const nearbyBonus = options.nearbyBonus ?? 8;

    if (!targets || targets.length === 0) {
      return { score: 0, reason: null, target: null };
    }

    const candidateRect = candidate.getBoundingClientRect();

    for (const target of targets) {
      if (target === candidate || target.contains(candidate)) {
        return { score: insideBonus, reason: 'inside_target', target };
      }
    }

    const candidateForm = candidate.closest('form');
    for (const target of targets) {
      const targetForm = target.closest('form');
      if (candidateForm && targetForm && candidateForm === targetForm) {
        return { score: insideBonus - 4, reason: 'same_form', target };
      }

      if (rectsAreNear(candidateRect, target.getBoundingClientRect(), options.maxGap ?? 220)) {
        return { score: nearbyBonus, reason: 'near_target', target };
      }
    }

    return { score: 0, reason: null, target: null };
  }

  function getElementInputValue(element) {
    if (!element) return '';
    if (element.matches?.('input, textarea')) return element.value || '';
    if (element.isContentEditable) return element.textContent || '';
    return '';
  }

  function getAncestorDescriptors(element, depth = 4) {
    const parts = [];
    let current = element?.parentElement || null;
    let remaining = depth;

    while (current && remaining > 0) {
      parts.push([
        current.tagName?.toLowerCase?.(),
        current.id,
        current.className,
        current.getAttribute?.('role'),
        current.getAttribute?.('aria-label'),
        current.getAttribute?.('title')
      ].filter(Boolean).join(' '));
      current = current.parentElement;
      remaining -= 1;
    }

    return normalizeText(parts.join(' '));
  }

  function buildHeuristicCaptchaIframeRoots() {
    if (!window.location.pathname.includes('/manage/')) return [];

    return Array.from(document.querySelectorAll('iframe'))
      .map((iframe) => {
        if (!isVisibleElement(iframe)) return null;

        const rect = iframe.getBoundingClientRect();
        const style = window.getComputedStyle(iframe);
        const visibleRect = clipRectToViewport(rect);
        if (!visibleRect) return null;

        const ancestorDescriptor = getAncestorDescriptors(iframe, 4);
        const descriptor = normalizeText([
          iframe.id,
          iframe.className,
          iframe.getAttribute('name'),
          iframe.getAttribute('title'),
          iframe.getAttribute('src'),
          iframe.getAttribute('aria-label'),
          iframe.getAttribute('role'),
          ancestorDescriptor
        ].filter(Boolean).join(' '));

        if (/(mce|tinymce|editor|toastui|codemirror|kakaomap|youtube|googlefinance)/i.test(descriptor)) {
          return null;
        }

        let score = 0;
        const reasons = [];
        const centerX = rect.left + (rect.width / 2);
        const centerY = rect.top + (rect.height / 2);
        const centeredHorizontally = Math.abs(centerX - (window.innerWidth / 2)) <= (window.innerWidth * 0.28);
        const centeredVertically = Math.abs(centerY - (window.innerHeight / 2)) <= (window.innerHeight * 0.32);
        const zIndex = Number(style.zIndex || 0);
        const area = rect.width * rect.height;

        if (/(captcha|dkaptcha|kakao|challenge|verify|security|보안|인증)/i.test(descriptor)) {
          score += 20;
          reasons.push('captcha_descriptor');
        }

        if (centeredHorizontally && centeredVertically) {
          score += 8;
          reasons.push('centered_overlay');
        }

        if (rect.width >= 220 && rect.width <= Math.max(420, window.innerWidth * 0.95) && rect.height >= 90 && rect.height <= Math.max(420, window.innerHeight * 0.9)) {
          score += 6;
          reasons.push('captcha_like_size');
        }

        if (style.position === 'fixed' || style.position === 'absolute') {
          score += 5;
          reasons.push('overlay_position');
        }

        if (zIndex >= 1000) {
          score += 4;
          reasons.push('high_z_index');
        }

        if (area >= 25000 && area <= 350000) {
          score += 3;
          reasons.push('reasonable_area');
        }

        if (score < 18) return null;

        return {
          element: iframe,
          matchedSelectors: ['iframe[heuristic-captcha]'],
          kinds: ['captcha_iframe_heuristic'],
          summary: summarizeElement(iframe, 'iframe[heuristic-captcha]', 'captcha_iframe_heuristic', {
            matchedSelectors: ['iframe[heuristic-captcha]'],
            score,
            reasons,
            associatedText: compactText(descriptor, 220),
            visibleRect,
            zIndex: Number.isFinite(zIndex) ? zIndex : null
          })
        };
      })
      .filter(Boolean);
  }

  function buildCaptchaRoots() {
    const selectorRoots = collectVisibleMatches(CAPTCHA_SELECTOR_SPECS).map((match) => ({
      ...match,
      summary: summarizeElement(match.element, match.matchedSelectors[0], match.kinds[0] || 'captcha_candidate', {
        matchedSelectors: match.matchedSelectors
      })
    }));

    const combined = [...selectorRoots];
    const seen = new Set(selectorRoots.map((match) => match.element));

    buildHeuristicCaptchaIframeRoots().forEach((match) => {
      if (seen.has(match.element)) return;
      seen.add(match.element);
      combined.push(match);
    });

    return combined;
  }

  function buildCaptchaAnswerInputs(captchaRoots = []) {
    const rootElements = captchaRoots.map((match) => match.element);

    return collectVisibleMatches(CAPTCHA_INPUT_SELECTOR_SPECS)
      .map((match) => {
        const el = match.element;
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (/^(hidden|checkbox|radio|file|image|range|date|datetime-local|month|time|week|color)$/.test(type)) {
          return null;
        }

        if (el.disabled || el.readOnly) {
          return null;
        }

        const descriptor = normalizeText([
          el.getAttribute('placeholder'),
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('name'),
          el.id,
          el.className,
          getAssociatedText(el)
        ].filter(Boolean).join(' '));

        const reasons = [];
        let score = 0;

        if (CAPTCHA_INPUT_HINT_RE.test(descriptor)) {
          score += 12;
          reasons.push('captcha_hint_text');
        }

        if (el.matches('textarea')) {
          score += 4;
          reasons.push('textarea');
        } else if (!type || /^(text|search|tel|number|password)$/.test(type)) {
          score += 3;
          reasons.push(`type_${type || 'text'}`);
        }

        const relation = findBestRelation(el, rootElements, { insideBonus: 18, nearbyBonus: 9 });
        if (relation.score > 0) {
          score += relation.score;
          reasons.push(relation.reason);
        }

        const maxLength = Number(el.getAttribute('maxlength')) || null;
        if (maxLength && maxLength <= 12) {
          score += 2;
          reasons.push('short_code_length');
        }

        if (EDITOR_FIELD_HINT_RE.test(descriptor)) {
          score -= 10;
          reasons.push('editor_field_penalty');
        }

        if (score <= 0) return null;
        if (!hasStrongCaptchaInputEvidence(reasons)) return null;
        if (score < 10) return null;

        return {
          ...match,
          score,
          reasons,
          summary: summarizeElement(el, match.matchedSelectors[0], 'captcha_answer_input', {
            matchedSelectors: match.matchedSelectors,
            score,
            reasons,
            valueLength: getElementInputValue(el).length,
            associatedText: compactText(descriptor, 220)
          })
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  function buildCaptchaSubmitButtons(captchaRoots = [], answerInputs = []) {
    const targetElements = [
      ...captchaRoots.map((match) => match.element),
      ...answerInputs.map((match) => match.element)
    ];

    return collectVisibleMatches(CAPTCHA_BUTTON_SELECTOR_SPECS)
      .map((match) => {
        const el = match.element;
        const descriptor = normalizeText([
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('value'),
          getAssociatedText(el)
        ].filter(Boolean).join(' '));

        const reasons = [];
        let score = 0;

        if (CAPTCHA_BUTTON_HINT_RE.test(descriptor)) {
          score += 12;
          reasons.push('captcha_action_text');
        }

        if ((el.getAttribute('type') || '').toLowerCase() === 'submit') {
          score += 4;
          reasons.push('native_submit');
        }

        const relation = findBestRelation(el, targetElements, { insideBonus: 16, nearbyBonus: 8 });
        if (relation.score > 0) {
          score += relation.score;
          reasons.push(relation.reason);
        }

        if (PUBLISH_BUTTON_HINT_RE.test(descriptor) && !CAPTCHA_BUTTON_HINT_RE.test(descriptor)) {
          score -= 8;
          reasons.push('publish_button_penalty');
        }

        if (el.disabled) {
          score -= 20;
          reasons.push('disabled_penalty');
        }

        if (score <= 0) return null;
        if (!hasStrongCaptchaButtonEvidence(reasons)) return null;
        if (score < 10) return null;

        return {
          ...match,
          score,
          reasons,
          summary: summarizeElement(el, match.matchedSelectors[0], 'captcha_submit_button', {
            matchedSelectors: match.matchedSelectors,
            score,
            reasons,
            associatedText: compactText(descriptor, 220)
          })
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  function buildCaptchaCaptureCandidates(captchaRoots = []) {
    const viewport = buildViewportSnapshot();
    const rootElements = captchaRoots.map((match) => match.element);
    const visualMatches = new Map();

    const addVisualCandidate = (el, originSelector = null, originKind = 'captcha_visual') => {
      if (!el || !isVisibleElement(el)) return;

      const existing = visualMatches.get(el);
      if (existing) {
        if (originSelector && !existing.matchedSelectors.includes(originSelector)) {
          existing.matchedSelectors.push(originSelector);
        }
        if (originKind && !existing.kinds.includes(originKind)) {
          existing.kinds.push(originKind);
        }
        return;
      }

      visualMatches.set(el, {
        element: el,
        matchedSelectors: originSelector ? [originSelector] : [],
        kinds: originKind ? [originKind] : []
      });
    };

    captchaRoots.forEach((root) => {
      const visualChildren = [root.element];
      root.element.querySelectorAll('img, canvas, svg, iframe').forEach((el) => {
        visualChildren.push(el);
      });

      visualChildren.forEach((el) => {
        const tagName = el.tagName?.toLowerCase();
        if (!/^(img|canvas|svg|iframe)$/.test(tagName || '')) return;
        addVisualCandidate(el, root.matchedSelectors[0] || null, root.kinds[0] || 'captcha_visual');
      });
    });

    const visualCandidates = Array.from(visualMatches.values())
      .map((match) => {
        const el = match.element;
        const rect = el.getBoundingClientRect();
        const visibleRect = clipRectToViewport(rect, viewport);
        if (!visibleRect) return null;

        const tagName = el.tagName?.toLowerCase() || null;
        const descriptor = normalizeText([
          el.getAttribute?.('alt'),
          el.getAttribute?.('aria-label'),
          el.getAttribute?.('title'),
          el.getAttribute?.('name'),
          el.id,
          el.className,
          el.getAttribute?.('src'),
          getAssociatedText(el)
        ].filter(Boolean).join(' '));

        const reasons = [];
        let score = 0;

        if (tagName === 'img') {
          score += 28;
          reasons.push('img');
        } else if (tagName === 'canvas') {
          score += 24;
          reasons.push('canvas');
        } else if (tagName === 'svg') {
          score += 18;
          reasons.push('svg');
        } else if (tagName === 'iframe') {
          score += 14;
          reasons.push('iframe');
        }

        if (el.id === 'captchaImg') {
          score += 20;
          reasons.push('captcha_image_id');
        }

        if (CAPTCHA_INPUT_HINT_RE.test(descriptor)) {
          score += 10;
          reasons.push('captcha_hint_text');
        }

        const relation = findBestRelation(el, rootElements, { insideBonus: 18, nearbyBonus: 8 });
        if (relation.score > 0) {
          score += relation.score;
          reasons.push(relation.reason);
        }

        const totalArea = rectArea(serializeRect(rect));
        const visibleArea = rectArea(visibleRect);
        if (visibleArea >= 2500 && visibleArea <= 200000) {
          score += 4;
          reasons.push('reasonable_area');
        }

        const visibleRatio = totalArea > 0 ? Math.min(1, visibleArea / totalArea) : 0;
        if (visibleRatio >= 0.85) {
          score += 3;
          reasons.push('mostly_visible');
        } else if (visibleRatio < 0.45) {
          score -= 6;
          reasons.push('partially_hidden_penalty');
        }

        if (score <= 0) return null;

        return {
          ...match,
          score,
          reasons,
          summary: summarizeElement(el, match.matchedSelectors[0] || null, 'captcha_capture_candidate', {
            matchedSelectors: match.matchedSelectors,
            score,
            reasons,
            captureRole: 'visual_candidate',
            visibleRect,
            visibleRatio: Math.round(visibleRatio * 1000) / 1000,
            imageTag: tagName,
            naturalWidth: typeof el.naturalWidth === 'number' ? el.naturalWidth : null,
            naturalHeight: typeof el.naturalHeight === 'number' ? el.naturalHeight : null,
            currentSrc: tagName === 'img' ? (el.currentSrc || el.getAttribute('src') || null) : null,
            area: totalArea,
            visibleArea
          })
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (visualCandidates.length > 0) {
      return visualCandidates;
    }

    return captchaRoots
      .map((match) => {
        const rect = match.element.getBoundingClientRect();
        const visibleRect = clipRectToViewport(rect, viewport);
        if (!visibleRect) return null;

        const totalArea = rectArea(match.summary.rect);
        const visibleArea = rectArea(visibleRect);
        const visibleRatio = totalArea > 0 ? Math.min(1, visibleArea / totalArea) : 0;
        const reasons = ['root_fallback'];
        let score = 0;

        if (match.kinds.includes('captcha_image')) {
          score += 24;
          reasons.push('image_selector');
        } else if (match.kinds.includes('captcha_root')) {
          score += 18;
          reasons.push('captcha_root');
        } else if (match.kinds.includes('captcha_iframe')) {
          score += 15;
          reasons.push('captcha_iframe');
        } else {
          score += 9;
          reasons.push('generic_root');
        }

        if (visibleRatio >= 0.85) {
          score += 3;
          reasons.push('mostly_visible');
        } else if (visibleRatio < 0.45) {
          score -= 5;
          reasons.push('partially_hidden_penalty');
        }

        return {
          ...match,
          score,
          reasons,
          summary: {
            ...match.summary,
            score,
            reasons,
            captureRole: 'root_fallback',
            visibleRect,
            visibleRatio: Math.round(visibleRatio * 1000) / 1000,
            area: totalArea,
            visibleArea
          }
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  function collectCaptchaDiagnostics() {
    const captchaRoots = buildCaptchaRoots();
    const answerInputs = buildCaptchaAnswerInputs(captchaRoots);
    const submitButtons = buildCaptchaSubmitButtons(captchaRoots, answerInputs);
    const captureCandidates = buildCaptchaCaptureCandidates(captchaRoots);
    return {
      captchaRoots,
      answerInputs,
      submitButtons,
      captureCandidates
    };
  }

  function getCaptchaContext() {
    const diagnostics = collectCaptchaDiagnostics();
    const publishLayer = getVisiblePublishLayer();
    const confirmBtn = getConfirmButton();
    const completeBtn = findElement(S.publish.completeButton, S.publish.fallback);
    const iframeCandidates = diagnostics.captchaRoots.filter((match) => match.element?.tagName?.toLowerCase?.() === 'iframe');

    return {
      success: true,
      url: window.location.href,
      title: document.title,
      captchaPresent: diagnostics.captchaRoots.length > 0,
      candidateCount: diagnostics.captchaRoots.length,
      candidates: diagnostics.captchaRoots.map((match) => match.summary),
      iframeCaptchaPresent: iframeCandidates.length > 0,
      iframeCaptchaCandidateCount: iframeCandidates.length,
      iframeCaptchaCandidates: iframeCandidates.map((match) => match.summary),
      preferredSolveMode: iframeCandidates.length > 0 ? 'browser_handoff' : 'extension_dom',
      answerInputCandidateCount: diagnostics.answerInputs.length,
      answerInputCandidates: diagnostics.answerInputs.map((match) => match.summary),
      activeAnswerInput: diagnostics.answerInputs[0]?.summary || null,
      submitButtonCandidateCount: diagnostics.submitButtons.length,
      submitButtonCandidates: diagnostics.submitButtons.map((match) => match.summary),
      activeSubmitButton: diagnostics.submitButtons[0]?.summary || null,
      captureCandidateCount: diagnostics.captureCandidates.length,
      captureCandidates: diagnostics.captureCandidates.map((match) => match.summary),
      activeCaptureCandidate: diagnostics.captureCandidates[0]?.summary || null,
      publishLayerPresent: !!publishLayer,
      publishLayerText: compactText(publishLayer?.textContent || '', 320),
      publishLayerRect: serializeRect(publishLayer?.getBoundingClientRect?.()),
      confirmButtonText: compactText(confirmBtn?.textContent || '', 80),
      confirmButton: confirmBtn ? summarizeElement(confirmBtn, S.publish.confirmButton, 'publish_confirm_button') : null,
      completeButtonText: compactText(completeBtn?.textContent || '', 80),
      completeButton: completeBtn ? summarizeElement(completeBtn, S.publish.completeButton, 'publish_complete_button') : null,
      viewport: buildViewportSnapshot()
    };
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('blob_read_failed'));
      reader.readAsDataURL(blob);
    });
  }

  function findDirectCaptchaImageElement(captureMatch) {
    if (!captureMatch?.element) return null;

    if (captureMatch.element.matches?.('img, canvas')) {
      return captureMatch.element;
    }

    return captureMatch.element.querySelector?.('img, canvas') || null;
  }

  async function extractCaptchaImageArtifact() {
    const diagnostics = collectCaptchaDiagnostics();
    const selectedCapture = diagnostics.captureCandidates[0] || null;

    if (!selectedCapture) {
      return {
        success: false,
        status: 'captcha_capture_target_not_found',
        error: '보이는 CAPTCHA 캡처 대상을 찾지 못했습니다.',
        diagnostics: getCaptchaContext()
      };
    }

    const sourceElement = findDirectCaptchaImageElement(selectedCapture);
    if (!sourceElement) {
      return {
        success: false,
        status: 'captcha_image_artifact_unavailable',
        error: '직접 추출 가능한 CAPTCHA 이미지 요소(img/canvas)를 찾지 못했습니다.',
        selectedCandidate: selectedCapture.summary,
        diagnostics: getCaptchaContext()
      };
    }

    const tagName = sourceElement.tagName?.toLowerCase() || null;
    try {
      let dataUrl = null;
      let mimeType = 'image/png';

      if (tagName === 'canvas') {
        dataUrl = sourceElement.toDataURL('image/png');
      } else if (tagName === 'img') {
        const currentSrc = sourceElement.currentSrc || sourceElement.src || sourceElement.getAttribute('src') || null;
        if (!currentSrc) {
          throw new Error('captcha_image_src_missing');
        }

        if (currentSrc.startsWith('data:')) {
          dataUrl = currentSrc;
          mimeType = currentSrc.slice(5, currentSrc.indexOf(';')) || mimeType;
        } else {
          try {
            const response = await fetch(currentSrc, { credentials: 'include', cache: 'no-store' });
            if (!response.ok) {
              throw new Error(`captcha_image_fetch_${response.status}`);
            }
            const blob = await response.blob();
            mimeType = blob.type || mimeType;
            dataUrl = await blobToDataUrl(blob);
          } catch (fetchError) {
            const canvas = document.createElement('canvas');
            canvas.width = sourceElement.naturalWidth || sourceElement.width || 1;
            canvas.height = sourceElement.naturalHeight || sourceElement.height || 1;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              throw fetchError;
            }
            ctx.drawImage(sourceElement, 0, 0);
            dataUrl = canvas.toDataURL('image/png');
            mimeType = 'image/png';
          }
        }
      } else {
        throw new Error(`unsupported_capture_tag:${tagName || 'unknown'}`);
      }

      return {
        success: true,
        status: 'captcha_image_artifact_ready',
        selectedCandidate: selectedCapture.summary,
        artifact: {
          kind: 'direct_image',
          mimeType,
          dataUrl,
          width: tagName === 'canvas'
            ? sourceElement.width || null
            : (sourceElement.naturalWidth || sourceElement.width || null),
          height: tagName === 'canvas'
            ? sourceElement.height || null
            : (sourceElement.naturalHeight || sourceElement.height || null),
          sourceTagName: tagName,
          sourceUrl: tagName === 'img'
            ? (sourceElement.currentSrc || sourceElement.src || sourceElement.getAttribute('src') || null)
            : null,
          rect: selectedCapture.summary?.rect || null,
          visibleRect: selectedCapture.summary?.visibleRect || null
        },
        captureContext: getCaptchaContext()
      };
    } catch (error) {
      return {
        success: false,
        status: 'captcha_image_artifact_unavailable',
        error: error.message,
        selectedCandidate: selectedCapture.summary,
        diagnostics: getCaptchaContext()
      };
    }
  }

  async function prepareCaptchaCapture() {
    const diagnostics = collectCaptchaDiagnostics();
    const selectedCapture = diagnostics.captureCandidates[0] || null;

    if (!selectedCapture) {
      return {
        success: false,
        status: 'captcha_capture_target_not_found',
        error: '보이는 CAPTCHA 캡처 대상을 찾지 못했습니다.',
        diagnostics: getCaptchaContext()
      };
    }

    selectedCapture.element.scrollIntoView?.({ block: 'center', inline: 'center' });
    selectedCapture.element.focus?.({ preventScroll: true });
    await delay(120);

    const captureContext = getCaptchaContext();
    return {
      success: true,
      status: 'captcha_capture_ready',
      selectedCandidate: captureContext.activeCaptureCandidate || selectedCapture.summary,
      captureContext
    };
  }

  function simulateClick(element) {
    if (!element) return false;

    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();

    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) => {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });

    if (typeof element.click === 'function') {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }

    return true;
  }

  function normalizeCaptchaAnswer(answer) {
    const trimmed = String(answer ?? '').trim();
    return trimmed ? trimmed.replace(/\s+/g, '') : '';
  }

  async function submitCaptchaAnswer(answer, options = {}) {
    const normalizedAnswer = normalizeCaptchaAnswer(answer);
    if (!normalizedAnswer) {
      return {
        success: false,
        status: 'captcha_answer_required',
        error: 'CAPTCHA 답안을 입력하세요.'
      };
    }

    const before = collectCaptchaDiagnostics();
    const beforeContext = getCaptchaContext();
    const selectedInput = before.answerInputs[0] || null;
    const selectedButton = before.submitButtons[0] || null;
    const iframeCaptchaPresent = before.captchaRoots.some((match) => match.element?.tagName?.toLowerCase?.() === 'iframe');

    if (!selectedInput) {
      return {
        success: false,
        status: iframeCaptchaPresent ? 'captcha_browser_handoff_required' : 'captcha_input_not_found',
        error: iframeCaptchaPresent
          ? '현재 CAPTCHA 입력창이 cross-origin iframe 안에 있어 확장 내부 DOM 입력 대신 browser/CDP handoff가 필요합니다. 같은 탭에서 풀이한 뒤 RESUME_DIRECT_PUBLISH를 호출하세요.'
          : '보이는 CAPTCHA 입력창을 찾지 못했습니다.',
        handoff: iframeCaptchaPresent ? {
          reason: 'cross_origin_iframe',
          recommendedAction: 'solve_in_browser_then_resume',
          sameTabRequired: true
        } : null,
        diagnostics: getCaptchaContext()
      };
    }

    if (!selectedButton) {
      return {
        success: false,
        status: iframeCaptchaPresent ? 'captcha_browser_handoff_required' : 'captcha_submit_not_found',
        error: iframeCaptchaPresent
          ? '현재 CAPTCHA 제출 버튼이 cross-origin iframe 안에 있어 확장 내부 DOM 제출 대신 browser/CDP handoff가 필요합니다. 같은 탭에서 풀이한 뒤 RESUME_DIRECT_PUBLISH를 호출하세요.'
          : '보이는 CAPTCHA 제출 버튼을 찾지 못했습니다.',
        handoff: iframeCaptchaPresent ? {
          reason: 'cross_origin_iframe',
          recommendedAction: 'solve_in_browser_then_resume',
          sameTabRequired: true
        } : null,
        diagnostics: getCaptchaContext()
      };
    }

    selectedInput.element.focus?.();
    await delay(80);
    simulateInput(selectedInput.element, normalizedAnswer);
    await delay(120);

    const appliedValue = getElementInputValue(selectedInput.element);
    const inputApplied = normalizeCaptchaAnswer(appliedValue) === normalizedAnswer;
    if (!inputApplied) {
      return {
        success: false,
        status: 'captcha_input_not_applied',
        error: 'CAPTCHA 답안을 입력창에 적용하지 못했습니다.',
        selectedInput: selectedInput.summary,
        diagnostics: {
          before: beforeContext,
          afterInput: getCaptchaContext()
        }
      };
    }

    simulateClick(selectedButton.element);

    const waitMs = Math.max(300, Number(options.waitMs) || 1200);
    await delay(waitMs);

    const afterContext = getCaptchaContext();

    return {
      success: true,
      status: afterContext.captchaPresent ? 'captcha_still_present' : 'captcha_submitted',
      url: window.location.href,
      answerLength: normalizedAnswer.length,
      inputApplied,
      clicked: true,
      selectedInput: selectedInput.summary,
      selectedButton: selectedButton.summary,
      buttonText: selectedButton.summary?.text || selectedButton.summary?.ariaLabel || selectedButton.summary?.title || null,
      captchaPresentBefore: before.captchaRoots.length > 0,
      captchaPresentAfterWait: !!afterContext.captchaPresent,
      captchaStillAppears: !!afterContext.captchaPresent,
      diagnostics: {
        waitMs,
        before: beforeContext,
        after: afterContext
      }
    };
  }

  /**
   * "저장중" 스피너가 사라질 때까지 대기
   */
  async function waitForSaveComplete(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      // 저장중/발행중 인디케이터 체크
      const saving = document.querySelector('.saving, .btn-publish.disabled, .loading, [class*="saving"]');
      if (!saving || saving.offsetParent === null) return true;
      await delay(500);
    }
    return false; // 타임아웃
  }

  /**
   * 발행 실행 ("완료" 버튼) — captcha 감지 + 발행 검증 포함
   */
  async function publish(visibility = 'public') {
    const publishTrace = [];
    const phase = 'publish';
    const mark = (stage, extra = {}) => pushTraceEntry(publishTrace, stage, { phase, ...extra });
    const respond = (response, stage, extra = {}) => attachTraceMetadata(response, 'publishTrace', publishTrace, stage, phase, extra);

    try {
      mark('publish_invoked', { visibility });

      // 사전 체크: CAPTCHA가 이미 표시되어 있는지
      if (detectCaptcha()) {
        const captchaContext = getCaptchaContext();
        mark('captcha_detected_before_publish', {
          captchaPresent: true,
          preferredSolveMode: captchaContext?.preferredSolveMode || null
        });
        console.warn('[TistoryAuto] CAPTCHA 감지됨 — same-tab handoff 필요');
        return respond({
          success: false,
          error: 'CAPTCHA가 감지되었습니다. 같은 탭에서 browser/CDP handoff로 풀이를 진행하세요.',
          status: 'captcha_required',
          captchaContext,
          captchaStage: 'before_publish'
        }, 'captcha_detected_before_publish');
      }

      const initialSnapshot = getEditorSnapshot();
      mark('editor_snapshot_captured', {
        snapshot: summarizeSnapshotForLog(initialSnapshot)
      });
      if (!initialSnapshot.hasMeaningfulContent) {
        mark('editor_snapshot_empty');
        return respond({
          success: false,
          error: '발행 직전 에디터 본문이 비어 있어 발행을 중단합니다.',
          status: 'content_empty',
          persistenceCheck: {
            confirmed: false,
            status: 'content_empty',
            issues: ['editor_content_missing'],
            error: formatPersistenceIssues(['editor_content_missing']),
            snapshot: summarizeSnapshotForLog(initialSnapshot)
          }
        }, 'editor_snapshot_empty');
      }

      const prePublishPersistence = await ensureEditorStatePersistence(initialSnapshot, { reason: 'pre_publish' });
      mark(prePublishPersistence.success ? 'pre_publish_persistence_ready' : 'pre_publish_persistence_failed', {
        persistenceStatus: prePublishPersistence.status || null,
        persistenceIssues: prePublishPersistence.issues || []
      });
      if (!prePublishPersistence.success) {
        return respond({
          success: false,
          error: prePublishPersistence.error || '발행 직전 에디터 동기화 검증에 실패했습니다.',
          status: prePublishPersistence.status,
          persistenceCheck: {
            confirmed: false,
            status: prePublishPersistence.status,
            issues: prePublishPersistence.issues,
            error: prePublishPersistence.error,
            snapshot: summarizeSnapshotForLog(prePublishPersistence.snapshot)
          }
        }, 'pre_publish_persistence_failed');
      }

      const expectedSnapshot = prePublishPersistence.snapshot;
      clearLastManagePostDiag();
      const managePostSeqBefore = getLastManagePostSeq();
      mark('manage_post_diag_reset', { managePostSeqBefore });

      // 최종 발행 직전에 MAIN world interceptor를 주입해 실제 페이지 XHR/fetch payload도 교정한다.
      try {
        await chrome.runtime.sendMessage({ action: 'INJECT_MAIN_WORLD_VISIBILITY_HELPER' });
        mark('main_world_interceptor_ready');
      } catch (e) {
        mark('main_world_interceptor_failed', { error: e.message });
        console.warn('[TistoryAuto] MAIN world interceptor 주입 요청 실패:', e);
      }
      const forcedVisibilityNum = String(visibilityToNumber(visibility));
      document.documentElement.dataset.blogAutoTargetVisibilityNum = forcedVisibilityNum;
      document.documentElement.setAttribute('data-blog-auto-target-visibility-num', forcedVisibilityNum);
      try { localStorage.setItem('__blog_auto_publish_marker', forcedVisibilityNum); } catch (_) {}
      mark('target_visibility_marker_set', { forcedVisibilityNum });

      // TinyMCE save() 호출하여 에디터 내용을 textarea에 동기화
      const editor = getTinyMCEEditor();
      if (editor) {
        try {
          editor.save();
          mark('editor_save_synced_to_textarea');
        } catch (e) {
          mark('editor_save_sync_failed', { error: e.message });
        }
      }

      // 발행 레이어가 이미 열려 있으면 완료 버튼을 다시 누르지 않음
      let publishLayer = document.querySelector('.publish-layer, #publish-layer, .layer-publish');
      let confirmBtn = findElement(S.publish.confirmButton, null);
      const layerAlreadyOpen = !!(publishLayer && confirmBtn);
      mark(layerAlreadyOpen ? 'publish_layer_already_open' : 'publish_layer_closed_before_open', {
        publishLayerPresent: !!publishLayer,
        confirmButtonPresent: !!confirmBtn
      });

      if (!layerAlreadyOpen) {
        // "완료" 버튼 클릭 → 발행 설정 레이어 열림
        const completeBtn = findElement(S.publish.completeButton, S.publish.fallback);
        if (!completeBtn) {
          mark('complete_button_missing');
          return respond({ success: false, error: '완료 버튼을 찾을 수 없음', status: 'editor_not_ready' }, 'complete_button_missing');
        }

        completeBtn.click();
        mark('open_publish_layer_clicked');
        const openLayerDelay = await delayWithStageJitter(1500, STAGE_JITTER_DEFAULTS);
        mark('open_publish_layer_wait_complete', {
          baseDelayMs: openLayerDelay.baseMs,
          jitterExtraMs: openLayerDelay.extraMs,
          waitedMs: openLayerDelay.waitMs
        });

        // CAPTCHA 체크 (완료 버튼 클릭 후 나타날 수 있음)
        if (detectCaptcha()) {
          const captchaContext = getCaptchaContext();
          mark('captcha_after_open_publish_layer', {
            captchaPresent: true,
            preferredSolveMode: captchaContext?.preferredSolveMode || null
          });
          console.warn('[TistoryAuto] 발행 시도 후 CAPTCHA 감지됨');
          return respond({
            success: false,
            error: '발행 중 CAPTCHA가 감지되었습니다.',
            status: 'captcha_required',
            captchaContext,
            captchaStage: 'after_open_publish_layer'
          }, 'captcha_after_open_publish_layer');
        }

        publishLayer = document.querySelector('.publish-layer, #publish-layer, .layer-publish');
        confirmBtn = findElement(S.publish.confirmButton, null);
        mark('publish_layer_state_checked', {
          publishLayerPresent: !!publishLayer,
          confirmButtonPresent: !!confirmBtn
        });
      }

      if (confirmBtn) {
        // 발행 레이어가 열린 뒤 최종 공개 설정을 적용
        const visibilityResult = await setVisibility(visibility);
        mark(visibilityResult.success ? 'visibility_applied' : 'visibility_apply_failed', {
          visibilityStatus: visibilityResult.status || null,
          expectedValue: visibilityResult.expectedValue || visibility
        });
        if (!visibilityResult.success) {
          return respond({
            success: false,
            error: `공개 설정 적용 실패 (${visibilityResult.expectedValue || visibility})`,
            status: 'visibility_failed'
          }, 'visibility_apply_failed');
        }

        // React re-render로 confirmBtn 참조가 stale할 수 있으므로 다시 찾기
        confirmBtn = findElement(S.publish.confirmButton, null);
        if (!confirmBtn) {
          // fallback: 텍스트 기반 검색
          confirmBtn = Array.from(document.querySelectorAll('button')).find(b => /(발행|저장)/.test(b.textContent.trim()) && b.closest('.layer_foot, .wrap_btn, .ReactModal__Content'));
        }
        if (!confirmBtn) {
          mark('confirm_button_missing_after_rerender');
          return respond({
            success: false,
            error: '최종 발행 버튼을 다시 찾을 수 없음 (React re-render)',
            status: 'editor_not_ready'
          }, 'confirm_button_missing_after_rerender');
        }

        const urlBefore = window.location.href;
        const preConfirmDelay = await delayWithStageJitter(350, STAGE_JITTER_DEFAULTS);
        mark('before_final_confirm_wait_complete', {
          baseDelayMs: preConfirmDelay.baseMs,
          jitterExtraMs: preConfirmDelay.extraMs,
          waitedMs: preConfirmDelay.waitMs
        });

        confirmBtn.click();
        console.log('[TistoryAuto] 최종 발행 버튼 클릭');
        mark('final_confirm_clicked', { urlBefore });
        const afterConfirmDelay = await delayWithStageJitter(2000, STAGE_JITTER_DEFAULTS);
        mark('after_final_confirm_wait_complete', {
          baseDelayMs: afterConfirmDelay.baseMs,
          jitterExtraMs: afterConfirmDelay.extraMs,
          waitedMs: afterConfirmDelay.waitMs
        });

        // CAPTCHA 체크 (최종 발행 후)
        if (detectCaptcha()) {
          const captchaContext = getCaptchaContext();
          mark('captcha_after_final_confirm', {
            captchaPresent: true,
            preferredSolveMode: captchaContext?.preferredSolveMode || null
          });
          return respond({
            success: false,
            error: '최종 발행 후 CAPTCHA가 감지되었습니다.',
            status: 'captcha_required',
            captchaContext,
            captchaStage: 'after_final_confirm'
          }, 'captcha_after_final_confirm');
        }

        // "저장중" 스피너 대기
        const saveComplete = await waitForSaveComplete(15000);
        mark(saveComplete ? 'save_indicator_cleared' : 'save_indicator_timeout');
        if (!saveComplete) {
          return respond({ success: false, error: '"저장중" 상태가 15초 이상 지속됨', status: 'save_timeout' }, 'save_indicator_timeout');
        }

        // 발행 성공 검증: URL 변경 또는 성공 알림 확인
        const verificationDelay = await delayWithStageJitter(1000, STAGE_JITTER_DEFAULTS);
        mark('post_save_verification_wait_complete', {
          baseDelayMs: verificationDelay.baseMs,
          jitterExtraMs: verificationDelay.extraMs,
          waitedMs: verificationDelay.waitMs
        });
        const urlAfter = window.location.href;
        const urlChanged = urlAfter !== urlBefore;
        const hasSuccessIndicator = !!document.querySelector('.success, .alert-success, [class*="complete"]');
        const isStillOnNewPost = urlAfter.includes('/manage/newpost');

        // 에러 메시지 체크
        const errorEl = document.querySelector('.error-message, .alert-error, [class*="error"]:not([class*="error-hide"])');
        if (errorEl && errorEl.offsetParent !== null && errorEl.textContent.trim().length > 0) {
          const errorText = errorEl.textContent.trim();
          mark('publish_error_visible', { errorText });
          return respond({ success: false, error: `발행 오류: ${errorText}`, status: 'publish_error' }, 'publish_error_visible');
        }

        const requestDiag = await waitForNextManagePostDiag(managePostSeqBefore, 12000);
        const lateCaptchaContext = getCaptchaContext();
        mark(requestDiag ? 'manage_post_diag_observed' : 'manage_post_diag_missing', {
          requestSequence: requestDiag?.sequence || null,
          captchaPresentDuringVerification: !!lateCaptchaContext?.captchaPresent
        });
        if (!requestDiag && lateCaptchaContext?.captchaPresent) {
          return respond({
            success: false,
            error: '최종 발행 검증 중 CAPTCHA가 감지되었습니다.',
            status: 'captcha_required',
            url: urlAfter,
            captchaContext: lateCaptchaContext,
            captchaStage: 'during_verification'
          }, 'captcha_during_verification');
        }

        const persistenceCheck = verifyPublishRequestPersistence(expectedSnapshot, requestDiag);
        mark(persistenceCheck.confirmed ? 'persistence_verified' : 'persistence_unverified', {
          persistenceStatus: persistenceCheck.status || null,
          persistenceIssues: persistenceCheck.issues || []
        });
        if (!persistenceCheck.confirmed) {
          return respond({
            success: false,
            error: persistenceCheck.error || '발행 payload 검증에 실패했습니다.',
            status: persistenceCheck.status,
            url: urlAfter,
            persistenceCheck
          }, 'persistence_unverified');
        }

        if (urlChanged || hasSuccessIndicator) {
          console.log('[TistoryAuto] 발행 완료! URL:', urlAfter);
          mark('publish_verified', { urlAfter, urlChanged, hasSuccessIndicator });
          return respond({ success: true, status: 'published', url: urlAfter, persistenceCheck }, 'publish_verified');
        }

        // URL 변경 없이 여전히 newpost 페이지라면 의심
        if (isStillOnNewPost) {
          mark('verification_failed_still_on_editor', { urlAfter });
          console.warn('[TistoryAuto] 발행 후에도 글쓰기 페이지에 머물러 있음');
          return respond({ success: false, error: '발행 후에도 글쓰기 페이지에서 이동하지 않음', status: 'verification_failed' }, 'verification_failed_still_on_editor');
        }

        mark('publish_verified_without_redirect', { urlAfter, urlChanged, hasSuccessIndicator });
        return respond({ success: true, status: 'published', url: urlAfter, persistenceCheck }, 'publish_verified_without_redirect');
      }

      // 발행 레이어 없이 바로 발행 시도된 경우 — 검증 수행
      const noLayerDelay = await delayWithStageJitter(2000, STAGE_JITTER_DEFAULTS);
      mark('publish_without_layer_wait_complete', {
        baseDelayMs: noLayerDelay.baseMs,
        jitterExtraMs: noLayerDelay.extraMs,
        waitedMs: noLayerDelay.waitMs
      });
      const saveComplete = await waitForSaveComplete(15000);
      mark(saveComplete ? 'save_indicator_cleared_without_layer' : 'save_indicator_timeout_without_layer');
      if (!saveComplete) {
        return respond({ success: false, error: '"저장중" 상태가 지속됨', status: 'save_timeout' }, 'save_indicator_timeout_without_layer');
      }

      if (detectCaptcha()) {
        const captchaContext = getCaptchaContext();
        mark('captcha_without_layer', {
          captchaPresent: true,
          preferredSolveMode: captchaContext?.preferredSolveMode || null
        });
        return respond({
          success: false,
          error: 'CAPTCHA 감지됨',
          status: 'captcha_required',
          captchaContext,
          captchaStage: 'without_layer'
        }, 'captcha_without_layer');
      }

      const requestDiag = await waitForNextManagePostDiag(managePostSeqBefore, 12000);
      const lateCaptchaContext = getCaptchaContext();
      mark(requestDiag ? 'manage_post_diag_observed_without_layer' : 'manage_post_diag_missing_without_layer', {
        requestSequence: requestDiag?.sequence || null,
        captchaPresentDuringVerification: !!lateCaptchaContext?.captchaPresent
      });
      if (!requestDiag && lateCaptchaContext?.captchaPresent) {
        return respond({
          success: false,
          error: '발행 검증 중 CAPTCHA가 감지되었습니다.',
          status: 'captcha_required',
          url: window.location.href,
          captchaContext: lateCaptchaContext,
          captchaStage: 'without_layer_verification'
        }, 'captcha_without_layer_verification');
      }

      const persistenceCheck = verifyPublishRequestPersistence(expectedSnapshot, requestDiag);
      mark(persistenceCheck.confirmed ? 'persistence_verified_without_layer' : 'persistence_unverified_without_layer', {
        persistenceStatus: persistenceCheck.status || null,
        persistenceIssues: persistenceCheck.issues || []
      });
      if (!persistenceCheck.confirmed) {
        return respond({
          success: false,
          error: persistenceCheck.error || '발행 payload 검증에 실패했습니다.',
          status: persistenceCheck.status,
          url: window.location.href,
          persistenceCheck
        }, 'persistence_unverified_without_layer');
      }

      console.log('[TistoryAuto] 완료 버튼으로 발행됨 (레이어 없음)');
      mark('publish_verified_without_layer', { url: window.location.href });
      return respond({ success: true, status: 'published', url: window.location.href, persistenceCheck }, 'publish_verified_without_layer');
    } catch (error) {
      mark('publish_exception', { error: error.message });
      console.error('[TistoryAuto] 발행 실패:', error);
      return respond({ success: false, error: error.message }, 'publish_exception');
    }
  }

  /**
   * 전체 글 작성 프로세스
   */
  async function writePost(postData) {
    const results = {};
    const writeTrace = [];
    const phase = 'write_post';
    const mark = (stage, extra = {}) => pushTraceEntry(writeTrace, stage, { phase, ...extra });
    const respond = (response, stage, extra = {}) => attachTraceMetadata(response, 'writeTrace', writeTrace, stage, phase, extra);

    mark('write_post_invoked', {
      hasTitle: !!postData.title,
      hasCategory: !!postData.category,
      hasContent: !!postData.content,
      imageCount: Array.isArray(postData.images) ? postData.images.length : 0,
      tagCount: Array.isArray(postData.tags) ? postData.tags.length : 0,
      autoPublish: !!postData.autoPublish,
      visibility: postData.visibility || null
    });

    const writePreflight = await waitForEditorReady({
      timeoutMs: 4000,
      intervalMs: 250,
      settleDelayMs: 150
    });
    mark(writePreflight.success ? 'editor_preflight_ready' : 'editor_preflight_failed', {
      waitedMs: writePreflight.waitedMs,
      pollCount: writePreflight.pollCount,
      reason: writePreflight.reason || null
    });

    if (!writePreflight.success) {
      return respond({
        success: false,
        status: writePreflight.status,
        error: writePreflight.error,
        results,
        preflight: {
          reason: writePreflight.reason,
          waitedMs: writePreflight.waitedMs,
          pollCount: writePreflight.pollCount,
          diagnostics: writePreflight.diagnostics
        },
        message: '실제 에디터가 준비되지 않아 제목 입력 전에 쓰기를 중단했습니다.'
      }, 'editor_preflight_failed');
    }

    // 1. 제목
    if (postData.title) {
      mark('title_step_started');
      results.title = await setTitle(postData.title);
      mark(results.title?.success ? 'title_step_completed' : 'title_step_failed', {
        titleStatus: results.title?.status || null
      });
      const titleDelay = await delayWithStageJitter(300, STAGE_JITTER_DEFAULTS);
      mark('title_gap_wait_complete', {
        baseDelayMs: titleDelay.baseMs,
        jitterExtraMs: titleDelay.extraMs,
        waitedMs: titleDelay.waitMs
      });
    }

    // 2. 카테고리 (본문보다 먼저 — 본문 입력 후 포커스 문제 방지)
    if (postData.category) {
      mark('category_step_started');
      results.category = await setCategory(postData.category);
      mark(results.category?.success ? 'category_step_completed' : 'category_step_failed', {
        categoryStatus: results.category?.status || null
      });
      const categoryDelay = await delayWithStageJitter(300, STAGE_JITTER_DEFAULTS);
      mark('category_gap_wait_complete', {
        baseDelayMs: categoryDelay.baseMs,
        jitterExtraMs: categoryDelay.extraMs,
        waitedMs: categoryDelay.waitMs
      });
    }

    // 3. 본문
    if (postData.content) {
      mark('content_step_started');
      results.content = await setContent(postData.content);
      mark(results.content?.success ? 'content_step_completed' : 'content_step_failed', {
        contentStatus: results.content?.status || null
      });
      const contentDelay = await delayWithStageJitter(500, STAGE_JITTER_DEFAULTS);
      mark('content_gap_wait_complete', {
        baseDelayMs: contentDelay.baseMs,
        jitterExtraMs: contentDelay.extraMs,
        waitedMs: contentDelay.waitMs
      });
    }

    // 4. 이미지 삽입 (본문 뒤에 추가)
    if (postData.images && postData.images.length > 0) {
      mark('images_step_started', { imageCount: postData.images.length });
      results.images = await insertImages(postData.images);
      mark(results.images?.success ? 'images_step_completed' : 'images_step_failed', {
        imageStatus: results.images?.status || null
      });
      const imagesDelay = await delayWithStageJitter(500, STAGE_JITTER_DEFAULTS);
      mark('images_gap_wait_complete', {
        baseDelayMs: imagesDelay.baseMs,
        jitterExtraMs: imagesDelay.extraMs,
        waitedMs: imagesDelay.waitMs
      });
    }

    // 5. 태그
    if (postData.tags && postData.tags.length > 0) {
      mark('tags_step_started', { tagCount: postData.tags.length });
      results.tags = await setTags(postData.tags);
      mark(results.tags?.success ? 'tags_step_completed' : 'tags_step_failed', {
        tagStatus: results.tags?.status || null
      });
      const tagsDelay = await delayWithStageJitter(300, STAGE_JITTER_DEFAULTS);
      mark('tags_gap_wait_complete', {
        baseDelayMs: tagsDelay.baseMs,
        jitterExtraMs: tagsDelay.extraMs,
        waitedMs: tagsDelay.waitMs
      });
    }

    // 6. 공개 설정
    // autoPublish=true인 경우 실제 공개 설정은 publish() 내부의 발행 레이어에서 최종 적용한다.
    if (postData.visibility && !postData.autoPublish) {
      mark('visibility_step_started', { visibility: postData.visibility });
      results.visibility = await setVisibility(postData.visibility);
      mark(results.visibility?.success ? 'visibility_step_completed' : 'visibility_step_failed', {
        visibilityStatus: results.visibility?.status || null
      });
      const visibilityDelay = await delayWithStageJitter(300, STAGE_JITTER_DEFAULTS);
      mark('visibility_gap_wait_complete', {
        baseDelayMs: visibilityDelay.baseMs,
        jitterExtraMs: visibilityDelay.extraMs,
        waitedMs: visibilityDelay.waitMs
      });
    } else if (postData.visibility && postData.autoPublish) {
      results.visibility = { success: true, deferred: true, target: postData.visibility };
      mark('visibility_deferred_to_publish', { visibility: postData.visibility });
    }

    // 7. 발행 (autoPublish가 true인 경우)
    if (postData.autoPublish) {
      // 발행 전 에디터 내용 최종 확인 — publish() 호출 이전에 수행
      if (results.content?.success || results.images?.success) {
        const preflightSnapshot = getEditorSnapshot();
        mark('publish_preflight_snapshot_captured', {
          snapshot: summarizeSnapshotForLog(preflightSnapshot)
        });
        if (!preflightSnapshot.hasMeaningfulContent) {
          mark('publish_preflight_snapshot_empty');
          return respond({
            success: false,
            status: 'content_empty',
            error: '발행 직전 에디터 본문이 비어있어 발행을 중단합니다.',
            results,
            message: '발행 직전 에디터 본문이 비어있어 발행을 중단합니다.'
          }, 'publish_preflight_snapshot_empty');
        }

        const preflightPersistence = await ensureEditorStatePersistence(preflightSnapshot, { reason: 'write_post_preflight' });
        mark(preflightPersistence.success ? 'publish_preflight_persistence_ready' : 'publish_preflight_persistence_failed', {
          persistenceStatus: preflightPersistence.status || null,
          persistenceIssues: preflightPersistence.issues || []
        });
        if (!preflightPersistence.success) {
          return respond({
            success: false,
            status: preflightPersistence.status,
            error: preflightPersistence.error || '발행 직전 에디터 동기화 검증에 실패했습니다.',
            results,
            message: preflightPersistence.error || '발행 직전 에디터 동기화 검증에 실패했습니다.'
          }, 'publish_preflight_persistence_failed');
        }
      }

      const beforePublishDelay = await delayWithStageJitter(500, STAGE_JITTER_DEFAULTS);
      mark('before_publish_wait_complete', {
        baseDelayMs: beforePublishDelay.baseMs,
        jitterExtraMs: beforePublishDelay.extraMs,
        waitedMs: beforePublishDelay.waitMs
      });
      results.publish = await publish(postData.visibility || 'public');
      mark(results.publish?.success ? 'publish_step_completed' : 'publish_step_failed', {
        publishStatus: results.publish?.status || null,
        publishStage: results.publish?.stage || null
      });
    }

    const allSuccess = Object.values(results).every(r => r.success);
    // 개별 단계에서 특수 상태가 반환된 경우 전파
    const failedStep = Object.entries(results).find(([, r]) => !r.success && r.status);
    const status = failedStep ? failedStep[1].status : (allSuccess ? 'published' : 'partial_failure');
    const finalWriteStage = failedStep ? `${failedStep[0]}_step_failed` : (allSuccess ? 'write_post_completed' : 'write_post_partial_failure');

    console.log('[TistoryAuto] 글 작성 결과:', results);

    const baseResponse = respond({
      success: allSuccess,
      status,
      error: failedStep ? (failedStep[1].error || null) : null,
      results,
      publishTrace: results.publish?.publishTrace || null,
      publishPhase: results.publish?.phase || null,
      publishStage: results.publish?.stage || null,
      publishLastTransition: results.publish?.lastTransition || null,
      captchaContext: results.publish?.captchaContext || null,
      persistenceCheck: results.publish?.persistenceCheck || null,
      message: allSuccess ? '글 작성이 완료되었습니다.' : '일부 단계에서 오류가 발생했습니다.'
    }, finalWriteStage);

    if (results.publish?.publishTrace) {
      baseResponse.publishTrace = cloneTraceEntries(results.publish.publishTrace);
    }
    if (results.publish?.phase) {
      baseResponse.phase = results.publish.phase;
    }
    if (results.publish?.stage) {
      baseResponse.stage = results.publish.stage;
    }
    if (results.publish?.lastTransition) {
      baseResponse.lastTransition = results.publish.lastTransition;
    }

    return baseResponse;
  }

  function getCurrentTagsSnapshot() {
    const tags = new Set();
    const container = document.querySelector(S.tag.container);

    const candidates = container
      ? container.querySelectorAll('.tag-item, .tag, .token, .chip, li, span, a')
      : [];

    candidates.forEach(node => {
      const text = node.textContent?.trim();
      if (!text) return;
      if (text.length > 40) return;
      if (/^(태그|추가|입력)$/i.test(text)) return;
      tags.add(text.replace(/^#/, ''));
    });

    const tagInput = findElement(S.tag.input, S.tag.fallback);
    const inlineValue = tagInput?.value?.trim();
    if (inlineValue && !tags.size) {
      inlineValue.split(',').map(tag => tag.trim()).filter(Boolean).forEach(tag => tags.add(tag.replace(/^#/, '')));
    }

    return [...tags];
  }

  function getDraftSnapshot() {
    const titleEl = findElement(S.title.input, S.title.fallback);
    const title = titleEl?.value?.trim() || titleEl?.textContent?.trim() || '';
    const editor = getTinyMCEEditor();
    const editorProbe = getEditorReadinessProbe();
    let contentHtml = '';
    let contentText = '';

    if (editor) {
      try {
        contentHtml = editor.getContent({ format: 'html' }) || '';
      } catch (error) {
        console.warn('[TistoryAuto] draft snapshot HTML 읽기 실패:', error);
      }

      try {
        contentText = editor.getContent({ format: 'text' }) || '';
      } catch (error) {
        console.warn('[TistoryAuto] draft snapshot text 읽기 실패:', error);
      }
    }

    if (!contentHtml || !contentText) {
      const editorDoc = getEditorDocument();
      const body = editorDoc ? getEditorBody(editorDoc) : null;
      if (body) {
        contentHtml = contentHtml || body.innerHTML || '';
        contentText = contentText || body.textContent || '';
      }
    }

    const normalizedText = contentText.replace(/\s+/g, ' ').trim();
    const categoryBtn = findElement(S.category.button, null);

    return {
      success: true,
      url: window.location.href,
      title,
      currentCategory: categoryBtn?.textContent?.trim() || '',
      tags: getCurrentTagsSnapshot(),
      contentHtmlLength: contentHtml.trim().length,
      contentTextLength: normalizedText.length,
      contentPreview: normalizedText.slice(0, 160),
      imageCount: (contentHtml.match(/<img\b/gi) || []).length,
      editorReady: editorProbe.ready,
      editorProbe
    };
  }

  /**
   * 현재 페이지 정보 수집 (카테고리 목록 포함)
   */
  function getPageInfo() {
    const categoryBtn = findElement(S.category.button, null);
    const editorProbe = getEditorReadinessProbe();

    // 카테고리 버튼 클릭해서 목록 가져오기
    const categories = [];
    const categoryItems = document.querySelectorAll(S.category.items);
    categoryItems.forEach(item => {
      const text = item.textContent.trim();
      const id = item.id?.replace('category-item-', '') || '';
      if (text) categories.push({ name: text, id });
    });

    return {
      url: window.location.href,
      isNewPost: window.location.pathname.includes(S.page.newPost),
      isEditPost: window.location.pathname.includes(S.page.editPost),
      currentCategory: categoryBtn?.textContent?.trim() || '',
      availableCategories: categories,
      editorReady: editorProbe.ready,
      editorProbe
    };
  }

  // ── 메시지 리스너 ──────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[TistoryAuto] 메시지 수신:', message);

    const handleAsync = async () => {
      switch (message.action) {
        case 'WRITE_POST':
          return await writePost(message.data);

        case 'SET_TITLE':
          return await setTitle(message.data.title);

        case 'SET_CONTENT':
          return await setContent(message.data.content);

        case 'SET_CATEGORY':
          return await setCategory(message.data.category);

        case 'SET_TAGS':
          return await setTags(message.data.tags);

        case 'SET_VISIBILITY':
          return await setVisibility(message.data.visibility);

        case 'INSERT_IMAGES':
          return await insertImages(message.data.images);

        case 'PUBLISH':
          return await publish(message.data?.visibility || 'public');

        // CAPTCHA 해결 후 발행만 재시도 (에디터 내용은 이미 입력됨)
        case 'RESUME_PUBLISH':
          return await publish(message.data?.visibility || 'public');

        // CAPTCHA 표시 여부 확인
        case 'CHECK_CAPTCHA':
          return { success: true, captchaPresent: detectCaptcha() };

        case 'GET_CAPTCHA_CONTEXT':
          return getCaptchaContext();

        case 'PREPARE_CAPTCHA_CAPTURE':
          return await prepareCaptchaCapture();

        case 'GET_CAPTCHA_IMAGE_ARTIFACT':
          return await extractCaptchaImageArtifact();

        case 'SUBMIT_CAPTCHA':
          return await submitCaptchaAnswer(message.data?.answer, message.data || {});

        case 'GET_PAGE_INFO':
          return getPageInfo();

        case 'GET_DRAFT_SNAPSHOT':
          return getDraftSnapshot();

        case 'PROBE_EDITOR_READY':
          return await waitForEditorReady(message.data || {});

        case 'PING':
          {
            const editorProbe = getEditorReadinessProbe();
            return {
              success: true,
              message: 'Content script is alive',
              editorReady: editorProbe.ready,
              editorProbe
            };
          }

        default:
          return { success: false, error: `알 수 없는 액션: ${message.action}` };
      }
    };

    handleAsync().then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });

    return true; // 비동기 응답
  });

  // ── 자동저장 복구 다이얼로그 자동 dismiss ──
  // 티스토리 에디터는 이전 임시저장본이 있으면 confirm()을 띄움
  // 원래 confirm을 오버라이드해서 항상 취소(false)로 응답
  const _origConfirm = window.confirm;
  window.confirm = function(msg) {
    if (msg && /저장된 글이 있습니다|이어서 작성/.test(msg)) {
      console.log('[TistoryAuto] 자동저장 복구 다이얼로그 자동 dismiss:', msg);
      return false; // 취소 (새로 작성)
    }
    return _origConfirm.call(window, msg);
  };

  // ── 초기화 ──────────────────────────────────
  installPostVisibilityInterceptor();
  console.log('[TistoryAuto] Content Script 로드 완료 ✅');
  console.log('[TistoryAuto] 페이지:', window.location.href);

  // Background에 준비 완료 알림
  chrome.runtime.sendMessage({ action: 'CONTENT_READY', url: window.location.href });
})();
