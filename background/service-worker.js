/**
 * Background Service Worker
 * - Popup ↔ Content Script 메시지 라우팅
 * - 외부 API 수신 (externally_connectable)
 * - 발행 큐 관리
 */

// ── 발행 큐 ──────────────────────────────────
let publishQueue = [];
let isProcessing = false;
let currentTabId = null;

/**
 * 큐 상태를 스토리지에 저장
 */
async function saveQueueState() {
  await chrome.storage.local.set({
    publishQueue: publishQueue.map(item => ({
      ...item,
      status: item.status,
      error: item.error || null
    }))
  });
}

/**
 * 큐 상태 로드
 */
async function loadQueueState() {
  const result = await chrome.storage.local.get('publishQueue');
  if (result.publishQueue) {
    publishQueue = result.publishQueue;
  }
}

/**
 * 티스토리 글쓰기 탭 찾기 또는 생성
 */
async function getTistoryTab(blogName) {
  const url = `https://${blogName}.tistory.com/manage/newpost`;
  
  // 이미 열린 탭 찾기
  const tabs = await chrome.tabs.query({ url: '*://*.tistory.com/manage/newpost*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    return tabs[0].id;
  }

  // 새 탭 열기
  const tab = await chrome.tabs.create({ url, active: true });
  
  // 페이지 로딩 완료 대기
  return new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === tab.id && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // Content script 로딩 추가 대기
        setTimeout(() => resolve(tab.id), 2000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * 큐에서 글 하나를 발행
 */
async function processNextInQueue() {
  if (isProcessing || publishQueue.length === 0) return;

  const pendingIndex = publishQueue.findIndex(item => item.status === 'pending');
  if (pendingIndex === -1) {
    isProcessing = false;
    return;
  }

  isProcessing = true;
  const item = publishQueue[pendingIndex];
  item.status = 'processing';
  await saveQueueState();

  try {
    // 블로그명 추출
    const blogName = item.data.blogName || await getBlogName();
    if (!blogName) throw new Error('블로그 이름을 설정해주세요.');

    // 티스토리 글쓰기 탭 열기/찾기
    const tabId = await getTistoryTab(blogName);
    currentTabId = tabId;

    // Content Script에 글 작성 요청
    await new Promise(resolve => setTimeout(resolve, 2000));
    await ensurePageWorldVisibilityInterceptor(tabId);

    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'WRITE_POST',
      data: { ...item.data, autoPublish: true }
    });

    if (response.success) {
      item.status = 'completed';
      item.completedAt = new Date().toISOString();
      item.publishStatus = response.status || 'published';
    } else if (response.status === 'captcha_required') {
      // CAPTCHA 감지 — 실패가 아닌 일시정지 상태로 보존 (에디터 내용 유지됨)
      item.status = 'captcha_paused';
      item.error = 'CAPTCHA 감지 — 브라우저에서 해결 후 Resume 클릭';
      item.publishStatus = 'captcha_required';
      item.captchaTabId = currentTabId; // 에디터가 살아있는 탭 ID 보존
      console.warn('[TistoryAuto BG] CAPTCHA 감지 — 큐 일시정지 (captcha_paused). tabId:', currentTabId);
      await saveQueueState();
      isProcessing = false;
      return; // 다음 항목 처리하지 않음 (사용자가 Resume 해야 함)
    } else {
      item.status = 'failed';
      item.error = response.error || response.message || '발행 실패';
      item.publishStatus = response.status || 'unknown_error';
    }
  } catch (error) {
    item.status = 'failed';
    item.error = error.message;
  }

  await saveQueueState();
  isProcessing = false;

  // 다음 항목 처리 (사용자 설정 간격 사용)
  const nextPending = publishQueue.find(i => i.status === 'pending');
  if (nextPending) {
    const settings = await chrome.storage.local.get('publishInterval');
    const intervalMs = ((settings.publishInterval || 5) * 1000);
    setTimeout(() => processNextInQueue(), intervalMs);
  }
}

/**
 * 저장된 블로그명 가져오기
 */
async function getBlogName() {
  const result = await chrome.storage.local.get('blogName');
  return result.blogName || null;
}

/**
 * 최적의 티스토리 글쓰기 탭 후보 찾기
 * 우선순위: 현재 추적 중이며 살아있는 탭 > newpost 탭 > edit 탭 > 기타 manage 탭
 */
async function getTistoryTabCandidates() {
  const allTabs = await chrome.tabs.query({ url: '*://*.tistory.com/manage/*' });
  if (allTabs.length === 0) return [];

  const tracked = currentTabId ? allTabs.filter(t => t.id === currentTabId) : [];
  const newPosts = allTabs.filter(t => t.url?.includes('/manage/newpost'));
  const edits = allTabs.filter(t => t.url?.includes('/manage/post/'));
  const others = allTabs.filter(t => !tracked.some(x => x.id === t.id) && !newPosts.some(x => x.id === t.id) && !edits.some(x => x.id === t.id));

  return [...tracked, ...newPosts, ...edits, ...others];
}

async function pingTab(tabId) {
  try {
    const pingResult = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
    return !!pingResult?.success;
  } catch (_) {
    return false;
  }
}

async function ensurePageWorldVisibilityInterceptor(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
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
          } catch (_) {}
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
      }
    });
    return true;
  } catch (error) {
    console.warn('[TistoryAuto BG] MAIN world interceptor 주입 실패:', error);
    return false;
  }
}

