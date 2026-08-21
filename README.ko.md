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
  A[정적 HTML\n+ wz-editor 마커 블록] -->|연필 아이콘 클릭| B[비밀번호 게이트\nSHA-256 검증]
  B --> C[contenteditable 모드\n+ 리치텍스트 미니 툴바]
  C -->|1초 디바운스| D[localStorage\n자동 초안]
  C -->|저장 클릭| E[내장된 GitLab 토큰 복호화\nAES-GCM, 비밀번호 기반 키]
  E --> F[GitLab에서 최신 커밋본\n조회, 캐시 우회]
  F --> G[라이브 편집 내용과\nDOM 인덱스 기준 diff]
  G --> H[GitLab Files API로\nPUT 커밋]
```

"저장 클릭" 이전 단계는 전부 순수 클라이언트 DOM 조작입니다 — 네트워크
호출도, 토큰 사용도 없습니다. 저장을 눌렀을 때만, 그리고 GitLab 토큰이
설정되어 있을 때만 네트워크를 탑니다(아래 "보안 모델" 참조).

## 기능 목록

- **부착 / 탈착**: `</body>` 앞에 마커 블록(`<!-- wz-editor:start -->`
  ~ `<!-- wz-editor:end -->`) 하나만 삽입 — 기존 콘텐츠 무손상.
- **비밀번호 게이트**: SHA-256 해시로 편집 비밀번호를 검증(평문 비밀번호는
  코드에 남기지 않음).
- **인페이지 편집**: 문서 전역의 텍스트 요소를 `contenteditable`로 전환.
- **리치텍스트 미니 툴바**: 굵게, 글꼴, 크기, 색상(팔레트+자유 선택),
  정렬(좌/중/우).
- **localStorage 자동 초안**: 편집 중 1초 디바운스로 임시 저장, 새로고침해도
  복구 배너로 이어서 편집 가능.
- **GitLab 커밋 저장**: 비밀번호로 복호화한 프로젝트 액세스 토큰으로 GitLab
  Files API(`PUT .../repository/files/...`)를 호출해 원본 HTML에 diff를
  반영·커밋. 60초 이내 연속 저장은 자동 병합.
- **취소 / 저장 후 자동 종료**: 취소 시 페이지를 새로고침해 원상 복구,
  저장 성공 시 편집모드를 자동으로 빠져나옴.
- **탈착**: 마커 블록만 제거하면 완전히 원래 정적 HTML로 복귀(런타임 주입
  DOM/CSS이므로 문서 자체에는 흔적이 남지 않음).

## Quick Start (Claude Code 없이, 순수 JS 모듈로)

1. `wz-editor.js`를 대상 HTML 옆에 복사합니다 (예: `assets/js/wz-editor.js`).
2. `</body>` 바로 앞에 아래 블록을 삽입합니다.

   ```html
   <!-- wz-editor:start -->
   <script>
     window.WZ_EDITOR_CONFIG = {
       gitlabHost: 'https://gitlab.example.com',
       projectPath: 'your-group/your-repo',
       filePath: 'docs/report.html',
       branch: 'main',
       pwHashHex: '<편집 비밀번호의 SHA-256 16진 해시>',
       tokenSaltB64: '',
       tokenIvB64: '',
       tokenCipherB64: '',
       editableSelector: null
     };
   </script>
   <script src="assets/js/wz-editor.js"></script>
   <!-- wz-editor:end -->
   ```

   `pwHashHex`는 편한 방법으로 계산하면 됩니다 — 예를 들어 브라우저
   콘솔에서 `crypto.subtle.digest('SHA-256', new TextEncoder().encode('<비밀번호>'))`,
   또는 Node의 `crypto` 모듈로도 계산 가능합니다.

3. *(선택 — GitLab 커밋 저장 기능을 쓰려면)* GitLab **프로젝트 액세스
   토큰**을 발급합니다(Settings → Access Tokens, role: `Maintainer`,
   scope: `api`, 짧은 만료일 권장). 토큰을 **채팅에 붙여넣지 말고** 로컬
   파일에 저장한 뒤 다음을 실행합니다.

   ```
   node tools/encrypt-token.mjs --token-file token.txt "<편집 비밀번호>"
   ```

   출력된 세 값(`tokenSaltB64`, `tokenIvB64`, `tokenCipherB64`)을 위
   config에 붙여넣고, `token.txt`는 즉시 삭제합니다.

4. 페이지를 열고 우측 상단 연필 아이콘을 클릭 → 비밀번호 입력 → 편집 →
   저장합니다.

3번을 생략해도 GitLab 커밋 저장만 빠진 채 나머지는 전부 동작합니다 —
저장을 누르면 실패 토스트가 명확히 표시될 뿐, 편집 내용은 사라지지
않습니다(페이지와 localStorage 초안에 그대로 남습니다). 토큰 없이 동작하는
스켈레톤 예시는 `examples/embed-example.html`을 참고하세요.

## Claude Code 스킬로 사용하기

`skill/SKILL.md`를 프로젝트의 `.claude/skills/textfix/SKILL.md`로 복사하고
(문서 내 `wz-editor.js` / `tools/encrypt-token.mjs` 경로 참조를 이 저장소를
둔 실제 위치로 조정), Claude Code 세션에서 `/textfix <경로 또는 URL>`로
직접 호출하거나 "이 HTML에 편집 기능 붙여줘" 같은 자연어 요청으로도
트리거할 수 있습니다. 스킬은 대상이 remote가 있는 git 레포에 속하는지
판별 → 편집 비밀번호와 (선택적으로) GitLab 토큰 수집 → 마커 블록 삽입 →
원격에 손대기 전 로컬 검증 → 사용자의 명시적 확인 후에만 커밋/푸시,
순서로 진행됩니다.

## 보안 모델 (실제 문서에 쓰기 전에 반드시 읽으세요)

이 구조는 **클라이언트 측 비밀번호 게이트일 뿐, 진짜 접근 통제가
아닙니다.** 편집 비밀번호를 아는 사람은 누구나 브라우저 devtools에서
복호화된 GitLab 토큰 평문을 그대로 볼 수 있습니다. AES-GCM 암호화는
"비밀번호를 모르는 사람이 토큰을 못 본다"는 뜻일 뿐, 비밀번호를 아는
사람으로부터의 보호는 전혀 아닙니다.

구체적으로: 비밀번호로 파생한 AES-256-GCM 키가 브라우저 안에서 GitLab
프로젝트 액세스 토큰을 복호화하고, 브라우저는 그 토큰으로 GitLab Files
API를 직접 호출합니다.

- **내부망의 저위험 문서**에만 사용하세요 — 비밀번호를 아는 사람이라면
  누구든 편집해도 괜찮은 콘텐츠여야 합니다.
- GitLab 토큰의 스코프를 좁게 유지하세요: `api` 스코프, 단일 프로젝트,
  `Maintainer` role, 짧은 만료일 — 비밀번호가 새더라도 피해 범위를
  최소화합니다.
- 토큰을 채팅에 붙여넣거나 레포에 커밋하거나 CLI 인자로 넘기지 마세요 —
  `tools/encrypt-token.mjs`는 의도적으로 파일 경로로만 토큰을 읽습니다.
- 비밀번호나 토큰 유출이 의심되면 즉시 GitLab에서 토큰을 폐기(revoke)하고
  재발급하세요.
- 이 정도 위험을 감당할 수 없다면, 클라이언트 측 복호화+커밋 단계를
  토큰은 서버에만 보관하고 비밀번호만 받는 작은 서버사이드 프록시로
  교체하는 것을 권장합니다.

## 한계

- 진짜 접근 통제가 아닙니다 — 위 "보안 모델" 참조.
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
- GitLab 커밋 저장까지 쓰려면: 대상 레포의 로컬 clone + GitLab 프로젝트
  액세스 토큰(`Maintainer` role, `api` scope).

## 라이선스

MIT — [LICENSE](./LICENSE) 참조.
