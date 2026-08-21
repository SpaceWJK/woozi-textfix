---
name: textfix
description: 정적 HTML 문서(로컬 경로 또는 GitLab Pages URL)에 인페이지 편집 기능(wz-editor — 비밀번호 게이트 + 전역 contenteditable + 리치텍스트 툴바 + localStorage 초안 + GitLab 커밋 저장)을 부착/탈착한다. 트리거: "HTML에 편집 기능 붙여줘", "문서 직접 편집 가능하게", "textfix", "인페이지 편집 추가", "편집 버튼 달아줘", URL 또는 경로 제시 + "편집 기능/편집 가능하게" 조합. 탈착은 "/textfix --detach <경로>" 또는 "편집 기능 떼줘/제거해줘".
version: 0.1.0
---

<!--
  경로 표기 안내: 이 문서의 `<TEXTFIX_ROOT>`는 이 저장소(woozi-textfix)를 내려받아 둔
  루트 경로를 가리킨다. Claude Code 플러그인으로 패키징해 설치했다면 그 환경이 제공하는
  플러그인 루트 변수로 치환하고, 이 저장소를 프로젝트에 그대로 복사해 두었다면 그 복사
  경로를 직접 대입한다. 실물 파일 위치: `<TEXTFIX_ROOT>/wz-editor.js`,
  `<TEXTFIX_ROOT>/tools/encrypt-token.mjs`.
-->

# textfix — 인페이지 편집 기능 부착/탈착

정적 HTML 문서에 `wz-editor` 모듈(비밀번호 게이트 + contenteditable 편집 +
리치텍스트 미니 툴바 + localStorage 자동 초안 + GitLab Files API 커밋 저장 +
취소/저장-후-자동종료)을 마커 블록 하나로 부착하거나, 그 블록만 제거해
완전히 원복한다. 외부 의존성 0, 단일 파일 — 모듈 자체 설계는
`<TEXTFIX_ROOT>/wz-editor.js` 상단 주석 참조.

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

## Step 2. 모드 분기

### 2-A. 레포 소속 (git 레포 안, remote 존재)

`git remote`(인자 없이, 이름만)로 remote가 존재하는지 확인한다. 존재하면
**풀 기능**(부착 + GitLab 커밋 저장)으로 진행한다.

- `gitlabHost`: URL을 조회하지 않는다. 사용자에게 직접 묻는다
  (예: "GitLab 호스트가 `https://gitlab.example.com` 맞습니까?"). 이미 대상
  레포 안에 다른 wz-editor 임베드가 있으면 그 값을 그대로 재사용한다
  (아래 2-A 하위 항목 "기존 임베드 재사용" 참고 — 이 경우도 URL 조회 없이
  기존 config script 블록을 Read/Grep으로 읽는 것뿐이라 안전하다).
- `projectPath`: `git rev-parse --show-toplevel`로 얻은 레포 루트 폴더명,
  또는 사용자가 알고 있는 GitLab 네임스페이스/프로젝트 경로
  (예: `your-group/your-repo`)를 직접 확인받는다.
- `filePath`: 대상 HTML의 레포 루트 기준 상대 경로.
- `branch`: `git branch --show-current` (또는 `git rev-parse --abbrev-ref HEAD`).

### 2-B. 레포 밖 (git 레포가 아니거나 remote 없음)

저장 백엔드가 없다는 것을 명확히 고지한다:

> "이 문서는 git 레포에 속해 있지 않아 GitLab 커밋 저장 기능을 붙일 수
> 없습니다. 편집·리치텍스트 서식·localStorage 초안까지는 동작하지만,
> '저장' 버튼을 눌러도 서버에 반영되지 않습니다. 그래도 진행할까요?"

사용자가 진행에 동의하면 `WZ_EDITOR_CONFIG`에서 `tokenSaltB64`/`tokenIvB64`/
`tokenCipherB64`를 빈 문자열로 두고 부착한다(저장 클릭 시 wz-editor.js가
내부적으로 에러 토스트를 띄우며 실패하지만 편집 내용 자체는 유지됨 —
모듈 자체 동작, 별도 처리 불필요).

## Step 3. 자격 수집 (2-A 풀 기능일 때만)

1. **편집 비밀번호**: 사용자에게 입력받아 `crypto.subtle.digest('SHA-256', ...)`
   와 동일한 결과가 나오도록 SHA-256 16진 해시로 변환한다(`pwHashHex`).
   Node 환경이면 `node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "<비밀번호>"` 로 계산 가능하나,
   **비밀번호를 argv로 넘기는 이 방식도 프로세스 목록 조회 시 노출 경로가
   되므로**, 가능하면 Node REPL의 표준입력(stdin)으로 넘기거나 임시 스크립트
   파일에 넣어 실행 후 즉시 삭제하는 방식을 우선한다.