/**
 * 실제로 content script와 통신 가능한 티스토리 탭 찾기
 * - stale 탭/닫힌 탭/주입 안 된 탭은 제외
 * - 필요하면 새 newpost 탭을 열고 재시도
 */
async function findReadyTistoryTab() {
  const candidates = await getTistoryTabCandidates();

  for (const tab of candidates) {
    if (await pingTab(tab.id)) {
      currentTabId = tab.id;
      return tab;
    }
  }

  const blogName = await getBlogName();
  if (blogName) {
    const newTabId = await getTistoryTab(blogName);
    await new Promise(resolve => setTimeout(resolve, 1500));

    if (await pingTab(newTabId)) {
      currentTabId = newTabId;
      const tab = await chrome.tabs.get(newTabId);
      return tab;
    }
  }

  return null;
}

// ── 공통 메시지 처리 함수 ──────────────────────────
async function handleMessage(message, sender) {
  switch (message.action) {
    // Content Script가 준비되었음을 알림
    case 'CONTENT_READY':
      currentTabId = sender.tab?.id;
      return { success: true };

    case 'INJECT_MAIN_WORLD_VISIBILITY_HELPER': {
      const tabId = sender.tab?.id;
      if (!tabId) return { success: false, error: 'sender tab 없음' };
      const injected = await ensurePageWorldVisibilityInterceptor(tabId);
      return { success: injected };
    }

    // Popup → Content Script로 전달
    case 'WRITE_POST':
    case 'SET_TITLE':
    case 'SET_CONTENT':
    case 'SET_CATEGORY':
    case 'SET_TAGS':
    case 'SET_VISIBILITY':
    case 'INSERT_IMAGES':
    case 'PUBLISH':
    case 'GET_PAGE_INFO': {
      const tistoryTab = await findReadyTistoryTab();

      if (!tistoryTab) {
        return { success: false, error: '콘텐츠 스크립트가 준비된 티스토리 글쓰기 탭을 찾지 못했습니다. 새 글쓰기 탭을 새로 열어주세요.', status: 'editor_not_ready' };
      }

      try {
        await ensurePageWorldVisibilityInterceptor(tistoryTab.id);
        const response = await chrome.tabs.sendMessage(tistoryTab.id, message);
        return response;
      } catch (err) {
        return { success: false, error: '콘텐츠 스크립트와 통신 실패. 페이지를 새로고침해주세요.', status: 'editor_not_ready' };
      }
    }

    // 큐에 글 추가
    case 'ADD_TO_QUEUE': {
      const items = Array.isArray(message.data) ? message.data : [message.data];
      for (const item of items) {
        publishQueue.push({
          id: Date.now() + Math.random().toString(36).substr(2, 9),
          data: item,
          status: 'pending',
          addedAt: new Date().toISOString(),
          error: null,
          completedAt: null
        });
      }
      await saveQueueState();
      return { success: true, queueLength: publishQueue.length };
    }

    // 큐 처리 시작
    case 'START_QUEUE':
      processNextInQueue();
      return { success: true, message: '큐 처리를 시작합니다.' };

    // 큐 상태 조회
    case 'GET_QUEUE':
      return { success: true, queue: publishQueue, isProcessing };

    // 큐 항목 삭제
    case 'REMOVE_FROM_QUEUE': {
      publishQueue = publishQueue.filter(item => item.id !== message.data.id);
      await saveQueueState();
      return { success: true };
    }

    // 큐 전체 초기화
    case 'CLEAR_QUEUE':
      publishQueue = [];
      await saveQueueState();
      return { success: true };

    // 설정 저장
    case 'SAVE_SETTINGS': {
      await chrome.storage.local.set(message.data);
      return { success: true };
    }

    // 설정 로드
    case 'LOAD_SETTINGS': {
      const settings = await chrome.storage.local.get(null);
      return { success: true, settings };
    }

    // CAPTCHA 해결 후 발행 재개 (큐 항목)
    case 'RESUME_AFTER_CAPTCHA': {
      const itemId = message.data?.id;
      const item = publishQueue.find(i => i.id === itemId && i.status === 'captcha_paused');
      if (!item) {
        return { success: false, error: '재개할 captcha_paused 항목을 찾을 수 없음', status: 'item_not_found' };
      }

      const tabId = item.captchaTabId || currentTabId;
      if (!tabId) {
        return { success: false, error: '에디터 탭을 찾을 수 없음. 페이지를 새로 열어주세요.', status: 'editor_not_ready' };
      }

      // 탭 생존 확인
      if (!(await pingTab(tabId))) {
        return { success: false, error: '에디터 탭이 닫혔거나 새로고침됨. RETRY로 처음부터 다시 시도하세요.', status: 'editor_not_ready' };
      }

      // CAPTCHA가 아직 표시되어 있는지 확인
      try {
        const captchaCheck = await chrome.tabs.sendMessage(tabId, { action: 'CHECK_CAPTCHA' });
        if (captchaCheck?.captchaPresent) {
          return { success: false, error: 'CAPTCHA가 아직 표시되어 있습니다. 먼저 해결해주세요.', status: 'captcha_required' };
        }
      } catch (e) { /* 확인 실패 시 발행 시도 진행 */ }

      // 발행 재시도 (에디터 내용은 이미 입력되어 있음 — RESUME_PUBLISH만 호출)
      item.status = 'processing';
      await saveQueueState();

      try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'RESUME_PUBLISH' });
        if (response.success) {
          item.status = 'completed';
          item.completedAt = new Date().toISOString();
          item.publishStatus = response.status || 'published';
          item.captchaTabId = null;
          await saveQueueState();
          isProcessing = false;
          // 다음 대기 항목 처리
          processNextInQueue();
          return { success: true, status: 'published', url: response.url };
        } else if (response.status === 'captcha_required') {
          item.status = 'captcha_paused';
          item.error = 'CAPTCHA 재발생 — 다시 해결 후 Resume 클릭';
          item.captchaTabId = tabId;
          await saveQueueState();
          isProcessing = false;
          return response;
        } else {
          item.status = 'failed';
          item.error = response.error || '재개 후 발행 실패';
          item.publishStatus = response.status;
          await saveQueueState();
          isProcessing = false;
          return response;
        }
      } catch (e) {
        item.status = 'failed';
        item.error = e.message;
        await saveQueueState();
        isProcessing = false;
        return { success: false, error: e.message };
      }
    }

    // 실패/일시정지 항목 처음부터 재시도
    case 'RETRY_ITEM': {
      const itemId = message.data?.id;
      const item = publishQueue.find(i => i.id === itemId);
      if (!item) return { success: false, error: '항목을 찾을 수 없음' };
      item.status = 'pending';
      item.error = null;
      item.captchaTabId = null;
      item.completedAt = null;
      item.publishStatus = null;
      await saveQueueState();
      return { success: true };
    }

    // CAPTCHA 해결 후 직접 발행 재개 (큐 외부, 팝업 직접 발행)
    case 'RESUME_DIRECT_PUBLISH': {
      const tistoryTab = await findReadyTistoryTab();
      if (!tistoryTab) {
        return { success: false, error: '티스토리 글쓰기 페이지를 찾을 수 없습니다.', status: 'editor_not_ready' };
      }

      // CAPTCHA 상태 확인
      try {
        const captchaCheck = await chrome.tabs.sendMessage(tistoryTab.id, { action: 'CHECK_CAPTCHA' });
        if (captchaCheck?.captchaPresent) {
          return { success: false, error: 'CAPTCHA가 아직 표시되어 있습니다.', status: 'captcha_required' };
        }
      } catch (e) { /* 진행 */ }

      // 발행 재시도
      try {
        const response = await chrome.tabs.sendMessage(tistoryTab.id, { action: 'RESUME_PUBLISH' });
        return response;
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    default:
      return { success: false, error: `알 수 없는 액션: ${message.action}` };
  }
}

// ── 내부 메시지 핸들러 ──────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[TistoryAuto BG] 메시지:', message.action, 'from:', sender.tab?.url || 'popup/external');

  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));

  return true; // 비동기 응답
});

// ── 외부 연결 핸들러 (externally_connectable) ──────────────
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log('[TistoryAuto BG] 외부 메시지:', message.action, 'from:', sender.url);

  // 보안: localhost만 허용
  if (!sender.url?.startsWith('http://localhost') && !sender.url?.startsWith('http://127.0.0.1')) {
    sendResponse({ success: false, error: '허용되지 않은 출처입니다.' });
    return;
  }

  // 공통 핸들러로 처리
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));

  return true; // 비동기 응답
});

// ── 초기화 ──────────────────────────────────
loadQueueState().then(() => {
  console.log('[TistoryAuto BG] Service Worker 시작 ✅, 큐 항목:', publishQueue.length);
});
