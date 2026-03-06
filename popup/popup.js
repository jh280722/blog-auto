/**
 * Popup UI 이벤트 핸들링
 * - 글쓰기 폼 처리
 * - 이미지 업로드 (드래그앤드롭 + 파일 선택 + URL)
 * - 큐 관리
 * - 설정
 */

(() => {
  'use strict';

  // ── 상태 ────────────────────────────────────
  let attachedImages = []; // { src, alt, file?, url? }

  // ── DOM 요소 ────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── HTML 이스케이프 ──────────────────────────
  function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── 탭 전환 ─────────────────────────────────
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');

      // 큐 탭일 때 큐 새로고침
      if (tab.dataset.tab === 'queue') refreshQueue();
    });
  });

  // ── 토스트 알림 ──────────────────────────────
  function showToast(message, type = 'success') {
    let toast = $('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }

    toast.textContent = type === 'success' ? `✅ ${message}` : `❌ ${message}`;
    toast.className = `toast ${type}`;

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  // ── Background 메시지 전송 ──────────────────
  function sendMessage(action, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, data }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  // ── 상태 표시 업데이트 ─────────────────────
  function setStatus(text, type = 'ready') {
    const dot = $('.status-dot');
    const label = $('.status-text');
    label.textContent = text;

    dot.style.background = type === 'processing' ? 'var(--warning)' :
                           type === 'error' ? 'var(--danger)' :
                           'var(--success)';
  }

  // ── 폼 데이터 수집 ──────────────────────────
  function getFormData() {
    const tagsRaw = $('#post-tags').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
    const visibility = document.querySelector('input[name="visibility"]:checked')?.value || 'public';

    return {
      title: $('#post-title').value.trim(),
      content: $('#post-content').value.trim(),
      category: $('#post-category').value.trim() || null,
      tags,
      visibility,
      images: attachedImages.map(img => ({
        url: img.url || img.src,
        base64: img.src?.startsWith('data:') ? img.src : undefined,
        alt: img.alt || ''
      })),
    };
  }

  // ── 폼 초기화 ───────────────────────────────
  function clearForm() {
    $('#post-title').value = '';
    $('#post-content').value = '';
    $('#post-category').value = '';
    $('#post-tags').value = '';
    document.querySelector('input[name="visibility"][value="public"]').checked = true;
    attachedImages = [];
    renderImagePreviews();
  }

  // ── CAPTCHA 배너 제어 ────────────────────────
  function showCaptchaAlert() {
    $('#captcha-alert').style.display = 'flex';
  }

  function hideCaptchaAlert() {
    $('#captcha-alert').style.display = 'none';
  }

  // ── 발행 버튼 ───────────────────────────────
  $('#btn-publish').addEventListener('click', async () => {
    const data = getFormData();
    if (!data.title && !data.content) {
      showToast('제목 또는 본문을 입력하세요', 'error');
      return;
    }

    hideCaptchaAlert();
    setStatus('발행 중...', 'processing');
    $('#btn-publish').disabled = true;

    try {
      const result = await sendMessage('WRITE_POST', { ...data, autoPublish: true });
      if (result.success) {
        showToast('발행이 완료되었습니다!');
        setStatus('발행 완료', 'ready');
        hideCaptchaAlert();
        clearForm();
      } else if (result.status === 'captcha_required') {
        showToast('CAPTCHA 감지 — 브라우저에서 해결 후 재개 클릭', 'error');
        setStatus('CAPTCHA 대기 중', 'error');
        showCaptchaAlert(); // 재개 버튼 배너 표시
      } else {
        showToast(result.error || '발행 실패', 'error');
        setStatus('오류 발생', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
      setStatus('오류 발생', 'error');
    }

    $('#btn-publish').disabled = false;
  });

  // ── CAPTCHA 재개 버튼 (직접 발행) ──────────
  $('#btn-resume-publish').addEventListener('click', async () => {
    $('#btn-resume-publish').disabled = true;
    setStatus('발행 재개 중...', 'processing');

    try {
      const result = await sendMessage('RESUME_DIRECT_PUBLISH');
      if (result.success) {
        showToast('발행이 완료되었습니다!');
        setStatus('발행 완료', 'ready');
        hideCaptchaAlert();
        clearForm();
      } else if (result.status === 'captcha_required') {
        showToast('CAPTCHA가 아직 표시되어 있습니다. 먼저 해결해주세요.', 'error');
        setStatus('CAPTCHA 대기 중', 'error');
      } else {
        showToast(result.error || '재개 실패', 'error');
        setStatus('오류 발생', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
      setStatus('오류 발생', 'error');
    }

    $('#btn-resume-publish').disabled = false;
  });

  // ── 큐에 추가 ───────────────────────────────
  $('#btn-add-queue').addEventListener('click', async () => {
    const data = getFormData();
    if (!data.title && !data.content) {
      showToast('제목 또는 본문을 입력하세요', 'error');
      return;
    }

    try {
      const result = await sendMessage('ADD_TO_QUEUE', data);
      if (result.success) {
        showToast(`큐에 추가됨 (총 ${result.queueLength}개)`);
        updateQueueBadge(result.queueLength);
        clearForm();
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── 이미지 처리 ──────────────────────────────

  // 파일 → Base64 변환
  function fileToBase64(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }

  // 이미지 파일 추가
  async function addImageFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const base64 = await fileToBase64(file);
      attachedImages.push({ src: base64, alt: file.name });
    }
    renderImagePreviews();
  }

  // 이미지 URL 추가
  function addImageUrl(url) {
    if (!url) return;
    attachedImages.push({ src: url, url, alt: '' });
    renderImagePreviews();
  }

  // 이미지 프리뷰 렌더링
  function renderImagePreviews() {
    const container = $('#image-preview-list');
    container.innerHTML = '';

    attachedImages.forEach((img, idx) => {
      const item = document.createElement('div');
      item.className = 'image-preview-item';

      const imgEl = document.createElement('img');
      imgEl.src = img.src;
      imgEl.alt = img.alt || '';

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.dataset.idx = idx;
      removeBtn.textContent = '\u00d7';

      item.appendChild(imgEl);
      item.appendChild(removeBtn);
      container.appendChild(item);
    });

    // 삭제 버튼 이벤트
    container.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.idx);
        attachedImages.splice(idx, 1);
        renderImagePreviews();
      });
    });
  }

  // 드래그앤드롭
  const dropZone = $('#image-drop-zone');

  dropZone.addEventListener('click', () => {
    $('#image-file-input').click();
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addImageFiles(e.dataTransfer.files);
  });

  // 파일 input
  $('#image-file-input').addEventListener('change', (e) => {
    addImageFiles(e.target.files);
    e.target.value = '';
  });

  // URL 입력 (Enter)
  $('#image-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addImageUrl(e.target.value.trim());
      e.target.value = '';
    }
  });

  // ── 큐 관리 ──────────────────────────────────

  async function refreshQueue() {
    try {
      const result = await sendMessage('GET_QUEUE');
      if (!result.success) return;

      const list = $('#queue-list');
      const queue = result.queue || [];

      updateQueueBadge(queue.filter(i => i.status === 'pending').length);
      $('#queue-count').textContent = `${queue.length}개 항목`;

      if (queue.length === 0) {
        list.innerHTML = `
          <div class="queue-empty">
            <span class="empty-icon">📭</span>
            <span>큐가 비어있습니다</span>
          </div>
        `;
        return;
      }

      list.innerHTML = queue.map(item => {
        const statusIcon = {
          pending: '&#9203;',
          processing: '&#9881;',
          completed: '&#9989;',
          failed: '&#10060;',
          captcha_paused: '&#9888;'
        }[item.status] || '&#9203;';

        const isCaptchaPaused = item.status === 'captcha_paused';
        const isFailed = item.status === 'failed';
        const extraClass = isCaptchaPaused ? ' captcha-paused' : (isFailed ? ' item-failed' : '');

        const safeId = esc(item.id);
        const resumeBtn = isCaptchaPaused
          ? `<button class="btn btn-warning btn-sm queue-item-resume" data-id="${safeId}">재개</button>`
          : '';
        const retryBtn = (isFailed || isCaptchaPaused)
          ? `<button class="btn btn-sm btn-secondary queue-item-retry" data-id="${safeId}">재시도</button>`
          : '';

        return `
          <div class="queue-item${extraClass}" data-id="${safeId}">
            <span class="queue-item-status">${statusIcon}</span>
            <div class="queue-item-info">
              <div class="queue-item-title">${esc(item.data.title) || '(제목 없음)'}</div>
              <div class="queue-item-meta">${esc(item.status)}${item.error ? ` &mdash; ${esc(item.error)}` : ''}</div>
            </div>
            <div class="queue-item-actions">
              ${resumeBtn}${retryBtn}
              <button class="queue-item-remove" data-id="${safeId}" title="삭제">&#215;</button>
            </div>
          </div>
        `;
      }).join('');

      // 삭제 버튼
      list.querySelectorAll('.queue-item-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          await sendMessage('REMOVE_FROM_QUEUE', { id: btn.dataset.id });
          refreshQueue();
        });
      });

      // CAPTCHA 재개 버튼 (에디터 내용 유지 상태에서 발행만 재시도)
      list.querySelectorAll('.queue-item-resume').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          showToast('발행 재개 중...');
          const result = await sendMessage('RESUME_AFTER_CAPTCHA', { id: btn.dataset.id });
          if (result.success) {
            showToast('발행이 완료되었습니다!');
          } else if (result.status === 'captcha_required') {
            showToast('CAPTCHA가 아직 표시되어 있습니다. 먼저 해결해주세요.', 'error');
          } else {
            showToast(result.error || '재개 실패', 'error');
          }
          refreshQueue();
        });
      });

      // 재시도 버튼 (처음부터 — 새 탭 열어 전체 재작성)
      list.querySelectorAll('.queue-item-retry').forEach(btn => {
        btn.addEventListener('click', async () => {
          await sendMessage('RETRY_ITEM', { id: btn.dataset.id });
          showToast('대기 상태로 복원됐습니다. 시작 버튼을 눌러 재시도하세요.');
          refreshQueue();
        });
      });
    } catch (err) {
      console.error('큐 로드 실패:', err);
    }
  }

  function updateQueueBadge(count) {
    const badge = $('#queue-badge');
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // 큐 시작
  $('#btn-start-queue').addEventListener('click', async () => {
    try {
      const result = await sendMessage('START_QUEUE');
      if (result.success) {
        showToast('큐 처리를 시작합니다!');
        setStatus('큐 처리 중...', 'processing');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // 큐 초기화
  $('#btn-clear-queue').addEventListener('click', async () => {
    if (confirm('큐를 전부 초기화하시겠습니까?')) {
      await sendMessage('CLEAR_QUEUE');
      refreshQueue();
      showToast('큐가 초기화되었습니다');
    }
  });

  // JSON 대량 입력
  $('#btn-batch-add').addEventListener('click', async () => {
    const jsonText = $('#batch-json').value.trim();
    if (!jsonText) {
      showToast('JSON을 입력하세요', 'error');
      return;
    }

    try {
      const items = JSON.parse(jsonText);
      const arr = Array.isArray(items) ? items : [items];

      const result = await sendMessage('ADD_TO_QUEUE', arr);
      if (result.success) {
        showToast(`${arr.length}개 항목이 큐에 추가됨`);
        $('#batch-json').value = '';
        updateQueueBadge(result.queueLength);
        refreshQueue();
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        showToast('유효하지 않은 JSON 형식입니다', 'error');
      } else {
        showToast(err.message, 'error');
      }
    }
  });

  // ── 설정 ──────────────────────────────────────

  // 설정 로드
  async function loadSettings() {
    try {
      const result = await sendMessage('LOAD_SETTINGS');
      if (result.success && result.settings) {
        $('#setting-blog-name').value = result.settings.blogName || '';
        $('#setting-interval').value = result.settings.publishInterval || 5;
      }
    } catch (err) {
      console.error('설정 로드 실패:', err);
    }

    // 확장 프로그램 ID 표시
    $('#extension-id').textContent = chrome.runtime.id;
  }

  // 설정 저장
  $('#btn-save-settings').addEventListener('click', async () => {
    const settings = {
      blogName: $('#setting-blog-name').value.trim(),
      publishInterval: parseInt($('#setting-interval').value) || 5
    };

    try {
      await sendMessage('SAVE_SETTINGS', settings);
      showToast('설정이 저장되었습니다');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── 초기화 ────────────────────────────────────
  loadSettings();
  refreshQueue();

  // 주기적 큐 새로고침 (3초)
  setInterval(() => {
    const activeTab = document.querySelector('.tab.active');
    if (activeTab?.dataset.tab === 'queue') {
      refreshQueue();
    }
  }, 3000);

})();
