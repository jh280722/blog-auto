# Tistory Auto Publisher

티스토리 블로그 글쓰기를 자동화하는 Chrome 확장 프로그램입니다.

> 현재 운영 기준: **v1.3.0**
> - DKAPTCHA 핸드오프/재개 지원
> - stale tab 회피 + live content script 확인
> - 자동저장 복구 팝업 자동 dismiss
> - **비공개 발행 visibility 강제 보정(MAIN world XHR/fetch interceptor)**

## 주요 기능

- **팝업 UI**: 확장 프로그램 아이콘 클릭 → 직접 글 작성/발행
- **이미지 삽입**: 로컬 파일, 드래그앤드롭, URL 모두 지원
- **대량 발행 큐**: JSON으로 여러 글을 한번에 등록, 순차 발행
- **외부 API**: `externally_connectable`로 외부 도구에서 데이터 전송 가능
- **CAPTCHA 핸드오프**: DKAPTCHA 감지 시 자동 일시정지 → 수동 해결 → 원클릭 재개

## 설치

1. 이 폴더를 로컬에 다운로드
2. Chrome 브라우저에서 `chrome://extensions` 접속
3. 우측 상단 **개발자 모드** 활성화
4. **압축해제된 확장 프로그램을 로드합니다** 클릭
5. 이 폴더 선택

## 설정

1. 확장 프로그램 아이콘 클릭 → **설정** 탭
2. **블로그 이름** 입력 (예: `your-blog-name` → `https://your-blog-name.tistory.com`)
3. **발행 간격** 설정 (대량 발행 시 글 사이 대기 시간, 초)
4. **확장 프로그램 ID** 확인 (외부 API 연동 시 필요)

---

## 운영 모드

### 모드 1: Full-Auto (완전 자동)

CAPTCHA가 없을 때의 기본 모드. 제목/본문/태그 입력 후 단일 클릭으로 발행.

```
팝업 열기 → 글쓰기 탭에서 폼 작성 → [발행] 클릭 → 완료
```

- CAPTCHA 발생 시 자동으로 **모드 2**로 전환됩니다.
- 큐를 사용하면 여러 글을 순차 자동 발행할 수 있습니다.

### 모드 2: CAPTCHA 핸드오프 (Captcha Handoff)

DKAPTCHA 등이 감지된 경우. 에디터 내용(제목/본문/태그 등)은 이미 입력된 상태로 보존됩니다.

**직접 발행 시 흐름:**

```
[발행] 클릭 → CAPTCHA 감지 → 팝업에 경고 배너 표시
→ 브라우저에서 CAPTCHA 수동 해결 → [재개] 버튼 클릭 → 발행 완료
```

**큐 발행 시 흐름:**

```
큐 처리 중 CAPTCHA 감지 → 해당 항목이 captcha_paused 상태로 일시정지
→ 큐 탭에서 ⚠️ 항목 확인 → 브라우저에서 CAPTCHA 수동 해결
→ 큐 탭의 [재개] 버튼 클릭 → 발행 완료 → 큐 자동 계속
```

> **핵심**: CAPTCHA 감지 시 에디터를 닫거나 새로고침하면 안 됩니다.
> 에디터 탭을 그대로 두고 CAPTCHA만 해결한 뒤 재개 버튼을 누르세요.

### 모드 3: 재시도 (Retry from Scratch)

에디터 탭이 닫혔거나 새로고침된 경우. 처음부터 다시 시도합니다.

**큐 재시도:**

```
큐 탭에서 실패/일시정지 항목의 [재시도] 버튼 클릭
→ 항목이 pending 상태로 복원 → [시작] 버튼으로 재처리
```

---

## 사용법

### 1. 팝업에서 직접 발행

1. 티스토리 글쓰기 페이지 열기 (`https://your-blog.tistory.com/manage/newpost`)
2. 확장 프로그램 아이콘 클릭
3. 제목, 본문(HTML), 카테고리, 태그, 이미지 입력
4. **[발행]** 클릭
5. CAPTCHA가 감지되면 경고 배너가 나타납니다 → 브라우저에서 CAPTCHA 해결 → **[재개]** 클릭

### 2. 대량 발행

1. **큐** 탭에서 JSON 대량 입력 영역에 데이터 입력
2. 또는 **글쓰기** 탭에서 하나씩 **[큐에 추가]**
3. **[시작]** 클릭 → 순차 발행
4. CAPTCHA 발생 시 해당 항목이 ⚠️ 상태로 표시 → 해결 후 **[재개]** 클릭

### 3. 외부 API 연동

`api/api-page.html`을 로컬 서버에서 열어 사용하거나, 코드로 직접 호출:

**운영 권장값**
- 실제 발행: `visibility: "public"`
- 테스트 발행: `visibility: "private"`
- DKAPTCHA 발생 시: 브라우저에서 해결 후 `RESUME_DIRECT_PUBLISH`
- 브라우저 시작 직후/오래된 티스토리 탭 사용 시: 먼저 `PREPARE_EDITOR`
- `editor_not_ready` 발생 시: `diagnostics` 확인 후 `PREPARE_EDITOR` 재호출

