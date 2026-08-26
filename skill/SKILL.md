---
name: textfix
description: "HTML로 만든 문서에 간단한 인페이지 '편집툴'을 붙여주는 스킬 — 붙이면 브라우저에서 연필 아이콘을 눌러 비밀번호를 입력하고 그 자리에서 텍스트를 직접 고쳐 GitLab 또는 GitHub 커밋으로 저장할 수 있다. 사용법: '/textfix' 실행 후 편집 기능을 붙일 HTML 문서의 로컬 경로나 GitLab/GitHub URL을 알려주면 된다. 탈착은 '/textfix --detach <경로>'. 트리거: 'HTML에 편집 기능 붙여줘', '문서 직접 편집 가능하게', '편집 버튼 달아줘', 'textfix', '인페이지 편집 추가', 경로/URL 제시 + '편집 기능/편집 가능하게' 조합, 탈착은 '편집 기능 떼줘/제거해줘'."
user_invocable: true
auto_trigger: true
version: 0.2.0
---

<!--
  경로 표기 안내: 이 문서의 `<TEXTFIX_ROOT>`는 이 저장소(woozi-textfix)를 내려받아 둔
  루트 경로를 가리킨다. Claude Code 플러그인으로 패키징해 설치했다면 그 환경이 제공하는
  플러그인 루트 변수로 치환하고, 이 저장소를 프로젝트에 그대로 복사해 두었다면 그 복사
  경로를 직접 대입한다. 실물 파일 위치: `<TEXTFIX_ROOT>/wz-editor.js`,
  `<TEXTFIX_ROOT>/tools/encrypt-token.mjs`, `<TEXTFIX_ROOT>/tools/embed-lint.mjs`.
-->

# textfix — 인페이지 편집 기능 부착/탈착

정적 HTML 문서에 `wz-editor` 모듈(비밀번호 게이트 + contenteditable 편집 +
리치텍스트 미니 툴바 + localStorage 자동 초안 + GitLab/GitHub Files API 커밋 저장 +
저장 후 실배포 추적 배너 + 취소/저장-후-자동종료)을 마커 블록 하나로 부착하거나,
그 블록만 제거해 완전히 원복한다. 외부 의존성 0, 단일 파일 — 모듈 자체 설계는
`<TEXTFIX_ROOT>/wz-editor.js` 상단 주석 참조.

편집 대상은 문서별로 지정하지 않는다 — 기본값은 **범용 편집**이다: 페이지 안에서
보이는 텍스트를 가진 요소는 전부 자동으로 편집 대상이 된다(편집기 자신의 UI와
`script`/`style`/`template`만 제외). 특정 요소만 편집 가능하게 좁히려면 config의
`editableSelector`에 CSS 셀렉터를 넣어 override한다(고급, 기본은 `null`).

## 절대 원칙

- **wz-editor.js 본문을 이 스킬에서 수정하지 않는다.** 버그 발견 시 별도로
  보고하고, 이 스킬은 부착/탈착 오케스트레이션만 담당한다.
- **토큰 원문을 채팅에 붙여넣게 하지 않는다.** 반드시 파일로 저장하게
  안내하고, `encrypt-token.mjs`로 암호화 후 원본 파일을 즉시 삭제한다.
- **`git remote -v` / `git remote show` / `git config --get remote.*.url` 등
  credential-embedded URL을 출력하는 명령을 절대 실행하지 않는다.** 저장소
  이름만 필요하면 인자 없는 `git remote`를 쓰고, GitLab 호스트(gitlabHost)는
  항상 사용자에게 직접 확인한다 — 내부망 GitLab 원격 URL은
  `https://<user>:<token>@host/...` 형태로 액세스 토큰이 그대로 박혀 있는
  경우가 있어, 이 URL을 조회하는 순간 토큰이 평문으로 노출된다.
- **부착 대상이 이미 wz-editor 블록을 갖고 있으면 중복 부착하지 않는다.**
  기존 블록을 찾으면 "이미 부착되어 있습니다 — 갱신하시겠습니까?"로 갱신
  여부를 묻는다.

## Step 0. 스킬 소개 및 입력 안내 (호출 직후)

