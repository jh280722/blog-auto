# Tistory Auto Publisher

티스토리 블로그 글쓰기를 자동화하는 Chrome 확장 프로그램입니다.

> 현재 운영 기준: **v1.8.32 (2026-04-28 direct publish confirmation target fail-closed 포함)**
> - **v1.8.32부터 `RESUME_DIRECT_PUBLISH`가 저장된 direct publish state의 `phase: "publish_confirmation"` / `publish_confirm_*` 상태를 복구할 때 저장 탭이 사라졌으면 fresh editor tab을 열지 않고 즉시 `publish_confirm_target_not_found`로 fail-closed 합니다.** 응답에는 `sameTabRequired`, `recommendedAction: "verify_remote_state_before_retry"`, compact `confirmationState`, `publishConfirmationRecovery`가 붙으므로, 크론은 새 글 재작성 전에 관리자 최신 글/RSS/공개 URL로 원격 저장 여부를 먼저 확인할 수 있습니다.
> - **v1.8.31부터 generated body image provenance gate가 CLI 래퍼뿐 아니라 확장 서비스워커의 `WRITE_POST` / `ADD_TO_QUEUE` 메시지 입구에도 적용됩니다.** API 페이지나 다른 externally_connectable 호출이 `scripts/blog_auto_call.mjs`를 우회하더라도, `generated: true` 또는 `generation` 메타데이터가 붙은 본문 이미지는 Hermes `image_generate` → `openai-codex` / `gpt-image-2-medium` 경로만 통과하고, PIL/Pillow·수제 인포그래픽·`baoyu-*` 기본 우회 경로는 에디터 탭 열기/큐 저장 전에 `body_image_policy_violation`으로 fail-fast 합니다. 상품 대표 이미지/공식 이미지처럼 생성물이 아니면 generated metadata를 붙이지 않습니다.
> - **v1.8.30부터 `RESUME_DIRECT_PUBLISH`도 저장된 direct publish state가 `publish_confirm_unresolved` / `publish_confirm_in_flight` 또는 `phase: "publish_confirmation"`이면, `RESUME_PUBLISH`를 바로 다시 누르기 전에 같은 탭에 `GET_PUBLISH_CONFIRMATION_STATE` preflight를 수행합니다.** 현재 레이어가 `confirm_ready`일 때만 final confirm 재시도를 계속하고, `confirm_in_flight`는 `publish_confirm_in_flight` 상태로 poll 유지, CAPTCHA는 `captcha_required` handoff로 전환, 레이어 소실/탭 probe 실패는 `publish_confirm_target_not_found`로 fail-closed 합니다. 직접 발행 크론에서도 저장중 상태 중복 클릭이나 fresh tab 재작성으로 인한 공개 글 중복 오염을 줄입니다.
> - **v1.8.29부터 직접 발행뿐 아니라 큐 발행도 `publish_confirm_unresolved` / `publish_confirm_in_flight`를 실패로 넘기지 않고 `publish_confirm_paused`로 보존합니다.** `GET_QUEUE`에서 `publishConfirmTabId`, `confirmationState`, `publishConfirmationRecovery`를 확인한 뒤 `RESUME_AFTER_PUBLISH_CONFIRMATION({ id | tabId })`로 같은 탭 final-confirm 재개를 호출할 수 있고, 여러 paused 항목이 있으면 fail-closed로 명시 대상 선택을 요구합니다. 재개 직전에는 content script가 같은 탭의 현재 발행 확인 레이어를 `GET_PUBLISH_CONFIRMATION_STATE`로 다시 읽어 `confirm_ready`일 때만 최종 확인 재시도를 허용하며, `confirm_in_flight`/레이어 소실/CAPTCHA 감지 상태는 새 탭 재작성 없이 poll·fail-closed·CAPTCHA pause로 보존합니다. `RESUME_DIRECT_PUBLISH`도 같은 상태를 direct publish state에 저장해 새 탭 재작성/중복 공개 오염 대신 같은 탭 복구를 유도합니다.
> - **v1.8.28부터 최종 티스토리 발행 확인 버튼 클릭 뒤 `manage/post` 요청이 관측되지 않으면, 열린 발행 레이어/버튼 상태를 구조화해 `publish_confirm_unresolved` 또는 `publish_confirm_in_flight`로 반환합니다.** 크론은 같은 탭의 레이어를 유지한 채 `RESUME_DIRECT_PUBLISH`/재조회로 이어가면 되고, 새 탭 재작성으로 공개 글을 중복 오염시키지 않습니다.
> - **v1.8.27부터 `scripts/blog_auto_call.mjs`가 `WRITE_POST` / `ADD_TO_QUEUE` payload의 본문용 generated image provenance를 먼저 검사합니다.** `generated: true` 또는 `generation` 메타데이터가 붙은 이미지는 반드시 `generation.tool: "Hermes image_generate"`, `generation.runner: "openai-codex"`, `generation.model: "gpt-image-2-medium"` 경로여야 하며, PIL/Pillow 수제 인포그래픽·`baoyu-*` 우회 경로는 `body_image_policy_violation`으로 Chrome 호출 전에 fail-fast 합니다. 상품 대표 이미지나 외부 사진처럼 생성 이미지가 아니면 generated metadata를 붙이지 않으면 통과합니다.
> - DKAPTCHA 핸드오프/재개 지원
> - **v1.8.26부터 `scripts/blog_auto_call.mjs`가 extension callback 무응답뿐 아니라 Chrome DevTools/API page bootstrap 실패도 `bridge_setup_error` / `bridge_transport_error`로 구조화해 돌려줍니다.** 따라서 크론이 `fetch failed` 같은 단일 문구만 남기고 셸 hard timeout이나 generic wrapper error로 끝나지 않고, `bridgeDiagnostics.stage` / `inferredCause` / `browserVersion` / `debugTargets`로 DevTools 미기동·API page target 부재·websocket transport 단절을 바로 분리할 수 있습니다.
> - **v1.8.25부터 `GET_CAPTCHA_CONTEXT` / `GET_CAPTCHA_ARTIFACTS` / `INFER_CAPTCHA_ANSWER`도 queue `captcha_paused` 항목의 `id`를 직접 받을 수 있고, direct publish state가 없고 paused 항목이 하나뿐이면 해당 항목을 자동 선택합니다.** 따라서 크론/API 페이지가 매번 `GET_QUEUE` → `captchaTabId` 재주입을 선행하지 않아도, 저장된 queue `captchaContext` / `solveHints`를 그대로 재사용해 같은 탭 CAPTCHA inspection → artifact capture → OCR answer inference를 더 짧게 이어갈 수 있습니다. 여러 paused 항목이 있으면 기존처럼 fail-closed로 `id` 또는 `tabId`를 요구합니다.
> - **v1.8.24부터 `GET_CAPTCHA_CONTEXT` / `GET_CAPTCHA_ARTIFACTS` / `INFER_CAPTCHA_ANSWER` / `SUBMIT_CAPTCHA*`는 저장된 blocked tab이 없을 때 아무 탭에나 `currentTabId`를 쓰지 않고, 현재 탭에 live CAPTCHA가 실제로 남아 있을 때만 current-tab fallback을 허용합니다. 제출 계열(`SUBMIT_CAPTCHA`, `SUBMIT_CAPTCHA_AND_RESUME`)은 current tab에 actionable answer path까지 확인하지 못하면 `captcha_target_not_found`로 fail-closed 하므로, stale editor/currentTab drift 때문에 잘못된 탭에 답을 넣는 위험을 줄이고 크론은 `GET_DIRECT_PUBLISH_STATE` / `GET_QUEUE`로 다시 대상 탭을 잡으면 됩니다.**
> - **v1.8.23부터 direct publish same-tab CAPTCHA 재시도/재조회가 중간에 live handoff를 다시 못 읽더라도, 서비스워커가 기존 `directPublishState.captchaContext` / `lastCaptchaArtifactCapture` / `lastCaptchaSubmitResult`를 보존한 채 새 결과만 덮어씁니다.** 따라서 `GET_CAPTCHA_CONTEXT` / `GET_CAPTCHA_ARTIFACTS` / `SUBMIT_CAPTCHA*` 중 한 번이 `editor_not_ready`·빈 handoff·부분 컨텍스트로 돌아와도, 이전 `challengeText` / `challengeMasked` / solve hint가 direct publish state에서 사라져 false `captcha_challenge_context_missing`로 재개가 끊기는 회차를 더 줄입니다.
> - **v1.8.22부터 direct publish도 `SUBMIT_CAPTCHA_AND_RESUME({ tabId, ocrTexts })`처럼 explicit `tabId`를 넘긴 재개 경로에서, 저장된 `directPublishState.captchaContext` / `solveHints`를 같은 blocked tab이면 답안 추론 입력으로 다시 재사용합니다.** 따라서 크론이 `GET_DIRECT_PUBLISH_STATE`에서 받은 `tabId`를 그대로 넘기거나 MV3 service worker restart 직후 live `GET_CAPTCHA_CONTEXT` probe가 잠깐 비어도, 이전 handoff에 남아 있던 `challengeText` / `challengeMasked` / target hint 기준 OCR 축약을 이어가 false `captcha_challenge_context_missing`로 same-tab 재개가 끊기는 회차를 줄입니다.
> - **v1.8.21부터 `SUBMIT_CAPTCHA_AND_RESUME({ id | tabId, ocrTexts })`의 queue 경로도 `captcha_paused` 항목에 저장된 `captchaContext` / `solveHints`를 답안 추론 입력으로 우선 재사용합니다.** 따라서 MV3 service worker restart 직후나 live `GET_CAPTCHA_CONTEXT` probe가 잠깐 비어도, `GET_QUEUE`에 남아 있던 `challengeText` / `challengeMasked` / target hint 기준으로 OCR 후보를 다시 줄일 수 있어 false `captcha_challenge_context_missing`로 same-tab 재개가 끊기는 회차를 줄입니다.
> - **v1.8.20부터 queue continuation wake도 `START_QUEUE` / startup recovery / `chrome.alarms` 분기 모두 tracked wake helper를 공유해, MV3 service worker restart 직후 queue resume이 detached microtask/fire-and-forget로 흘러 continuation alarm만 지워지고 실제 `processNextInQueue()`가 조용히 멈추는 silent stall 가능성을 줄입니다. 중복 wake는 skip하고, in-flight 플래그는 성공/실패 모두에서 정리됩니다.**
> - **큐의 `captcha_paused` 항목은 이제 최초 pause, same-tab 재개 중 `captcha_required` 재발생, `SUBMIT_CAPTCHA_AND_RESUME` 재시도까지 모두 최신 `captchaContext` / `solveHints` / `lastCaptchaArtifactCapture` / `lastCaptchaSubmitResult` / `lastCheckedAt` 메타데이터를 함께 갱신합니다. 따라서 크론/에이전트는 `GET_QUEUE`만 읽어도 대상 `id` / `captchaTabId`뿐 아니라 어떤 프롬프트·solve mode·아티팩트 preference로 다시 풀어야 하는지 바로 파악할 수 있고, stale queue CAPTCHA 힌트 때문에 잘못된 재개 분기로 가는 일을 줄입니다. 완료/재시도 시에는 이 transient 메타데이터를 자동으로 비웁니다.**
> - **큐의 `captcha_paused` 항목도 이제 `SUBMIT_CAPTCHA_AND_RESUME({ id | tabId, ... })`로 same-tab CAPTCHA 제출 뒤 해당 큐 항목 재개까지 바로 이어집니다. direct publish state가 없고 `captcha_paused` 항목이 하나뿐이면 자동 선택하고, 여러 개면 fail-closed로 `id` 또는 `tabId`를 요구합니다. queue resume 성공 뒤 다음 pending 항목도 기존 publish interval을 다시 존중합니다.**
> - **v1.8.18부터는 queue CAPTCHA 재개도 `publish_layer_open`을 무조건 `editor_not_ready`로 끊지 않습니다. CAPTCHA가 최종 발행 직후 걸렸던 회차(`after_final_confirm`)는 먼저 post-submit settle/navigation을 짧게 확인하고, 발행 레이어가 열린 채 남은 회차는 같은 탭 `RESUME_PUBLISH`로 이어서 false `editor_not_ready`를 줄입니다.**
> - **`captcha_required` / `captcha_browser_handoff_required` / `GET_CAPTCHA_ARTIFACTS` handoff는 이제 기본적으로 `artifacts.sourceImage`까지 함께 채워, 크론/에이전트가 추가 왕복 없이 원본 CAPTCHA 이미지를 바로 OCR/비전에 넘길 수 있습니다. 명시적으로 `includeSourceImage: false`일 때만 opt-out 하며, 원본 fetch는 Tistory/Kakao 계열 CAPTCHA 이미지 origin만 허용합니다.**
> - **direct publish continuation wake는 더 이상 detached microtask로 흘리지 않고, alarm/startup wake가 실제 `resumeDirectPublishFlow()` 완료까지 추적합니다.** 이제 same-tab browser handoff 대기 복구가 alarm 직후 조용히 멈추는 silent stall 가능성을 줄입니다.
> - **직접 발행 CAPTCHA state 보존 + saved tab 우선 resume**
> - **`RESUME_DIRECT_PUBLISH({ waitForCaptcha: true })`도 direct publish runtime state + `chrome.alarms` wake-up을 storage에 남겨, MV3 service worker restart 뒤 same-tab CAPTCHA 대기/재개를 자동 복구**
> - **browser/CDP 외부 풀이 뒤 `/manage/posts` 등 성공 URL로 이동하면 stale directPublishState 자동 정리**
> - **에디터 진입 기본 경로를 `manage → newpost`로 정규화**
> - **준비/발행 전환 지점에 bounded stage jitter 추가 (고정 sleep 패턴 완화)**
> - **`publishTrace` / `stage` / `phase` / `lastTransition` 진단 필드 추가**
> - **CAPTCHA context inspection API (blocked tab / iframe rect / 입력창/버튼 후보 확인)**
> - **iframe-only / cross-origin CAPTCHA도 `chrome.scripting.executeScript(allFrames)` 기반 same-tab 감지/입력/제출 지원**
> - **CAPTCHA artifact API (같은 blocked tab 기준 source image / frame direct image / direct image / viewport crop 반환)**
> - **viewport crop용 `<all_urls>` host permission 포함 (captureVisibleTab 안정화)**
> - **`captcha_required` / `captcha_browser_handoff_required` 응답에 same-tab artifact handoff 정보 즉시 포함**
> - **CAPTCHA answer submit API (same blocked tab main DOM + cross-origin iframe 답안 입력 + 확인 버튼 클릭, visible 버튼이 없어도 `dkaptcha.submit()` 경로가 살아 있으면 same-tab 제출 유지)**
> - **raw `preferredSolveMode`도 iframe-only CAPTCHA에서 `extension_frame_dom`을 우선 반환해 초기 trace/힌트가 same-tab frame solve 기본값과 일치**
> - **`SUBMIT_CAPTCHA*`는 merged `captchaContext.preferredSolveMode === "extension_frame_dom"`일 때 frame submit을 먼저 시도하고, 실제 frame solve가 막힌 예외에서만 browser handoff로 내려감**
> - **iframe submit 직후 frame reload/navigation으로 응답이 비어도 tab URL + refreshed captcha context probe로 `captcha_submit_tab_navigated` / `captcha_submitted` / `captcha_still_present`를 복구**
> - **post-CAPTCHA merged context는 실제 challenge/capture 신호 없이 제목/본문에 `captcha` 같은 문자열만 남은 회차를 blocking으로 유지하지 않음**
> - **`SUBMIT_CAPTCHA_AND_RESUME`는 submit 단계에서 이미 `/manage/posts` 또는 permalink로 이동한 회차를 terminal success로 처리해 false `content_empty` 재개를 막음**
> - **`challengeText` / `challengeSlotCount` / `challengeCandidates`를 same-tab CAPTCHA context와 artifact handoff에 함께 포함**
> - **`solveHints`를 `GET_CAPTCHA_CONTEXT` / `GET_CAPTCHA_ARTIFACTS` / `GET_DIRECT_PUBLISH_STATE(includeCaptchaContext: true)` / `captcha_required` handoff 응답에 함께 포함해, 크론이 비전 프롬프트를 추측하지 않고 바로 이미지 판독 → 제출로 이어질 수 있음**
> - **challenge 문구를 끝내 못 읽는 회차도 `solveHints.answerMode = "vision_direct_answer"` fallback을 내려 same-tab 비전 풀이를 계속 유도하고, OCR 후보가 한 개로 정리되면서 길이 힌트까지 맞으면 `SUBMIT_CAPTCHA_AND_RESUME({ ocrTexts })`도 직접 답안으로 수용**
> - **live DKAPTCHA frame summary가 frame body line + submit button text까지 다시 합쳐 instruction-style / masked challenge를 재구성하므로 `challengeText: null` 회차를 줄임**
> - **`INFER_CAPTCHA_ANSWER`로 OCR 후보 텍스트를 빈칸 답안으로 바로 줄이는 helper 추가**
> - **`SUBMIT_CAPTCHA_AND_RESUME`가 explicit answer뿐 아니라 OCR 후보 텍스트 기반 답안 추론도 바로 수용**
> - **OCR 후보가 여러 개면 `SUBMIT_CAPTCHA*`가 masked뿐 아니라 instruction/map CAPTCHA도 상위 답안 후보를 같은 challenge에서 순차 재시도하고, challenge가 바뀌면 즉시 중단 후 새 handoff로 전환**
> - **instruction/map same-challenge retry 직전에는 answer input + submit button이 다시 actionable 해질 때까지 짧게 재대기해서, 첫 오답 직후 transient `captcha_input_not_found`로 두 번째 후보를 놓치는 회차를 줄임**
> - **challenge 문구를 다시 못 읽는 경우에도 same challenge 동일성을 visual signature fallback으로 계속 비교**
> - **live `/manage/newpost` 탭에서 content script가 살아 있어도 probe가 실패하면 곧바로 `editor_ready`로 간주하지 않고 `manage → newpost` 회복 경로를 다시 태움**
> - **`RESUME_DIRECT_PUBLISH(waitForCaptcha)`로 saved blocked tab을 유지한 채 extension-frame/browser fallback same-tab solve 완료까지 대기 후 즉시 재개**
> - **발행 직후 탭 navigation 때문에 content-script 응답 채널이 닫혀도 `WRITE_POST`뿐 아니라 queue / `RESUME_AFTER_CAPTCHA` / `RESUME_DIRECT_PUBLISH`까지 recovery verification로 성공 여부를 다시 확정**
> - **발행 큐는 in-memory timer와 `chrome.alarms`를 함께 사용해 MV3 service worker idle shutdown 뒤에도 다음 항목을 다시 깨우고, 재시작 중 이미 `processing`이던 항목은 duplicate publish를 피하기 위해 fail-closed(`worker_restarted_during_publish`)로 전환한 뒤 남은 pending 항목만 재개**
> - **stale tab 회피 + 실제 editor body readiness gate**
> - **`WRITE_POST` 시작 전 final preflight로 title-only draft fail-closed**
> - **post-CAPTCHA draft snapshot이 local TinyMCE에서 0으로 읽혀도 MAIN world editor summary로 길이/미리보기를 다시 합산**
> - **content script를 `document_start`로 당겨 draft restore confirm bypass와 main-world bridge를 더 빨리 심음**
> - 자동저장 복구 팝업 자동 dismiss
> - **비공개 발행 visibility 강제 보정(MAIN world XHR/fetch interceptor)**