```javascript
const EXTENSION_ID = "your-extension-id";

chrome.runtime.sendMessage(EXTENSION_ID, {
  action: "PREPARE_EDITOR",
  data: {
    blogName: "your-blog-name" // 선택: 저장된 설정이 있으면 생략 가능
  }
}, (response) => {
  console.log(response);
  // { success: true, status: "editor_ready", tabId, url, blogName, diagnostics }
});

chrome.runtime.sendMessage(EXTENSION_ID, {
  action: "WRITE_POST",
  data: {
    blogName: "your-blog-name", // 선택: 저장된 설정이 있으면 생략 가능
    title: "글 제목",
    content: "<p>본문 HTML</p>",
    category: "카테고리명",
    tags: ["태그1", "태그2"],
    images: [{ url: "https://example.com/img.jpg" }],
    visibility: "public",
    autoPublish: true
  }
}, (response) => {
  if (response.status === 'captcha_required') {
    // CAPTCHA 감지 — 사용자가 해결 후 RESUME_DIRECT_PUBLISH 호출
    console.log('CAPTCHA 필요: 브라우저에서 해결 후 재개하세요');
  }
  if (response.status === 'editor_not_ready') {
    console.log(response.diagnostics);
  }
  console.log(response);
});
```

**운영 권장 순서**
1. `PREPARE_EDITOR` 호출
2. `success: true`, `status: "editor_ready"` 확인
3. `WRITE_POST` 호출
4. `editor_not_ready`면 `diagnostics.attempts`를 보고 `PREPARE_EDITOR` 재호출

---

## 구조

```
├── manifest.json              # 확장 프로그램 설정
├── background/
│   └── service-worker.js      # 메시지 라우팅, 큐 관리, CAPTCHA 재개 로직
├── content/
│   ├── selectors.js           # DOM 셀렉터 (수정 용이)
│   └── tistory.js             # 에디터 DOM 조작, CAPTCHA 감지
├── popup/
│   ├── popup.html             # 팝업 UI (CAPTCHA 경고 배너 포함)
│   ├── popup.css              # 스타일
│   └── popup.js               # 이벤트 핸들링, 재개 버튼
├── api/
│   └── api-page.html          # 외부 API 테스트 페이지
├── utils/
│   └── image-handler.js       # 이미지 유틸리티
├── icons/                     # 확장 프로그램 아이콘
└── docs/
    └── README.md              # 이 문서
```

## 셀렉터 수정

티스토리가 에디터 UI를 변경하면 `content/selectors.js`만 수정하면 됩니다.

## 주의사항

- 티스토리에 **로그인된 상태**에서 사용해야 합니다
- 저장된 `blogName` 또는 요청의 `data.blogName`이 있으면 `PREPARE_EDITOR`/`WRITE_POST`가 `/manage/newpost` 탭을 자동으로 복구하거나 새로 엽니다
- CAPTCHA 해결 중 에디터 탭을 **닫거나 새로고침하지 마세요** — 내용이 초기화됩니다
- 티스토리 에디터 업데이트 시 `content/selectors.js`의 셀렉터를 조정해야 할 수 있습니다

---

## 발행 상태 코드 (v1.3.0)

응답의 `status` 필드로 발행 결과를 세밀하게 구분할 수 있습니다:

| 상태 | 설명 | 다음 액션 |
|------|------|-----------|
| `editor_ready` | `PREPARE_EDITOR`가 사용 가능한 에디터 탭 확보 완료 | `WRITE_POST` 호출 |
| `blog_not_configured` | 자동으로 열 블로그명을 알 수 없음 | 설정 저장 또는 `data.blogName` 전달 |
| `published` | 발행 성공 | — |
| `captcha_required` | CAPTCHA 감지됨 (직접 발행) | 해결 후 `RESUME_DIRECT_PUBLISH` |
| `captcha_paused` | 큐 항목 CAPTCHA 일시정지 | 해결 후 `RESUME_AFTER_CAPTCHA` |
| `editor_not_ready` | 에디터 탭 확보/복구 실패 | `diagnostics` 확인 후 `PREPARE_EDITOR` 재호출 |
| `item_not_found` | 재개할 큐 항목 없음 | 큐 확인 |
| `content_empty` | 본문 비어있거나 에디터 미반영 | 본문 확인 후 재시도 |
| `verification_failed` | 발행 후 URL 미변경 — 실제 저장 여부 불확실 | 관리자 페이지 직접 확인 |
| `save_timeout` | 저장중 상태 15초 이상 지속 | 네트워크 확인 후 재시도 |
| `publish_error` | 티스토리 에러 메시지 표시 | 에러 내용 확인 |
| `partial_failure` | 일부 단계 실패 (제목/태그 등) | `results` 객체에서 실패 단계 확인 |
| `unknown_error` | 분류되지 않은 오류 | 콘솔 로그 확인 |