사용자가 대상 없이 `/textfix`만 호출했으면, 먼저 이 스킬이 무엇인지 한 줄로
소개하고 입력을 요청한다(대상 경로/URL이 이미 인자로 주어졌으면 이 안내를
생략하고 Step 1로 진행):

> **textfix** 는 이미 만들어진 HTML 문서에 **인페이지 '편집툴'** 을 붙여주는
> 스킬입니다. 붙이고 나면 브라우저에서 우측 상단 **연필 아이콘 → 비밀번호 →
> 텍스트를 그 자리에서 직접 수정 → 저장**(GitLab/GitHub 커밋)까지 됩니다. 별도
> CMS나 개발환경 없이 이미 배포된 정적 문서에 편집 기능만 얇게 얹는 용도입니다.
>
> 편집 기능을 붙일 **HTML 문서의 경로**(GitLab/GitHub 저장소에 clone된 로컬
> 경로) 또는 **GitLab/GitHub Pages URL** 을 알려주세요.
>
> ⚠️ 이 스킬은 **GitLab/GitHub 저장소에 있는 HTML 문서 전용**입니다. 저장이
> 커밋으로 이뤄지기 때문에, git 저장소에 속하지 않은 순수 로컬 문서는
> 지원하지 않습니다(브라우저 보안상 로컬 파일 직접 저장 불가).

## Step 1. 대상 판별

인자로 받은 문자열이 URL인지 로컬 경로인지 먼저 구분한다.

- **URL인 경우** (예: `https://<pages-host>/...`): GitLab Pages URL의 경로
  구조에서 레포 상대 경로를 역산한다. Pages 배포 방식(프로젝트 루트 서빙 /
  `public/` 서빙 등)은 레포마다 다를 수 있으므로, 역산한 추정 경로를
  사용자에게 제시하고 **로컬에 clone된 레포 경로**를 확인받는다
  ("이 문서가 속한 레포를 로컬 어디에 clone해 두셨나요?").
- **로컬 경로인 경우**: 파일 존재를 확인한 뒤, 해당 경로가 git 레포에
  속하는지 `git rev-parse --show-toplevel`로 확인한다(대상 파일이 있는
  디렉터리에서 실행). 성공하면 레포 루트 경로를 얻는다.

**전제 (필수)**: 대상 문서는 반드시 **GitLab/GitHub 저장소에 속해야** 한다.
`git remote`(인자 없이)로 remote가 없거나 git 레포가 아니면, 아래처럼 고지하고
**중단**한다 — 저장 백엔드가 없어 이 스킬을 붙일 수 없다:

> "이 문서는 GitLab/GitHub 저장소에 속해 있지 않습니다. textfix는 편집 결과를
> 저장소 커밋으로 저장하므로, git 저장소 안의 문서에만 부착할 수 있습니다.
> (브라우저 보안상 순수 로컬 파일은 직접 저장이 불가능합니다.)"

## Step 2. 저장소 설정 (remote 존재 확인 후)

`git remote`(인자 없이, 이름만)로 remote 존재를 확인했으면 **풀 기능**
(부착 + **GitLab 또는 GitHub** 커밋 저장)으로 진행한다.

- `provider`: 저장 백엔드를 `'gitlab'` 또는 `'github'`로 지정한다. 호스트를
  사용자에게 직접 확인해 정한다(원격 URL 조회 금지 — 토큰 임베드 URL 노출
  위험). GitHub(.com 또는 GitHub Enterprise)면 `'github'`, 사내/공개 GitLab이면
  `'gitlab'`. 미지정 시 모듈이 host 문자열로 자동 추론하나, 명시를 권장한다.
- 호스트:
  - GitLab → `gitlabHost` (예: `https://gitlab.example.com`).
  - GitHub → `apiBase` (기본값 `https://api.github.com`, GitHub Enterprise면
    `https://<ghe-host>/api/v3`).
  이미 대상 레포 안에 다른 wz-editor 임베드가 있으면 그 config 값을 그대로
  재사용한다(URL 조회 없이 기존 config script 블록을 Read/Grep으로 읽는 것뿐이라
  안전하다).
- `projectPath`: `<네임스페이스>/<프로젝트>`(GitLab) 또는 `<owner>/<repo>`(GitHub).
  `git rev-parse --show-toplevel`로 얻은 폴더명이나 사용자가 아는 경로를
  직접 확인받는다.