## 주요 기능

- **팝업 UI**: 확장 프로그램 아이콘 클릭 → 직접 글 작성/발행
- **이미지 삽입**: 로컬 파일, 드래그앤드롭, URL 모두 지원
- **대량 발행 큐**: JSON으로 여러 글을 한번에 등록, 순차 발행
- **MV3 queue durability**: `START_QUEUE` 이후에는 in-memory timer + `chrome.alarms` wake-up을 함께 유지하고, queue continuation wake 자체도 tracked helper로 묶어 startup recovery / alarm / explicit start가 모두 같은 in-flight 가드를 공유합니다. 따라서 `GET_QUEUE`는 `queueRuntimeState`뿐 아니라 `captcha_paused` 항목의 최신 `captchaContext` / `solveHints` / `lastCaptchaArtifactCapture` / `lastCaptchaSubmitResult` 메타데이터와 `publish_confirm_paused` 항목의 `publishConfirmTabId` / `confirmationState` / `publishConfirmationRecovery`를 함께 보존해 service worker restart/idle shutdown 이후 자동 재개 여부와 same-tab CAPTCHA/최종확인 재개 힌트를 같이 추적할 수 있음. v1.8.21부터는 `SUBMIT_CAPTCHA_AND_RESUME({ id | tabId, ocrTexts })`가 이 저장된 queue `captchaContext` / `solveHints`를 answer inference에 우선 재주입하므로, live probe가 잠깐 비어도 `challengeText` 기반 OCR 추론이 이어집니다.
- **publish confirmation same-tab recovery**: `publish_confirm_unresolved` / `publish_confirm_in_flight`는 실패 항목으로 확정하지 않고 direct publish state 또는 queue `publish_confirm_paused`에 보존합니다. direct publish는 `RESUME_DIRECT_PUBLISH`, queue는 `RESUME_AFTER_PUBLISH_CONFIRMATION({ id | tabId })`로 같은 탭 final confirm 레이어에서만 재개합니다. 큐 재개 전에는 같은 탭의 현재 확인 레이어 상태를 다시 읽어 `confirm_ready`일 때만 최종 확인을 재시도하고, `confirm_in_flight`는 poll 상태로 유지, CAPTCHA는 `captcha_paused` handoff로 전환, 레이어 소실/탭 probe 실패는 `publish_confirm_target_not_found`로 fail-closed 처리합니다.
- **direct publish wait durability**: `RESUME_DIRECT_PUBLISH({ waitForCaptcha: true })`가 `directPublishRuntimeState`를 storage에 남기고, service worker restart 뒤에도 saved blocked tab의 same-tab CAPTCHA 대기/재개를 alarm 기반으로 다시 이어감 (`GET_DIRECT_PUBLISH_STATE` 응답에도 runtime state 포함)
- **외부 API**: `externally_connectable`로 외부 도구에서 데이터 전송 가능
- **직접 발행 상태 추적**: `captcha_required` 시 blocked tab / blog / visibility / diagnostics / requestData와 `publishTrace` / `stage`를 저장
- **CAPTCHA context API**: 에이전트가 iframe/레이어/입력창/버튼 위치를 읽어 같은 탭에서 해결할 수 있도록 컨텍스트 제공 (`preferredSolveMode`, `iframeCaptchaPresent`, `frameCaptchaCandidates` 포함)
- **정규화된 same-tab solve 힌트**: 초기 `captcha_required` 응답과 `GET_DIRECT_PUBLISH_STATE(includeCaptchaContext: true)` 모두 서비스워커가 merge한 `captchaContext`를 돌려줘 raw iframe 감지보다 정확한 `preferredSolveMode`를 바로 사용할 수 있음
- **raw solve hint 정렬**: content-side `GET_CAPTCHA_CONTEXT` / 초기 publish trace도 iframe-only CAPTCHA에서 `extension_frame_dom`을 먼저 가리켜, 초기 로그가 browser handoff로 과하게 기울지 않음
- **resume blocking 판정 개선**: `RESUME_DIRECT_PUBLISH(waitForCaptcha)`와 queue resume은 top DOM iframe 껍데기만 보지 않고 merged frame context 기준으로 실제 blocking CAPTCHA만 기다림
- **CAPTCHA artifact API**: 에이전트가 같은 blocked tab에서 main DOM/iframe 양쪽 CAPTCHA 이미지를 직접 받아 OCR/비전 입력으로 넘길 수 있음
- **직접 응답 handoff**: `WRITE_POST` / `RESUME_DIRECT_PUBLISH` / `SUBMIT_CAPTCHA*`가 CAPTCHA로 막히면 응답에 `captchaArtifacts`를 같이 붙여 크론이 추가 왕복 없이 바로 OCR/비전으로 넘어갈 수 있음
- **inline source-image handoff 기본화**: 기본 handoff와 `GET_CAPTCHA_ARTIFACTS`는 `sourceImage`를 함께 채워, `frameDirectImage`가 있어도 원본 CAPTCHA 이미지를 우선 사용할 수 있음 (`includeSourceImage: false`로만 opt-out)
- **CAPTCHA challenge extraction**: context/artifact 응답에 빈칸 문제 문구(`challengeText`)와 칸 수(`challengeSlotCount`)를 포함해 OCR 결과를 답안으로 줄이기 쉬움
- **CAPTCHA solve hints**: `solveHints.prompt`, `answerMode`, `submitField`, `targetEntity`, `nextAction`을 함께 반환해 masked CAPTCHA는 `ocrTexts` 기반 추론, instruction/map CAPTCHA는 `answer` 직접 제출이 기본이지만, 여러 OCR 후보만 있어도 target entity 기준으로 `ocrTexts` fallback 추론까지 연결 가능
- **challenge-missing fallback hints**: `challengeText`를 끝내 못 읽는 회차도 `solveHints.answerMode = "vision_direct_answer"` + `submitField = "answer"`를 내려 크론이 same-tab 비전 풀이를 계속할 수 있음
- **live frame fallback extraction**: DKAPTCHA가 문구를 직접 안 내려줘도 frame body line, submit button text, capture candidate 주변 텍스트를 다시 합쳐 `challengeText`를 복원함
- **CAPTCHA submit API**: 에이전트가 blocked tab의 main DOM뿐 아니라 cross-origin iframe에도 답안을 입력하고 같은 탭의 확인 버튼까지 누를 수 있음. 버튼이 잠깐 안 보여도 `window.dkaptcha.submit()`가 살아 있으면 same-tab submit path를 계속 사용합니다.
- **frame-first submit routing**: merged `captchaContext`가 `extension_frame_dom`을 가리키면 `SUBMIT_CAPTCHA` / `SUBMIT_CAPTCHA_AND_RESUME`가 content DOM 실패 응답을 기다리지 않고 frame submit을 먼저 시도함
- **missing-response submit recovery**: frame submit 직후 iframe reload/navigation으로 응답 payload가 비어도 tab URL과 refreshed `captchaContext`를 다시 읽어 `captcha_submit_tab_navigated` / `captcha_submitted` / `captcha_still_present`를 복구함
- **CAPTCHA inference API**: `INFER_CAPTCHA_ANSWER`로 `백촌오피스□ + 백촌오피스텔 → 텔` 같은 빈칸 답안을 안정적으로 추론
- **CAPTCHA submit+resume API**: `SUBMIT_CAPTCHA_AND_RESUME`로 같은 탭 답안 제출과 직접 발행 재개를 한 번에 처리하고, submit 단계에서 이미 완료 URL로 이동하면 추가 resume 없이 성공으로 종료함
- **ranked answer retry**: OCR 후보가 여러 개면 `INFER_CAPTCHA_ANSWER` 또는 instruction/map inference의 `answerCandidates`를 기준으로 `SUBMIT_CAPTCHA` / `SUBMIT_CAPTCHA_AND_RESUME`가 같은 challenge 안에서 상위 답안을 자동 재시도
- **retry-ready wait**: same-challenge 재시도 직전 `activeAnswerInput` + `activeSubmitButton`이 다시 잡힐 때까지 짧게 polling해서, 첫 submit 직후 iframe이 잠깐 비활성화되는 회차에서도 다음 후보 제출 성공률을 올림
- **visual challenge fallback**: `challengeText`가 비는 iframe/canvas CAPTCHA에서도 visual signature를 같이 비교해 같은 challenge 재시도를 너무 빨리 끊지 않음
- **post-publish channel-close recovery 공통화**: 발행 직후 탭 이동으로 content-script 응답 채널이 닫혀도 `WRITE_POST`, queue auto-publish, `RESUME_AFTER_CAPTCHA`, `RESUME_DIRECT_PUBLISH`가 최신 saved post를 다시 검증해 false fail을 줄임
- **solve wait-resume**: `RESUME_DIRECT_PUBLISH`가 `editorProbe.reason === "captcha_present"`인 blocked tab도 그대로 wait target으로 유지하고, same-tab extension-frame/browser fallback 풀이가 끝난 뒤 같은 탭 기준으로만 재개를 이어감. handoff 중 일시적인 `editor_not_ready` / frame-scan miss는 clear로 취급하지 않음
- **post-CAPTCHA settle**: CAPTCHA submit 직후 publish layer가 잠깐 `저장중/발행중` 상태로 남아 있으면 곧바로 `editor_not_ready`로 되감지하지 않고, same-tab completion URL 또는 publish-layer settle을 짧게 대기한 뒤 재개 여부를 판정함. editor shell(`post-editor-app`, TinyMCE/Toast UI surface) 같은 비-CAPTCHA DOM은 answer/button 후보에서 제외하고, 제목/본문 텍스트에 `captcha`가 남아도 challenge/capture 근거가 없으면 blocking으로 유지하지 않아 false `captcha_required`를 줄임
- **실제 에디터 준비 probe**: `PREPARE_EDITOR`가 content script alive만 보지 않고 TinyMCE body / contenteditable / publish layer / CAPTCHA 상태까지 확인하며, live `/manage/newpost` 탭 probe가 실패하면 blind reuse 대신 회복 navigation으로 넘김
- **fail-closed 쓰기 preflight**: `WRITE_POST`는 title/category 쓰기 전에 실제 editor body를 다시 확인하고, 미준비면 `editor_not_ready` + `preflight`로 즉시 중단
- **재개 전 draft self-heal**: CAPTCHA 후 재개 전에 제목/본문/카테고리/이미지/태그 스냅샷을 확인하고, 비어 있으면 같은 탭에서 자동 복구 후 발행
- **CAPTCHA 핸드오프**: DKAPTCHA 감지 시 자동 일시정지 → 같은 탭에서 해결 → 원클릭 재개

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
   - MV3 service worker가 idle 종료될 수 있으므로, 확장은 짧은 간격은 in-memory timer로 바로 이어가고 동시에 `chrome.alarms` fallback을 예약합니다. Chrome stable에서는 alarm wake-up이 최소 약 30초까지 늦어질 수 있으니, 5~10초 간격을 넣어도 worker가 잠들면 다음 항목은 다소 늦게 재개될 수 있습니다.
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
[발행] 클릭 → CAPTCHA 감지 → directPublishState 저장(tabId/blog/url/visibility)
→ 응답의 captchaArtifacts 확인 (없거나 재시도가 필요하면 GET_DIRECT_PUBLISH_STATE / GET_CAPTCHA_ARTIFACTS 호출)
→ 응답의 `solveHints`를 먼저 읽고, 거기 적힌 `prompt` 그대로 OCR/비전에 전달
→ direct publish가 saved blocked tab으로 남아 있다면, v1.8.22부터는 `GET_DIRECT_PUBLISH_STATE`에서 받은 `tabId`를 그대로 `SUBMIT_CAPTCHA_AND_RESUME({ tabId, ... })`에 넘겨도 저장된 `captchaContext` / `solveHints`를 answer inference에 다시 재사용
→ v1.8.23부터는 같은 direct publish state가 후속 `GET_CAPTCHA_CONTEXT` / `GET_CAPTCHA_ARTIFACTS` / `SUBMIT_CAPTCHA*` 중간에 partial handoff만 받아도 이전 `challengeText` / `challengeMasked` / `lastCaptchaArtifactCapture` / `lastCaptchaSubmitResult`를 보존해, live probe miss 한 번으로 same-tab 재개 힌트를 잃지 않음
→ `solveHints.submitField === "ocrTexts"`면 전체 후보 텍스트를 줄바꿈 후보로 읽어 `INFER_CAPTCHA_ANSWER` 또는 `SUBMIT_CAPTCHA_AND_RESUME({ ocrTexts })`로 빈칸 답안 축약
→ `solveHints.submitField === "answer"`면 지시문 대상의 전체 명칭 또는 challenge-missing fallback에서 비전이 직접 읽은 최종 정답을 한 줄 답안으로 만들어 바로 `SUBMIT_CAPTCHA_AND_RESUME({ answer })`
→ v1.8.12부터는 `challengeText`를 끝내 못 읽더라도 `solveHints.answerMode = "vision_direct_answer"`가 내려오며, OCR 후보가 한 개로 정리되고 길이 힌트까지 맞으면 서비스워커가 `SUBMIT_CAPTCHA_AND_RESUME({ ocrTexts })`도 직접 답안으로 수용
→ v1.8.4 기준 live DKAPTCHA에서도 `challengeText`가 비면 frame body line + submit button text fallback으로 다시 복원되는지 먼저 확인
→ OCR 후보가 여러 개면 `SUBMIT_CAPTCHA*`가 `answerCandidates` 상위 답안을 같은 challenge에서 자동 재시도하고, CAPTCHA 문구가 바뀌면 바로 멈춘 뒤 새 artifact/handoff를 돌려줌
→ `preferredSolveMode`가 `extension_dom` / `extension_frame_dom`이면 SUBMIT_CAPTCHA_AND_RESUME로 같은 탭 답안 입력 + 즉시 재개 (`extension_frame_dom`이면 frame submit 우선)
→ 응답이 `captcha_submit_tab_navigated`면 submit 단계에서 이미 `/manage/posts` 또는 permalink로 이동한 성공 케이스이므로 추가 `RESUME_DIRECT_PUBLISH` 없이 그대로 성공 처리
→ iframe-only / cross-origin CAPTCHA도 우선 `extension_frame_dom`으로 처리되며, frame solve가 막힐 때만 `captcha_browser_handoff_required` + `preferredSolveMode=browser_handoff` 기준 browser/CDP fallback 사용
→ fallback이 필요할 때 `RESUME_DIRECT_PUBLISH({ waitForCaptcha: true })`를 걸어두면 blocked tab이 아직 `captcha_present` 상태여도 새 탭으로 갈아타지 않고, CAPTCHA 해제 감지 직후 같은 탭에서 자동 재개
→ CAPTCHA가 계속 보이면 새 답안/새 artifact로 재시도, 사라지면 발행 완료
```

> 구버전/디버그 호환이 필요할 때만 `SUBMIT_CAPTCHA` 후 `captchaStillAppears === false`일 때 `RESUME_DIRECT_PUBLISH`를 따로 호출하세요. `browser_handoff` fallback일 때는 `RESUME_DIRECT_PUBLISH({ waitForCaptcha: true })`가 권장됩니다.

**큐 발행 시 흐름:**

```
큐 처리 중 CAPTCHA 감지 → 해당 항목이 captcha_paused 상태로 일시정지
→ GET_QUEUE 또는 팝업 큐 탭에서 대상 항목 id / captchaTabId 와 함께 `captchaContext` / `solveHints` / `lastCaptchaArtifactCapture` 확인
→ 같은 탭에서 OCR/비전으로 정답 판독
→ SUBMIT_CAPTCHA_AND_RESUME({ id, ocrTexts }) 또는 SUBMIT_CAPTCHA_AND_RESUME({ tabId, answer }) 호출
→ 답안 제출 + 해당 큐 항목 same-tab 재개
→ v1.8.18부터는 publish layer가 열린 채 남은 회차도 같은 탭에서 바로 이어가고, after_final_confirm 회차는 post-submit settle/navigation을 먼저 확인
→ 발행 완료 → 큐는 기존 publish interval을 지킨 뒤 자동 계속
```

> direct publish state가 없고 `captcha_paused` 항목이 하나뿐이면 `id` / `tabId` 없이도 `SUBMIT_CAPTCHA_AND_RESUME(...)`가 그 항목을 자동 선택합니다. 여러 개면 fail-closed로 selector를 요구합니다.
> v1.8.18부터는 queue CAPTCHA resume이 `publish_layer_open`만으로 false `editor_not_ready`를 내지 않도록 stage-aware resume(`after_final_confirm` settle 확인 포함)을 적용합니다.
> **핵심**: CAPTCHA 감지 시 에디터를 닫거나 새로고침하면 안 됩니다.
> 에디터 탭을 그대로 두고 CAPTCHA만 해결한 뒤 재개하세요. 팝업의 **[재개]** 버튼은 기존처럼 수동 solve 뒤 재개용이고, 크론/에이전트는 `SUBMIT_CAPTCHA_AND_RESUME` 경로가 권장됩니다.

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
5. CAPTCHA가 감지되면 경고 배너가 나타납니다 → 같은 에디터 탭에서 CAPTCHA 해결 → **[재개]** 클릭

### 2. 대량 발행

1. **큐** 탭에서 JSON 대량 입력 영역에 데이터 입력
2. 또는 **글쓰기** 탭에서 하나씩 **[큐에 추가]**
3. **[시작]** 클릭 → 순차 발행
4. 각 글 사이에는 in-memory timer와 `chrome.alarms` fallback이 함께 예약되어, MV3 service worker가 쉬는 동안에도 다음 항목을 최대한 이어서 깨웁니다.
5. `START_QUEUE` / startup recovery / alarm wake는 같은 tracked helper를 공유하므로, worker restart 직후 queue resume이 detached microtask/fire-and-forget로 끝나 continuation alarm만 사라지는 silent stall 리스크를 줄입니다.
6. service worker 재시작 중 이미 `processing`이던 항목은 duplicate publish를 피하려고 `worker_restarted_during_publish` 실패로 남기고, 남은 pending 항목만 이어서 처리합니다.
7. CAPTCHA 발생 시 해당 항목이 ⚠️ 상태로 표시 → same-tab solve 뒤 **[재개]** 클릭하거나, 외부 크론/에이전트는 `GET_QUEUE`로 `id` / `captchaTabId`와 최신 `captchaContext` / `solveHints` / `lastCaptchaArtifactCapture` / `lastCaptchaSubmitResult`를 확인한 뒤 `SUBMIT_CAPTCHA_AND_RESUME({ id | tabId, ... })`를 호출해 해당 항목만 바로 재개. v1.8.21부터는 이 queue solve 경로가 저장된 `captchaContext` / `solveHints`를 answer inference에 우선 재사용하므로, worker restart 직후나 live context probe가 잠깐 비어도 OCR 후보만으로 다시 `captcha_challenge_context_missing`에 빠질 확률이 낮아집니다.

### 3. 외부 API 연동

`api/api-page.html`을 로컬 서버에서 열어 사용하거나, 코드로 직접 호출:

**운영 권장값**
- 실제 발행: `visibility: "public"`
- 테스트 발행: `visibility: "private"`
- DKAPTCHA 발생 시: 먼저 응답의 `captchaArtifacts`와 `solveHints`를 확인하고, 필요하면 `GET_DIRECT_PUBLISH_STATE` / `GET_CAPTCHA_ARTIFACTS`로 blocked tab과 캡차 이미지를 다시 확보합니다. `GET_DIRECT_PUBLISH_STATE` 응답에는 `directPublishRuntimeState`도 함께 내려오므로, service worker restart 뒤 same-tab CAPTCHA wait가 다시 이어질 예정인지 바로 확인할 수 있습니다. v1.8.22부터는 direct publish가 saved blocked tab으로 남아 있을 때 `GET_DIRECT_PUBLISH_STATE`에서 받은 `tabId`를 그대로 `SUBMIT_CAPTCHA_AND_RESUME({ tabId, ... })`에 넘겨도 저장된 `captchaContext` / `solveHints`를 answer inference에 재사용합니다.
- v1.8.24부터는 저장된 blocked tab이 없을 때 `GET_CAPTCHA_CONTEXT` / `GET_CAPTCHA_ARTIFACTS` / `INFER_CAPTCHA_ANSWER` / `SUBMIT_CAPTCHA*`가 무조건 마지막 `currentTabId`로 떨어지지 않습니다. 현재 탭에 live CAPTCHA가 실제로 남아 있을 때만 current-tab fallback을 허용하고, 제출 계열은 actionable answer path까지 확인하지 못하면 `captcha_target_not_found`로 fail-closed 합니다. 크론은 이 응답을 받으면 `GET_DIRECT_PUBLISH_STATE(includeCaptchaContext: true)` 또는 `GET_QUEUE`로 대상 탭을 다시 고정한 뒤 재시도하세요.
- v1.8.25부터는 direct publish state가 없고 queue에 `captcha_paused` 항목이 하나뿐일 때 `GET_CAPTCHA_CONTEXT` / `GET_CAPTCHA_ARTIFACTS` / `INFER_CAPTCHA_ANSWER`도 그 항목을 자동 선택합니다. 여러 paused 항목이 있으면 기존처럼 fail-closed로 `id` 또는 `tabId`를 요구하고, explicit `id`를 넘기면 queue에 저장된 `captchaContext` / `solveHints`를 같은 탭 inspection/inference에도 바로 재주입합니다.
- 기본 handoff와 `GET_CAPTCHA_ARTIFACTS`는 이제 `artifacts.sourceImage`를 함께 반환하므로, cross-origin frame export가 살아 있어 `frameDirectImage`가 있어도 원본 CAPTCHA 이미지를 우선 OCR/비전에 넘길 수 있습니다. 더 가벼운 응답이 필요할 때만 `includeSourceImage: false`로 opt-out 하세요.
- `solveHints.prompt`는 그대로 OCR/비전 프롬프트로 사용합니다. masked challenge면 **`ocrTexts` 기반 추론**, instruction/map challenge면 **`answer` 직접 제출**이 기본이지만, 비전이 여러 후보를 줄바꿈으로 돌려준 경우에도 **`ocrTexts` fallback**으로 target entity 기준 자동 선택을 시도할 수 있습니다.
- v1.8.12부터는 `challengeText`를 못 읽은 회차도 `solveHints.answerMode = "vision_direct_answer"` + `submitField = "answer"`로 직접 정답 판독을 유도합니다. 이때 OCR 후보가 1개로 정리되고 길이 힌트까지 맞으면 서비스워커가 `SUBMIT_CAPTCHA_AND_RESUME({ ocrTexts })`도 직접 답안으로 수용합니다.
- 일반 DOM형 CAPTCHA면 OCR/비전으로 전체 후보 텍스트를 구한 뒤 **`INFER_CAPTCHA_ANSWER` 또는 `SUBMIT_CAPTCHA_AND_RESUME({ ocrTexts })`를 우선 사용**
- OCR 후보가 여러 개면 `answerCandidates`가 순위대로 내려오고, `SUBMIT_CAPTCHA*`가 기본적으로 상위 3개 답안까지 같은 challenge에서 자동 재시도
- `captcha_browser_handoff_required` 또는 `preferredSolveMode: "browser_handoff"`면 cross-origin iframe이므로 같은 탭에서 browser/CDP로 직접 풀이하고 **`RESUME_DIRECT_PUBLISH({ waitForCaptcha: true })`** 로 자동 재개 대기를 거는 것이 권장입니다. v1.8.14부터는 이 browser handoff 대기 자체도 `directPublishRuntimeState` + `chrome.alarms`로 영속화돼, MV3 service worker가 idle restart돼도 남은 timeout 범위 안에서 saved tab을 다시 잡고 same-tab 재개를 이어갑니다. v1.8.15부터는 alarm/startup wake가 detached microtask가 아니라 실제 resume 호출 완료까지 추적되므로, wake 직후 continuation alarm만 지워지고 재개가 조용히 멈추는 silent stall 리스크도 함께 줄였습니다.
- 구버전/디버그 호환이 필요할 때만 `SUBMIT_CAPTCHA` → `RESUME_DIRECT_PUBLISH` 분리 호출
- 브라우저 시작 직후/오래된 티스토리 탭 사용 시: 먼저 `PREPARE_EDITOR`
- `editor_not_ready` 발생 시: `diagnostics.attempts[].editorProbe` / `contentScriptAlive` / `preflight`를 보고 `PREPARE_EDITOR` 재호출
- 큐를 외부에서 모니터링할 때 `GET_QUEUE` 응답의 `queueRuntimeState.active` / `scheduledTimeMs`를 같이 보면, worker 재시작 뒤 자동 재개가 예정됐는지 바로 확인할 수 있습니다. 이제 `captcha_paused` 항목에는 `captchaContext` / `solveHints` / `lastCaptchaArtifactCapture` / `lastCaptchaSubmitResult` / `lastCheckedAt`도 함께 남으므로, 큐 solve 직전에 별도 상태 재구성 없이 어떤 문제를 같은 탭에서 다시 풀어야 하는지 바로 판단할 수 있습니다. queue CAPTCHA solve 뒤에는 `captcha_paused` 항목의 `id` 또는 `captchaTabId`를 그대로 `SUBMIT_CAPTCHA_AND_RESUME({ id | tabId, ... })`에 넘겨 같은 항목만 재개하세요. v1.8.25부터는 direct publish state가 없고 paused 항목이 하나뿐이면 `GET_CAPTCHA_CONTEXT` / `GET_CAPTCHA_ARTIFACTS` / `INFER_CAPTCHA_ANSWER`도 selector 생략으로 그 항목을 자동 선택하고, explicit `id`를 주면 queue에 저장된 `captchaContext` / `solveHints`를 inspection/inference 단계에도 바로 재사용합니다. v1.8.21부터는 이 queue submit path가 저장된 `captchaContext` / `solveHints`를 answer inference에 우선 주입하므로, worker restart 직후나 live `GET_CAPTCHA_CONTEXT` 재조회가 비는 회차도 `challengeText` 기반 OCR 축약을 계속 시도합니다. v1.8.18부터는 `after_final_confirm` 회차가 final submit 직후 `publish_layer_open`으로 남아도 post-submit settle/navigation을 먼저 확인한 뒤 same-tab 재개를 이어갑니다. direct publish handoff는 `GET_DIRECT_PUBLISH_STATE`의 `directPublishRuntimeState.active` / `nextCheckTimeMs` / `deadlineMs`를 같이 보세요.

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
    console.log('inline captcha handoff', response.captchaArtifacts, response.solveHints); // solveHints.prompt를 바로 OCR/vision 입력에 사용 가능
    // response.captchaContext / directPublish.captchaContext 의 preferredSolveMode 는 service-worker merged 결과
    chrome.runtime.sendMessage(EXTENSION_ID, {
      action: "GET_DIRECT_PUBLISH_STATE",
      data: { includeCaptchaContext: true }
    }, (state) => console.log('blocked tab state', state.directPublish?.captchaContext?.preferredSolveMode, state));
  }
  if (response.status === 'editor_not_ready') {
    console.log(response.preflight || response.diagnostics);
  }
  console.log(response);
});

chrome.runtime.sendMessage(EXTENSION_ID, {
  action: "GET_CAPTCHA_CONTEXT"
}, (response) => console.log('captcha context', response));

chrome.runtime.sendMessage(EXTENSION_ID, {
  action: "GET_CAPTCHA_ARTIFACTS"
}, (response) => {
  console.log('captcha artifact', response.artifact);
  // response.artifact.dataUrl + response.captureContext.challengeText -> OCR/vision input
});

chrome.runtime.sendMessage(EXTENSION_ID, {
  action: "INFER_CAPTCHA_ANSWER",
  data: {
    ocrTexts: ["백촌오피스텔", "백촌오피스탤"]
  }
}, (response) => {
  console.log(response.answer, response.answerCandidates);
});

chrome.runtime.sendMessage(EXTENSION_ID, {
  action: "SUBMIT_CAPTCHA_AND_RESUME",
  data: {
    ocrTexts: ["백촌오피스텔"]
    // tabId: 321 // 선택: 기본값은 저장된 directPublishState tab
  }
}, (response) => {
  if (response.status === 'captcha_browser_handoff_required') {
    console.log('solve in browser/CDP on the same tab', response.captchaArtifacts);
    chrome.runtime.sendMessage(EXTENSION_ID, {
      action: "RESUME_DIRECT_PUBLISH",
      data: {
        waitForCaptcha: true,
        waitTimeoutMs: 120000,
        pollIntervalMs: 1000
      }
    }, (resume) => console.log('resume after browser handoff', resume.captchaWait, resume));
    return;
  }
  if (response.status === 'captcha_submit_tab_navigated') {
    console.log('publish completed during captcha submit recovery', response.url, response.submitResult);
    return;
  }
  console.log('captcha submit result', response.submitResult);
  console.log('resume result', response.resumeResult || response);
});
```

