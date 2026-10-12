# 미팅 노트 (meeting-stt) 웹 앱 — 레퍼런스 UI/클라이언트 사양서

> 원본: Vite 프로덕션 번들(`index-1Qjul4Ap.js`, 앱 코드는 prettified 기준 15993~19350행)과 `index.css`(23KB)를 역분석해 작성.
> 코드 식별자는 영문 그대로, 화면 문자열은 **원문 그대로** 인용한다. 번들의 난독화된 변수명 대신 역할 기반 이름(예: `MeetingDetail`)을 사용하고, 필요한 곳에는 번들 내 식별자를 괄호로 병기했다.
> 동반 파일: `docs/reference.css` (원본 스타일시트 그대로 복사).

---

## 0. 한눈에 보기

| 항목 | 내용 |
|---|---|
| 스택 | React 18 (StrictMode) + react-oidc-context / oidc-client-ts + Vite. 노트 편집기는 BlockNote 기반 별도 청크(`NoteEditor-*.js/.css`)를 `React.lazy`로 지연 로드 |
| 인증 | Amazon Cognito Hosted UI (Authorization Code + PKCE). 앱 자체 로그인 폼 없음. 첫 로그인 임시 비밀번호 변경은 Cognito Hosted UI가 처리 |
| 라우팅 | **URL 라우팅 없음.** 모든 화면 전환은 React state. 유일한 URL 조작은 OIDC 콜백 뒤 `history.replaceState`로 `?code&state` 제거 |
| 백엔드 | 동일 오리진 `/api/*` JSON API. 헤더 `X-Id-Token`(Cognito id_token) + `x-amz-content-sha256` |
| 시간대 | 모든 날짜 계산은 `Asia/Seoul` 고정(`+09:00`). 서버와는 UTC ISO 문자열로 교환 |
| 로컬 저장 | IndexedDB `meeting-stt`(v2): `recording-sessions`, `recording-chunks`. localStorage는 oidc 사용자 저장(`oidc.user:…`)에만 사용 |
| 녹음 | `MediaRecorder`, 5초 timeslice로 chunk를 IndexedDB에 즉시 저장. 종료 시 Blob 조립 → presigned PUT 업로드 |
| 폴링 | 미완료(DONE/FAILED 아님) 회의가 하나라도 있으면 8초 간격으로 `/meetings` 재조회 |
| 테마 | 다크 테마 단일(라이트 모드 없음). 반응형 브레이크포인트 900px, 700px |

---

## 1. 앱 셸 & 부트스트랩

### 1.1 부트스트랩 순서 (`main`)

1. `fetch("/config.json", { cache: "no-store" })` → 실패 시 `Error("Could not load /config.json (status)")` throw (top-level await, 앱 전체 중단).
2. config 필드(클라이언트가 읽는 것): `cognitoAuthority`, `clientId`, `redirectUri`, `cognitoDomain`.
3. `AuthProvider` 설정:
   ```js
   {
     authority: config.cognitoAuthority,
     client_id: config.clientId,
     redirect_uri: config.redirectUri,
     post_logout_redirect_uri: config.redirectUri,
     response_type: "code",
     scope: "openid email profile",
     userStore: new WebStorageStateStore({ store: window.localStorage }),
     onSigninCallback: () => window.history.replaceState({}, document.title, window.location.pathname),
   }
   ```
4. `createRoot(#root).render(<StrictMode><AuthProvider …><App config={config}/></AuthProvider></StrictMode>)`.

### 1.2 인증 상태별 루트 화면 (`App`)

| 상태 | 렌더 |
|---|---|
| `auth.isLoading` | `<div class="center">로그인 확인 중…</div>` |
| `auth.error` | `.center` 안에 `<p>인증 오류: {error.message}</p>` + `<button class="primary">다시 로그인</button>` → `auth.signinRedirect()` |
| 미인증 | 랜딩(§2.1) |
| 인증됨 | 앱 셸(§1.3) |

id_token 공급: `useEffect(() => setTokenGetter(() => auth.user?.id_token), [auth.user])` — API 클라이언트가 매 요청 시 호출.

### 1.3 앱 셸 레이아웃

```
┌─ header.topbar ──────────────────────────────────────────────────────────────┐
│ [📝 미팅 노트]  [● 녹음 시작][파일 업로드] 끌어다 놓기도 됩니다   [캘린더] [⋯] │
├──────────────────────────────────────────────────────────────────────────────┤
│ (.alert.error 전역 오류)                                      [닫기]         │
│ (.pending 업로드되지 않은 녹음 N건 …)                                        │
│ (section.calendar-drawer — 열렸을 때만)                                      │
├──────────────────────┬───────────────────────────────────────────────────────┤
│ .mlist (320px)       │ section.reader                                        │
│  [회의 검색]         │   ├ AdminPanel (관리자 & 열림)                        │
│  오늘                │   ├ MeetingDetail (선택된 회의)                       │
│   09:30 12분 회의… │   ├ "불러오는 중…" (.empty, 초기 로딩)                │
│  어제                │   └ 빈 상태 "첫 회의를 기록해 보세요"                 │
│   …                  │                                                       │
└──────────────────────┴───────────────────────────────────────────────────────┘
```

- `.app`: `display:flex; flex-direction:column; height:100vh; overflow:hidden`.
- `.main`: `grid-template-columns: minmax(0,320px) minmax(0,1fr)`; 900px 이하에서는 1열(`grid-template-rows:auto minmax(0,1fr)`), `.mlist`는 `max-height:210px`로 상단에 쌓임.
- 900px 이하: `.topbar{flex-wrap:wrap}`, `.capture{order:3;width:100%}`(캡처 패널이 둘째 줄로 내려감), `.topbar-right{order:2}`.

### 1.4 App 상태 (모두 React state, URL 미반영)

| state | 초기값 | 의미 |
|---|---|---|
| `meetings: Meeting[]` | `[]` | `/meetings` 결과 |
| `selectedId?: string` | undefined | 선택 회의 meetingId |
| `query: string` | `""` | 목록 검색어 |
| `session?: Session` | undefined | `/session` 결과 |
| `error?: string` | undefined | 전역 오류 배너 |
| `loading: boolean` | true | 첫 `/meetings` 완료 전 |
| `pendingReloadKey: number` | 0 | 증가하면 PendingRecordings 재조회 |
| `activeSessionId?: string` | undefined | 녹음 중인 IndexedDB 세션 id(펜딩 목록에서 제외) |
| `adminOpen` | false | 사용자 관리 패널 |
| `menuOpen` | false | 우상단 메뉴 |
| `pwOpen` | false | 비밀번호 변경 모달 |
| `calOpen` | false | 캘린더 드로어 |
| `view: "day"\|"week"\|"month"` | `"week"` | 캘린더 뷰 |
| `anchor: "YYYY-MM-DD"` | `todayKey()` | 캘린더 기준 날짜(KST) |

### 1.5 데이터 로딩/폴링

- `loadMeetings()`: `GET /meetings?from=<now-180d ISO>&to=<now+7d ISO>` (`LOOKBACK_DAYS=180`). 결과는 `stableMerge(prev, next)`: `meetingId`가 같고 `JSON.stringify`가 동일하면 이전 객체 참조를 유지(불필요한 리렌더 방지). 길이가 달라지거나 하나라도 바뀌면 새 배열.
- 최초 마운트 및 `auth.isAuthenticated` 변경 시 호출. 완료 시 `loading=false`.
- 인증되면 `GET /session` 1회 → `session`.
- `hasActive = meetings.some(m => !isTerminal(m.status))` 이면 `setInterval(loadMeetings, 8000)`.
- `sortedDesc = [...meetings].sort((a,b)=>b.startUtc.localeCompare(a.startUtc))`; `selectedId`가 없고 회의가 있으면 자동으로 최신 회의 선택.
- 선택 회의 `selected = meetings.find(m => m.meetingId === selectedId)`.

### 1.6 전역 키보드

- `Escape`: 우선순위 `pwOpen → adminOpen → menuOpen → calOpen` 중 첫 번째 열린 것 하나만 닫음.
- 제목 인라인 편집 input: `Enter` 저장, `Escape` 취소(§2.8).
- 녹음/일시정지 중 `beforeunload`에 `preventDefault` → 브라우저 이탈 확인 다이얼로그.

---

## 2. 화면/컴포넌트 상세

### 2.1 랜딩(미인증)

```
          📝        (.logo.big 44px)
       미팅 노트     (h1)
 회의를 녹음하면 전사하고 미팅노트를 만들어 드립니다.  (p.muted, max-width 400px)
        [ 로그인 ]  (button.primary.big)
```
- `div.center.landing`. 로그인 → `auth.signinRedirect()` (Cognito Hosted UI로 이동).
- 콜백: Hosted UI가 `redirectUri?code=…&state=…`로 돌려보내면 react-oidc-context가 토큰 교환 → `onSigninCallback`이 쿼리 제거. 별도 콜백 화면 없음(그 동안 "로그인 확인 중…" 표시).
- 첫 로그인(FORCE_CHANGE_PASSWORD) 비밀번호 변경은 Hosted UI 화면. 앱 내에는 없음.

### 2.2 상단바 (`header.topbar`)

