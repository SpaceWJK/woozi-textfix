# textfix

정적 HTML 문서에 마커 블록 하나로 **인페이지 편집 기능**을 붙이는
도구입니다. 문서를 연 상태에서 우측 상단 연필 아이콘을 눌러 비밀번호를
입력하고, 그 자리에서 텍스트를 직접 고쳐 GitLab에 커밋으로 저장할 수
있습니다. 별도 개발 환경이나 CMS 없이, 이미 배포된 정적 보고서/문서에
편집 기능만 얇게 얹는 용도입니다. 외부 의존성 0의 단일 JS 모듈
(`wz-editor.js`)이며, `skill/` 폴더는 부착·탈착 과정을 자동화하는
선택적 Claude Code 스킬입니다.

([English README](./README.md))

## 동작 원리

```mermaid
flowchart LR
  A[정적 HTML\n+ wz-editor 마커 블록] -->|연필 아이콘 클릭| B[비밀번호 게이트:\n토큰 복호화\nAES-GCM]
  B --> C[contenteditable 모드\n+ 리치텍스트 미니 툴바]
  C -->|1초 디바운스| D[localStorage\n자동 초안]
  C -->|저장 클릭| E[암호화된 토큰 복구\nAES-GCM, 비밀번호 기반 키]
  E --> F[GitLab/GitHub에서\n최신 커밋본 조회, 캐시 우회]
  F --> G[라이브 편집 내용과\nDOM 인덱스 기준 diff]
  G --> H[Files API로\nPUT 커밋]
```

"저장 클릭" 이전 단계는 전부 순수 클라이언트 DOM 조작입니다 — 네트워크
호출도, 토큰 사용도 없습니다. 저장을 눌렀을 때만, 그리고 GitLab 또는
GitHub 토큰이 설정되어 있을 때만 네트워크를 탑니다(아래 "보안 모델" 참조).

## 기능 목록

- **부착 / 탈착**: `</body>` 앞에 마커 블록(`<!-- wz-editor:start -->`
  ~ `<!-- wz-editor:end -->`) 하나만 삽입 — 기존 콘텐츠 무손상.
- **기본값 = 범용 편집**: 문서마다 편집 대상을 지정할 필요가 없습니다 —
  보이는 텍스트를 가진 요소는 전부 자동으로 편집 대상이 됩니다. 편집기
  자신의 UI와 `script`/`style`/`template`만 예외입니다. 특정 요소만 편집
  가능하게 좁히려면 config의 `editableSelector`에 CSS 셀렉터를 지정할 수
  있습니다(고급, 선택 사항).
- **비밀번호 게이트**: 편집 비밀번호로 내장된 토큰을 AES-256-GCM으로
  복호화(비밀번호 자체는 문서에 저장되지 않음).
- **인페이지 편집**: 대상 텍스트 요소를 `contenteditable`로 전환.
- **리치텍스트 미니 툴바**: 굵게, 글꼴, 크기, 색상(팔레트+자유 선택),
  정렬(좌/중/우).
- **붙여넣기 새니타이즈**: 편집기에 붙여 넣거나 드롭한 HTML에서 스크립트,
  이벤트 핸들러, 위험한 URL(`javascript:`, `data:` 등)을 제거하고 저장
  (XSS 방지).
- **localStorage 자동 초안**: 편집 중 1초 디바운스로 임시 저장, 새로고침해도
  복구 배너로 이어서 편집 가능. 초안은 7일 후 자동 만료.
- **GitLab/GitHub 커밋 저장**: 비밀번호로 복호화한 프로젝트 액세스 토큰으로
  Files API(`PUT .../repository/files/...`)를 호출해 원본 HTML에 diff를
  반영·커밋. 60초 이내 연속 저장은 자동 병합.
- **저장 후 실배포 추적 배너**: 저장 성공 직후 "배포 중" 상태로 시작해
  GitLab 파이프라인 또는 GitHub 커밋 상태 API를 폴링하며 "배포 완료"까지
  갱신됩니다(커밋이 저장됐다는 것과 실제로 사이트에 반영됐다는 것을 구분).
  폴링은 성공/실패가 확정되거나 시도 예산이 소진되면 멈추고, 네트워크
  오류가 나도 편집 흐름을 막지 않도록 항상 "대기중"으로 물러날 뿐 예외를
  던지지 않습니다.
- **재편집 가드**: 방금 저장한 내용이 아직 배포 확인 전(15분 이내, 상태가
  아직 pending으로 확인될 때)인 상태로 같은 문서를 다시 편집 진입하면
  경고를 표시합니다.