2. **GitLab 프로젝트 액세스 토큰**:
   - 대상 레포에 기존 wz-editor 임베드가 있으면, 그 config script의
     `tokenSaltB64`/`tokenIvB64`/`tokenCipherB64` 값을 그대로 재사용할지
     제안한다(단, 이 경우 **편집 비밀번호도 기존 값과 동일해야** 복호화가
     성공한다 — 새 비밀번호를 원하면 토큰도 새로 암호화해야 함을 사용자에게
     고지).
   - 기존 임베드가 없으면, 사용자에게 다음을 안내한다:
     1. GitLab 프로젝트 → Settings → Access Tokens에서 토큰 발급
        (권장 role: Maintainer, scope: `api`, 만료일 설정 권장).
     2. 발급된 토큰 문자열을 **채팅에 붙여넣지 말고** 로컬 파일에 저장
        (예: `token.txt`).
     3. `node "<TEXTFIX_ROOT>/tools/encrypt-token.mjs" --token-file <token.txt 경로> <편집 비밀번호>`
        실행 → 출력된 `tokenSaltB64`/`tokenIvB64`/`tokenCipherB64` 3값을 확보.
     4. **토큰 파일을 즉시 삭제**(`rm token.txt` 또는 탐색기에서 삭제) —
        Claude가 대신 지워도 되지만, 사용자가 직접 지웠는지 확인 문구를
        마지막에 남긴다.

## Step 4. 부착

전제: `<TEXTFIX_ROOT>/wz-editor.js` 실물이 존재해야 한다.

1. 대상 레포에 `assets/js/wz-editor.js`가 없으면
   `<TEXTFIX_ROOT>/wz-editor.js`를 그 경로로 복사한다
   (이미 있으면 그대로 참조 — 임의로 덮어쓰지 않는다. 버전 차이가 의심되면
   사용자에게 갱신 여부를 확인).
2. 대상 HTML에서 `</body>` 위치를 찾고, 그 직전에 마커 블록을 삽입한다:

   ```html
   <!-- wz-editor:start -->
   <script>
     window.WZ_EDITOR_CONFIG = {
       gitlabHost: 'https://<확인받은 호스트>',
       projectPath: '<네임스페이스>/<프로젝트>',
       filePath: '<레포 루트 기준 상대경로>',
       branch: '<현재 브랜치>',
       pwHashHex: '<Step 3에서 계산한 SHA-256 해시>',
       tokenSaltB64: '<Step 3 출력>',
       tokenIvB64: '<Step 3 출력>',
       tokenCipherB64: '<Step 3 출력>',
       editableSelector: null
     };
   </script>
   <script src="<문서 기준 wz-editor.js 상대경로>"></script>
   <!-- wz-editor:end -->
   ```

   `src`의 상대경로는 대상 HTML 파일 위치를 기준으로 계산한다(예: 문서가
   레포 루트에 있으면 `assets/js/wz-editor.js`, 하위 폴더에 있으면
   `../../assets/js/wz-editor.js` 등).
3. 삽입 외 어떤 기존 콘텐츠도 건드리지 않는다(Surgical Changes — 요청에
   직결된 줄만 수정).

## Step 5. 검증

1. 로컬에서 `python -m http.server` (또는 동등 도구)로 대상 디렉터리를
   서빙하고, 부착한 HTML을 브라우저(Claude Browser MCP 등)로 열어 확인:
   - 우측 상단 연필 아이콘(FAB)이 보이는가
   - 클릭 시 비밀번호 모달이 뜨는가, 올바른 비밀번호로 편집모드 진입하는가
   - 편집모드에서 텍스트 수정 → 저장 시 토스트/에러가 예상대로 뜨는가
     (레포 밖 모드면 실패 토스트가 정상 — 에러 아님)
2. `git diff`로 실제 삽입된 내용이 마커 블록(`<!-- wz-editor:start -->`~
   `<!-- wz-editor:end -->`)뿐인지 확인한다 — 기존 콘텐츠 무손상 검증.
3. 커밋/푸시는 **사용자 확인 후에만** 진행한다(저장소에 대한 쓰기 작업이므로
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

- 비밀번호를 아는 사람은 누구나 브라우저 devtools에서 복호화된 토큰
  평문을 볼 수 있다. AES-GCM 암호화는 "비밀번호를 몰라도 토큰을 못 본다"는
  뜻일 뿐, 비밀번호 아는 내부자로부터의 보호는 아니다.
- 이 구조는 **내부망 저위험 문서** 용도로만 사용한다. 토큰은 해당 레포
  한정 스코프(`api`)와 만료일을 설정해 피해 범위를 제한할 것을 권장한다.
- 토큰 원문은 채팅, argv, 스킬 산출물 어디에도 남기지 않는다. 유출 의심
  시 즉시 GitLab에서 토큰을 폐기(revoke)하고 재발급한다.

## 산출물 경로 요약

| 항목 | 경로 |
|------|------|
| wz-editor 모듈 실물 | `<TEXTFIX_ROOT>/wz-editor.js` (부착 시 대상 레포로 복사) |
| 토큰 암호화 도구 | `<TEXTFIX_ROOT>/tools/encrypt-token.mjs` |