**운영 권장 순서**
1. `PREPARE_EDITOR` 호출
2. `success: true`, `status: "editor_ready"` 확인
3. `WRITE_POST` 호출
4. `captcha_required`면 우선 응답의 `captchaArtifacts`를 확인하고, 필요하면 `GET_DIRECT_PUBLISH_STATE(includeCaptchaContext: true)` 또는 `GET_CAPTCHA_ARTIFACTS`로 막힌 탭/캡차 이미지를 다시 확보
5. `response.captchaArtifacts.artifact.dataUrl`와 `response.captchaArtifacts.captureContext.challengeText`를 OCR/비전 입력으로 사용해 전체 후보 텍스트를 구함
6. `challengeText`가 있으면 `INFER_CAPTCHA_ANSWER` 또는 `SUBMIT_CAPTCHA_AND_RESUME({ ocrTexts })`로 빈칸 답안을 먼저 줄임
7. v1.8.12부터 `solveHints.answerMode === "vision_direct_answer"`면 challenge 문구가 비어도 비전이 최종 정답을 직접 읽어 `SUBMIT_CAPTCHA_AND_RESUME({ answer })`로 제출합니다. OCR 후보가 1개뿐이면서 길이 힌트까지 맞으면 `SUBMIT_CAPTCHA_AND_RESUME({ ocrTexts })`도 same-tab direct answer로 수용됩니다.
8. OCR 후보가 여러 개면 응답의 `answerCandidates`와 `answerAttemptHistory`를 확인합니다. 같은 challenge가 유지되는 동안에는 `SUBMIT_CAPTCHA*`가 상위 답안을 자동 재시도합니다.
9. `response.captchaContext` 또는 refreshed direct state의 `preferredSolveMode !== "browser_handoff"`면 `SUBMIT_CAPTCHA_AND_RESUME`로 같은 탭에 답안을 제출하고 즉시 재개
10. 응답이 `captcha_submit_tab_navigated`면 submit 단계에서 이미 완료 URL로 이동한 것이므로 성공으로 처리하고 추가 resume을 호출하지 않습니다.
11. `preferredSolveMode === "browser_handoff"` 또는 `captcha_browser_handoff_required`면 same-tab browser/CDP 풀이와 함께 `RESUME_DIRECT_PUBLISH({ waitForCaptcha: true })`를 호출해 CAPTCHA 해제 직후 자동 재개
12. 재개 단계는 저장된 `requestData`를 기준으로 draft snapshot을 검사하고, 제목/본문/이미지가 비어 있으면 먼저 복구합니다. 복구가 충분하지 않으면 `draft_restore_failed`로 fail-closed 합니다.
13. 응답이 `captcha_still_present`인데 `answerRetrySummary.stoppedReason === "challenge_changed"`면 challenge가 새로고침된 것이므로, 새 artifact/OCR 후보로 다시 시작합니다.
14. `editor_not_ready`면 `diagnostics.attempts[].editorProbe` / `contentScriptAlive` / `preflight.reason`을 보고 `PREPARE_EDITOR` 재호출