### 응답 예시

```javascript
// PREPARE_EDITOR 성공
{
  success: true,
  status: "editor_ready",
  tabId: 321,
  url: "https://your-blog.tistory.com/manage/newpost",
  blogName: "your-blog",
  diagnostics: {
    requestedBlogName: "your-blog",
    blogName: "your-blog",
    candidateCount: 1,
    attempts: [...]
  }
}

// 성공
{ success: true, status: "published", url: "https://blog.tistory.com/123" }

// CAPTCHA 차단 (직접 발행)
{ success: false, status: "captcha_required", error: "CAPTCHA가 감지되었습니다." }

// 큐 CAPTCHA 일시정지
// → 큐 항목 status가 "captcha_paused"로 변경됨
// → 팝업 큐 탭에서 재개 버튼 표시

// 준비 실패
{
  success: false,
  status: "editor_not_ready",
  error: "콘텐츠 스크립트가 준비된 티스토리 글쓰기 탭을 확보하지 못했습니다. diagnostics를 확인하세요.",
  diagnostics: {
    attempts: [
      { step: "probe_existing", outcome: "not_ready", error: "ping_timeout" },
      { step: "navigate_candidate", toUrl: "https://your-blog.tistory.com/manage/newpost" },
      { step: "open_fresh_tab", toUrl: "https://your-blog.tistory.com/manage/newpost" }
    ]
  }
}

// CAPTCHA 해결 후 재개 성공
{ success: true, status: "published" }
```

### 에디터 준비 diagnostics

`PREPARE_EDITOR`와 `editor_not_ready` 응답에는 `diagnostics`가 포함됩니다.

- `requestedBlogName`: 요청에서 넘긴 블로그명
- `blogName`: 실제로 사용한 블로그명
- `currentTabId`: 준비 시작 시점의 추적 탭
- `candidateCount`: 검사한 `/manage/*` 탭 수
- `attempts[]`: 준비 단계 로그

자주 보게 될 `attempts[].step` 값:

- `inspect_candidate`: 후보 탭 점검 시작
- `probe_existing`: 현재 탭에 `PING` 재시도
- `reload_candidate` / `navigate_candidate`: stale 탭을 `/manage/newpost`로 복구
- `probe_after_navigation`: 복구 후 재프로브
- `open_fresh_tab`: 새 글쓰기 탭 오픈
- `probe_fresh_tab`: 새 탭 준비 확인
- `skip_candidate`: 다른 블로그 탭이라 건너뜀

---

## API 액션 목록

| 액션 | 설명 |
|------|------|
| `PREPARE_EDITOR` | 사용 가능한 티스토리 에디터 탭 확보 + diagnostics 반환 |
| `WRITE_POST` | 글 작성 + 발행 |
| `SET_TITLE` | 제목만 입력 |
| `SET_CONTENT` | 본문만 입력 |
| `SET_CATEGORY` | 카테고리 선택 |
| `SET_TAGS` | 태그 입력 |
| `SET_VISIBILITY` | 공개 설정 |
| `INSERT_IMAGES` | 이미지 삽입 |
| `PUBLISH` | 발행 실행 (처음부터) |
| `RESUME_DIRECT_PUBLISH` | CAPTCHA 해결 후 직접 발행 재개 |
| `RESUME_AFTER_CAPTCHA` | CAPTCHA 해결 후 큐 항목 재개 (`data.id` 필요) |
| `RETRY_ITEM` | 큐 항목 처음부터 재시도 (`data.id` 필요) |
| `ADD_TO_QUEUE` | 큐에 추가 |
| `START_QUEUE` | 큐 처리 시작 |
| `GET_QUEUE` | 큐 상태 조회 |
| `REMOVE_FROM_QUEUE` | 큐 항목 삭제 |
| `CLEAR_QUEUE` | 큐 초기화 |
| `GET_PAGE_INFO` | 페이지 정보 조회 |
| `CHECK_CAPTCHA` | CAPTCHA 표시 여부 확인 |

---

## 알려진 한계 및 잔여 리스크

- **verification_failed 오탐**: Tistory가 발행 후 URL을 변경하지 않는 경우 발행이 성공했음에도 실패로 기록될 수 있습니다. 관리자 페이지(`/manage/posts`)에서 직접 확인하세요.
- **CAPTCHA 중 탭 닫힘**: CAPTCHA 해결 전에 에디터 탭을 닫으면 내용이 사라집니다. Retry(재시도)로만 복구할 수 있습니다.
- **셀렉터 변경**: 티스토리 에디터 업데이트 시 `content/selectors.js` 수정이 필요할 수 있습니다.
- **외부 CAPTCHA 해결 서비스 없음**: 의도적으로 포함하지 않았습니다. 사용자가 직접 해결하는 방식만 지원합니다.
