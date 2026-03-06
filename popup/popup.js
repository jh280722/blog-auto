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

  // ── 발행 버튼 ───────────────────────────────
  $('#btn-publish').addEventListener('click', async () => {
    const data = getFormData();
    if (!data.title && !data.content) {
      showToast('제목 또는 본문을 입력하세요', 'error');
      return;
    }

    setStatus('발행 중...', 'processing');
    $('#btn-publish').disabled = true;

    try {
      const result = await sendMessage('WRITE_POST', { ...data, autoPublish: true });
      if (result.success) {
        showToast('발행이 완료되었습니다!');
        setStatus('발행 완료', 'ready');
        clearForm();
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
      item.innerHTML = `
        <img src="${img.src}" alt="${img.alt}">
        <button class="remove-btn" data-idx="${idx}">×</button>
      `;
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
          pending: '⏳',
          processing: '⚙️',
          completed: '✅',
          failed: '❌'
        }[item.status] || '⏳';

        return `
          <div class="queue-item" data-id="${item.id}">
            <span class="queue-item-status">${statusIcon}</span>
            <div class="queue-item-info">
              <div class="queue-item-title">${item.data.title || '(제목 없음)'}</div>
              <div class="queue-item-meta">${item.status}${item.error ? ` - ${item.error}` : ''}</div>
            </div>
            <button class="queue-item-remove" data-id="${item.id}" title="삭제">×</button>
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