### 4. 크론/CLI 래퍼 (`scripts/blog_auto_call.mjs`)

크론이 `chrome.runtime.sendMessage(...)` callback을 무기한 기다리다가 **셸 hard timeout**에만 의존하지 않도록, repo에는 구조화된 호출 래퍼 `scripts/blog_auto_call.mjs`가 포함됩니다.

```bash
# 기본: 127.0.0.1:18800 의 운영 Chrome + extension API page 재사용
node scripts/blog_auto_call.mjs \
  --action PREPARE_EDITOR \
  --data-json '{"blogName":"nakseo-dev"}'

node scripts/blog_auto_call.mjs \
  --action WRITE_POST \
  --data-file /path/to/payload.json
```

주요 동작:
- `chrome-extension://<EXTENSION_ID>/api/api-page.html` 탭을 자동 재사용/복구
- `BLOG_AUTO_CALL_TIMEOUT_MS` 또는 `--timeout-ms` 기준으로 **page-context Promise timeout** 적용
- `WRITE_POST` / `ADD_TO_QUEUE` payload에 generated body image가 명시된 경우 Chrome/CDP 호출 전에 provenance를 검사해, Hermes `image_generate` → `openai-codex` / `gpt-image-2-medium` 외의 PIL/Pillow·수제 인포그래픽·`baoyu-*` 기본 우회 경로를 `body_image_policy_violation`으로 즉시 차단
- 같은 검사는 확장 서비스워커의 `WRITE_POST` / `ADD_TO_QUEUE` 메시지 입구에서도 한 번 더 실행되므로, API 페이지·외부 `chrome.runtime.sendMessage` 호출이 CLI 래퍼를 우회해도 unsafe generated image payload가 에디터 탭을 열거나 큐에 저장되기 전에 중단됨
- extension callback이 끝내 돌아오지 않으면 터미널 hard timeout까지 멍하게 기다리지 않고 즉시 `status: "bridge_timeout"` 반환
- Chrome DevTools가 안 떠 있거나 API page target/bootstrap이 실패하면 `status: "bridge_setup_error"`로 끊고, `bridgeDiagnostics.stage === "ensure_api_target"` + `inferredCause` / `browserVersion` / `debugTargets`를 남겨 DevTools 미기동 vs API page target 부재를 바로 구분
- API target을 찾은 뒤 websocket/evaluate transport가 끊기면 `status: "bridge_transport_error"`로 끊고, `bridgeDiagnostics.stage === "call_extension_action"` + 동일 진단 필드를 남겨 bridge callback 무응답과 CDP transport 실패를 분리
- `bridge_timeout` 응답에는 follow-up diagnostics 포함:
  - `GET_DIRECT_PUBLISH_STATE(includeCaptchaContext: true)`
  - `GET_QUEUE`
  - 가능할 때 `GET_CAPTCHA_CONTEXT` / `GET_CAPTCHA_ARTIFACTS`
