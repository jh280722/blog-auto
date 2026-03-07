/**
 * 티스토리 에디터 DOM 조작 Content Script
 * 실제 티스토리 에디터(2025년 기준) DOM 구조에 맞게 작성됨
 * 티스토리 글쓰기 페이지에서 자동으로 실행됩니다.
 */

(() => {
  'use strict';

  const S = window.__TISTORY_SELECTORS || SELECTORS;
  const IMG = window.__IMAGE_HANDLER || ImageHandler;

  function visibilityToNumber(visibility = 'public') {
    return visibility === 'private' ? 0 : visibility === 'protected' ? 15 : 20;
  }

  function installPostVisibilityInterceptor() {
    const markerId = '__blog-auto-visibility-interceptor';
    if (document.getElementById(markerId)) return;

    const script = document.createElement('script');
    script.id = markerId;
    script.textContent = `(() => {
      if (window.__BLOG_AUTO_VISIBILITY_INTERCEPTOR_INSTALLED__) return;
      window.__BLOG_AUTO_VISIBILITY_INTERCEPTOR_INSTALLED__ = true;

      const shouldRewrite = (url) => typeof url === 'string' && url.includes('/manage/post.json');
      const getForcedVisibility = () => {
        const raw = document.documentElement.dataset.blogAutoTargetVisibilityNum;
        return raw == null || raw === '' ? null : Number(raw);
      };
      const logRewrite = (payload) => {
        try {
          localStorage.setItem('__blog_auto_forced_post_body', JSON.stringify(payload));
        } catch (e) {}
      };
      const rewriteBody = (body) => {
        const forcedVisibility = getForcedVisibility();
        if (forcedVisibility == null) return body;
        try {
          if (typeof body === 'string') {
            const parsed = JSON.parse(body);
            parsed.visibility = forcedVisibility;
            logRewrite(parsed);
            console.log('[TistoryAuto:page] manage/post.json visibility 강제 적용:', forcedVisibility, parsed);
            return JSON.stringify(parsed);
          }
        } catch (e) {
          console.warn('[TistoryAuto:page] visibility rewrite 실패:', e);
        }
        return body;
      };

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__blogAutoMeta = { method, url };
        return origOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(body) {
        const meta = this.__blogAutoMeta || {};
        const nextBody = shouldRewrite(meta.url) ? rewriteBody(body) : body;
        return origSend.call(this, nextBody);
      };

      if (typeof window.fetch === 'function') {
        const origFetch = window.fetch.bind(window);
        window.fetch = function(input, init) {
          const url = typeof input === 'string' ? input : input?.url || '';
          if (shouldRewrite(url) && init && 'body' in init) {
            init = { ...init, body: rewriteBody(init.body) };
          }
          return origFetch(input, init);
        };
      }
    })();`;

    (document.head || document.documentElement).appendChild(script);
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

  // 유틸: input/textarea 이벤트 시뮬레이션 (React/Vue 호환)
  function simulateInput(element, value) {
    // textarea와 input 모두 지원
    const proto = element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;

    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(element, value);
    } else {
      element.value = value;
    }

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

  /**
   * 본문 입력 (HTML) — TinyMCE API 우선, DOM fallback
   * TinyMCE setContent + save를 사용하여 내부 textarea 동기화 보장
   */
  async function setContent(htmlContent) {
    try {
      if (!htmlContent || htmlContent.trim().length === 0) {
        return { success: false, error: '본문 내용이 비어있습니다.', status: 'content_empty' };
      }

      await delay(500);

      let contentSet = false;

      // 1차: TinyMCE API (가장 안전한 경로 — 내부 textarea 동기화 포함)
      const editor = getTinyMCEEditor();
      if (editor) {
        try {
          editor.setContent(htmlContent);
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

      // 검증: 본문이 실제로 들어갔는지 확인
      await delay(300);
      const verifyEditor = getTinyMCEEditor();
      if (verifyEditor) {
        const currentContent = verifyEditor.getContent();
        if (!currentContent || currentContent.trim().length === 0) {
          return { success: false, error: '본문이 에디터에 반영되지 않음', status: 'verification_failed' };
        }
      } else {
        const editorDoc = getEditorDocument();
        const body = editorDoc ? getEditorBody(editorDoc) : null;
        const bodyText = body ? body.textContent.trim() : '';
        if (body && bodyText.length === 0) {
          return { success: false, error: '본문이 에디터에 반영되지 않음', status: 'verification_failed' };
        }
      }

      return { success: true };
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
      let radio;
      switch (visibility) {
        case 'public':
          radio = findElement(S.visibility.openRadio, S.visibility.fallback);
          break;
        case 'protected':
          radio = findElement(S.visibility.protectedRadio, null);
          break;
        case 'private':
          radio = findElement(S.visibility.privateRadio, null);
          break;
        default:
          radio = findElement(S.visibility.openRadio, S.visibility.fallback);
      }

      if (!radio) {
        return { success: false, error: `공개 설정 라디오를 찾을 수 없음: ${visibility}` };
      }

      const label = radio.id ? document.querySelector(`label[for="${radio.id}"]`) : null;
      if (label) {
        label.click();
      } else {
        radio.click();
      }

      if ('checked' in radio) {
        radio.checked = true;
      }
      radio.dispatchEvent(new Event('input', { bubbles: true }));
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      await delay(250);

      const checked = document.querySelector(`${S.visibility.openRadio}:checked, ${S.visibility.protectedRadio}:checked, ${S.visibility.privateRadio}:checked, input[name="basicSet"]:checked, input[name="visibility"]:checked`);
      const checkedValue = checked?.value || null;
      const expectedValue = visibility === 'public' ? '20' : visibility === 'protected' ? '15' : '0';
      const publishBtnText = findElement(S.publish.confirmButton, null)?.textContent?.trim() || null;
      const textMatches = visibility === 'private'
        ? /비공개/.test(publishBtnText || '')
        : visibility === 'protected'
          ? /(보호|공개)/.test(publishBtnText || '')
          : /공개/.test(publishBtnText || '');

      console.log('[TistoryAuto] 공개 설정 완료:', visibility, 'checked=', checkedValue, 'button=', publishBtnText);
      return { success: checkedValue === expectedValue && textMatches, checkedValue, expectedValue, publishBtnText };
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
  async function uploadImageViaTistory(imageBlob, filename = 'image.png') {
    try {
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
      await delay(2000); // 업로드 완료 대기
      return true;
    } catch (error) {
      console.error('[TistoryAuto] 티스토리 업로더 실패:', error);
      return false;
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

      const editorDoc = getEditorDocument();
      let uploadCount = 0;
      let inlineCount = 0;

      for (const image of images) {
        // base64 데이터가 있으면 → 티스토리 업로더로 실제 업로드 시도
        if (image.base64) {
          const blob = IMG.base64ToBlob(image.base64);
          const filename = image.alt || `image_${Date.now()}.png`;
          const success = await uploadImageViaTistory(blob, filename);
          if (success) {
            uploadCount++;
          } else if (editorDoc) {
            // 업로드 실패 시 에디터에 직접 삽입
            IMG.insertImageToEditor(editorDoc, {
              src: image.base64,
              alt: image.alt || ''
            });
            inlineCount++;
          }
        }
        // URL만 있으면 → 에디터에 <img> 태그로 직접 삽입
        else if (image.url || image.src) {
          const imgSrc = image.url || image.src;

          if (editorDoc) {
            const body = getEditorBody(editorDoc);
            if (body) {
              // figure + img 구조 (티스토리 네이티브 스타일)
              const figure = editorDoc.createElement('figure');
              figure.setAttribute('data-ke-type', 'image');
              figure.setAttribute('data-ke-mobilestyle', 'widthContent');

              const img = editorDoc.createElement('img');
              img.src = imgSrc;
              img.alt = image.alt || '';
              img.style.maxWidth = '100%';

              figure.appendChild(img);

              // 이미지 설명용 figcaption
              if (image.alt) {
                const caption = editorDoc.createElement('figcaption');
                caption.textContent = image.alt;
                figure.appendChild(caption);
              }

              body.appendChild(figure);

              // 이미지 뒤에 빈 줄 추가
              const p = editorDoc.createElement('p');
              p.innerHTML = '&nbsp;';
              body.appendChild(p);

              inlineCount++;
            }
          }
        }

        await delay(500);
      }

      console.log(`[TistoryAuto] 이미지 삽입 완료: 업로드 ${uploadCount}개, 인라인 ${inlineCount}개`);
      return { success: true, uploaded: uploadCount, inline: inlineCount };
    } catch (error) {
      console.error('[TistoryAuto] 이미지 삽입 실패:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * CAPTCHA/차단 상태 감지
   */
  function detectCaptcha() {
    // DKAPTCHA, reCAPTCHA, 또는 기타 보안 요소 감지
    const captchaSelectors = [
      '#dkaptcha', '.dkaptcha', '[class*="captcha"]', '[id*="captcha"]',
      '.g-recaptcha', '#recaptcha', 'iframe[src*="captcha"]',
      '.captcha-wrap', '#captchaImg'
    ];
    for (const sel of captchaSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return true; // visible captcha
    }
    return false;
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

  function summarizeElement(el, selector, kind = 'captcha_candidate') {
    return {
      kind,
      selector,
      tagName: el.tagName?.toLowerCase() || null,
      id: el.id || null,
      className: compactText(el.className || '', 120),
      text: compactText(el.textContent || '', 220),
      ariaLabel: el.getAttribute?.('aria-label') || null,
      title: el.getAttribute?.('title') || null,
      name: el.getAttribute?.('name') || null,
      src: (el.tagName === 'IFRAME' || el.tagName === 'IMG') ? (el.getAttribute('src') || null) : null,
      rect: serializeRect(el.getBoundingClientRect())
    };
  }

  function getCaptchaContext() {
    const selectorSpecs = [
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

    const seen = new Set();
    const candidates = [];

    for (const spec of selectorSpecs) {
      const elements = document.querySelectorAll(spec.selector);
      elements.forEach((el) => {
        if (!isVisibleElement(el)) return;
        const key = `${spec.selector}::${el.tagName}::${el.id || ''}::${el.getAttribute('src') || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(summarizeElement(el, spec.selector, spec.kind));
      });
    }

    const publishLayer = document.querySelector('.publish-layer, #publish-layer, .layer-publish');
    const confirmBtn = findElement(S.publish.confirmButton, null)
      || Array.from(document.querySelectorAll('button')).find(b => /(발행|저장)/.test((b.textContent || '').trim()) && b.closest('.layer_foot, .wrap_btn, .ReactModal__Content'));
    const completeBtn = findElement(S.publish.completeButton, S.publish.fallback);

    return {
      success: true,
      url: window.location.href,
      title: document.title,
      captchaPresent: detectCaptcha(),
      candidateCount: candidates.length,
      candidates,
      publishLayerPresent: !!(publishLayer && isVisibleElement(publishLayer)),
      publishLayerText: compactText(publishLayer?.textContent || '', 320),
      confirmButtonText: compactText(confirmBtn?.textContent || '', 80),
      completeButtonText: compactText(completeBtn?.textContent || '', 80),
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio || 1
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
    try {
      // 사전 체크: CAPTCHA가 이미 표시되어 있는지
      if (detectCaptcha()) {
        console.warn('[TistoryAuto] CAPTCHA 감지됨 — 수동 처리 필요');
        return { success: false, error: 'CAPTCHA가 감지되었습니다. 수동으로 처리해주세요.', status: 'captcha_required' };
      }

      // 최종 발행 직전에 MAIN world interceptor를 주입해 실제 페이지 XHR/fetch payload도 교정한다.
      try {
        await chrome.runtime.sendMessage({ action: 'INJECT_MAIN_WORLD_VISIBILITY_HELPER' });
      } catch (e) {
        console.warn('[TistoryAuto] MAIN world interceptor 주입 요청 실패:', e);
      }
      const forcedVisibilityNum = String(visibilityToNumber(visibility));
      document.documentElement.dataset.blogAutoTargetVisibilityNum = forcedVisibilityNum;
      document.documentElement.setAttribute('data-blog-auto-target-visibility-num', forcedVisibilityNum);
      try { localStorage.setItem('__blog_auto_publish_marker', forcedVisibilityNum); } catch (_) {}

      // TinyMCE save() 호출하여 에디터 내용을 textarea에 동기화
      const editor = getTinyMCEEditor();
      if (editor) {
        try { editor.save(); } catch (e) { /* 무시 */ }
      }

      // 발행 레이어가 이미 열려 있으면 완료 버튼을 다시 누르지 않음
      let publishLayer = document.querySelector('.publish-layer, #publish-layer, .layer-publish');
      let confirmBtn = findElement(S.publish.confirmButton, null);
      const layerAlreadyOpen = !!(publishLayer && confirmBtn);

      if (!layerAlreadyOpen) {
        // "완료" 버튼 클릭 → 발행 설정 레이어 열림
        const completeBtn = findElement(S.publish.completeButton, S.publish.fallback);
        if (!completeBtn) {
          return { success: false, error: '완료 버튼을 찾을 수 없음', status: 'editor_not_ready' };
        }

        completeBtn.click();
        await delay(1500);

        // CAPTCHA 체크 (완료 버튼 클릭 후 나타날 수 있음)
        if (detectCaptcha()) {
          console.warn('[TistoryAuto] 발행 시도 후 CAPTCHA 감지됨');
          return { success: false, error: '발행 중 CAPTCHA가 감지되었습니다.', status: 'captcha_required' };
        }

        publishLayer = document.querySelector('.publish-layer, #publish-layer, .layer-publish');
        confirmBtn = findElement(S.publish.confirmButton, null);
      } else {
        console.log('[TistoryAuto] 발행 레이어가 이미 열려 있어 완료 버튼 클릭 생략');
      }

      if (confirmBtn) {
        // 발행 레이어가 열린 뒤 최종 공개 설정을 적용
        const visibilityResult = await setVisibility(visibility);
        if (!visibilityResult.success) {
          return { success: false, error: `공개 설정 적용 실패 (${visibilityResult.expectedValue || visibility})`, status: 'visibility_failed' };
        }

        // React re-render로 confirmBtn 참조가 stale할 수 있으므로 다시 찾기
        confirmBtn = findElement(S.publish.confirmButton, null);
        if (!confirmBtn) {
          // fallback: 텍스트 기반 검색
          confirmBtn = Array.from(document.querySelectorAll('button')).find(b => /(발행|저장)/.test(b.textContent.trim()) && b.closest('.layer_foot, .wrap_btn, .ReactModal__Content'));
        }
        if (!confirmBtn) {
          return { success: false, error: '최종 발행 버튼을 다시 찾을 수 없음 (React re-render)', status: 'editor_not_ready' };
        }

        const urlBefore = window.location.href;

        confirmBtn.click();
        console.log('[TistoryAuto] 최종 발행 버튼 클릭');
        await delay(2000);

        // CAPTCHA 체크 (최종 발행 후)
        if (detectCaptcha()) {
          return { success: false, error: '최종 발행 후 CAPTCHA가 감지되었습니다.', status: 'captcha_required' };
        }

        // "저장중" 스피너 대기
        const saveComplete = await waitForSaveComplete(15000);
        if (!saveComplete) {
          return { success: false, error: '"저장중" 상태가 15초 이상 지속됨', status: 'save_timeout' };
        }

        // 발행 성공 검증: URL 변경 또는 성공 알림 확인
        await delay(1000);
        const urlAfter = window.location.href;
        const urlChanged = urlAfter !== urlBefore;
        const hasSuccessIndicator = !!document.querySelector('.success, .alert-success, [class*="complete"]');
        const isStillOnNewPost = urlAfter.includes('/manage/newpost');

        // 에러 메시지 체크
        const errorEl = document.querySelector('.error-message, .alert-error, [class*="error"]:not([class*="error-hide"])');
        if (errorEl && errorEl.offsetParent !== null && errorEl.textContent.trim().length > 0) {
          return { success: false, error: `발행 오류: ${errorEl.textContent.trim()}`, status: 'publish_error' };
        }

        if (urlChanged || hasSuccessIndicator) {
          console.log('[TistoryAuto] 발행 완료! URL:', urlAfter);
          return { success: true, status: 'published', url: urlAfter };
        }

        // URL 변경 없이 여전히 newpost 페이지라면 의심
        if (isStillOnNewPost) {
          console.warn('[TistoryAuto] 발행 후에도 글쓰기 페이지에 머물러 있음');
          return { success: false, error: '발행 후에도 글쓰기 페이지에서 이동하지 않음', status: 'verification_failed' };
        }

        return { success: true, status: 'published' };
      }

      // 발행 레이어 없이 바로 발행 시도된 경우 — 검증 수행
      await delay(2000);
      const saveComplete = await waitForSaveComplete(15000);
      if (!saveComplete) {
        return { success: false, error: '"저장중" 상태가 지속됨', status: 'save_timeout' };
      }

      if (detectCaptcha()) {
        return { success: false, error: 'CAPTCHA 감지됨', status: 'captcha_required' };
      }

      console.log('[TistoryAuto] 완료 버튼으로 발행됨 (레이어 없음)');
      return { success: true, status: 'published' };
    } catch (error) {
      console.error('[TistoryAuto] 발행 실패:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 전체 글 작성 프로세스
   */
  async function writePost(postData) {
    const results = {};

    // 1. 제목
    if (postData.title) {
      results.title = await setTitle(postData.title);
      await delay(300);
    }

    // 2. 카테고리 (본문보다 먼저 — 본문 입력 후 포커스 문제 방지)
    if (postData.category) {
      results.category = await setCategory(postData.category);
      await delay(300);
    }

    // 3. 본문
    if (postData.content) {
      results.content = await setContent(postData.content);
      await delay(500);
    }

    // 4. 이미지 삽입 (본문 뒤에 추가)
    if (postData.images && postData.images.length > 0) {
      results.images = await insertImages(postData.images);
      await delay(500);
    }

    // 5. 태그
    if (postData.tags && postData.tags.length > 0) {
      results.tags = await setTags(postData.tags);
      await delay(300);
    }

    // 6. 공개 설정
    // autoPublish=true인 경우 실제 공개 설정은 publish() 내부의 발행 레이어에서 최종 적용한다.
    if (postData.visibility && !postData.autoPublish) {
      results.visibility = await setVisibility(postData.visibility);
      await delay(300);
    } else if (postData.visibility && postData.autoPublish) {
      results.visibility = { success: true, deferred: true, target: postData.visibility };
    }

    // 7. 발행 (autoPublish가 true인 경우)
    if (postData.autoPublish) {
      // 발행 전 에디터 내용 최종 확인 — publish() 호출 이전에 수행
      if (results.content?.success) {
        const editor = getTinyMCEEditor();
        if (editor) {
          const finalContent = editor.getContent();
          if (!finalContent || finalContent.trim().length === 0) {
            return {
              success: false,
              status: 'content_empty',
              results,
              message: '발행 직전 에디터 본문이 비어있어 발행을 중단합니다.'
            };
          }
        }
      }

      await delay(500);
      results.publish = await publish(postData.visibility || 'public');
    }

    const allSuccess = Object.values(results).every(r => r.success);
    // 개별 단계에서 특수 상태가 반환된 경우 전파
    const failedStep = Object.entries(results).find(([, r]) => !r.success && r.status);
    const status = failedStep ? failedStep[1].status : (allSuccess ? 'published' : 'partial_failure');

    console.log('[TistoryAuto] 글 작성 결과:', results);

    return {
      success: allSuccess,
      status,
      results,
      message: allSuccess ? '글 작성이 완료되었습니다.' : '일부 단계에서 오류가 발생했습니다.'
    };
  }

  /**
   * 현재 페이지 정보 수집 (카테고리 목록 포함)
   */
  function getPageInfo() {
    const categoryBtn = findElement(S.category.button, null);

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
      editorReady: !!getEditorDocument()
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
          return await publish();

        // CAPTCHA 해결 후 발행만 재시도 (에디터 내용은 이미 입력됨)
        case 'RESUME_PUBLISH':
          return await publish();

        // CAPTCHA 표시 여부 확인
        case 'CHECK_CAPTCHA':
          return { success: true, captchaPresent: detectCaptcha() };

        case 'GET_CAPTCHA_CONTEXT':
          return getCaptchaContext();

        case 'GET_PAGE_INFO':
          return getPageInfo();

        case 'PING':
          return { success: true, message: 'Content script is alive' };

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