- `filePath`: 대상 HTML의 레포 루트 기준 상대 경로.
- `branch`: `git branch --show-current` (또는 `git rev-parse --abbrev-ref HEAD`).

## Step 3. 자격 수집

1. **편집 비밀번호**: 사용자에게 편집 비밀번호를 정하게 한다. **`pwHashHex`
   같은 해시는 계산하지 않는다**(이 스킬은 더 이상 pwHashHex를 쓰지 않는다).
   비밀번호는 아래 2단계에서 토큰을 암호화할 때 함께 쓰이고, 편집 진입 시
   인증은 "그 비밀번호로 토큰 복호화가 성공하는가"로 판정된다(AES-GCM 인증
   태그가 곧 비밀번호 검증자 — 별도 해시를 페이지에 게시하지 않으므로 외부
   열람자의 오프라인 크랙 표면이 없다).
2. **프로젝트 액세스 토큰**:
   - 대상 레포에 기존 wz-editor 임베드가 있으면, 그 config script의
     `tokenSaltB64`/`tokenIvB64`/`tokenCipherB64` 값을 그대로 재사용할지
     제안한다(단, 이 경우 **편집 비밀번호도 기존 값과 동일해야** 복호화가
     성공한다 — 새 비밀번호를 원하면 토큰도 새로 암호화해야 함을 사용자에게
     고지).
   - 기존 임베드가 없으면, provider별로 토큰을 발급받게 안내한다:
     - **GitLab**: 프로젝트 → Settings → Access Tokens에서 발급.
       대상 브랜치가 **protected**(보통 `main`)면 role은 **Maintainer 필수**
       — Developer 토큰은 저장 시 `400 You are not allowed to push into this
       branch`로 실패한다(실측 확인). protected가 아니면 Developer도 가능하나
       Maintainer를 권장한다. scope는 **`api` 하나만** 체크 — 저장이 REST
       API(`/repository/files`, `/commits`) 경유라 `api`가 필요하고
       `write_repository`(git-over-HTTP 전용)는 불필요·불충분하다. 만료일
       설정을 권장한다.
     - **GitHub**: Settings → Developer settings → Personal access tokens.
       fine-grained PAT면 대상 레포에 **Contents: Read and write** 권한만,
       classic이면 `repo` scope. 만료일 설정 권장.
     그다음 (provider 공통):
     1. 발급된 토큰 문자열을 **채팅에 붙여넣지 말고** 로컬 파일에 저장
        (예: `token.txt`).
     2. `node "<TEXTFIX_ROOT>/tools/encrypt-token.mjs" --token-file <token.txt 경로> --password-stdin`
        실행 → 프롬프트에 편집 비밀번호를 입력(stdin)한다. **비밀번호를 argv로
        넘기지 않는다**(프로세스 목록·셸 히스토리 노출 차단 — argv 전달은
        스크립트가 거부한다). 출력된 `tokenSaltB64`/`tokenIvB64`/`tokenCipherB64`
        3값을 확보.
     3. **토큰 파일을 즉시 삭제**(`rm token.txt` 또는 탐색기에서 삭제) —
        Claude가 대신 지워도 되지만, 사용자가 직접 지웠는지 확인 문구를
        마지막에 남긴다.

## Step 4. 부착

전제: `<TEXTFIX_ROOT>/wz-editor.js` 실물이 존재해야 한다.

1. 대상 레포에 `assets/js/wz-editor.js`가 없으면
   `<TEXTFIX_ROOT>/wz-editor.js`를 그 경로로 복사한다
   (이미 있으면 그대로 참조 — 임의로 덮어쓰지 않는다. 버전 차이가 의심되면
   사용자에게 갱신 여부를 확인).
