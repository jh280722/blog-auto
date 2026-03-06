# Tistory Auto Publisher

티스토리 블로그 글쓰기를 자동화하는 Chrome 확장 프로그램입니다.

## ✨ 주요 기능

- **팝업 UI**: 확장 프로그램 아이콘 클릭 → 직접 글 작성/발행
- **이미지 삽입**: 로컬 파일, 드래그앤드롭, URL 모두 지원
- **대량 발행 큐**: JSON으로 여러 글을 한번에 등록, 순차 발행
- **외부 API**: `externally_connectable`로 외부 도구(OpenClaw 등)에서 데이터 전송 가능

## 📦 설치

1. 이 폴더를 로컬에 다운로드
2. Chrome 브라우저에서 `chrome://extensions` 접속
3. 우측 상단 **개발자 모드** 활성화
4. **압축해제된 확장 프로그램을 로드합니다** 클릭
5. 이 폴더(`ethereal-zodiac`) 선택

## ⚙️ 설정

1. 확장 프로그램 아이콘 클릭 → **설정** 탭
2. **블로그 이름** 입력 (예: `your-blog-name` → `https://your-blog-name.tistory.com`)
3. **발행 간격** 설정 (대량 발행 시 글 사이 대기 시간)
4. **확장 프로그램 ID** 확인 (외부 API 연동 시 필요)

## 🚀 사용법

### 1. 팝업에서 직접 발행

1. 티스토리 글쓰기 페이지 열기 (`https://your-blog.tistory.com/manage/newpost`)
2. 확장 프로그램 아이콘 클릭
3. 제목, 본문(HTML), 카테고리, 태그, 이미지 입력
4. **🚀 발행** 클릭

### 2. 대량 발행

1. **큐** 탭에서 JSON 대량 입력 영역에 데이터 입력
2. 또는 **글쓰기** 탭에서 하나씩 **📋 큐에 추가**
3. **▶ 시작** 클릭 → 순차 발행

### 3. 외부 API 연동

`api/api-page.html`을 로컬 서버에서 열어 사용하거나, 코드로 직접 호출:

```javascript
const EXTENSION_ID = "your-extension-id";

chrome.runtime.sendMessage(EXTENSION_ID, {
  action: "WRITE_POST",
  data: {
    title: "글 제목",
    content: "<p>본문 HTML</p>",
    category: "카테고리명",
    tags: ["태그1", "태그2"],
    images: [{ url: "https://example.com/img.jpg" }],
    visibility: "public",
    autoPublish: true
  }
}, (response) => console.log(response));
```

## 📁 구조

```
├── manifest.json              # 확장 프로그램 설정
├── background/
│   └── service-worker.js      # 메시지 라우팅, 큐 관리
├── content/
│   ├── selectors.js           # DOM 셀렉터 (수정 용이)
│   └── tistory.js             # 에디터 DOM 조작
├── popup/
│   ├── popup.html             # 팝업 UI
│   ├── popup.css              # 스타일
│   └── popup.js               # 이벤트 핸들링
├── api/
│   └── api-page.html          # 외부 API 테스트 페이지
├── utils/
│   └── image-handler.js       # 이미지 유틸리티
├── icons/                     # 확장 프로그램 아이콘
└── docs/
    └── README.md              # 이 문서
```

## 🔧 셀렉터 수정

티스토리가 에디터 UI를 변경하면 `content/selectors.js`만 수정하면 됩니다.

## ⚠️ 주의사항

- 티스토리에 **로그인된 상태**에서 사용해야 합니다
- 글쓰기 페이지(`/manage/newpost`)가 **열려있어야** 발행이 동작합니다
- 티스토리 에디터 업데이트 시 `content/selectors.js`의 셀렉터를 조정해야 할 수 있습니다

## 📡 API 액션 목록

| 액션 | 설명 |
|------|------|
| `WRITE_POST` | 글 작성 + 발행 |
| `SET_TITLE` | 제목만 입력 |
| `SET_CONTENT` | 본문만 입력 |
| `SET_CATEGORY` | 카테고리 선택 |
| `SET_TAGS` | 태그 입력 |
| `SET_VISIBILITY` | 공개 설정 |
| `INSERT_IMAGES` | 이미지 삽입 |
| `PUBLISH` | 발행 실행 |
| `ADD_TO_QUEUE` | 큐에 추가 |
| `START_QUEUE` | 큐 처리 시작 |
| `GET_QUEUE` | 큐 상태 조회 |
| `CLEAR_QUEUE` | 큐 초기화 |
| `GET_PAGE_INFO` | 페이지 정보 |
