# textfix

In-page editing for static HTML documents, attached with a single marker
block. Open a static report or dashboard in the browser, click the pencil
icon, enter a password, edit the text right there, and save straight to a
GitLab commit — no build step, no CMS, no separate editor app. It's a
single-file JS module (`wz-editor.js`) with zero dependencies; the
`skill/` folder is an optional Claude Code skill that automates attaching
and detaching it.

([한국어 문서](./README.ko.md))

## How it works

```mermaid
flowchart LR
  A[Static HTML\n+ wz-editor marker block] -->|click pencil icon| B[Password gate:\ndecrypt embedded token\nAES-GCM]
  B --> C[contenteditable mode\n+ rich-text mini toolbar]
  C -->|1s debounce| D[localStorage\nautosave draft]
  C -->|click Save| E[Recover encrypted token\nAES-GCM, password-derived key]
  E --> F[Fetch latest committed file\nfrom GitLab/GitHub, cache-busted]
  F --> G[Diff by DOM index\nagainst live edits]
  G --> H[PUT via Files API\ncommit to GitLab/GitHub]
```

Everything left of the "click Save" step is pure client-side DOM
manipulation — no network calls, no token involved. Only pressing Save
touches the network, and only if a GitLab or GitHub token was configured
(see Security model below).

## Features

- **Attach / detach** via a single marker block
  (`<!-- wz-editor:start -->` … `<!-- wz-editor:end -->`) inserted before
  `</body>` — existing content is left untouched.
- **Password gate** — the edit password decrypts an embedded token using
  AES-256-GCM; the password itself is never stored in the document.
- **In-page editing** — turns the document's text elements into
  `contenteditable` regions.
- **Rich-text mini toolbar** — bold, font family, size, color (palette +
  free picker), alignment (left/center/right).
- **Paste sanitization** — HTML pasted or dropped into the editor has
  scripts, event handlers, and dangerous URLs (`javascript:`, `data:` etc.)
  stripped before saving (XSS prevention).
- **localStorage autosave draft** — 1-second debounce while editing, with a
  recovery banner on reload so you don't lose work. Drafts auto-expire after
  7 days.
- **GitLab/GitHub commit save** — decrypts an embedded project access token
  with the edit password, then calls the Files API (`PUT .../repository/files/...`) 
  to commit the diff. Saves within a 60-second window auto-merge instead of racing.
- **Cancel / auto-exit on save** — Cancel reloads the page to discard
  changes; a successful save automatically exits edit mode.
- **Clean detach** — everything the module renders is injected at runtime,
  so removing the marker block alone fully restores the original static
  document.

## Quick Start (plain JS module — no Claude Code required)

1. Copy `wz-editor.js` next to your HTML, e.g. as `assets/js/wz-editor.js`.

2. Generate a **GitLab Project Access Token** (Settings → Access Tokens;
   role `Developer`, scope `api`, short expiration recommended) or a
   **GitHub fine-grained Personal Access Token** (Contents: Read and write,
   or classic token with `repo` scope). Save it to a local file.

3. Encrypt the token with your chosen edit password using **stdin** (not shell args):

   ```bash
   node tools/encrypt-token.mjs --token-file token.txt --password-stdin
   # Then type your password when prompted
   ```

   This avoids exposing the password in shell history or process lists. The tool
   outputs three values: `tokenSaltB64`, `tokenIvB64`, `tokenCipherB64`.

4. Insert this block right before `</body>` in your HTML:

   **GitLab example:**
   ```html
   <!-- wz-editor:start -->
   <script>
     window.WZ_EDITOR_CONFIG = {
       provider: 'gitlab',
       gitlabHost: 'https://gitlab.example.com',
       projectPath: 'your-group/your-repo',
       filePath: 'docs/report.html',
       branch: 'main',
       tokenSaltB64: '<output from encrypt-token.mjs>',
       tokenIvB64: '<output from encrypt-token.mjs>',
       tokenCipherB64: '<output from encrypt-token.mjs>',
       allowedHosts: ['gitlab.example.com'],
       editableSelector: null
     };
   </script>
   <script src="assets/js/wz-editor.js"></script>
   <!-- wz-editor:end -->
   ```

   **GitHub example:**
   ```html
   <!-- wz-editor:start -->
   <script>
     window.WZ_EDITOR_CONFIG = {
       provider: 'github',
       apiBase: 'https://api.github.com',
       projectPath: 'owner/repo',
       filePath: 'docs/report.html',
       branch: 'main',
       tokenSaltB64: '<output from encrypt-token.mjs>',
       tokenIvB64: '<output from encrypt-token.mjs>',
       tokenCipherB64: '<output from encrypt-token.mjs>',
       allowedHosts: ['api.github.com'],
       editableSelector: null
     };
   </script>
   <script src="assets/js/wz-editor.js"></script>
   <!-- wz-editor:end -->
   ```

