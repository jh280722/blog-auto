/**
 * 티스토리 에디터 DOM 셀렉터 관리
 * 실제 티스토리 에디터(2025년 기준)의 DOM 구조를 반영합니다.
 * 티스토리 UI가 변경되면 이 파일의 셀렉터만 수정하면 됩니다.
 */
const SELECTORS = {
  // 제목 (textarea 요소)
  title: {
    input: '#post-title-inp',
    fallback: '.title-area textarea, [class*="title"] textarea'
  },

  // 본문 에디터 (TinyMCE iframe 기반)
  editor: {
    iframe: '#editor-tistory_ifr',
    contentArea: 'body#tinymce',
    // iframe 없는 경우 fallback
    fallback: '[contenteditable="true"], .mce-content-body'
  },

  // 카테고리 (드롭다운 버튼)
  category: {
    button: '#category-btn',
    dropdown: '.mce-menu, .category-list',
    items: '.mce-menu-item, .category-item',
    selectedLabel: '#category-btn .txt, #category-btn',
    fallback: '[class*="category"] select, [class*="category"] button'
  },

  // 태그
  tag: {
    input: '#tagText',
    container: '.tag-list, .post-tag-area',
    fallback: '[placeholder*="태그"], [class*="tag"] input'
  },

  // 공개 설정 (완료 버튼 클릭 시 나타나는 발행 레이어)
  visibility: {
    openRadio: '#open20',
    protectedRadio: '#open15',
    privateRadio: '#open0',
    container: '.publish-layer',
    fallback: '[name="visibility"]'
  },

  // 첨부/이미지 업로드
  image: {
    // 상단 툴바의 첨부(사진) 아이콘
    attachButton: '#mceu_0',
    // 첨부 메뉴 내 "사진" 항목
    photoMenuItem: '#attach-image',
    // 숨겨진 파일 input (사진 클릭 시 생성됨)
    fileInput: 'input[type="file"][accept*="image"], #image-file-input',
    fallback: 'input[type="file"]'
  },

  // 발행 버튼
  publish: {
    // 우측 하단 "완료" 버튼
    completeButton: '#publish-layer-btn, .btn-publish',
    // 발행 확인 레이어의 최종 발행 버튼
    confirmButton: '#publish-btn',
    // 임시저장
    saveButton: '.btn-save, #save-btn',
    fallback: 'button:has-text("완료"), button[class*="publish"]'
  },

  // 기타 UI
  ui: {
    // 임시저장 버튼
    tempSaveButton: '.btn-temp-save',
    // 기본모드/마크다운/HTML 전환
    modeSelector: '.editor-mode-selector',
    // 하단 바
    bottomBar: '.editor-bottom-bar'
  },

  // CAPTCHA / 보안 레이어
  captcha: {
    dkaptcha: '#dkaptcha, .dkaptcha',
    recaptcha: '.g-recaptcha, #recaptcha',
    generic: '[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]'
  },

  // 저장/발행 상태 인디케이터
  status: {
    saving: '.saving, .btn-publish.disabled, .loading, [class*="saving"]',
    error: '.error-message, .alert-error',
    success: '.success, .alert-success, [class*="complete"]'
  },

  // 글쓰기 페이지 URL 패턴
  page: {
    newPost: '/manage/newpost',
    editPost: '/manage/post/'
  }
};

// Content script에서 사용하기 위해 window에 노출
if (typeof window !== 'undefined') {
  window.__TISTORY_SELECTORS = SELECTORS;
}
