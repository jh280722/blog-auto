/**
 * 티스토리 에디터 DOM 조작 Content Script
 * 실제 티스토리 에디터(2025년 기준) DOM 구조에 맞게 작성됨
 * 티스토리 글쓰기 페이지에서 자동으로 실행됩니다.
 */

(() => {
  'use strict';

  const S = window.__TISTORY_SELECTORS || SELECTORS;
  const IMG = window.__IMAGE_HANDLER || ImageHandler;

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
   * 본문 입력 (HTML)
   */
  async function setContent(htmlContent) {
    try {
      await delay(500); // 에디터 로딩 대기

      const editorDoc = getEditorDocument();
      if (!editorDoc) throw new Error('에디터 문서를 찾을 수 없음');

      const body = getEditorBody(editorDoc);
      if (!body) throw new Error('에디터 본문 영역을 찾을 수 없음');

      // 기존 내용 비우고 새 내용 삽입
      body.innerHTML = htmlContent;

      // TinyMCE에 변경 사항 알리기
      body.dispatchEvent(new Event('input', { bubbles: true }));
      body.dispatchEvent(new Event('change', { bubbles: true }));

      // TinyMCE API가 있으면 직접 호출
      try {
        const win = document.querySelector(S.editor.iframe)?.contentWindow;
        if (win?.tinymce?.activeEditor) {
          win.tinymce.activeEditor.setContent(htmlContent);
        }
      } catch (e) { /* tinymce API 없으면 무시 */ }

      console.log('[TistoryAuto] 본문 입력 완료');
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

      if (radio) {
        radio.click();
        await delay(100);
      }

      console.log('[TistoryAuto] 공개 설정 완료:', visibility);
      return { success: true };
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
   * 발행 실행 ("완료" 버튼)
   */
  async function publish() {
    try {
      // "완료" 버튼 클릭 → 발행 설정 레이어 열림
      const completeBtn = findElement(S.publish.completeButton, S.publish.fallback);
      if (!completeBtn) throw new Error('완료 버튼을 찾을 수 없음');

      completeBtn.click();
      await delay(1000);

      // 발행 레이어가 열렸을 경우 최종 확인 버튼 클릭
      const confirmBtn = findElement(S.publish.confirmButton, null);
      if (confirmBtn) {
        confirmBtn.click();
        console.log('[TistoryAuto] 발행 완료!');
        return { success: true };
      }

      // 발행 레이어 없이 바로 발행된 경우
      console.log('[TistoryAuto] 완료 버튼 클릭 완료 (바로 발행됨)');
      return { success: true };
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
    if (postData.visibility) {
      results.visibility = await setVisibility(postData.visibility);
      await delay(300);
    }

    // 7. 발행 (autoPublish가 true인 경우)
    if (postData.autoPublish) {
      await delay(500);
      results.publish = await publish();
    }

    const allSuccess = Object.values(results).every(r => r.success);
    console.log('[TistoryAuto] 글 작성 결과:', results);

    return {
      success: allSuccess,
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

  // ── 초기화 ──────────────────────────────────
  console.log('[TistoryAuto] Content Script 로드 완료 ✅');
  console.log('[TistoryAuto] 페이지:', window.location.href);

  // Background에 준비 완료 알림
  chrome.runtime.sendMessage({ action: 'CONTENT_READY', url: window.location.href });
})();