| 영역 | 요소 | 비고 |
|---|---|---|
| `.brand` | `<span class="logo">📝</span><strong>미팅 노트</strong>` | |
| `Capture` | §2.5 | `flex:1` |
| `.topbar-right` | `<button class="ghost {on}">캘린더</button>` title `"날짜로 찾아보기"` | 클릭: 열려 있으면 닫기; 닫혀 있으면 `anchor = dateKey(최신 회의.startUtc)`(회의 있을 때)로 설정 후 열기 |
| | `.menu-wrap` > `<button class="ghost icon" aria-label="메뉴" aria-expanded>⋯</button>` | §2.3 |

### 2.3 사용자 메뉴 (`.menu`)

```
┌────────────────────────┐
│ user@example.com       │ strong
│ platform 팀과 공유      │ .muted.small  (isPersonal → "개인 · 공유되지 않음")
├────────────────────────┤
│ 비밀번호 변경           │
│ 사용자 관리 [닫기]      │ isAdmin만. 열려 있으면 "사용자 관리 닫기", class .on
│ 로그아웃                │
└────────────────────────┘
```
- `.menu-backdrop`(fixed, z 40) 클릭으로 닫힘. `.menu`는 `position:absolute; right:0; top:calc(100%+6px); min-width:220px; z 41`.
- 두 번째 줄 문자열: `session.isPersonal ? "개인 · 공유되지 않음" : \`${session.teams.join(", ")} 팀과 공유\``.
- 로그아웃: `auth.removeUser()` 후 `window.location.href = \`${config.cognitoDomain}/logout?client_id=${config.clientId}&logout_uri=${config.redirectUri}\``.

### 2.4 전역 오류 배너

`error`가 있으면 `.pending` 위에 `<div class="alert error"><span>{error}</span><button class="ghost small">닫기</button></div>`. Capture의 `onError`, `/meetings` 실패 메시지가 여기로 모임.

### 2.5 캡처 패널 (`Capture`, `.capture`)

상태 머신 `phase: "idle" | "recording" | "paused" | "uploading"`.

**idle:**
```
[● 녹음 시작] [파일 업로드]  끌어다 놓기도 됩니다
```
- 녹음 미지원(`!(MediaRecorder && navigator.mediaDevices.getUserMedia)`)이면 녹음 버튼 대신 `<span class="hint" title="HTTPS와 MediaRecorder 지원이 필요합니다">이 브라우저에서는 녹음을 쓸 수 없습니다</span>`.
- 숨김 `<input type="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav,.mp4,.webm,.ogg,.flac" hidden>`; 선택 후 `input.value=""`로 초기화(같은 파일 재선택 허용).
- `.capture-main`에 `onDragOver(preventDefault, dragging=true)`, `onDragLeave`, `onDrop(첫 파일만)`. 드래그 중 `.capture.dragging` → `outline:2px dashed var(--accent)`.

**recording / paused (`.rec-live`, 빨간 테두리 pill):**
```
(●) 12:34 [일시정지|계속] [종료 후 전사] [중단]
```
- `.rec-dot.on`(recording일 때만 pulse 애니메이션), `.rec-time` = `fmtClock(elapsedSec)` 200ms마다 갱신.
- `일시정지` → `recorder.pause()`, phase=paused. `계속` → `resume()`.
- `종료 후 전사`(primary small) → §3.4 업로드 흐름.
- `중단`(ghost small, title `"녹음을 멈추고 보관합니다 (삭제하지 않음)"`) → `recorder.abandon()`; IndexedDB 데이터는 남아 펜딩 목록에 `녹음 중 중단됨`으로 표시.

**uploading / 진행률:**
`.progress > .bar(width %) + <span>{pct}%</span>`; 진행률 undefined면 `"처리 중…"`.

**파일 선택 후 폼 (`.capture-form`, 상단바 아래 중앙 팝오버, `top:56px; width:min(460px, 100vw-32px)`; 900px 이하 좌우 16px 꽉 채움):**
```
┌──────────────────────────────────────────────┐
│ recording.m4a                      12.3 MB   │ .cf-file
│ 회의 시작 일시 *  [2026-10-11T09:00      ]   │ datetime-local, required
│ 길이는 파일에서 읽어 종료 시각을 계산합니다. 녹음 시각이 파일에 들어 있으면 (아이폰 음성 메모 등) 그 값을 우선합니다. │ .cf-hint
│ 회의명           [비워 두면 전사 후 자동 생성 ] │
│ 참석자           [쉼표로 구분 — 화자 이름 추정에 사용됩니다] │
│ [업로드] [취소]                              │ .cf-actions
└──────────────────────────────────────────────┘
```
- 파일 크기: `(size/1024/1024).toFixed(1) + " MB"`.
- 시작 일시 기본값: `` `${anchorDay}T09:00` `` (anchorDay = 캘린더 anchor, 기본 오늘).
- `업로드` 검증: `parseLocalInput(startInput)` 실패 → 오류 `"회의 시작 일시를 입력해 주세요."`.
- 전송 메타: `{ startUtc, timeSource: "user", title: title.trim() || undefined, attendees: split(",").map(trim).filter(Boolean) }`.
- 취소 → 폼 닫고 모든 필드 초기화.

### 2.6 업로드되지 않은 녹음 (`PendingRecordings`, `.pending`)

표시 조건: IndexedDB에 2048바이트 이상이고 현재 녹음 중이 아닌 세션이 1개 이상. 없으면 `null`.

```
┌ .pending (노란 테두리) ─────────────────────────────────────────────┐
│ 업로드되지 않은 녹음 2건  이 브라우저에만 저장되어 있습니다. 업로드하면 전사가 시작됩니다. │
│ (.alert.error 오류)                                                 │
│ ── .pending-row ─────────────────────────────────────────────────── │
│ 2026. 10. 11. 14:05            [업로드] [파일로 저장] [삭제]         │
│ 12:34 · 5.1 MB · 녹음 중 중단됨                                     │
│ 업로드 실패: Upload failed (403): …          (.pr-error)            │
└─────────────────────────────────────────────────────────────────────┘
```
- 행 1: `fmtDateTime(startedAtUtc)`; 행 2: `fmtClock(durationSec) · fmtBytes(bytes)` + (`state==="recording"` → `" · 녹음 중 중단됨"`).
- `lastError`가 `"세션 정보가"`로 시작하면 그대로, 아니면 `"업로드 실패: " + lastError`.
- `fmtBytes`: `<1MB → "{round(KB)} KB"`, else `"{x.x} MB"`.
- 업로드 중인 행은 액션 대신 `.progress.small-bar` 표시; 다른 행 버튼 `disabled`.
- `업로드` → §3.4 (timeSource `"recorder"`). `파일로 저장` → Blob 조립 → `URL.createObjectURL` → `<a download="{filename}">.click()`. `삭제` → `confirm(\`이 녹음(${fmtBytes(bytes)})을 완전히 삭제할까요? 복구할 수 없습니다.\`)`.
- 저장소 읽기 실패: `"이 브라우저의 녹음 저장소를 읽지 못했습니다. 서버에 저장된 회의는 정상입니다."`.
- 재조회 트리거: `reloadKey` 변경(녹음 시작/종료/중단, 업로드 완료), `activeSessionId` 변경.

### 2.7 캘린더 드로어 (`section.calendar-drawer`)

```
┌ .cd-head ───────────────────────────────────────────────────┐
│ [‹]  2026년 10월 5일 – 11일  [›] [오늘]  [일|주|월]   [닫기] │
├─────────────────────────────────────────────────────────────┤
│ MonthView (view==="month") 또는 TimeGrid (day/week)         │
└─────────────────────────────────────────────────────────────┘
```
- `‹` aria-label `"이전"`, `›` aria-label `"다음"` → `shift(view, anchor, ∓1)`. `오늘` → `anchor = todayKey()`. `.viewswitch` 버튼 라벨 `{day:"일", week:"주", month:"월"}`, 활성 `.on`. `닫기`(`.cd-close`, `margin-left:auto`).
- 제목 `rangeTitle(view, anchor)`:
  - month: `"{Y}년 {M}월"`
  - day: `"{Y}년 {M}월 {D}일 ({요일 short ko})"` 예 `2026년 10월 11일 (토)`
  - week: 같은 달 `"{Y}년 {M}월 {D1}일 – {D7}일"`, 달이 다르면 `"{Y}년 {M1}월 {D1}일 – {M2}월 {D7}일"` (en dash `–`)
- 드로어에 표시되는 회의는 `rangeFor(view, anchor)`의 `[fromUtc, toUtc)`로 필터.
- 회의 클릭 → `selectedId` 설정(드로어는 열린 채 유지).

#### 2.7.1 월 뷰 (`MonthView`, `.month`)

- `.month-head`: 7개 `.dow.w{0..6}` = `일 월 화 수 목 금 토` (w0 빨강 `#ff8880`, w6 파랑 `#7fbcff`).
- `.month-body`: 42칸(`monthGrid`), 각 `.cell` 클래스: `out`(다른 달, opacity .3), `today`(inset 2px accent 테두리), `weekend`.
- 칸 안: `<button class="cell-date" title="이 날짜 보기">{dayOfMonth}</button>` → `onOpenDay(key)` = `anchor=key; view="day"`.
- 회의 chip 최대 **4개**(`MAX_CHIPS=4`), 날짜별 `startUtc` 오름차순. `<button class="chip s-{status lower} {sel}" title="{HH:mm} {title}">` 내부 `.chip-time`(HH:mm) `.chip-title`(`title ?? "(제목 생성 중)"`) + DONE이 아니면 compact 배지.
- 초과분: `<button class="chip more">+{n}건 더</button>` → `onOpenDay`.

