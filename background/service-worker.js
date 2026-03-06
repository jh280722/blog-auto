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

    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'WRITE_POST',
      data: { ...item.data, autoPublish: true }
    });

    if (response.success) {
      item.status = 'completed';
      item.completedAt = new Date().toISOString();
    } else {
      item.status = 'failed';
      item.error = response.message || '발행 실패';
    }
  } catch (error) {
    item.status = 'failed';
    item.error = error.message;
  }

  await saveQueueState();
  isProcessing = false;

  // 다음 항목 처리 (딜레이 포함)
  const nextPending = publishQueue.find(i => i.status === 'pending');
  if (nextPending) {
    setTimeout(() => processNextInQueue(), 5000); // 5초 간격
  }
}

/**
 * 저장된 블로그명 가져오기
 */
async function getBlogName() {
  const result = await chrome.storage.local.get('blogName');
  return result.blogName || null;
}

// ── 공통 메시지 처리 함수 ──────────────────────────
async function handleMessage(message, sender) {
  switch (message.action) {
    // Content Script가 준비되었음을 알림
    case 'CONTENT_READY':
      currentTabId = sender.tab?.id;
      return { success: true };

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
      // 모든 tistory 글쓰기 탭에서 찾기 (active가 아닐 수도 있음)
      const allTabs = await chrome.tabs.query({ url: '*://*.tistory.com/manage/*' });
      const tistoryTab = allTabs[0];

      if (!tistoryTab) {
        return { success: false, error: '티스토리 글쓰기 페이지를 열어주세요.' };
      }

      try {
        const response = await chrome.tabs.sendMessage(tistoryTab.id, message);
        return response;
      } catch (err) {
        return { success: false, error: '콘텐츠 스크립트와 통신 실패. 페이지를 새로고침해주세요.' };
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