- bulky `artifact.dataUrl`는 제거하고 compact summary만 남겨, 크론 로그가 base64 blob으로 오염되지 않음
- 정상 응답에도 `bridgeMeta.startedAt/finishedAt/runtimeTimeoutMs/apiTarget`를 붙여 호출 provenance를 남김

setup failure 예시:

```json
{
  "success": false,
  "status": "bridge_setup_error",
  "error": "fetch failed",
  "bridgeDiagnostics": {
    "stage": "ensure_api_target",
    "inferredCause": "devtools_unreachable",
    "browserVersion": {
      "success": false,
      "status": "bridge_diagnostic_error",
      "error": "fetch failed"
    },
    "debugTargets": {
      "success": false,
      "status": "bridge_diagnostic_error",
      "error": "fetch failed"
    }
  }
}
```

timeout 예시:

```json
{
  "success": false,
  "status": "bridge_timeout",
  "error": "PREPARE_EDITOR did not return a callback within 300ms.",
  "bridgeDiagnostics": {
    "inferredCause": "editor_prepare_unresolved",
    "directState": { "directPublish": null },
    "queueState": { "total": 0 },
    "captchaContext": null,
    "captchaArtifacts": null
  }
}
```

운영 팁:
- wrapper-level timeout (`bridge_timeout`)은 **확장 응답이 아예 없는 경우**를 surface하는 용도입니다. extension이 정상적으로 `editor_not_ready`, `captcha_required`, `captcha_wait_timeout` 등을 돌려주면 그 응답은 그대로 통과시킵니다.
- `body_image_policy_violation`은 Chrome을 호출하기 전 payload 품질 gate에서 막힌 것입니다. v1.8.31부터는 동일 gate가 서비스워커 `WRITE_POST` / `ADD_TO_QUEUE` 입구에도 적용되므로, CLI 래퍼를 우회한 API 페이지/외부 메시지도 에디터 탭 열기나 큐 저장 전에 같은 status로 중단됩니다. 생성 이미지가 필요하면 먼저 Hermes `image_generate`(운영 backend: `openai-codex` / `gpt-image-2-medium`)로 만들고, 업로드 URL에 아래 provenance를 함께 붙여 호출하세요. 상품 대표 이미지/공식 이미지처럼 생성물이 아니면 `generated` / `generation` 필드를 생략합니다.