#### 2.7.2 주/일 뷰 (`TimeGrid`, `.timegrid[.single]`)

상수: `HOUR_PX=48`, `DEFAULT_START_HOUR=8`, `MIN_BLOCK_MIN=24`.
```
┌ .tg-head ────────────────────────────────┐
│ [gutter] 일 5 │ 월 6 │ … │ 토 11(today)  │   .tg-day-head > .dow.w{n} + .dnum
├ .tg-body (max-height 360px, scroll) ─────┤
│ 01:00 ┆──────┆──────┆                    │   .tg-hour-label (00:00은 비움)
│ …     ┆ ▌09:30 주간회의 ┆                │   .tg-block (absolute)
│       ┆  ━━━━ now line ━━━━              │   .tg-now (오늘 열에만)
└──────────────────────────────────────────┘
```
- `.tg-inner` 높이 `24*48=1152px`. 각 열 24개 `.tg-slot`(48px).
- 블록 레이아웃 `layoutDay(meetings, dayKey)`: start=`max(startUtc, dayStart)`, end=`min(max(start+durationSec, start+1분), dayEnd)`, `heightMin = max(end-start, 24)`. topMin 순 정렬 뒤 겹치는 블록들을 클러스터로 묶고 greedy column 배정 → `left: calc(col/cols*100% + 2px)`, `width: calc(100%/cols - 4px)`, `top: topMin/60*48px`, `height: heightMin/60*48px`.
- 초기 스크롤: `scrollTop = max(0, ((earliestMinuteOfAnyMeeting ?? 8*60) - 30)/60 * 48)`.
- 현재 시각 선: 오늘 열에 `top = minutesIntoDay(now)/60*48`.
- 블록 내용: `.tg-block-time`(HH:mm) `.tg-block-title`(`title ?? "(제목 생성 중)"`) + compact 배지(DONE 아님). `title` 속성 `"{HH:mm} {title}"`.
- 일 뷰(`days.length===1`)는 `.timegrid.single` → 요일/날짜 헤더를 가로 배치.

### 2.8 회의 목록 (`MeetingList`, `.mlist`)

```
┌ .mlist-search ──────────────┐
│ [🔍 회의 검색              ] │  input[type=search] placeholder/aria-label "회의 검색"
├ .mlist-body (scroll) ───────┤
│ 오늘                        │  .mlist-day (sticky)
│ ▌09:30 45분 [전사 중]       │  .mi-top: .mi-time .mi-dur badge
│ ▌🔒 주간 스탠드업           │  .mi-title (2줄 clamp)
│ ▌  오늘 논의한 핵심 내용은… │  .mi-preview (DONE && notePreview, 90자)
│ 어제                        │
│ 10월 9일 (금)               │
└─────────────────────────────┘
```
- 검색: `q = query.trim().toLowerCase()`; 대상 필드 `title`, `originalFilename`, `notePreview`, `attendees[]` 중 하나라도 `toLowerCase().includes(q)`.
- 정렬: `startUtc` 내림차순. 그룹: `dateKey(startUtc)` 기준, 등장 순서 유지.
- 그룹 라벨 `dayLabel(key)`: 오늘 → `"오늘"`, 어제 → `"어제"`, 그 외 `"{M}월 {D}일 ({요일})"`.
- 빈 상태 `.muted.mlist-empty`: 검색어 있으면 `"검색 결과가 없습니다."`, 없으면 `"아직 회의가 없습니다."`.
- 항목 `<button class="mlist-item {sel} s-{status lower}">`:
  - `.mi-time` = `fmtTime(startUtc)`; `durationSec`가 있으면 `.mi-dur` = `fmtDuration`; `status!=="DONE"`이면 `<Badge>`.
  - `.mi-title`: `teamId?.startsWith("personal-")`이면 `<span class="mi-lock" title="나만 볼 수 있습니다">🔒 </span>` 앞에 붙임; 텍스트 `title ?? originalFilename ?? "제목 없음"`.
  - `.mi-preview`: `status==="DONE" && notePreview` → `notePreview.replace(/[#*|\`\-]/g," ").replace(/\s+/g," ").trim().slice(0,90)`.
- 왼쪽 3px 보더 색: sel → accent, `.s-done` 초록 50%, `.s-failed` 빨강, `.s-transcribing/.s-summarizing/.s-pending_upload` 노랑 (CSS에 `s-refining`, `s-uploaded`는 정의되지 않아 투명).

### 2.9 리더 영역 빈 상태 (`.empty`)

- 로딩 중: `<div class="empty">불러오는 중…</div>`
- 회의 없음:
  ```
  첫 회의를 기록해 보세요                                   (h2)
  위의 **녹음 시작**을 누르면 회의를 녹음하고, 끝나면 전사문과 미팅노트를 자동으로 만들어 드립니다.  (p.muted)
  이미 녹음한 파일이 있다면 **파일 업로드**를 쓰세요.         (p.muted.small)
  ```

### 2.10 회의 상세 (`MeetingDetail`, `.panel`, `React.memo`)

props: `meeting`, `showOwner = !session.isPersonal`, `session`, `onChanged = loadMeetings`, `onClose = () => selectedId=undefined`.

파생값:
- `teams = meeting.teams?.length ? meeting.teams : meeting.teamId ? [meeting.teamId] : []`
- `isPrivate = teams.some(t => t.startsWith("personal-"))`, `sharedTeams = teams.filter(!personal-)`
- `canEdit = !!session && (meeting.ownerEmail === session.email || session.isAdmin)`
- 리셋 키: `meetingId + title + startUtc + attendees + JSON(speakerMap) + teams` 가 바뀌면 로컬 state(note/turns/error/editForm/editingNote/scopePick/titleEditing, speakerMap 입력값, 제목·시작·참석자 입력값, 선택 팀) 모두 초기화.
- 데이터 지연 로드: `status==="DONE"`일 때만, `tab==="note" && note===undefined` → `GET note`; `tab==="transcript" && turns===undefined` → `GET turns`. 404는 무시(빈 상태 유지), 그 외 오류는 `error`.