5. Delete `token.txt` after inserting the config.

6. Open the page, click the pencil icon (top-right), enter the password,
   edit, and Save. Your changes are committed directly to the repository.

## Using it as a Claude Code skill

Copy `skill/SKILL.md` into your project's `.claude/skills/textfix/SKILL.md`
(update the `wz-editor.js` / `tools/encrypt-token.mjs` path references
inside it to wherever you keep this repo), then from a Claude Code session
either run `/textfix <path-or-url>` or ask in plain language — e.g. "add
in-page editing to this HTML." The skill walks through: detecting whether
the target belongs to a git repo with a remote, collecting the edit
password and a GitLab or GitHub token, inserting the marker block,
verifying locally before touching anything remote, and only committing /
pushing after you explicitly confirm.

## Security model (read before using this on anything real)

This is a **client-side password gate, not access control.** Whoever knows
the edit password can open browser devtools and read the decrypted token in
plaintext. AES-GCM here only stops someone *without* the password from
reading the token — it does nothing against someone who has it.

**Encryption:**
- Password is stretched via PBKDF2 (600,000 iterations) into an
  AES-256-GCM key.
- This key decrypts a GitLab Project Access Token (or GitHub Personal Access
  Token) inside the browser.
- The browser then talks directly to the GitLab/GitHub Files API with the
  decrypted token.

**Best practices:**
- Use this only on **low-risk, internal-network documents** — content
  you'd be fine with anyone who has the password editing.
- Scope tokens narrowly:
  - **GitLab:** `api` scope, a single project, `Developer` role (sufficient
    for file commits), and a short expiration date.
  - **GitHub:** fine-grained PAT with **Contents: Read and write** scope (or
    classic token with `repo` scope).
- Set `allowedHosts` in the config to lock the token to your server's
  domain, preventing accidental token leaks to other hosts.
- Never paste the token into chat, commit it to a repo, or pass it as a CLI
  argument — `tools/encrypt-token.mjs` only reads it from a file path you
  give it, by design. Use `--password-stdin` to avoid exposing the password
  in shell history.
- Autosaved drafts in localStorage expire after 7 days; no cleanup is
  required.
- If you suspect the password or token leaked, revoke it immediately in
  GitLab/GitHub settings.
- For anything beyond that risk tolerance, replace the client-side
  decrypt-and-commit step with a small server-side proxy that holds the
  token and only ever accepts the password from the client.

### Security review evidence

Core items reviewed before release:

| Check | Method | Result |
|-------|--------|--------|
| No unauthorized document persistence | Full grep of localStorage/IndexedDB/cookie/file-write/remote-logging + source read | **PASS** |
| No external exfiltration path | Full grep of fetch/XHR/sendBeacon/WebSocket/tracking-pixel — network calls limited to the configured repo API only | **PASS** |
| Token encryption design | PBKDF2-SHA256 600,000 iterations + AES-256-GCM (random salt/IV) source read + encrypt/decrypt round-trip | **PASS** |
| Password verifier | Auth = successful token decryption (no separate password hash is published → no offline-crack surface) source read + analysis | **PASS** |

## Limitations

- No real access control — see Security model above.
- **Pure local files (outside a git repository) are not supported.** The
  editor requires saving via GitLab/GitHub API, which means the HTML must
  be in a git repository with a remote configured. Browser security policies
  prevent direct local file writes anyway.
- Diffing is DOM-index based: if the live document's structure and the
  latest committed version have drifted apart between load and save, the
  whole save is rejected rather than partially applied (fails closed, does
  not partial-write).
- Requires a modern browser (Web Crypto API, `crypto.subtle`).
- Detach only removes the marker block. If you also copied `wz-editor.js`
  into the target repo, that file itself is left in place in case other
  documents reference it — delete it manually if it's no longer needed.

## Requirements

- Node.js, for `tools/encrypt-token.mjs` — uses only the built-in
  `crypto`/`fs` modules, no `npm install` needed.
- A modern evergreen browser.
- GitLab/GitHub commit-save additionally needs a local clone of the target
  repo and either:
  - A **GitLab Project Access Token** (`Developer` role, `api` scope), or
  - A **GitHub Personal Access Token** (fine-grained with Contents R/W scope,
    or classic with `repo` scope).

## License

MIT — see [LICENSE](./LICENSE).