```json
{
  "images": [
    {
      "url": "https://i.imgur.com/example.png",
      "alt": "본문용 생성 이미지",
      "generated": true,
      "generation": {
        "tool": "Hermes image_generate",
        "runner": "openai-codex",
        "model": "gpt-image-2-medium"
      }
    }
  ]
}
```

- `bridge_setup_error`는 callback timeout 전에 **Chrome DevTools / API page 준비 단계**에서 막힌 경우입니다. `bridgeDiagnostics.inferredCause`가 `devtools_unreachable`이면 Chrome/CDP 자체를, `api_page_target_missing`이면 extension API page 탭/로드 상태를 먼저 봅니다.
- `bridge_transport_error`는 API page target은 잡았지만 `Runtime.evaluate` / websocket transport가 중간에 끊긴 경우입니다. MV3 worker idle 종료 문제가 아니라 CDP lane 자체가 흔들린 것이므로, browser/DevTools 쪽 복구를 우선합니다.
- 실제 크론에서는 이 래퍼를 먼저 쓰고, 터미널/cron hard timeout은 wrapper timeout보다 넉넉한 마지막 safety net으로만 둡니다.

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
├── scripts/
│   └── blog_auto_call.mjs     # 크론/CLI용 structured bridge wrapper
├── utils/
│   ├── blog-auto-call.js      # blog_auto_call.mjs용 CDP/diagnostics helper
│   ├── blog-image-policy.js   # generated body image provenance guard (Hermes image_generate only)
│   ├── image-handler.js       # 이미지 유틸리티
│   ├── captcha-submit-recovery.js # frame submit 응답 누락 복구 유틸
│   ├── publish-confirmation.js # 최종 발행 확인 단계 상태 분류 유틸
│   └── queue-runtime.js       # MV3 queue wake-up / restart recovery 유틸
├── tests/
│   ├── blog-auto-call.test.mjs # wrapper timeout/diagnostics regression tests
│   └── publish-confirmation.test.mjs # final confirmation state regression tests
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

## 발행 상태 코드 (v1.8.32)

응답의 `status` 필드로 발행 결과를 세밀하게 구분할 수 있습니다:

| 상태 | 설명 | 다음 액션 |
|------|------|-----------|
| `editor_ready` | `PREPARE_EDITOR`가 실제 TinyMCE/editor body까지 준비된 탭 확보 완료 | `WRITE_POST` 호출 |
| `body_image_policy_violation` | `scripts/blog_auto_call.mjs` 또는 서비스워커 `WRITE_POST` / `ADD_TO_QUEUE` 입구가 generated body image provenance를 검사했고, Hermes `image_generate` → `openai-codex` / `gpt-image-2-medium` 외 경로(PIL/Pillow, `baoyu-*`, 수제 인포그래픽 등)를 발견 | payload 이미지 생성 경로를 Hermes `image_generate`로 다시 만들고 `generation` metadata를 붙여 재호출. 상품/외부 이미지면 generated metadata를 붙이지 않음 |
| `blog_not_configured` | 자동으로 열 블로그명을 알 수 없음 | 설정 저장 또는 `data.blogName` 전달 |
| `published` | 발행 성공 | — |
| `captcha_required` | CAPTCHA 감지됨 (직접 발행) | 응답의 `captchaArtifacts` 우선 확인 → `preferredSolveMode`가 `extension_dom` / `extension_frame_dom`이면 `SUBMIT_CAPTCHA_AND_RESUME`, 드물게 `browser_handoff`면 browser/CDP fallback + `RESUME_DIRECT_PUBLISH({ waitForCaptcha: true })` |
| `captcha_submit_tab_navigated` | same-tab CAPTCHA 제출 직후 이미 `/manage/posts` 또는 permalink로 이동함 | 성공으로 처리, 추가 `RESUME_DIRECT_PUBLISH` 호출 불필요 |
| `captcha_browser_handoff_required` | cross-origin iframe에서도 extension-frame solve가 막힌 예외 케이스 | 같은 탭에서 browser/CDP로 풀이하고 `RESUME_DIRECT_PUBLISH({ waitForCaptcha: true })`로 자동 재개 대기 |
| `captcha_target_not_found` | 저장된 blocked tab이 없고 현재 탭에도 live/actionable CAPTCHA가 없음 | `GET_DIRECT_PUBLISH_STATE(includeCaptchaContext: true)` 또는 `GET_QUEUE`로 대상 `tabId` / `id`를 다시 확인한 뒤 재시도 |
| `captcha_wait_timeout` | `RESUME_DIRECT_PUBLISH(waitForCaptcha)` 대기 시간이 초과됨 | 같은 탭 solve 진행 상태 확인 후 재시도 또는 `waitTimeoutMs` 증가 |
| `captcha_paused` | 큐 항목 CAPTCHA 일시정지 | `GET_QUEUE`로 `id` / `captchaTabId`뿐 아니라 `captchaContext` / `solveHints` / `lastCaptchaArtifactCapture` / `lastCaptchaSubmitResult`를 함께 확인한 뒤 `SUBMIT_CAPTCHA_AND_RESUME({ id | tabId, ... })` 권장. v1.8.21부터는 이 queue submit path가 저장된 `captchaContext` / `solveHints`를 answer inference에 우선 재사용해 false `captcha_challenge_context_missing`를 줄입니다. v1.8.18부터는 `publish_layer_open` 상태도 same-tab 재개/settle 확인으로 이어지고, 팝업 수동 solve라면 `RESUME_AFTER_CAPTCHA` |
| `publish_confirm_paused` | 큐 항목이 티스토리 최종 확인 레이어/저장중 상태에서 멈춰 다음 항목으로 넘어가지 않도록 일시정지됨 | `GET_QUEUE`에서 `id`, `publishConfirmTabId`, `confirmationState`, `publishConfirmationRecovery` 확인 후 같은 탭에서 `RESUME_AFTER_PUBLISH_CONFIRMATION({ id | tabId })`. 이 호출은 재개 직전 같은 탭 레이어를 다시 probe해 `confirm_ready`일 때만 final confirm을 누르고, `confirm_in_flight`는 poll 유지, CAPTCHA는 `captcha_paused` 전환, 레이어 소실은 `publish_confirm_target_not_found`로 중단합니다. 여러 항목이면 id 또는 tabId를 명시해야 하며, `RETRY_ITEM`은 처음부터 재작성하므로 공개 오염 위험 검토 후 사용 |
| `publish_confirm_target_not_found` | 저장된 최종 확인 탭/레이어를 재개 직전 확인하지 못함. v1.8.32부터 direct `RESUME_DIRECT_PUBLISH`도 이 상태를 저장된 direct publish state에 보존하고 fresh editor rewrite로 fallback하지 않음 | 새 탭 재작성/`RETRY_ITEM`로 바로 가지 말고 direct는 `GET_DIRECT_PUBLISH_STATE`, queue는 `GET_QUEUE`와 실제 탭 상태를 다시 확인. 이미 저장됐는지 관리자 최신 글/RSS/공개 URL을 먼저 확인한 뒤 수동 복구 또는 재발행 여부 결정 |
| `publish_confirm_unresolved` | 최종 발행 확인 버튼 클릭 뒤 `manage/post` 요청이 아직 관측되지 않았고 발행 레이어/확인 버튼이 같은 탭에 남아 있음 | 새 글쓰기 탭을 열지 말고 같은 탭에서 `RESUME_DIRECT_PUBLISH` 또는 queue라면 저장된 항목에 `RESUME_AFTER_PUBLISH_CONFIRMATION`으로 final confirm만 재시도. v1.8.30부터 direct `RESUME_DIRECT_PUBLISH`도 재개 직전 `GET_PUBLISH_CONFIRMATION_STATE` preflight를 수행해 `confirm_ready`일 때만 다시 누르고, `confirm_in_flight`/CAPTCHA/레이어 소실은 중복 클릭 없이 보존합니다. 응답의 `confirmationState.recommendedAction`, `sameTabRequired`, `retryable` 확인 |
| `publish_confirm_in_flight` | 확인 버튼 클릭 뒤 버튼/레이어가 저장중·발행중 또는 disabled 상태인데 `manage/post` 요청은 아직 관측되지 않음 | 중복 클릭/새 탭 재작성을 피하고 같은 탭을 먼저 poll. direct `RESUME_DIRECT_PUBLISH`는 이제 이 상태에서 곧바로 `RESUME_PUBLISH`를 누르지 않고 `publish_confirm_in_flight`를 다시 반환하며 direct state에 `publishConfirmationRecovery`를 보존합니다. 짧게 재조회 후 완료 URL/`GET_DIRECT_PUBLISH_STATE`/`GET_DRAFT_SNAPSHOT` 확인, 계속 고착되면 same-tab resume 판단 |
| `editor_not_ready` | 실제 editor body 준비/복구 실패 또는 `WRITE_POST` preflight 실패 | `diagnostics`/`preflight` 확인 후 `PREPARE_EDITOR` 재호출 |
| `item_not_found` | 재개할 큐 항목 없음 | 큐 확인 |
| `content_empty` | 본문 비어있거나 에디터 미반영 | 본문 확인 후 재시도 |
| `draft_restore_failed` | CAPTCHA 재개 직전 draft 복구가 충분하지 않음 | blank post 방지를 위해 재발행 중단 — `draftRestore`/snapshot 확인 |
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
{
  success: false,
  status: "captcha_required",
  error: "CAPTCHA가 감지되었습니다.",
  tabId: 321,
  blogName: "your-blog",
  directPublish: {
    tabId: 321,
    blogName: "your-blog",
    url: "https://your-blog.tistory.com/manage/newpost",
    visibility: "public",
    detectedAt: "2026-03-07T01:23:45.678Z",
    captchaContext: {
      captchaPresent: true,
      candidateCount: 2,
      confirmButtonText: "공개 발행"
    }
  }
}