- **취소 / 저장 후 자동 종료**: 취소 시 페이지를 새로고침해 원상 복구,
  저장 성공 시 편집모드를 자동으로 빠져나옴.
- **탈착**: 마커 블록만 제거하면 완전히 원래 정적 HTML로 복귀(런타임 주입
  DOM/CSS이므로 문서 자체에는 흔적이 남지 않음).

## 셋업(레포당 1회) vs. 일상 사용

아래 1~5단계는 **문서/레포당 최초 1회만** 필요한 셋업입니다: 토큰 발급 →
암호화 → 부착. 이게 끝나면, 그 다음부터 편집할 때는 문서 URL과 편집
비밀번호만 있으면 됩니다 — 토큰은 만료되거나 교체하기 전까지 다시 다룰
필요가 없습니다.

## Quick Start (Claude Code 없이, 순수 JS 모듈로)

1. `wz-editor.js`를 대상 HTML 옆에 복사합니다 (예: `assets/js/wz-editor.js`).

2. 쓰기 토큰을 발급합니다:
   - **GitLab 프로젝트 액세스 토큰**(Settings → Access Tokens). 대상
     브랜치(보통 `main`)가 **protected**면 role은 **Maintainer 필수**
     입니다 — `Developer` 토큰은 저장 시 `400 You are not allowed to push
     into this branch`로 실패합니다(실제 protected 브랜치 프로젝트에서
     확인). protected가 아니면 `Developer`도 되지만, `Maintainer`를
     권장합니다. scope는 **`api` 하나만** — 저장이 REST
     API(`/repository/files`, `/commits`) 경유라 `api`가 필요하고
     `write_repository`(git-over-HTTP 전용)는 도움이 안 됩니다. 짧은
     만료일 권장.
   - **GitHub fine-grained 개인 액세스 토큰**: 대상 레포로 한정,
     **Contents: Read and write** 권한(또는 classic 토큰의 `repo` scope).

   토큰을 로컬 파일(예: `token.txt`)에 저장하거나 — 여러 문서에 부착할
   계획이면 — OS 환경변수로 등록해두면(예: Windows에서
   `setx TEXTFIX_TOKEN "<토큰>"` 후 새 터미널에서 사용) 문서마다 GitLab/
   GitHub 설정 페이지에서 토큰을 다시 찾아올 필요가 없습니다.

3. **stdin으로 토큰을 암호화합니다**(셸 인자로 비밀번호를 넘기지 않습니다 —
   셸 히스토리와 프로세스 목록 노출 차단):

   ```bash
   # 파일에서:
   node tools/encrypt-token.mjs --token-file token.txt --password-stdin
   # ...또는 환경변수에서 (argv에는 변수 "이름"만 실리고, 값은 스크립트가
   # process.env에서 직접 읽습니다):
   node tools/encrypt-token.mjs --token-env TEXTFIX_TOKEN --password-stdin
   # 프롬프트에 비밀번호를 입력합니다
   ```

   이렇게 하면 비밀번호(그리고 토큰 자체)가 셸 히스토리나 프로세스 목록에
   노출되지 않습니다. 도구는 세 값을 출력합니다: `tokenSaltB64`,
   `tokenIvB64`, `tokenCipherB64`.

4. HTML의 `</body>` 바로 앞에 아래 블록을 삽입합니다.

   **GitLab 예시:**
   ```html
   <!-- wz-editor:start -->
   <script>
     window.WZ_EDITOR_CONFIG = {
       provider: 'gitlab',
       gitlabHost: 'https://gitlab.example.com',
       projectPath: 'your-group/your-repo',
       filePath: 'docs/report.html',
       branch: 'main',
       tokenSaltB64: '<encrypt-token.mjs의 출력>',
       tokenIvB64: '<encrypt-token.mjs의 출력>',
       tokenCipherB64: '<encrypt-token.mjs의 출력>',
       allowedHosts: ['https://gitlab.example.com'],
       editableSelector: null
     };
   </script>
   <script src="assets/js/wz-editor.js"></script>
   <!-- wz-editor:end -->
   ```

   🔴 `allowedHosts`는 **origin**(`new URL(host).origin`, 예
   `https://gitlab.example.com` — GitHub Enterprise도 경로 제외)이어야
   합니다. 호스트명만 넣으면 검증에 조용히 실패해 연필 아이콘이 아예
   뜨지 않습니다. `node tools/embed-lint.mjs <경로>`로 부착 전에 미리
   잡을 수 있습니다.

   **GitHub 예시:**
   ```html
   <!-- wz-editor:start -->
   <script>
     window.WZ_EDITOR_CONFIG = {
       provider: 'github',
       apiBase: 'https://api.github.com',
       projectPath: 'owner/repo',
       filePath: 'docs/report.html',
       branch: 'main',
       tokenSaltB64: '<encrypt-token.mjs의 출력>',
       tokenIvB64: '<encrypt-token.mjs의 출력>',
       tokenCipherB64: '<encrypt-token.mjs의 출력>',
       allowedHosts: ['https://api.github.com'],
       editableSelector: null
     };
   </script>
   <script src="assets/js/wz-editor.js"></script>
   <!-- wz-editor:end -->
   ```