```
┌ header.panel-head ───────────────────────────────────────────────────────┐
│ h2.title-editable "주간 스탠드업"  (클릭→input.title-input)        [✕]   │ .ph-row
│ [완료] 2026. 10. 11. 09:30  45분  파일 메타데이터 기준  직접 수정됨        │ .meta
│ 참석자: 김철수, 이영희                                                   │ .meta
│ 올린 사람: owner@example.com                (showOwner && ownerEmail)    │ .meta
│ 👥 platform  👥 design  [공유 범위 변경]                                 │ .meta.scope-row
│   └ .scope-pick (열렸을 때)                                             │
├──────────────────────────────────────────────────────────────────────────┤
│ .alert.error failureReason (FAILED)  / .alert.error error                │
│ .edit-form (일정 토글)                                                   │
│ ▸ 화자 이름 지정 (3명)   (details.speakers)                              │
│ [미팅노트][전사문][복사]            [노트 수정][일정][노트 재생성][삭제]  │ .tabs
│ .content                                                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

**제목 인라인 편집**
- `<h2 class="title-editable" title="클릭하면 제목을 바꿉니다">{title ?? originalFilename ?? "녹음"}</h2>` 클릭 → `<input class="title-input" autoFocus aria-label="회의 제목">` (초기값 `title ?? originalFilename ?? ""`).
- `Enter`/blur → `commitTitle()`: trim 후 비었거나 기존과 같으면 되돌림; 아니면 `PATCH /meetings/{id} {title}` 후 `onChanged()`. `Escape` → 되돌리고 종료.
- 닫기 `<button class="ghost icon" aria-label="닫기">✕</button>`.

**메타 행**
- `<Badge status>`; `fmtDateTime(startUtc)`; `durationSec` → `fmtDuration`.
- `timeSource` → `<span class="hint" title={TIME_SOURCE_HINT[ts]}>{TIME_SOURCE_LABEL[ts]}</span>`:

| timeSource | 라벨 | title |
|---|---|---|
| `mvhd` | 파일 메타데이터 기준 | 녹음 파일 내부 메타데이터에서 읽은 실제 녹음 시각 |
| `user` | 직접 입력 | 직접 입력한 시각 |
| `recorder` | 녹음 시각 | 브라우저 녹음 시작 시각 |
| `upload` | 업로드 시각 추정 | 업로드 시각에서 역산한 추정치 |

- `noteEditedAt` → `<span class="hint" title="{fmtDateTime(noteEditedAt)}에 직접 수정">직접 수정됨</span>`.
- `attendees?.length` → `"참석자: " + attendees.join(", ")`.
- `showOwner && ownerEmail` → `"올린 사람: " + ownerEmail`.

**공유 범위 (`.scope-row`)**
- `isPrivate` → `<span class="scope private" title="나만 볼 수 있습니다">🔒 나만 보기</span>`; 아니면 팀별 `<span class="scope shared" title="{team} 팀원 모두가 볼 수 있습니다">👥 {team}</span>`.
- `canEdit`이면 `<button class="ghost small">공유 범위 변경</button>` → `.scope-pick` 인라인 패널:
  ```
  공유할 팀을 고르세요. 여러 팀을 선택하면 모두의 캘린더에 나타납니다.   (p.muted.small)
  [x] 👥 platform 팀 전체          (session.teams 각각 checkbox)
  [ ] 👥 design 팀 전체
  ─────────────────────────
  ( ) 🔒 나만 보기 (공유 안 함)     (radio, 선택 팀이 0개일 때 checked; 클릭 시 모두 해제)
  [적용] [취소]
  ```
  - 적용 → `PATCH {teams: selected.length ? selected : ["personal"]}` → 닫고 `onChanged()`.

**편집 폼 (`.edit-form`, 탭바 `일정` 버튼으로 토글)**
```
회의명     [                ]
시작 일시  [datetime-local  ]   (초기값 toLocalInput(startUtc))
참석자     [쉼표로 구분      ]   (초기값 attendees.join(", "))
[저장] [취소]
```
- 저장: `parseLocalInput` 실패 → `"시작 일시 형식이 올바르지 않습니다."`; 성공 → `PATCH {title: title.trim(), startUtc, attendees[]}` 후 폼 닫기.

**화자 이름 지정 (`details.speakers`)**, `meeting.speakers?.length`일 때만
- `<summary>화자 이름 지정 ({n}명)</summary>`
- 각 raw speaker별 `<label><span>{speaker}</span><input list="attendee-list" placeholder="실제 이름" value={speakerMap[speaker] ?? ""}></label>`; `<datalist id="attendee-list">`에 `attendees` 옵션.
- `저장` → `POST /meetings/{id}/speakers` body = `{ [rawSpeaker]: displayName }` 전체 맵 → `turns=undefined`(재조회) + `onChanged()`.

**탭바 (`.tabs`)**
| 버튼 | 조건 | 동작 |
|---|---|---|
| `미팅노트` | 항상, `tab==="note"`면 `.on` | tab 전환 |
| `전사문` | 항상 | tab 전환 |
| `복사` (ghost small, title `"전문을 클립보드로 복사"`) | 현재 탭 데이터 로드 전 disabled | note: 마크다운 원문; transcript: `turns.map(t => \`${speakerMap[t.speaker] ?? t.speaker}: ${t.text}\`).join("\n")` → `navigator.clipboard.writeText` |
| `.spacer` | | |
| `노트 수정` | `tab==="note" && note!==undefined && !editing` | `draft=note; editing=true` |
| `일정` | 항상 | edit-form 토글 |
| `노트 재생성` | `status==="DONE"`, busy/editing 시 disabled | `noteEditedAt`이면 `confirm("직접 수정한 노트가 AI 생성 내용으로 덮어써집니다. 계속할까요?")`; `POST regenerate-note` → `note=undefined` + `onChanged()` |
| `삭제` (ghost small danger) | 항상 | `confirm("이 회의를 캘린더에서 삭제할까요?")` → `DELETE` → `onClose()` |

> 참고: 별도의 "정밀 전사" 탭은 없다. 정밀(refined) 여부는 `/turns` 응답의 `refined` 플래그로 전사문 상단 안내문만 바뀐다. 파이프라인 단계명으로는 `정밀 전사`가 존재한다.

**콘텐츠 (`.content`)**
- `status !== "DONE"`: `<Pipeline status>` + (FAILED이면 `failureReason`을 `.muted.small`로, 아니면 `"완료되면 자동으로 표시됩니다."`).
- note 탭: `note===undefined` → `"불러오는 중…"`; `editing` → 노트 편집기(아래); 아니면 `<Markdown source={note}/>`.
- transcript 탭: `turns===undefined` → `"불러오는 중…"`; 아니면 `<Chat turns speakerMap refined/>`.

**노트 편집기 (`.note-editor`)**
```
서식은 자동으로 적용됩니다. `/` 를 입력하면 제목·목록·표를 넣을 수 있습니다.   [저장] [취소]   (.ne-bar)
┌ .bn-wrap (BlockNote, min-height 55vh) ┐
│ …                                      │
└────────────────────────────────────────┘
```
- `저장`(primary small; `saving || !draft.trim()`이면 disabled; 저장 중 라벨 `"저장 중…"`) → `PUT /meetings/{id}/note {note: draft}` → `note=draft; editing=false; onChanged()`.
- `취소` → `draft !== note`면 `confirm("수정한 내용을 버릴까요?")`.
- 편집기는 `React.lazy(() => import("./NoteEditor-*.js")).NoteEditor`, props `{ markdown, onChange }`. Suspense fallback `"편집기를 불러오는 중…"`. CSS 훅 `.bn-wrap .bn-editor` 등은 BlockNote 클래스 오버라이드.

#### 2.10.1 상태 배지 (`Badge`, `.badge`)

| status | 텍스트 | 클래스 | compact 글리프 |
|---|---|---|---|
| `PENDING_UPLOAD` | 업로드 대기 | `pending` | `···` |
| `UPLOADED` | 업로드됨 | `pending` | `···` |
| `TRANSCRIBING` | 전사 중 | `working` | `···` |
| `REFINING` | 정밀 전사 중 | `working` | `···` |
| `SUMMARIZING` | 노트 생성 중 | `working` | `···` |
| `DONE` | 완료 | `done` | `✓` |
| `FAILED` | 실패 | `failed` | `!` |

compact 모드: `<span class="badge {cls} compact" title={text}>`. `isTerminal(s) = s==="DONE" || s==="FAILED"`.

#### 2.10.2 파이프라인 스텝 (`Pipeline`, `.pipe`)

```
 (✓)────────(●)────────( )────────( )
업로드    음성 인식   정밀 전사  보정·노트 작성
        Amazon Transcribe가 화자를 구분하며 전사하고 있습니다.   (.pipe-hint)
```
| key | label | statuses | hint |
|---|---|---|---|
| `upload` | 업로드 | PENDING_UPLOAD, UPLOADED | 녹음 파일을 서버로 보내는 중입니다. |
| `transcribe` | 음성 인식 | TRANSCRIBING | Amazon Transcribe가 화자를 구분하며 전사하고 있습니다. |
| `refine` | 정밀 전사 | REFINING | Qwen3-ASR로 한 번 더 전사해 단어 정확도를 높이고 있습니다. |
| `note` | 보정·노트 작성 | SUMMARIZING | 두 전사문을 대조해 보정하고 미팅노트를 작성하고 있습니다. |

- DONE → 렌더하지 않음. FAILED → `.pipe.failed`, 모든 스텝 `halted`, 힌트 `"처리가 중단되었습니다."`.
- 스텝 클래스: 현재 index 이전 `done`(dot에 `✓`), 현재 `active`(pulse), 이후 `todo`.

#### 2.10.3 채팅형 전사문 (`Chat`, `.chat`)

- 상단 `.chat-note.muted.small`: `refined ? "두 개의 음성인식 결과를 대조해 보정한 전사문입니다." : "음성인식 원문입니다. 보정 전이라 오타가 있을 수 있습니다."`
- 빈 turns → `<p class="muted">전사문이 비어 있습니다.</p>`.
- 그룹화: 연속된 같은 `speaker` 턴을 하나의 `{speaker, startSec(첫 턴), texts[]}`로 묶음.
- 색상: 등장 순서대로 `HUES = [212,152,32,282,4,192,108,328]` 순환. 아바타 배경 `hsl(h 42% 26%)`, 이름 `hsl(h 60% 68%)`, 말풍선 테두리 `hsl(h 34% 30%)`.
- `primary` 화자 = 전체 `text.length` 합이 가장 큰 화자 → `.chat-row.mine`(오른쪽 정렬, 아바타 없음, accent-dim 말풍선).
- 아바타 이니셜 `initial(raw, display)`: 이름이 지정됐으면(`display !== raw`) `display[0]`; 아니면 raw 끝의 숫자(`/(\d+)\s*$/`, 예 `spk_0 → "0"`) 또는 `raw[0].toUpperCase()`.
- 행 구조: `.chat-avatar` → `.chat-body` > `.chat-head`(`.chat-name` 표시명 = `speakerMap[speaker] ?? speaker`, `.chat-time` = `fmtClock(startSec)`) + `texts.map(.chat-bubble)` (`white-space: pre-wrap`).

#### 2.10.4 마크다운 렌더러 (`Markdown`, `.md`)

자체 구현(라이브러리 없음). 지원 범위:
- 인라인: `**굵게**`, `` `코드` ``, `*기울임*`(이스케이프 `\*` 제외). `\_ \* \` \\` 언이스케이프.
- 블록: 빈 줄 무시; `---`/`***` → `<hr>`; `#`~`######` → **레벨+1** 태그(`#`→`h2`, 최대 h6); `|`로 시작하고 다음 줄이 구분선(`/^\|?[\s:-]*-[\s:|-]*\|?$/`)이면 표(`thead` 1행 + `tbody`); `-`, `*`, `N.` 목록(들여쓰기 2칸당 depth 1 → `margin-left: depth*14px`, 숫자면 `ol`); 그 외 연속 줄은 공백으로 이어 `<p>`.

### 2.11 사용자 관리 (`AdminPanel`, `.panel.admin`, max-width 700px)

```
[‹ 회의로 돌아가기]
사용자 관리                                   (h2)
(.alert.error) (.alert.warn)
┌ form.invite ────────────────────────────────┐
│ 사용자 초대                                  │ h3
│ 이메일 [colleague@example.com        ]       │ type=email required
│ 팀     [platform-team                ]       │ list=team-list required
│ [ ] 관리자 권한 부여                         │
│ 같은 팀에 속한 사람은 서로의 회의·전사문·노트를 모두 볼 수 있습니다. 팀 이름을 새로 입력하면 팀이 생성됩니다. │
│ [계정 만들기]                                │
└─────────────────────────────────────────────┘
┌ .handover (초록) ───────────────────────────┐  초대/재발급 직후
│ 계정이 만들어졌습니다. 아래 정보를 본인에게 전달하세요.                          │
│ 임시 비밀번호는 저장되지 않으므로 이 창을 닫으면 다시 볼 수 없습니다. 첫 로그인 때 본인이 새 비밀번호를 정하게 됩니다. 7일 안에 로그인해야 합니다. │
│ 주소          https://…origin                │ code
│ 아이디        user@example.com               │ code
│ 임시 비밀번호  Xk3!…                         │ code.ho-secret
│ [안내문 전체 복사] [닫기]                    │
└─────────────────────────────────────────────┘
사용자 5명                                    (h3)
┌ .user-row ──────────────────────────────────┐
│ user@example.com [관리자] [나] [로그인 대기]  │ .ur-main
│ platform ✕  design ✕  [＋ 팀 추가 ▾] [＋ 새 팀]│ .ur-teams
│ [비밀번호 재발급] [관리자 지정|관리자 해제] [삭제] │ .ur-actions
└─────────────────────────────────────────────┘
```
- 로드: `GET /admin/users` → `users`, `teams`.
- 초대 submit: `teamId = team.trim().toLowerCase()`; 둘 중 하나 비면 `"이메일과 팀을 모두 입력해 주세요."`. `POST /admin/users {email, teamId, asAdmin}` → `handover = {email, password: res.user.temporaryPassword}`; 이메일/체크박스 초기화(팀 입력은 유지).
- 안내문 복사 텍스트(줄바꿈 `\n`):
  ```
  미팅 노트에 초대되었습니다.

  주소: {window.location.origin}
  아이디: {email}
  임시 비밀번호: {password}

  첫 로그인 시 새 비밀번호를 정하게 됩니다. 7일 안에 로그인해 주세요.
  ```
- 사용자 행:
  - 이름 `email ?? username`; `isAdmin` → `<span class="badge done">관리자</span>`; 본인(`email === currentEmail`) → `<span class="badge pending">나</span>`; `status==="FORCE_CHANGE_PASSWORD"` → `<span class="badge working" title="임시 비밀번호로 첫 로그인 대기 중">로그인 대기</span>`.
  - 팀 없음 → `"팀 없음 (개인 회의만 보임)"`; 있으면 `.team-tag` + `<button class="tag-x" title="이 팀에서 제외">✕</button>` → `POST /admin/users/{username}/teams {teamId, remove:true}`.
  - 미소속 팀이 있으면 `<select value="">` 첫 옵션 `"＋ 팀 추가"` → 선택 즉시 `POST teams {teamId}`.
  - `＋ 새 팀`(title `"새 팀을 만들어 이 사용자를 넣습니다"`) → `prompt("만들 팀 이름 (영문 소문자·숫자·하이픈, 2~31자)", "")` → trim+lowercase → `POST teams`.
  - `비밀번호 재발급`(FORCE_CHANGE_PASSWORD만, title `"임시 비밀번호를 다시 발급합니다"`) → `POST reset-password` → handover 갱신.
  - 본인이 아니면: `관리자 지정`/`관리자 해제` → `POST admin {remove: isAdmin}`; `삭제` → `confirm(\`${email ?? username} 계정을 삭제할까요?\`)` → `DELETE`.
  - 모든 액션은 성공 후 목록 재조회 + `onChanged()`(회의 재조회). 진행 중 모든 버튼 disabled.

### 2.12 비밀번호 변경 모달 (`PasswordModal`, `.modal`, aria-label `"비밀번호 변경"`)

```
비밀번호 변경                               [✕]
(.alert.error)
현재 비밀번호      [••••••••]   autocomplete=current-password, autoFocus
새 비밀번호        [••••••••]   autocomplete=new-password
새 비밀번호 확인    [••••••••]
✓ 12자 이상  · 대문자  ✓ 소문자  · 숫자  · 기호      (.pw-rules, 충족 시 .met 초록 + "✓", 아니면 "·")
새 비밀번호가 서로 다릅니다.                          (.pw-error, 확인란 입력 중 불일치)
[변경|변경 중…] [취소]
```
- 규칙: `12자 이상 (len>=12)`, `대문자 /[A-Z]/`, `소문자 /[a-z]/`, `숫자 /\d/`, `기호 /[^A-Za-z0-9]/`.
- 제출 가능 조건: 현재 비밀번호 입력 && 모든 규칙 충족 && 확인 일치 && !busy.
- `POST /password {currentPassword, newPassword}`. 성공 화면: `.pw-done "비밀번호가 변경되었습니다."` + `"지금 로그인된 상태는 그대로 유지됩니다. 다음 로그인부터 새 비밀번호를 쓰세요."` + `[확인]`(닫기).
- `.modal-backdrop` 클릭/✕/취소/Escape로 닫힘.

---

## 3. 클라이언트 로직

### 3.1 시간대/포맷 헬퍼 (모두 KST 고정)

| 함수(역할명) | 번들명 | 구현 |
|---|---|---|
| `TZ_OFFSET` | `og` | `"+09:00"` |
| `TZ` | `el` | `"Asia/Seoul"` |
| `DAY_MS` | `It` | `86_400_000` |
| `pad2` | `Fn` | `String(n).padStart(2,"0")` |
| `dateKey(isoOrMs)` | `kt` | `Intl.DateTimeFormat("en-CA",{timeZone:TZ, year:"numeric",month:"2-digit",day:"2-digit"})` → `"YYYY-MM-DD"` |
| `dayStartMs(key)` | `gt` | `Date.parse(\`${key}T00:00:00+09:00\`)` |
| `minutesIntoDay(iso)` | `Hh` | `(parse(iso) - dayStartMs(dateKey(iso))) / 60000` |
| `fmtTime(iso)` | `ei` | `ko-KR, hour:"2-digit", minute:"2-digit", hour12:false` → `"09:30"` |
| `fmtDateTime(iso)` | `sc` | `ko-KR, dateStyle:"medium", timeStyle:"short", hour12:false` → `"2026. 10. 11. 09:30"` |
| `todayKey()` | `ti` | `dateKey(Date.now())` |
| `toLocalInput(iso)` | `pc` | `sv-SE` 포맷 `"YYYY-MM-DD HH:mm"` → 공백을 `T`로 → datetime-local value |
| `parseLocalInput(str)` | `fg` | `/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/` 매치 → `Date.parse(\`${d}T${hm}${s ?? ":00"}+09:00\`)` → `toISOString()`; 실패 시 undefined |
| `dayInfo(ms, inRange, todayKey)` | `dg` | `{key, dayOfMonth, month, inRange, isToday, weekday}`; weekday는 `new Date(dayStartMs(key)+12h).getUTCDay()` |
| `weekdayOf(key)` | `hg` | `en-US weekday:"short"` at +12h → `["Sun",…].indexOf` |
| `weekStartKey(key)` | `gg` | 일요일 시작: `dateKey(dayStartMs(key) - weekday*DAY_MS)` |
| `weekDays(key)` | `uc` | 7개 `dayInfo` |
| `monthGrid(y, m)` | `mg` | 1일이 속한 주의 일요일부터 42칸; `inRange = cell.month === m` |
| `rangeFor(view, key)` | `Iv` | day: `[dayStart, +1d)`; week: `[weekStart, +7d)`; month: `[grid[0], grid[41]+1d)` (ISO 문자열 `{fromUtc,toUtc}`) |
| `shift(view, key, delta)` | `kh` | day ±1일, week ±7일, month ±1개월(일자는 말일로 clamp) |
| `rangeTitle(view, key)` | `Wv` | §2.7 |
| `fmtDuration(sec)` | `pg` | falsy → `""`; `m=round(sec/60)`; `m<60 → "{m}분"`; 그 외 `"{h}시간 {m}분"` 또는 분이 0이면 `"{h}시간"` |
| `fmtClock(sec)` | `vc` | `h>0 → "h:mm:ss"`, 아니면 `"m:ss"` |
| `dayLabel(key)` | `ry` | `"오늘"`, `"어제"`, `"{M}월 {D}일 (요일)"` |

### 3.2 IndexedDB 스키마

- DB 이름 `"meeting-stt"`, 버전 `2`.
- `recording-sessions` (keyPath `id`):
  ```ts
  interface RecordingSession {
    id: string;              // "rec-{startedAtMs(13자리)}-{random base36 6자}"
    startedAtUtc: string;    // ISO
    mimeType: string;        // recorder.mimeType
    durationSec: number;     // 체크포인트/일시정지/종료 시 갱신
    state: "recording" | "complete";
    updatedAtMs: number;
    lastError?: string;      // 업로드 실패 메시지 또는 복구 안내문
  }
  ```
- `recording-chunks` (autoIncrement, index `sessionId` non-unique): `{ sessionId: string, blob: Blob }`.
- 열기(`openDb`): `onupgradeneeded`에서 두 스토어 생성. 열고 나서 스토어가 없으면(`console.warn('IndexedDB "meeting-stt" had no object stores; recreating it')`) `deleteDatabase` 후 재생성. 커넥션은 모듈 싱글턴 Promise.
- 트랜잭션 헬퍼 `tx(storeNames, mode, fn)`: `oncomplete` resolve, `onerror/onabort` reject.
- 연산: `putSession(s)`, `addChunk(sessionId, blob)`, `patchSession(id, partial)`(존재할 때만, `updatedAtMs=Date.now()` 자동), `listSessions()`(`updatedAtMs` 내림차순), `getSession(id)`, `assembleBlob(session)` = `new Blob(chunks, {type: session.mimeType})`, `sessionBytes(id)`, `deleteSession(id)`(세션 + 모든 chunk, 단일 readwrite 트랜잭션), `requestPersistentStorage()` = `navigator.storage.persisted() || navigator.storage.persist()`.
- localStorage: oidc-client-ts `WebStorageStateStore` 기본 prefix `"oidc."` (`oidc.user:{authority}:{client_id}`). 앱 고유 키 없음.

### 3.3 MediaRecorder (`Recorder` 클래스)

- 지원 체크 `canRecord()`: `typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia`.
- mimeType 후보(순서대로 `MediaRecorder.isTypeSupported`): `"audio/webm;codecs=opus"`, `"audio/webm"`, `"audio/mp4"`, `"audio/ogg;codecs=opus"`. 하나도 없으면 옵션 없이 생성. 실제 `mimeType = recorder.mimeType || picked || "audio/webm"`.
- `TIMESLICE_MS = 5000` → `recorder.start(5000)`; `ondataavailable`(size>0)마다 `addChunk` (Promise를 `pendingWrites`에 push; 실패는 `console.error("Could not persist a recording chunk")`).
- `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`.
- 오류 메시지(`RecorderError`):
  - 미지원: `"이 브라우저는 녹음을 지원하지 않습니다."`
  - `NotAllowedError`/`SecurityError`: `"마이크 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요."`
  - `NotFoundError`: `"사용할 수 있는 마이크를 찾을 수 없습니다."`
  - 기타: `` `마이크를 열 수 없습니다: ${e.message}` ``
  - stop 시 미시작: `"녹음이 시작되지 않았습니다."`; onerror: `"녹음 중 오류가 발생했습니다."`
- `start()`: 세션 레코드 `{id, startedAtUtc, mimeType, durationSec:0, state:"recording", updatedAtMs}` 저장 후 `requestPersistentStorage()`(결과 무시) → sessionId 반환.
- 경과 시간: `accumulatedMs + (recording ? now - resumedAtMs : 0)`. `pause()`는 accumulated에 더하고 `patchSession({durationSec})`; `resume()`은 `resumedAtMs=now`.
- `checkpoint()`: recording 상태면 `patchSession({durationSec: elapsedSec})` — Capture가 **10초 간격**으로 호출.
- `stop()`: `requestData()` + `stop()` → `onstop` 대기 → 트랙 해제 → `await Promise.all(pendingWrites)` → `patchSession({state:"complete", durationSec})` → `{sessionId, durationSec, startedAtUtc, mimeType}` 반환.
- `abandon()`: `onstop=null` 후 `stop()`, 트랙 해제. IndexedDB 레코드는 `state:"recording"`으로 남음(펜딩 목록에서 "녹음 중 중단됨").
- 확장자 `extFor(mime)`: `audio/mp4 → "m4a"`, `audio/ogg → "ogg"`, 그 외 `"webm"`.
- 파일명 `recordingFilename(startedAtUtc, mime)` = `` `recording-${toLocalInput(startedAtUtc).replace(/[-:T]/g,"").slice(0,12)}.${ext}` `` 예 `recording-202610110930.webm` (KST 기준 YYYYMMDDHHmm).

### 3.4 업로드 흐름

```
createUpload(meta) ──POST /uploads──▶ { url, contentType, … }
        │
        ▼
XHR PUT url  (header Content-Type: res.contentType, body: File)
  upload.onprogress → loaded/total → 진행률 바
  2xx → 성공; 그 외 Error(`Upload failed (${status}): ${responseText.slice(0,200)}`)
  onerror → Error("Upload failed (network error)")
        │
        ▼
성공: IndexedDB 세션 삭제(녹음 기반일 때) → 폼 초기화 → onCreated(): selectedId=undefined, loadMeetings()
실패: error 표시, 세션에 lastError 기록(patchSession), 펜딩 목록 갱신
```
- **녹음 종료("종료 후 전사")**: `phase="uploading"` → `recorder.stop()` → `getSession(id)` (없으면 `"녹음을 찾을 수 없습니다."`) → `assembleBlob` → `new File([blob], recordingFilename, {type: mimeType})` → `createUpload({filename, contentType: mimeType, startUtc: startedAtUtc, durationSec, timeSource:"recorder"})`. 실패 메시지는 `` `${msg} 아래 목록에서 다시 업로드할 수 있습니다.` ``.
- **파일 업로드(폼)**: `createUpload({filename: file.name, contentType: file.type || "application/octet-stream", startUtc, timeSource:"user", title?, attendees})`. durationSec 없음 → 서버가 파일에서 길이 추출. 폼 힌트대로 파일 내부 메타(mvhd)가 있으면 서버가 `timeSource:"mvhd"`로 덮어쓴다(클라이언트는 결과의 `timeSource`만 표시).
- **펜딩 재업로드**: `createUpload({filename, contentType: session.mimeType, startUtc: session.startedAtUtc, durationSec: session.durationSec, timeSource:"recorder"})`.
- 업로드 직후 서버가 생성한 회의는 `PENDING_UPLOAD`/`UPLOADED` 상태로 목록에 나타나고, 폴링(8초)으로 상태가 갱신된다. 새 회의 자동 선택: `selectedId`가 undefined가 되므로 다음 렌더에서 최신 회의(방금 올린 것)가 선택된다.
- 파일 크기 제한: 클라이언트 측 제한 없음(서버/presigned URL 정책에 위임).

### 3.5 로컬 녹음 복구

- **고아 chunk 복구(`recoverOrphans(sliceSec=5, mime="audio/webm")`)**: 펜딩 목록을 읽을 때마다 먼저 실행. `recording-chunks`의 모든 레코드 중 세션이 없는 `sessionId`를 묶어 `{bytes, chunkCount, startedAtUtc}`로 집계. `startedAtUtc`는 id의 13자리 ms(`/^rec-(\d{13})-/`, 2020-01-01 이상이고 now+1일 이하일 때만 유효)에서 복원. 2048바이트 이상이면 세션 레코드 생성: `durationSec = chunkCount*5`, `mimeType "audio/webm"`, `state "complete"`, `lastError "세션 정보가 유실되어 복구되었습니다. 길이는 추정치입니다."`. 복구 수가 있으면 `console.log("Recovered N orphaned recording(s)")`.
- **잔여 정리**: 세션 bytes < 2048 → 즉시 `deleteSession`(표시 안 함).
- **중단된 녹음**: `state:"recording"`인 세션은 그대로 노출되어 재업로드 가능(길이는 마지막 checkpoint 값).
- 녹음 중 새로고침: `beforeunload` 경고 → 강행하면 recorder가 끊기지만 5초 단위 chunk는 IDB에 있어 다음 방문 시 펜딩에 나타남.

### 3.6 검색/정렬/그룹 규칙 요약

| 위치 | 정렬 | 그룹 |
|---|---|---|
| 회의 목록 | `startUtc` desc | `dateKey` (오늘/어제/M월 D일 (요일)) |
| 월 뷰 셀 | `startUtc` asc | `dateKey`, 4개 초과 `+N건 더` |
| 타임그리드 | `topMin` asc | 겹침 클러스터 → 열 분할 |
| 펜딩 목록 | `updatedAtMs` desc | — |
| 사용자 목록 | 서버 순서 | — |

---

## 4. API 계약 (클라이언트가 사용하는 범위)

### 4.1 공통

- Base: 동일 오리진 `/api`.
- 헤더: `X-Id-Token: <Cognito id_token>` (있을 때), body가 있거나 method가 POST/PUT/PATCH면 `x-amz-content-sha256: <SHA-256 hex of body string>` (빈 body는 `""`의 해시), body가 비어 있지 않으면 `Content-Type: application/json`. body가 `""`면 fetch body는 `undefined`.
- 오류: `!res.ok` → 텍스트 읽고 `JSON.parse(text).message ?? text`를 메시지로 `ApiError(status, message || \`Request failed (${status})\`)`. UI는 `error.message`를 그대로 표시. `ApiError.status===404`는 note/turns 조회에서 무시.

### 4.2 엔드포인트

| 메서드/경로 | 요청 | 응답(클라이언트가 읽는 필드) |
|---|---|---|
| `GET /session` | — | `Session` (아래) |
| `POST /password` | `{ currentPassword, newPassword }` | 2xx (본문 미사용) |
| `GET /meetings?from=ISO&to=ISO` | query | `{ meetings: Meeting[] }` |
| `GET /meetings/{id}/transcript` | — | `text/plain` 전사문 (클라이언트 함수 존재, 현재 UI 미사용) |
| `GET /meetings/{id}/turns` | — | `{ turns: Turn[], speakerMap: Record<string,string>, refined: boolean }` |
| `GET /meetings/{id}/note` | — | `text/markdown` 노트 원문 (404 → 없음) |
| `PUT /meetings/{id}/note` | `{ note: string }` | 2xx |
| `POST /uploads` | `UploadRequest` | `{ url: string, contentType: string }` |
| `PATCH /meetings/{id}` | 부분 `{ title?, startUtc?, attendees?: string[], teams?: string[] }` | 2xx |
| `DELETE /meetings/{id}` | — | 2xx |
| `POST /meetings/{id}/speakers` | `Record<rawSpeaker, displayName>` | 2xx |
| `POST /meetings/{id}/regenerate-note` | (빈 body) | 2xx |
| `GET /admin/users` | — | `{ users: AdminUser[], teams: string[] }` |
| `POST /admin/users` | `{ email, teamId, asAdmin: boolean }` | `{ user: { temporaryPassword: string, … } }` |
| `POST /admin/users/{username}/reset-password` | (빈 body) | `{ temporaryPassword: string }` |
| `POST /admin/users/{username}/teams` | `{ teamId: string, remove: boolean }` | 2xx |
| `POST /admin/users/{username}/admin` | `{ remove: boolean }` | 2xx |
| `DELETE /admin/users/{username}` | — | 2xx |
| `PUT {uploads.url}` (S3 presigned, `/api` 외부) | 헤더 `Content-Type: {contentType}`, body = 파일 | 2xx |

### 4.3 타입

```ts
interface Session {
  email: string;
  teams: string[];        // 공유 가능한 팀 id 목록 (scope-pick 체크박스 소스)
  isAdmin: boolean;
  isPersonal: boolean;    // 팀 없음 → 메뉴 "개인 · 공유되지 않음", showOwner=false
}

type MeetingStatus =
  | "PENDING_UPLOAD" | "UPLOADED" | "TRANSCRIBING" | "REFINING" | "SUMMARIZING" | "DONE" | "FAILED";

type TimeSource = "mvhd" | "user" | "recorder" | "upload";

interface Meeting {
  meetingId: string;
  title?: string;               // 없으면 "(제목 생성 중)" / originalFilename / "제목 없음"
  originalFilename?: string;
  startUtc: string;             // ISO, 정렬/그룹 키
  durationSec?: number;
  status: MeetingStatus;
  failureReason?: string;
  attendees?: string[];
  teamId?: string;              // 단일 팀(레거시). "personal-…" 접두는 비공개
  teams?: string[];             // 다중 팀. 없으면 [teamId]
  ownerEmail?: string;
  notePreview?: string;         // DONE일 때 목록 미리보기(마크다운 원문 일부)
  noteEditedAt?: string;        // ISO, 사용자가 노트를 직접 수정한 시각
  speakers?: string[];          // raw 화자 라벨 (예 "spk_0")
  speakerMap?: Record<string,string>;
  timeSource?: TimeSource;
}

interface Turn { speaker: string; text: string; startSec: number; }

interface UploadRequest {
  filename: string;
  contentType: string;
  startUtc: string;             // ISO
  durationSec?: number;         // 녹음기 기반일 때만
  timeSource: "recorder" | "user";
  title?: string;
  attendees?: string[];
}

interface AdminUser {
  username: string;             // 경로 파라미터로 사용
  email?: string;
  isAdmin: boolean;
  status?: "FORCE_CHANGE_PASSWORD" | string;   // Cognito 상태
  teams: string[];
}
```

### 4.4 노트 마크다운 형식

서버가 생성하는 노트는 렌더러가 지원하는 부분집합이어야 한다:
- 제목 `#`/`##`/`###`(화면에서는 h2/h3/h4로 한 단계 내려 렌더; `.md h3`는 accent 색).
- 단락, `-`/`*`/`1.` 목록(2칸 들여쓰기 중첩), `|` 표(둘째 줄 `|---|---|`), `---` 구분선, 인라인 `**굵게**`, `*기울임*`, `` `코드` ``.
- `notePreview`는 이 마크다운의 앞부분으로 보이며, 목록에서 `#*|`-` 문자를 제거해 90자로 잘라 표시한다.
- 사용자가 BlockNote로 편집한 결과도 마크다운 문자열로 `PUT /note`에 저장된다.

---

## 5. 디자인 토큰 & CSS

### 5.1 CSS 변수 (`:root`)

| 변수 | 값 | 용도 |
|---|---|---|
| `--bg` | `#0d0f13` | 페이지 배경 |
| `--surface` | `#16191f` | 상단바, 목록, 드로어, 제목 input 배경 |
| `--surface-2` | `#1d2129` | 버튼/인풋/카드/말풍선/메뉴 배경 |
| `--surface-3` | `#252a34` | hover, pipe-dot 기본 |
| `--border` | `#292f3a` | 기본 보더 |
| `--border-strong` | `#3a4150` | 팝오버/모달 보더, chip 좌측 기본 |
| `--text` | `#e8eaee` | 본문 |
| `--text-dim` | `#b4bcc9` | 버튼 기본 글자, md 본문, 말풍선 글자 |
| `--muted` | `#8b93a1` | 보조 텍스트, placeholder |
| `--accent` | `#5b95ff` | primary 버튼, 선택, 링크성 강조 (hover `#6ea3ff`) |
| `--accent-dim` | `rgba(91,149,255,.14)` | 선택 배경, 내 말풍선, 팀 태그 |
| `--done` | `#46b95a` | 완료 배지, 규칙 충족, handover |
| `--working` | `#d9a13a` | 진행중 배지, pending 박스, 비공개 scope |
| `--failed` | `#f0554c` | 실패, 삭제 hover, 녹음 pill, now 선 |
| `--radius` | `10px` | 카드/모달/드로어 |
| `--radius-sm` | `6px` | 버튼/인풋/칩 |
| `--reading-max` | `820px` | `.panel` 최대 폭 |

- 라이트 모드/`prefers-color-scheme` 없음. `prefers-reduced-motion: reduce` 시 `.pipe-step.active .pipe-dot` 애니메이션 해제.

### 5.2 타이포그래피

- `body`: `font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", "Noto Sans KR", sans-serif`, antialiased.
- 모노: `ui-monospace, SFMono-Regular, Menlo, monospace` (`.md code`, `.handover code`, `.ne-bar code`).
- `h1` 20px, `h2` 17px(`.ph-row h2` 21px/1.3), `h3` 13px uppercase letter-spacing .05em muted. `.small` 12px. 숫자는 곳곳에 `font-variant-numeric: tabular-nums`.

### 5.3 버튼/폼

| 클래스 | 스타일 |
|---|---|
| `button` | surface-2 배경, border, radius-sm, `padding 7px 13px`, text-dim; hover surface-3; disabled opacity .45; focus-visible 2px accent outline |
| `.primary` | accent 배경/보더, 흰 글자, 600 |
| `.ghost` | 투명 배경; `.ghost.on` accent-dim 배경 + accent 보더/글자 |
| `.small` | `4px 9px`, 12px |
| `.big` | `11px 26px`, 15px |
| `.icon` | `5px 10px` |
| `.danger:hover` | 보더/글자 failed |
| `input, select, textarea` | surface-2, border, radius-sm, `7px 10px`; focus 보더 accent |

### 5.4 색상 매핑: 상태

| 상태 | `.badge` 글자/보더 | 목록 좌측 보더 | 월 chip 좌측 보더 | 타임그리드 블록 |
|---|---|---|---|---|
| DONE | `--done` / `#46b95a73` | `#46b95a80` | `--done` | 기본 accent (`#5b95ff33` bg) |
| TRANSCRIBING / SUMMARIZING / PENDING_UPLOAD | `--working` / `#d9a13a73` | `--working` | `--working` | `#d9a13a29` bg, working 보더 |
| FAILED | `--failed` / `#f0554c73` | `--failed` | `--failed` | `#f0554c29` bg, failed 보더 |
| REFINING / UPLOADED | working/pending 배지 | (CSS 미정의 → 투명) | (미정의) | 기본 accent |
| 선택(`.sel`) | — | accent-dim bg, `#5b95ff59` 보더, accent 좌측 | accent 보더 + accent-dim | `#5b95ff6b` bg + 1px accent ring |

### 5.5 화자 아바타 팔레트

`HUES = [212, 152, 32, 282, 4, 192, 108, 328]` (파랑, 청록, 주황, 보라, 빨강, 시안, 연두, 핑크). 등장 순 `i % 8`.
- 아바타 배경 `hsl(H 42% 26%)`, 글자 `--text`, 28px 원(700px 이하 26px).
- 이름 `hsl(H 60% 68%)`.
- 말풍선 보더 `hsl(H 34% 30%)`, 배경 surface-2, 라운드 `4px 14px 14px 14px`(첫 말풍선) / `14px`(연속).
- 내 말풍선(`.mine`): accent-dim 배경, 투명 보더, 라운드 `14px 4px 14px 14px`, 글자 `--text`.

### 5.6 그림자/레이어

| 요소 | z-index | shadow |
|---|---|---|
| `.menu-backdrop` / `.menu` | 40 / 41 | `0 12px 32px #00000080` |
| `.capture-form` | 45 | `0 16px 40px #0000008c` |
| `.modal-backdrop` / `.modal` | 50 / 51 | `0 20px 50px #0009`, backdrop `#0009` |
| `.tg-block` / `.tg-now` | 2 / 3 | — |
| `.mlist-day` sticky | 1 | — |

### 5.7 주요 클래스 색인

| 클래스 | 역할 |
|---|---|
| `.center`, `.landing` | 전체화면 중앙 정렬 컨테이너(로딩/오류/랜딩) |
| `.app`, `.topbar`, `.brand`, `.topbar-right`, `.menu-wrap`, `.menu`, `.menu-user`, `.menu-backdrop` | 셸/상단바/메뉴 |
| `.alert`, `.alert.error`, `.alert.warn` | 배너(`margin 0 16px 10px`) |
| `.capture`, `.capture-main`, `.capture.dragging`, `.rec-live`, `.rec-dot(.on)`, `.rec-time`, `.progress(.small-bar)`, `.bar`, `.capture-form`, `.cf-file`, `.cf-hint`, `.cf-actions` | 캡처 패널 |
| `.pending`, `.pending-head`, `.pending-row`, `.pr-info`, `.pr-error`, `.pr-actions` | 미업로드 녹음 |
| `.calendar-drawer`, `.cd-head`, `.cd-close`, `.viewswitch` | 캘린더 드로어 |
| `.month`, `.month-head`, `.month-body`, `.dow.w0~w6`, `.cell(.out/.today/.weekend)`, `.cell-date`, `.chip(.sel/.more/.s-*)`, `.chip-time`, `.chip-title` | 월 뷰 |
| `.timegrid(.single)`, `.tg-head`, `.tg-gutter`, `.tg-day-head(.today)`, `.dnum`, `.tg-body`, `.tg-inner`, `.tg-hour-label`, `.tg-col(.today)`, `.tg-slot`, `.tg-now`, `.tg-block(.sel/.s-*)`, `.tg-block-time`, `.tg-block-title` | 주/일 뷰 |
| `.main`, `.mlist`, `.mlist-search`, `.mlist-body`, `.mlist-empty`, `.mlist-group`, `.mlist-day`, `.mlist-item(.sel/.s-*)`, `.mi-top`, `.mi-time`, `.mi-dur`, `.mi-title`, `.mi-lock`, `.mi-preview` | 회의 목록 |
| `.reader`, `.empty` | 우측 리더 |
| `.panel(.admin)`, `.panel-head`, `.ph-row`, `.meta`, `.hint`, `.title-editable`, `.title-input`, `.scope-row`, `.scope(.shared/.private)`, `.scope-pick`, `.scope-private-option`, `.edit-form`, `.speakers`, `.speaker-rows`, `.tabs`, `.spacer`, `.content` | 회의 상세 |
| `.badge(.pending/.working/.done/.failed/.compact)` | 상태 배지 |
| `.pipe(.failed)`, `.pipe-steps`, `.pipe-step(.done/.active/.todo/.halted)`, `.pipe-dot`, `.pipe-label`, `.pipe-hint` | 파이프라인 |
| `.chat`, `.chat-note`, `.chat-row(.mine)`, `.chat-avatar`, `.chat-body`, `.chat-head`, `.chat-name`, `.chat-time`, `.chat-bubble` | 전사문 채팅 |
| `.md` (+ h2/h3/h4/p/ul/ol/li/hr/code/strong/em/table/th/td) | 마크다운 |
| `.note-editor`, `.ne-bar`, `.bn-wrap`, `.bn-loading`, `.bn-container`, `.bn-editor`, `.bn-block-content` | 노트 편집기(BlockNote 오버라이드) |
| `.modal-backdrop`, `.modal`, `.pw-rules(.met)`, `.pw-error`, `.pw-done` | 비밀번호 모달 |
| `.invite(.checkbox)`, `.handover`, `.ho-row`, `.ho-label`, `.ho-secret`, `.user-list`, `.user-row`, `.ur-main`, `.ur-teams`, `.ur-actions`, `.team-tag`, `.tag-x`, `button.back` | 사용자 관리 |

### 5.8 반응형

- `@media (max-width: 900px)`: `.main` 1열(목록 위 210px, 리더 아래), `.mlist` 하단 보더, `.topbar` wrap(캡처 패널 둘째 줄 전체폭), `.panel{padding:18px 16px 40px}`, `.capture-form` 좌우 16px 고정, `.cd-head` wrap.
- `@media (max-width: 700px)`: `.chat-body{max-width:86%}`(기본 76%), 아바타 26px.
- `@media (prefers-reduced-motion: reduce)`: 파이프 pulse 해제.
- 애니메이션: `@keyframes pulse`(rec-dot, 1.5s opacity 1→.2), `@keyframes pipe-pulse`(1.6s box-shadow 0→5px accent-dim).

---

## 6. 기타 주의사항

### 6.1 confirm/prompt 문구 모음

| 위치 | 문구 |
|---|---|
| 회의 삭제 | `이 회의를 캘린더에서 삭제할까요?` |
| 노트 재생성(직접 수정본 존재) | `직접 수정한 노트가 AI 생성 내용으로 덮어써집니다. 계속할까요?` |
| 노트 편집 취소(변경 있음) | `수정한 내용을 버릴까요?` |
| 로컬 녹음 삭제 | `이 녹음({size})을 완전히 삭제할까요? 복구할 수 없습니다.` |
| 사용자 삭제 | `{email ?? username} 계정을 삭제할까요?` |
| 새 팀 prompt | `만들 팀 이름 (영문 소문자·숫자·하이픈, 2~31자)` |

### 6.2 검증/제한

- 비밀번호: 12자 이상, 대문자·소문자·숫자·기호 각 1개 이상(클라이언트 사전 검증 + Cognito 정책).
- 팀 id: 소문자 변환 후 전송; 안내 규칙 "영문 소문자·숫자·하이픈, 2~31자"(서버 검증).
- 임시 비밀번호 유효기간 안내: 7일.
- 파일 accept: `audio/*,video/mp4,.m4a,.mp3,.wav,.mp4,.webm,.ogg,.flac`. 크기 제한은 클라이언트에 없음.
- 로컬 녹음 최소 유효 크기 2048바이트(미만은 자동 삭제/복구 제외).
- 회의 조회 범위: 과거 180일 ~ 미래 7일. 그 밖의 회의는 캘린더/목록에 보이지 않음.

### 6.3 접근성 속성

- `aria-label`: `"회의 검색"`, `"회의 제목"`(제목 input), `"닫기"`(✕ 버튼들), `"메뉴"`(+`aria-expanded`), `"이전"`, `"다음"`, 모달 `role="dialog" aria-label="비밀번호 변경"`.
- 아바타/파이프 dot은 `aria-hidden="true"`.
- `button:focus-visible` 2px accent outline.

### 6.4 재구현 시 유의할 동작 디테일

1. `MeetingDetail`은 `React.memo`이고 `/meetings` 폴링 결과는 `stableMerge`로 참조를 유지하므로, 변경이 없는 회의는 리렌더되지 않는다. 동일한 효과를 얻으려면 폴링 결과를 deep-equal 비교로 merge해야 한다.
2. 상세 패널의 로컬 state 리셋 키에 `status`는 포함되지 않는다 → 처리 중 → DONE 전환 시 입력 중이던 폼은 유지되고, note/turns는 `undefined`이므로 DONE이 되는 순간 자동 로드된다("완료되면 자동으로 표시됩니다").
3. 탭 기본값은 `"note"`. 회의를 바꿔도 탭은 유지(리셋 대상 아님).
4. 노트 저장 후 `note` state를 draft로 즉시 교체(낙관적), 이어서 `onChanged()`로 `noteEditedAt` 갱신.
5. 화자 이름 저장 후 `turns=undefined`로 재조회하여 새 `speakerMap` 반영. `meeting.speakerMap`도 폴링으로 갱신.
6. 캘린더를 열 때 anchor를 **가장 최근 회의 날짜**로 이동(오늘이 아님). `오늘` 버튼으로 복귀.
7. 업로드 성공 시 `selectedId=undefined` → 자동으로 최신 회의가 선택되므로 방금 올린 회의가 열린다.
8. 같은 화자 라벨이 연속되면 하나의 그룹(머리글 1개, 말풍선 여러 개)으로 묶는다. 시간은 그룹 첫 턴의 `startSec`.
9. `teamId`가 `"personal-"`로 시작하면 비공개. 공유 해제 시 서버에 `teams: ["personal"]`을 보낸다(접두 없는 리터럴 `"personal"`).
10. 세션 상태 `isPersonal`이 true면 상세의 "올린 사람" 행을 숨긴다(`showOwner = !isPersonal`).