// 큐 CAPTCHA 일시정지
// → 큐 항목 status가 "captcha_paused"로 변경됨
// → 팝업 큐 탭에서 재개 버튼 표시

// 준비 실패
{
  success: false,
  status: "editor_not_ready",
  error: "실제 에디터 본문이 준비된 티스토리 글쓰기 탭을 확보하지 못했습니다. diagnostics를 확인하세요.",
  diagnostics: {
    attempts: [
      {
        step: "probe_existing",
        outcome: "not_ready",
        error: "에디터 본문 영역을 아직 찾지 못했습니다. (https://your-blog.tistory.com/manage/newpost)",
        reason: "editor_body_missing",
        contentScriptAlive: true,
        editorProbe: {
          titleInputPresent: true,
          editorIframePresent: true,
          editorBodyPresent: false,
          captchaPresent: false,
          publishLayerPresent: false
        }
      },
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
- `attempts[].contentScriptAlive`: probe 실패 시 content script liveness
- `attempts[].reason`: 마지막 editor readiness 실패 reason
- `attempts[].editorProbe`: 마지막 실제 editor probe 요약 (title / iframe / body / TinyMCE / CAPTCHA / publish layer)

자주 보게 될 `attempts[].step` 값:

- `inspect_candidate`: 후보 탭 점검 시작
- `probe_existing`: 현재 탭에 실제 editor readiness probe 재시도
- `reload_candidate` / `navigate_candidate`: stale 탭을 `/manage/newpost`로 복구
- `probe_after_navigation`: 복구 후 재프로브
- `open_fresh_tab`: 새 글쓰기 탭 오픈
- `probe_fresh_tab`: 새 탭 준비 확인
- `skip_candidate`: 다른 블로그 탭이라 건너뜀

`WRITE_POST`가 제목 입력 전에 막히면 top-level `preflight`가 같이 옵니다.

- `preflight.reason`: fail-closed 원인 (`editor_body_missing`, `tinymce_body_missing`, `captcha_present` 등)
- `preflight.waitedMs` / `pollCount`: 쓰기 직전 대기 시간
- `preflight.diagnostics`: 마지막 실제 editor probe 상세

---

## Direct Publish CAPTCHA State

직접 발행(`WRITE_POST`)이 `captcha_required`로 멈추면 서비스워커가 `directPublishState`를 저장합니다.

저장 필드:
- `tabId`: CAPTCHA가 떠 있는 실제 에디터 탭
- `blogName`: 재개에 사용할 블로그명
- `url`: 막힌 탭 URL
- `visibility`: 마지막 발행 가시성 값
- `requestData`: 재개 시 재주입할 제목/본문/카테고리/태그/이미지 payload
- `detectedAt` / `updatedAt`: 상태 기록 시각
- `diagnostics`: 마지막 에디터 준비 로그
- `captchaContext`: 화면 판독용 캡차 후보 요소 / iframe / 버튼 텍스트 / rect
- `lastCaptchaSubmitResult`: 마지막 `SUBMIT_CAPTCHA` 시도 결과 요약
- `lastCaptchaArtifactCapture`: 마지막 `GET_CAPTCHA_ARTIFACTS` 시도 결과 요약
- `lastCaptchaWait`: 마지막 `RESUME_DIRECT_PUBLISH(waitForCaptcha)` 대기 결과 요약
- `lastDraftRestore`: 마지막 draft snapshot 점검/복구 결과 요약

이 상태 덕분에 외부 에이전트/크론은 새 탭을 다시 고르지 않고, **막힌 동일 탭**을 기준으로 캡차 이미지를 가져오고 `SUBMIT_CAPTCHA_AND_RESUME`를 바로 호출할 수 있습니다. v1.8.0부터는 cross-origin iframe도 `frameDirectImage` + same-tab frame submit 경로를 우선 시도하며, frame solve가 막힌 예외 케이스에서만 `browser_handoff` + `RESUME_DIRECT_PUBLISH({ waitForCaptcha: true })` fallback을 사용합니다. 또한 초기 `captcha_required` 응답과 `GET_DIRECT_PUBLISH_STATE(includeCaptchaContext: true)`는 서비스워커가 main DOM + frame scan 결과를 merge한 `captchaContext`를 반환하므로, 자동화는 raw iframe 감지값 대신 이 `preferredSolveMode`를 그대로 신뢰하면 됩니다. solve 뒤 iframe 껍데기만 남아 있는 경우에는 이 merged context가 `captchaPresent: false`로 정규화되어 불필요한 wait/resume timeout을 줄입니다. `waitForCaptcha` 모드는 저장된 blocked tab이 `captcha_present` 때문에 일반 editor-ready probe에 실패하더라도 같은 탭을 wait target으로 유지하고, CAPTCHA가 사라진 뒤에만 post-clear probe를 수행합니다. 이때 publish layer가 그대로 열려 있어도 `RESUME_PUBLISH`가 이어서 처리할 수 있는 상태로 간주합니다. handoff 중 일시적인 `editor_not_ready` / frame scan miss는 clear로 보지 않고 saved tab polling을 계속합니다.

v1.8.5부터는 frame submit 직후 iframe reload/navigation 때문에 content-script 응답이 비는 회차도 tab URL과 refreshed `captchaContext`를 다시 읽어 `captcha_submit_tab_navigated` / `captcha_submitted` / `captcha_still_present`로 복구합니다. 특히 `SUBMIT_CAPTCHA_AND_RESUME`는 이 복구 결과가 완료 URL이면 추가 resume을 생략하고 곧바로 성공으로 종료하므로, 이미 발행이 끝난 회차에서 false `content_empty`가 다시 뜨지 않습니다.

v1.8.9 follow-up부터는 same-tab CAPTCHA solve 직후 publish layer가 `저장중/발행중` 상태로 잠깐 남아 있는 회차를 별도 settle 구간으로 관찰합니다. 이 구간에서는 completion URL 감지와 publish-layer progress 텍스트를 함께 보고, TinyMCE/Toast UI/editor shell 같은 비-CAPTCHA DOM을 answer/button 후보에서 제외해 false `captcha_required` 또는 조기 `editor_not_ready` 재개 실패를 줄입니다.

2026-04-13 follow-up부터는 cross-origin frame 안 이미지 export가 tainted canvas로 막혀도, 서비스워커가 `activeCaptureCandidate.sourceUrl`을 직접 fetch해서 `artifacts.sourceImage`를 추가로 만듭니다. 덕분에 `frameDirectImage`가 비는 회차에도 viewport crop 대신 원본 CAPTCHA 이미지를 OCR에 우선 넘길 수 있습니다.

v1.8.10부터는 post-CAPTCHA publish layer가 열린 상태에서 isolated-world TinyMCE snapshot이 0으로 읽혀도, MAIN world editor summary(`GET_EDITOR_SNAPSHOT`)의 html/text/image 길이와 preview를 합산해 false `draft_restore_failed`를 줄입니다. 동시에 content script를 `document_start`에 주입하고 page-world confirm bypass도 함께 깔아, draft restore confirm이 늦게 떠서 재개를 방해하는 회차를 더 이르게 무해화합니다.

v1.8.11부터는 DKAPTCHA frame/main DOM에서 입력창은 잡혔지만 visible submit button이 잠깐 사라진 회차도 `submitApiAvailable`를 함께 노출하고, `window.dkaptcha.submit()`가 callable이면 browser handoff로 내리지 않고 same-tab submit을 계속 시도합니다. 이 덕분에 버튼 렌더 타이밍 race 때문에 `captcha_submit_not_found` / `captcha_frame_submit_not_found`로 끊기던 회차를 줄입니다.

### CAPTCHA Context / Submit 응답 포인트

- `GET_CAPTCHA_CONTEXT`는 `answerInputCandidates[]`, `submitButtonCandidates[]`, `activeAnswerInput`, `activeSubmitButton`, `captureCandidates[]`, `activeCaptureCandidate`, `challengeText`, `challengeSlotCount`, `challengeCandidates[]`, `answerLengthHint`, `rect`, `matchedSelectors`, `iframeCaptchaPresent`, `preferredSolveMode`, `submitApiAvailable`, `solveHints`를 포함합니다.
- `GET_CAPTCHA_ARTIFACTS`는 기본적으로 저장된 `directPublishState.tabId`를 대상으로 `artifact.dataUrl`, `artifact.kind`, `artifacts.sourceImage`, `artifacts.frameDirectImage`, `artifacts.directImage`, `artifacts.viewportCrop`, `selectedCandidate`, `captureContext`를 반환하며, 이 `captureContext`에도 `challengeText` / `challengeSlotCount`가 포함될 수 있습니다.
- `GET_CAPTCHA_ARTIFACTS.artifactPreference`는 외부 에이전트가 우선 사용할 이미지(`sourceImage` / `frameDirectImage` / `viewportCrop` / `directImage`)를 알려줍니다.
- `INFER_CAPTCHA_ANSWER`는 `challengeText` + `ocrTexts[]`를 받아 빈칸 답안을 추론하고, `chosenCandidate` / `candidates[]`로 어떤 OCR 후보가 채택됐는지 돌려줍니다.
- `SUBMIT_CAPTCHA`는 `selectedInput`, `selectedButton`, `buttonText`, `captchaPresentAfterWait`, `captchaStillAppears`, `diagnostics.before/after`, `answerNormalization`, `submitApiAvailable`을 반환합니다. v1.8.0부터는 cross-origin iframe도 우선 frame submit을 시도하고, 그래도 막히면 `captcha_browser_handoff_required`와 `handoff` 힌트를 반환합니다. v1.8.11부터는 visible submit button이 없어도 `dkaptcha.submit()`가 callable이면 같은 탭 submit을 계속 시도합니다.
- frame submit recovery가 발동한 회차는 `submitStrategy: "extension_frame_dom_recovered"`, `recoveredAfterMissingResponse: true`, `recoveredReason`, `postSubmitProbe`를 함께 반환합니다.
- `SUBMIT_CAPTCHA` 기본 대상 탭은 저장된 `directPublishState.tabId`이며, 필요하면 `data.tabId`로 override할 수 있습니다.
- `SUBMIT_CAPTCHA` / `SUBMIT_CAPTCHA_AND_RESUME`는 답안을 `trim`하고 내부 공백을 제거해 OCR 공백 노이즈를 줄입니다. `answer` 없이 `ocrTexts[]`만 넘겨도 saved `captchaContext.challengeText` 기준으로 답안을 먼저 추론할 수 있습니다.
- `SUBMIT_CAPTCHA_AND_RESUME`는 `submitResult` + `resumeResult`를 함께 반환하고, CAPTCHA가 사라졌으면 top-level `success` / `status` / `url`이 재개 결과를 반영합니다. 다만 submit 단계에서 이미 완료 URL로 이동한 `captcha_submit_tab_navigated` 회차는 추가 resume 없이 top-level 성공으로 바로 종료합니다.
- `SUBMIT_CAPTCHA` / `SUBMIT_CAPTCHA_AND_RESUME`는 iframe-only CAPTCHA에서도 우선 same-tab frame submit을 시도하고, 막히면 응답에 `captchaArtifacts`를 함께 실어 browser/CDP fallback으로 바로 이어지게 합니다.
- `RESUME_DIRECT_PUBLISH`는 `data.waitForCaptcha`, `data.waitTimeoutMs`, `data.pollIntervalMs`를 지원하며, wait 모드일 때 응답의 `captchaWait`에 대기 결과를 포함합니다. 이 wait는 저장된 blocked tab을 우선 유지하고, CAPTCHA 해제 뒤 same-tab post-clear probe를 거쳐 재개합니다. handoff 중 일시적인 `editor_not_ready` / frame scan miss는 clear로 취급하지 않습니다.
- `SUBMIT_CAPTCHA.status`
  - `captcha_submit_tab_navigated`: frame submit 직후 이미 `/manage/posts` 또는 permalink로 이동해 제출 단계에서 성공이 확정됨
  - `captcha_submitted`: 답안 입력 + 클릭 수행 후 짧은 대기 뒤 visible CAPTCHA가 더 이상 감지되지 않음
  - `captcha_still_present`: 답안 입력 + 클릭은 수행했지만 CAPTCHA가 계속 보임
  - `captcha_browser_handoff_required`: cross-origin iframe에서도 extension-frame solve가 막혀 browser/CDP same-tab fallback이 필요함
  - `captcha_answer_required` / `captcha_input_not_found` / `captcha_submit_not_found` / `captcha_input_not_applied`: 제출 전 실패 원인

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
| `GET_DIRECT_PUBLISH_STATE` | 저장된 direct publish CAPTCHA state 조회 (`includeCaptchaContext` 옵션 지원) |
| `GET_CAPTCHA_CONTEXT` | 저장된 direct publish 탭 또는 지정 탭(`data.tabId`)의 CAPTCHA context 조회 |
| `GET_CAPTCHA_ARTIFACTS` | 저장된 direct publish 탭 또는 지정 탭(`data.tabId`)의 CAPTCHA 이미지 아티팩트 조회 |
| `INFER_CAPTCHA_ANSWER` | `challengeText` + `ocrTexts[]` 또는 saved `captchaContext` 기준으로 CAPTCHA 빈칸 답안 추론 |
| `SUBMIT_CAPTCHA_AND_RESUME` | 저장된 direct publish 탭 또는 지정 탭(`data.tabId`)에 CAPTCHA 답안을 제출하고 같은 탭에서 즉시 직접 발행 재개 (`answer` 또는 `ocrTexts[]`) |
| `SUBMIT_CAPTCHA` | 저장된 direct publish 탭 또는 지정 탭(`data.tabId`)에 CAPTCHA 답안 입력 + 확인 버튼 클릭 (`answer` 또는 `ocrTexts[]`) |
| `RESUME_DIRECT_PUBLISH` | CAPTCHA 해결 후 또는 direct publish 최종 확인 단계 후 직접 발행 재개 (saved blocked tab 우선, `waitForCaptcha`/`waitTimeoutMs`/`pollIntervalMs` 지원). v1.8.30부터 저장된 상태가 `phase: "publish_confirmation"`이면 같은 탭 confirmation preflight 후 안전할 때만 final confirm 재시도 |
| `RESUME_AFTER_CAPTCHA` | CAPTCHA 해결 후 큐 항목 재개 (`data.id` 권장, 단일 paused 항목이면 자동 선택 가능) |
| `RESUME_AFTER_PUBLISH_CONFIRMATION` | `publish_confirm_paused` 큐 항목을 같은 탭 최종 확인 레이어에서 재개 (`data.id` 또는 `data.tabId`; 여러 paused 항목이면 필수). 재개 직전 현재 확인 레이어 상태를 다시 probe해 안전하지 않으면 fail-closed |
| `RETRY_ITEM` | 큐 항목 처음부터 재시도 (`data.id` 필요) |
| `ADD_TO_QUEUE` | 큐에 추가 |
| `START_QUEUE` | 큐 처리 시작 |
| `GET_QUEUE` | 큐 상태 조회 |
| `REMOVE_FROM_QUEUE` | 큐 항목 삭제 |
| `CLEAR_QUEUE` | 큐 초기화 |
| `GET_PAGE_INFO` | 페이지 정보 조회 |
| `GET_DRAFT_SNAPSHOT` | 현재 탭의 제목/본문/카테고리/태그/이미지 스냅샷 조회 |
| `CHECK_CAPTCHA` | CAPTCHA 표시 여부 확인 |

---

## 알려진 한계 및 잔여 리스크

- **verification_failed 오탐**: Tistory가 발행 후 URL을 변경하지 않는 경우 발행이 성공했음에도 실패로 기록될 수 있습니다. 관리자 페이지(`/manage/posts`)에서 직접 확인하세요.
- **CAPTCHA 중 탭 닫힘**: 같은 탭이 살아 있으면 재개 전에 draft self-heal을 시도하지만, 탭을 닫아버리면 저장되지 않은 내용은 복구 불가합니다.
- **셀렉터 변경**: 티스토리 에디터 업데이트 시 `content/selectors.js` 수정이 필요할 수 있습니다.
- **OCR 자체는 외부 책임**: 확장 프로그램은 `GET_CAPTCHA_ARTIFACTS`/`captchaArtifacts`로 이미지 아티팩트를 제공하고, `challengeText` / `challengeSlotCount` / `INFER_CAPTCHA_ANSWER`로 빈칸 답안 축약까지 도와주지만, 원본 이미지에서 전체 후보 텍스트를 읽는 OCR/비전 단계 자체는 외부 에이전트/서비스가 수행해야 합니다.
- **tainted canvas iframe은 여전히 challengeText가 비어 있을 수 있음**: 이번 패치로 same challenge retry는 visual signature로 더 안정화됐지만, `frame_direct_image`가 tainted canvas로 막히고 `challengeText`/`answerCandidates`까지 비면 전체 단어 OCR 단계는 여전히 외부 보강이 필요합니다.
- **cross-origin iframe 입력도 기본은 확장 same-tab solve**: v1.8.0부터는 `chrome.scripting.executeScript(allFrames)`로 iframe 내부 이미지/입력창/버튼을 직접 다루고, 이 경로가 막힌 예외 케이스에서만 `captcha_browser_handoff_required` + `preferredSolveMode: "browser_handoff"` fallback을 사용합니다.
- **viewport crop는 Chrome capture 권한 상태에 영향받을 수 있음**: 이 경우에도 Tistory DKAPTCHA가 실제 이미지 요소면 `artifacts.directImage` 또는 `artifacts.sourceImage`가 남을 수 있습니다.