5. `--token-file`을 썼다면 `token.txt`를 삭제합니다. 그리고 브라우저를
   열기 전에 부착 상태를 검증합니다:

   ```bash
   node tools/embed-lint.mjs path/to/report.html
   ```

   `tokenCipherB64` 존재, host가 `https://`, `allowedHosts`에 그 host의
   origin 포함, `<script src>` 경로가 실제로 존재하는지 4가지를
   확인합니다 — 이 넷은 전부 조용히 실패하는 유형이라(연필 아이콘이 그냥
   안 뜰 뿐, 화면에 에러가 안 보임) 사전 검증이 유용합니다.

6. 페이지를 열고 우측 상단 연필 아이콘을 클릭 → 비밀번호 입력 → 편집 →
   저장합니다. 변경 내용이 저장소에 커밋되고, 상태 배너가 "배포 중"에서
   "배포 완료"까지 진행을 추적합니다.

## Claude Code 스킬로 사용하기

`skill/SKILL.md`를 프로젝트의 `.claude/skills/textfix/SKILL.md`로 복사하고
(문서 내 `wz-editor.js` / `tools/encrypt-token.mjs` 경로 참조를 이 저장소를
둔 실제 위치로 조정), Claude Code 세션에서 `/textfix <경로 또는 URL>`로
직접 호출하거나 "이 HTML에 편집 기능 붙여줘" 같은 자연어 요청으로도
트리거할 수 있습니다. 스킬은 대상이 remote가 있는 git 레포에 속하는지
판별 → 편집 비밀번호와 GitLab 또는 GitHub 토큰 수집 → 마커 블록 삽입 →
원격에 손대기 전 로컬 검증 → 사용자의 명시적 확인 후에만 커밋/푸시,
순서로 진행됩니다.

## 보안 모델 (실제 문서에 쓰기 전에 반드시 읽으세요)

이 구조는 **클라이언트 측 비밀번호 게이트일 뿐, 진짜 접근 통제가
아닙니다.** 편집 비밀번호를 아는 사람은 누구나 브라우저 devtools에서
복호화된 토큰 평문을 그대로 볼 수 있습니다. AES-GCM 암호화는
"비밀번호를 모르는 사람이 토큰을 못 본다"는 뜻일 뿐, 비밀번호를 아는
사람으로부터의 보호는 전혀 아닙니다.

**암호화:**
- 비밀번호를 PBKDF2(600,000회 반복)로 스트레칭하여 AES-256-GCM 키를 파생합니다.
- 이 키가 브라우저 안에서 GitLab 프로젝트 액세스 토큰 (또는 GitHub 개인
  액세스 토큰)을 복호화합니다.
- 브라우저는 그 토큰으로 GitLab/GitHub Files API를 직접 호출합니다.

**권장 사항:**
- **내부망의 저위험 문서**에만 사용하세요 — 비밀번호를 아는 사람이라면
  누구든 편집해도 괜찮은 콘텐츠여야 합니다.
- 토큰의 스코프를 좁게 유지하세요:
  - **GitLab:** `api` 스코프, 단일 프로젝트, 짧은 만료일. role은 대상
    브랜치에 따라 달라집니다 — **protected 브랜치**(보통 `main`)면
    **Maintainer**가 필요합니다. `Developer` 토큰은 GitLab이 저장 시점에
    `400 You are not allowed to push into this branch`로 거부합니다.
    낮은 role이 항상 "더 안전"한 게 아니라, protected 브랜치 앞에서는
    그냥 "작동 안 함"입니다.
  - **GitHub:** fine-grained PAT with **Contents: Read and write** 권한(또는
    classic 토큰의 `repo` scope).
- config의 `allowedHosts`를 설정해 토큰이 당신의 서버 도메인으로만
  전송되도록 잠가두세요(토큰 실수로 다른 호스트에 유출되는 것 방지).
  **origin**(예: `https://gitlab.example.com`) 형식이어야 하며, 호스트명만
  넣으면 안 됩니다 — `tools/embed-lint.mjs`가 이를 대신 검증해줍니다.