2. 대상 HTML에서 `</body>` 위치를 찾고, 그 직전에 마커 블록을 삽입한다.
   provider에 맞는 config를 쓴다(풀 기능 모드에는 `pwHashHex`를 넣지 않는다 —
   인증은 토큰 복호화 성공으로 판정):

   **GitLab:**
   ```html
   <!-- wz-editor:start -->
   <script>
     window.WZ_EDITOR_CONFIG = {
       provider: 'gitlab',
       gitlabHost: 'https://<확인받은 호스트>',
       projectPath: '<네임스페이스>/<프로젝트>',
       filePath: '<레포 루트 기준 상대경로>',
       branch: '<현재 브랜치>',
       tokenSaltB64: '<Step 3 출력>',
       tokenIvB64: '<Step 3 출력>',
       tokenCipherB64: '<Step 3 출력>',
       allowedHosts: ['<확인받은 호스트의 도메인>'],   // 권장: 토큰이 전송될 호스트를 고정(변조 시 전송 차단)
       editableSelector: null
     };
   </script>
   <script src="<문서 기준 wz-editor.js 상대경로>"></script>
   <!-- wz-editor:end -->
   ```

   **GitHub** (차이: `provider`/`apiBase`, `projectPath`는 `<owner>/<repo>`):
   ```html
   <!-- wz-editor:start -->
   <script>
     window.WZ_EDITOR_CONFIG = {
       provider: 'github',
       apiBase: 'https://api.github.com',   // GitHub Enterprise면 https://<host>/api/v3
       projectPath: '<owner>/<repo>',
       filePath: '<레포 루트 기준 상대경로>',
       branch: '<현재 브랜치>',
       tokenSaltB64: '<Step 3 출력>',
       tokenIvB64: '<Step 3 출력>',
       tokenCipherB64: '<Step 3 출력>',
       allowedHosts: ['api.github.com'],   // 권장: 토큰이 전송될 호스트를 고정(변조 시 전송 차단). GHE면 그 호스트
       editableSelector: null
     };
   </script>
   <script src="<문서 기준 wz-editor.js 상대경로>"></script>
   <!-- wz-editor:end -->
   ```

   `tokenSaltB64`/`tokenIvB64`/`tokenCipherB64`가 비어 있으면 편집기는 부착되지
   않는다(저장 백엔드가 필수 — 토큰 없는 부착 불가).

   `src`의 상대경로는 대상 HTML 파일 위치를 기준으로 계산한다(예: 문서가
   레포 루트에 있으면 `assets/js/wz-editor.js`, 하위 폴더에 있으면
   `../../assets/js/wz-editor.js` 등).
3. 삽입 외 어떤 기존 콘텐츠도 건드리지 않는다(Surgical Changes — 요청에
   직결된 줄만 수정).

## Step 5. 검증

1. **기계 게이트 — `embed-lint`** (브라우저 열기 전에 먼저):
   ```bash
   node "<TEXTFIX_ROOT>/tools/embed-lint.mjs" <부착한 HTML 경로>
   ```
   `tokenCipherB64` 존재, host가 `https://`, `allowedHosts`에 host의 **origin**
   (`new URL(host).origin` — hostname만 넣으면 검증 실패로 FAB 자체가 안 뜬다)
   포함, `<script src>` 실물 파일 존재 4가지를 assert한다. FAIL이면 브라우저를
   열기 전에 config를 수정한다.
2. 로컬에서 `python -m http.server --bind 127.0.0.1 <port>` (또는 동등 도구)로
   대상 디렉터리를 서빙하고(0.0.0.0 전체 바인드 금지 — 암호문 config가 든 레포가
   LAN에 노출된다), 부착한 HTML을 브라우저(Claude Browser MCP 등)로 열어 확인:
   - 우측 상단 연필 아이콘(FAB)이 보이는가
   - 클릭 시 비밀번호 모달이 뜨는가, 올바른 비밀번호로 편집모드 진입하는가
   - 편집모드에서 텍스트 수정 → 저장 시 토스트/에러가 예상대로 뜨는가
     (부착 검증 단계에선 placeholder 토큰이라 저장이 실패 토스트로 끝나는 것이
     정상 — 실토큰은 실제 배포 시 주입)
   - 저장 성공 시 화면에 **배포 상태 배너**가 뜨는지 확인한다 — 커밋 직후
     "배포 중" 상태로 시작해, GitLab 파이프라인 또는 GitHub 커밋 상태 API를
     폴링해 성공/실패로 갱신된다(폴링은 성공/실패 확정 시 또는 시도 예산
     소진 시 멈추고, 네트워크 오류가 나도 편집 흐름을 막지 않는다 — 항상
     "pending"으로 물러날 뿐 예외를 던지지 않는다).
   - 저장 직후 아직 배포가 반영되기 전에 **같은 문서를 다시 편집 진입**해보고,
     "방금 저장한 내용이 아직 배포되지 않았습니다" 같은 재진입 경고가 뜨는지
     확인한다(직전 저장 기록이 15분 이내이고 배포 상태가 아직 pending으로
     확인될 때만 경고 — 오래된 기록이나 상태 불명 시에는 경고하지 않는 안전
     편향).