- 토큰을 채팅에 붙여넣거나 레포에 커밋하거나 CLI 인자로 넘기지 마세요 —
  `tools/encrypt-token.mjs`는 파일 경로 또는 환경변수 "이름"으로만 토큰을
  읽습니다(값 자체는 절대 argv에 실리지 않음). `--password-stdin`을
  사용해 비밀번호를 셸 히스토리에 남기지 마세요.
- 비밀번호나 토큰 유출이 의심되면 즉시 GitLab/GitHub 설정에서 토큰을
  폐기하고 재발급하세요.
- 이 정도 위험을 감당할 수 없다면, 클라이언트 측 복호화+커밋 단계를
  토큰은 서버에만 보관하고 비밀번호만 받는 작은 서버사이드 프록시로
  교체하는 것을 권장합니다.

### 브라우저에 저장되는 로컬 데이터

wz-editor가 남기는 데이터는 전부 브라우저 **localStorage**(문서가 열린
사이트 origin에 귀속, 서버·레포·다른 사이트로 전송되지 않음)에 한정되며
문서 경로별로 네임스페이스된 두 종류입니다:

- **초안(draft)**: 위에서 설명한, 저장 전 이탈에 대비한 편집 중 내용
  백업. 7일 후 자동 만료.
- **최근 저장 기록**: 문서당 1개(~100바이트, `{문서 경로, 커밋 SHA,
  시각}`)만 저장되며, 아직 배포가 끝나지 않은 저장 위에 다시 편집을
  시작하기 전 경고할지 판단하는 용도로만 쓰입니다(위 "재편집 가드" 참조).
  사용자가 직접 열람하는 용도가 아닙니다.
- 최근 저장 기록은 15분이 지나거나 원격에서 새 커밋이 감지되면 자동
  삭제되어 계속 쌓이지 않습니다.
- **토큰·비밀번호는 두 종류 어디에도 저장되지 않습니다.**
- 수동으로 지우려면 브라우저의 "사이트 데이터 삭제" 기능을 그 문서의
  origin에 대해 사용하면 됩니다.

### 보안 검수 증빙

배포 전 아래 핵심 항목을 검수했습니다.

| 검증 항목 | 검수 방법 | 결과 |
|-----------|-----------|------|
| 문서 무단 저장 경로 없음 | localStorage/IndexedDB/cookie/파일쓰기/원격 로깅 grep 전수 + 코드 통독 | **PASS** |
| 외부 유출 경로 없음 | fetch/XHR/sendBeacon/WebSocket/추적 픽셀 grep 전수 — 네트워크 호출은 설정된 저장소 API로만 한정 | **PASS** |
| 토큰 암호화 설계 | PBKDF2-SHA256 600,000회 + AES-256-GCM(랜덤 salt/IV) 코드 통독 + 암복호 라운드트립 | **PASS** |
| 비밀번호 검증자 | 인증=토큰 복호화 성공(별도 비밀번호 해시 미게시 → 오프라인 크랙 표면 없음) 코드 통독 + 분석 | **PASS** |

## 한계

- 진짜 접근 통제가 아닙니다 — 위 "보안 모델" 참조.
- **순수 로컬 파일(git 저장소 밖)은 지원되지 않습니다.** 편집기는 GitLab/GitHub API를
  통해 저장이 필요하므로, HTML이 remote가 설정된 git 저장소 안에 있어야
  합니다. 브라우저 보안 정책도 직접 로컬 파일 쓰기를 막고 있습니다.
- diff는 DOM 인덱스 기준입니다. 로드 시점과 저장 시점 사이에 라이브
  문서와 최신 커밋본의 구조가 어긋나면, 일부만 반영하지 않고 저장 전체를
  거부합니다(부분 반영이 아니라 안전 실패).
- 최신 브라우저가 필요합니다(Web Crypto API `crypto.subtle`).
- 탈착은 마커 블록만 제거합니다. `wz-editor.js`를 대상 레포에도
  복사했다면, 다른 문서가 참조하고 있을 수 있으므로 그 파일 자체는
  남겨둡니다 — 더 이상 필요 없다면 수동으로 삭제하세요.

## 요구사항

- Node.js — `tools/encrypt-token.mjs` 실행용(내장 `crypto`/`fs` 모듈만
  사용, `npm install` 불필요).
- 최신 evergreen 브라우저.
- GitLab/GitHub 커밋 저장까지 쓰려면: 대상 레포의 로컬 clone + 다음 중 하나:
  - **GitLab 프로젝트 액세스 토큰**(브랜치가 protected면 `Maintainer`
    role, `api` scope), 또는
  - **GitHub 개인 액세스 토큰**(fine-grained with Contents R/W scope, 또는
    classic with `repo` scope).

## 라이선스

MIT — [LICENSE](./LICENSE) 참조.