3. `git diff`로 실제 삽입된 내용이 마커 블록(`<!-- wz-editor:start -->`~
   `<!-- wz-editor:end -->`)뿐인지 확인한다 — 기존 콘텐츠 무손상 검증.
4. 커밋/푸시는 **사용자 확인 후에만** 진행한다(저장소에 대한 쓰기 작업이므로
   명시적 동의 필요).

## Step 6. 탈착

`/textfix --detach <경로>` 요청 시:

1. 대상 HTML에서 `<!-- wz-editor:start -->` ~ `<!-- wz-editor:end -->`
   마커 블록만 정확히 제거한다.
2. `git diff`로 제거 diff가 그 블록뿐인지 확인한다.
3. wz-editor.js가 만든 DOM/CSS는 전부 런타임 주입이라 문서 자체에는
   흔적이 남지 않으므로, 마커 블록 제거만으로 완전 원복된다
   (`assets/js/wz-editor.js` 파일 자체는 다른 문서에서도 쓸 수 있으므로
   기본적으로 지우지 않음 — 사용자가 명시적으로 요청하면 삭제).

## 보안 고지 (사용자에게 반드시 전달)

- 인증은 "그 비밀번호로 토큰 복호화가 성공하는가"로 판정한다 — 비밀번호 검증용
  해시(`pwHashHex`)를 페이지에 게시하지 않으므로 외부 열람자의 오프라인 크랙
  표면이 없다. 다만 **비밀번호를 아는 사람**은 브라우저 devtools에서 복호화된
  토큰 평문을 볼 수 있다. AES-GCM 암호화는 "비밀번호를 몰라도 토큰을 못 본다"는
  뜻일 뿐, 비밀번호 아는 내부자로부터의 보호는 아니다.
- 이 구조는 **내부망 저위험 문서** 용도로만 사용한다. 토큰은 해당 레포 한정
  최소 권한(GitLab: role Developer + scope `api` / GitHub: Contents 쓰기만)과
  만료일을 설정해 피해 범위를 제한할 것을 권장한다.
- 토큰 원문은 채팅, argv, 스킬 산출물 어디에도 남기지 않는다(암호화 도구도
  비밀번호를 stdin으로만 받는다). 유출 의심 시 즉시 GitLab/GitHub에서 토큰을
  폐기(revoke)하고 재발급한다.
- 편집 초안(localStorage)은 7일 후 자동 만료된다. GitLab/GitHub Pages가 path
  공유 도메인이면 같은 호스트의 다른 프로젝트가 초안을 읽을 수 있으므로,
  unique-domain(프로젝트별 하위 도메인) 배포를 권장한다.
- wz-editor가 브라우저에 남기는 데이터는 전부 **localStorage**(문서가 열린
  사이트 origin에 귀속, 서버·레포·다른 사이트로 전송되지 않음) 한정이며 두
  종류다: ① 위에서 설명한 **임시 초안**, ② 문서당 1개(~100바이트)인
  **최근 저장 기록**(`{문서 경로, 커밋 SHA, 시각}`만 — 저장 직후 아직 배포가
  반영되기 전에 같은 문서를 다시 편집하려 할 때의 재진입 경고 판단용, 사용자가
  직접 열람하는 용도는 아니다). 최근 저장 기록은 15분이 지나거나 원격에서
  새 커밋이 감지되면 자동 삭제되어 계속 쌓이지 않으며, 토큰·비밀번호는 두
  종류 어디에도 저장되지 않는다.

## 산출물 경로 요약

| 항목 | 경로 |
|------|------|
| wz-editor 모듈 실물 | `<TEXTFIX_ROOT>/wz-editor.js` (부착 시 대상 레포로 복사) |
| 토큰 암호화 도구 | `<TEXTFIX_ROOT>/tools/encrypt-token.mjs` |
| 부착 검증 게이트 | `<TEXTFIX_ROOT>/tools/embed-lint.mjs` |
