/*!
 * wz-editor.js — in-page text editor module
 * Password gate + contenteditable edit mode + rich-text mini toolbar (bold/font/size/color/align)
 * + localStorage autosave draft (with recovery banner) + GitLab commit save + cancel/auto-exit-on-save.
 * Zero external dependencies, single file, all CSS/HTML self-injected — can be attached to and
 * detached from any static HTML document.
 *
 * ===== Usage (embed block to add to the host document, 3-4 lines) =====
 *   <!-- wz-editor:start -->
 *   <script>
 *     window.WZ_EDITOR_CONFIG = {
 *       gitlabHost: 'https://gitlab.example.com',       // must be https when a token is embedded (enforced at init)
 *       projectPath: 'your-group/your-repo',           // URL-encoded internally by the module
 *       filePath: 'docs/report.html',                   // path relative to the repo root
 *       branch: 'main',
 *       tokenSaltB64: '<output of tools/encrypt-token.mjs>',
 *       tokenIvB64: '<output of tools/encrypt-token.mjs>',
 *       tokenCipherB64: '<output of tools/encrypt-token.mjs>',   // required -- see below
 *       // allowedHosts: ['https://gitlab.example.com']  // optional: restrict gitlabHost to this origin allowlist
 *       editableSelector: null   // null = module's default heuristic; set a CSS selector to override
 *     };
 *   </script>
 *   <script src="assets/js/wz-editor.js"></script>
 *   <!-- wz-editor:end -->
 *
 * Detach: removing only the block between the marker comments restores the host document to
 * a fully static state (everything this module renders is injected at runtime, so nothing is
 * left behind in the document itself).
 *
 * ===== Security note (read this even at the placeholder stage) =====
 * Decrypting a token client-side with a password and then having the browser call the GitLab
 * write API directly is not real access control, even with AES-GCM in front of it — anyone who
 * knows the password can open devtools and read the decrypted token in plaintext. Before wiring
 * up a real token for anything beyond low-risk internal documents, strongly consider replacing
 * the client-side decrypt+commit with a server-side proxy that only accepts the password and
 * keeps the token server-side.
 *
 * B: textfix is GitLab/GitHub-repo-document editing only -- there is no token-less "local/demo"
 * mode. A tokenCipherB64 is required for the module to attach at all; without a real storage
 * backend to save to, there is nothing for this editor to usefully do.
 */
(function(){
  'use strict';

  var CFG = window.WZ_EDITOR_CONFIG || {};
  // B: tokenCipherB64 is mandatory -- there is no token-less fallback mode (removed; see the
  // header comment above). Auth is decrypt-success-only (F-1): the AES-GCM auth tag itself is the
  // password verifier, so there is no separate password-hash config to publish or maintain.
  if (!CFG.tokenCipherB64) {
    console.warn('[wz-editor] WZ_EDITOR_CONFIG.tokenCipherB64 is missing -- a GitLab/GitHub storage backend is required. Module will not initialize.');
    return;
  }

  var GITLAB_HOST = CFG.gitlabHost || 'https://gitlab.example.com';
  var GITLAB_PROJECT_PATH = CFG.projectPath || '';
  var GITLAB_FILE_PATH = CFG.filePath || '';
  var GITLAB_BRANCH = CFG.branch || 'main';
  var TT_SALT_B64 = CFG.tokenSaltB64 || '';
  var TT_IV_B64 = CFG.tokenIvB64 || '';
  var TT_CIPHERTEXT_B64 = CFG.tokenCipherB64 || '';
  var DRAFT_KEY = 'wzEditorDraft::' + (GITLAB_FILE_PATH || location.pathname);
  var SAVE_MERGE_WINDOW_MS = 60000;
  var DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // R-3: stale local drafts older than 7 days are dropped, not restored.

  // Storage backend provider selection. Explicit CFG.provider wins; otherwise infer from
  // whichever host-ish config value was given, so existing GitLab embeds (no provider field)
  // keep working unchanged. projectPath stays 'owner/repo' for GitHub, same shape as GitLab's
  // 'namespace/project'.
  var PROVIDER = (CFG.provider || '').toLowerCase();
  if (!PROVIDER) {
    // N-4: exact-hostname match, not substring -- a naive /github\.com/.test() would misclassify
    // an attacker-controlled host like "https://github.com.evil.com" (a valid hostname whose
    // *label* is "evil.com" under a "github.com" *subdomain*, not github.com itself) as the
    // github provider, which then determines what host receives the Authorization: Bearer token.
    var hostHint = CFG.gitlabHost || CFG.apiBase || '';
    var inferredIsGithub = false;
    try {
      var hostHintHostname = new URL(hostHint).hostname.toLowerCase();
      inferredIsGithub = (hostHintHostname === 'github.com' || hostHintHostname === 'api.github.com' || hostHintHostname.slice(-'.githubusercontent.com'.length) === '.githubusercontent.com');
    } catch (e) {
      inferredIsGithub = false;
    }
    // m-1: a self-hosted GitHub Enterprise Server apiBase (a custom domain, not github.com /
    // api.github.com / *.githubusercontent.com) fails every hostname check above and used to fall
    // straight through to 'gitlab' -- silently wrong, since GITLAB_HOST would then resolve to its
    // own truthy placeholder default ('https://gitlab.example.com') rather than the intended host.
    // apiBase is GitHub's config key (GitLab's analogous key is gitlabHost); an embed that gives
    // apiBase but no gitlabHost at all is an explicit GitHub signal even when the hostname itself
    // doesn't match the well-known github.com family.
    if (!inferredIsGithub && CFG.apiBase && !CFG.gitlabHost) {
      inferredIsGithub = true;
    }
    PROVIDER = inferredIsGithub ? 'github' : 'gitlab';
  }
  var API_BASE = CFG.apiBase || (PROVIDER === 'github' ? 'https://api.github.com' : GITLAB_HOST);

  // R1 (partial -- see fetchLatest()/commitFile() below for why it stops here): per-provider host
  // lookup, replacing the `PROVIDER === 'github' ? A : B` ternary this line used to be with a table.
  // This table intentionally does NOT also take over dispatching to fetchLatestGitHub/
  // fetchLatestGitLab/commitGitHub/commitToGitLab -- those functions (and the fetchLatest/commitFile
  // ternaries that pick between them) are individually extracted from this source file's text and
  // run in isolated vm sandboxes by existing regression tests (test-github-provider.mjs,
  // test-a-error-body-redaction.mjs) that do not include a PROVIDERS declaration in what they
  // extract; a dispatch body referencing PROVIDERS there throws "PROVIDERS is not defined" even
  // though it works fine when this file loads normally. This line isn't part of any such extraction,
  // so it's free to route through PROVIDERS.
  var PROVIDERS = { gitlab: GITLAB_HOST, github: API_BASE };
  // The host actually used for this provider's network calls -- what F-3 below must validate.
  var ACTIVE_HOST = PROVIDERS[PROVIDER] || PROVIDERS.gitlab;

  // F-3: a token always exists now (B: tokenCipherB64 is mandatory, checked above), so this host
  // validation always runs unconditionally -- the active host must be https, and if the embed
  // also declares an allowlist (CFG.allowedHosts, an array of origins), it must match one.
  var hostIsHttps = /^https:\/\//i.test(ACTIVE_HOST);
  var hostAllowed = hostIsHttps;
  if (hostAllowed && CFG.allowedHosts && CFG.allowedHosts.length) {
    try {
      hostAllowed = CFG.allowedHosts.indexOf(new URL(ACTIVE_HOST).origin) !== -1;
    } catch (e) {
      hostAllowed = false;
    }
  }
  if (!hostAllowed) {
    console.warn('[wz-editor] WZ_EDITOR_CONFIG.gitlabHost/apiBase is not a valid https URL (or not in allowedHosts) — module will not initialize.');
    return;
  }
  // N-4: a token-backed embed with no allowedHosts pin accepts ANY https host (kept for
  // backward compat with existing embeds) -- but that means anyone able to edit the embed's
  // config script (e.g. a repo contributor with push access who does NOT know the edit
  // password) can repoint gitlabHost/apiBase at an attacker-controlled https server, and the
  // next time someone who DOES know the password saves, their decrypted token gets sent there
  // via the Authorization/PRIVATE-TOKEN header. This does not block (unpinned embeds keep
  // working) -- it only surfaces the recommendation.
  if (!(CFG.allowedHosts && CFG.allowedHosts.length)) {
    console.warn('[wz-editor] WZ_EDITOR_CONFIG has a real token but no allowedHosts allowlist — recommended to pin allowedHosts (an array of allowed origins) so a modified/compromised embed cannot redirect the decrypted token to an attacker-controlled host.');
  }

  // Default heuristic tuned to this kind of document's content classes — based on the design
  // token class names of the reference report this module was originally built against. When
  // attaching to a different document, override via config.editableSelector.
  var DEFAULT_EDIT_SEL = 'h1, h2, .page-title, .page-sub, .page-eyebrow, .section-label, .cover .lead, .cover .tag, '
    + 'p, li, td, th, .kpi-desc, .kpi-label, .kpi-value, .insight-title, .insight-body, .insight-tag, '
    + '.step-title, .step-time, .step-desc, .tl-step, .tl-q, .tl-result, .tl-learn, .tl-badge, .card h4, '
    + '.callout, .conclusion-label, .conclusion-body';
  var EDIT_SEL = CFG.editableSelector || DEFAULT_EDIT_SEL;
  var EXCLUDE_ANCESTOR_SEL = '.wz-edit-toolbar, .wz-pw-modal-overlay, .wz-draft-banner, .wz-save-toast, .wz-edit-fab';
  var OVERLAP_SEL = 'tr, td, th, .img-caption, .callout, .tl-result, .tl-learn, .tl-q, p, li, .kpi-desc, .insight-body, .dt-track, .subblock-title';

  // ===================================================================
  // CSS injection
  // ===================================================================
  var CSS = ''
    + '.wz-edit-fab{position:fixed;right:26px;top:24px;z-index:81;width:38px;height:38px;border-radius:50%;'
    // M-U2: icon color was #9aa4b2 on the ~white fab background (measured contrast 2.52:1, below the
    // WCAG 1.4.11 non-text 3:1 floor). #4b5563 keeps the same neutral-gray tone but reaches ~7.6:1
    // against a white backdrop (worst-case underlying page color, since the fab bg is a translucent
    // white that resolves to whatever's behind it) -- comfortably clears both the 3:1 floor and the
    // 4.5:1 text-level target this fix aims for.
    + '  border:1px solid #e3e7ec;background:rgba(255,255,255,.85);color:#4b5563;'
    + '  display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 12px rgba(18,35,63,.1);'
    + '  transition:color .15s,opacity .15s;opacity:.9;}'
    + '.wz-edit-fab:hover{color:#1c2b3a;}'
    + 'body.wz-edit-mode .wz-edit-fab{display:none;}'
    + '@media print{ .wz-edit-fab{display:none !important;} }'

    + '.wz-pw-modal-overlay{position:fixed;inset:0;background:rgba(18,35,63,.55);z-index:300;display:none;align-items:center;justify-content:center;padding:20px;}'
    + '.wz-pw-modal-overlay.active{display:flex;}'
    + '.wz-pw-modal-box{background:#fff;border-radius:14px;padding:24px 26px;width:280px;box-shadow:0 20px 50px rgba(0,0,0,.3);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
    + '.wz-pw-modal-box.wz-shake{animation:wzPwShake .32s;}'
    + '@keyframes wzPwShake{10%,90%{transform:translateX(-2px);}20%,80%{transform:translateX(4px);}30%,50%,70%{transform:translateX(-8px);}40%,60%{transform:translateX(8px);}}'
    + '.wz-pw-modal-title{font-size:15px;font-weight:800;color:#1c2b3a;margin-bottom:12px;}'
    + '.wz-pw-modal-input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #e3e7ec;border-radius:8px;font-size:14px;margin-bottom:6px;}'
    + '.wz-pw-modal-input:focus{outline:2px solid #2563eb;outline-offset:1px;}'
    + '.wz-pw-modal-err{font-size:12.5px;color:#c2410c;min-height:16px;margin-bottom:8px;visibility:hidden;}'
    + '.wz-pw-modal-err.show{visibility:visible;}'
    + '.wz-pw-modal-actions{display:flex;justify-content:flex-end;gap:8px;}'
    + '.wz-pw-modal-btn{padding:7px 14px;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid #e3e7ec;background:#fff;}'
    + '.wz-pw-modal-btn-submit{background:#1c2b3a;color:#fff;border-color:#1c2b3a;}'
    + '.wz-pw-modal-btn-submit:hover{background:#0f1b28;}'
    + '.wz-pw-modal-btn-cancel:hover{background:#f5f6f8;}'

    + '.wz-edit-toolbar{position:fixed;top:0;left:0;right:0;z-index:250;display:none;align-items:center;gap:10px;flex-wrap:wrap;'
    + '  padding:10px 20px;background:#1c2b3a;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
    + 'body.wz-edit-mode .wz-edit-toolbar{display:flex;}'
    + '.wz-edit-toolbar-dot{width:8px;height:8px;border-radius:50%;background:#c2410c;flex-shrink:0;animation:wzEditPulse 1.4s ease-in-out infinite;}'
    + '@keyframes wzEditPulse{0%,100%{opacity:1;}50%{opacity:.3;}}'
    + '.wz-edit-toolbar-label{font-size:13px;font-weight:700;letter-spacing:.02em;}'
    + '.wz-edit-toolbar-toast{font-size:12.5px;color:#bcd2f7;flex:1;}'
    // P3-4: compact optional commit-memo input, styled to match the toolbar's existing dark chrome
    // (same treatment as .wz-fmt-select) rather than a default white text input.
    + '.wz-edit-commit-msg{flex:0 1 220px;min-width:110px;padding:5px 10px;border-radius:6px;'
    + '  border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#fff;font-size:12.5px;}'
    + '.wz-edit-commit-msg::placeholder{color:rgba(255,255,255,.55);}'
    + '.wz-edit-commit-msg:focus{outline:2px solid #2563eb;outline-offset:1px;}'
    + '.wz-edit-toolbar-actions{display:flex;gap:8px;margin-left:auto;}'
    + '.wz-edit-toolbar-btn{padding:6px 16px;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid transparent;}'
    + '.wz-edit-toolbar-btn-cancel{background:rgba(255,255,255,.12);color:#fff;}'
    + '.wz-edit-toolbar-btn-cancel:hover{background:rgba(255,255,255,.2);}'
    + '.wz-edit-toolbar-btn-save{background:#15803d;color:#fff;}'
    + '.wz-edit-toolbar-btn-save:hover{background:#1f8a52;}'
    + '.wz-edit-toolbar-btn:disabled{opacity:.5;cursor:default;}'
    // C2: 78px only covered a single-row toolbar. The format bar (.wz-edit-format-bar, width:100%)
    // wraps the toolbar onto 2 rows (and more on narrow viewports), so 78px left H1 covered on every
    // viewport. This static value is a generous single-row-covering floor only -- the real,
    // viewport-accurate padding is computed from the toolbar's rendered offsetHeight in
    // measureAndSetToolbarPadding() (see enterEditMode) and applied as an inline style that
    // overrides this rule the instant edit mode is entered.
    + 'body.wz-edit-mode{padding-top:110px;}'

    + '.wz-edit-format-bar{display:flex;width:100%;align-items:center;gap:6px;padding-top:8px;margin-top:6px;'
    + '  border-top:1px solid rgba(255,255,255,.15);flex-wrap:wrap;}'
    + '.wz-fmt-label{font-size:11px;color:#9fb6da;margin-right:2px;}'
    + '.wz-fmt-sep{width:1px;height:18px;background:rgba(255,255,255,.2);margin:0 4px;}'
    + '.wz-fmt-btn{width:28px;height:26px;border-radius:5px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);'
    + '  color:#fff;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}'
    + '.wz-fmt-btn:hover{background:rgba(255,255,255,.18);}'
    + '.wz-fmt-select{height:26px;border-radius:5px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);'
    + '  color:#fff;font-size:11.5px;padding:0 4px;cursor:pointer;}'
    + '.wz-fmt-select option{color:#111;}'
    + '.wz-fmt-select-size{width:52px;}'
    + '.wz-fmt-color-picker{width:26px;height:26px;border-radius:5px;border:1px solid rgba(255,255,255,.25);'
    + '  background:transparent;cursor:pointer;padding:1px;}'
    + '.wz-fmt-color-btn{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.5);cursor:pointer;padding:0;}'
    + '.wz-fmt-color-btn:hover{border-color:#fff;}'
    + '.wz-fmt-color-default{background:#2b2b2b;}'

    // M-U3: every other injected bar (.wz-edit-toolbar, .wz-edit-format-bar) wraps at narrow widths
    // or 200% zoom except this one -- add flex-wrap so its text+actions reflow instead of
    // overflowing/clipping.
    + '.wz-draft-banner{position:fixed;top:0;left:0;right:0;z-index:260;display:none;align-items:center;gap:14px;flex-wrap:wrap;'
    + '  padding:10px 20px;background:#fff7ed;border-bottom:2px solid #c2410c;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
    + '.wz-draft-banner.active{display:flex;}'
    // C3: no body compensation existed for the banner's own height (~53px single-row, more once it
    // wraps per the flex-wrap fix above) -- it overlapped/covered page content underneath, most
    // visibly the title. 64px is a generous single-row-covering floor; the real, wrap-aware value is
    // computed from the banner's rendered offsetHeight in measureAndSetBannerPadding() (see
    // showDraftBannerIfAny) and applied as an inline style that overrides this rule.
    + 'body.wz-draft-banner-active{padding-top:64px;}'
    + '.wz-draft-banner-text{font-size:13px;font-weight:700;color:#c2410c;}'
    + '.wz-draft-banner-actions{display:flex;gap:8px;margin-left:auto;}'
    + '.wz-draft-banner-btn{padding:5px 14px;border-radius:6px;font-size:12.5px;font-weight:700;cursor:pointer;border:1px solid #c2410c;background:#fff;color:#c2410c;}'
    + '.wz-draft-banner-btn-restore{background:#c2410c;color:#fff;}'
    + '.wz-draft-banner-btn-restore:hover{background:#9a3412;}'
    + '.wz-draft-banner-btn-discard:hover{background:#fff7ed;}'

    + '.wz-save-toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:270;'
    + '  background:#1c2b3a;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:700;'
    + '  box-shadow:0 8px 24px rgba(0,0,0,.3);opacity:0;visibility:hidden;transition:opacity .25s ease;pointer-events:none;'
    + '  max-width:calc(100vw - 40px);text-align:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
    + '.wz-save-toast.active{opacity:1;visibility:visible;}'
    + '.wz-save-toast.wz-save-toast-warn{background:#c2410c;}'

    + '[data-wz-editable="true"]{outline:1px dashed transparent;outline-offset:3px;border-radius:3px;}'
    + 'body.wz-edit-mode [data-wz-editable="true"]{outline-color:#7aa8e0;cursor:text;}'
    + 'body.wz-edit-mode [data-wz-editable="true"]:hover{outline-color:#2563eb;}'
    + 'body.wz-edit-mode [data-wz-editable="true"]:focus{outline:2px solid #2563eb;background:rgba(59,130,246,.06);}';

  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-wz-editor', 'true');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ===================================================================
  // HTML injection
  // ===================================================================
  var HTML = ''
    + '<button type="button" class="wz-edit-fab" id="wzEditFab" aria-label="편집" title="편집">'
    + '  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'
    + '</button>'

    + '<div class="wz-pw-modal-overlay" id="wzPwModalOverlay">'
    // M-U1: role="dialog"+aria-modal so assistive tech announces this as a modal dialog (it had
    // neither before -- a screen reader user tabbing in had no signal they'd entered one).
    + '  <div class="wz-pw-modal-box" id="wzPwModalBox" role="dialog" aria-modal="true" aria-label="편집 비밀번호 입력">'
    + '    <div class="wz-pw-modal-title">편집 비밀번호</div>'
    + '    <input type="password" id="wzPwModalInput" class="wz-pw-modal-input" autocomplete="off" placeholder="비밀번호 입력">'
    + '    <div class="wz-pw-modal-err" id="wzPwModalErr">비밀번호가 올바르지 않습니다.</div>'
    + '    <div class="wz-pw-modal-actions">'
    + '      <button type="button" class="wz-pw-modal-btn wz-pw-modal-btn-cancel" id="wzPwModalCancel">취소</button>'
    + '      <button type="button" class="wz-pw-modal-btn wz-pw-modal-btn-submit" id="wzPwModalSubmit">확인</button>'
    + '    </div>'
    + '  </div>'
    + '</div>'

    + '<div class="wz-edit-toolbar" id="wzEditToolbar">'
    + '  <span class="wz-edit-toolbar-dot"></span>'
    + '  <span class="wz-edit-toolbar-label">편집 중</span>'
    + '  <span class="wz-edit-toolbar-toast" id="wzEditToast"></span>'
    + '  <input type="text" class="wz-edit-commit-msg" id="wzCommitMsgInput" maxlength="200" '
    + '    placeholder="커밋 메모(선택)" aria-label="커밋 메모(선택, 비우면 기본 메시지 사용)">'
    + '  <div class="wz-edit-toolbar-actions">'
    + '    <button type="button" class="wz-edit-toolbar-btn wz-edit-toolbar-btn-cancel" id="wzEditCancelBtn">취소</button>'
    + '    <button type="button" class="wz-edit-toolbar-btn wz-edit-toolbar-btn-save" id="wzEditSaveBtn">저장</button>'
    + '  </div>'
    + '  <div class="wz-edit-format-bar" id="wzEditFormatBar">'
    + '    <button type="button" class="wz-fmt-btn" id="wzFmtBold" title="굵게"><b>B</b></button>'
    + '    <span class="wz-fmt-sep"></span>'
    + '    <select class="wz-fmt-select" id="wzFmtFontFamily" title="글꼴">'
    + '      <option value="">글꼴(기본)</option>'
    + '      <option value="Pretendard, -apple-system, sans-serif">Pretendard</option>'
    + '      <option value="\'맑은 고딕\', \'Malgun Gothic\', sans-serif">맑은 고딕</option>'
    + '      <option value="\'Noto Sans KR\', sans-serif">Noto Sans KR</option>'
    + '      <option value="\'Nanum Gothic\', sans-serif">Nanum Gothic</option>'
    + '      <option value="Georgia, \'Batang\', serif">바탕(serif)</option>'
    + '      <option value="\'Consolas\', \'D2Coding\', monospace">monospace</option>'
    + '    </select>'
    + '    <span class="wz-fmt-sep"></span>'
    + '    <span class="wz-fmt-label">크기</span>'
    + '    <select class="wz-fmt-select wz-fmt-select-size" id="wzFmtSizeSelect" title="글자 크기">'
    + '      <option value="">px</option>'
    + '      <option value="10">10</option><option value="15">15</option><option value="20">20</option>'
    + '      <option value="25">25</option><option value="30">30</option><option value="35">35</option>'
    + '      <option value="40">40</option><option value="45">45</option><option value="50">50</option>'
    + '    </select>'
    + '    <span class="wz-fmt-sep"></span>'
    + '    <span class="wz-fmt-label">색상</span>'
    + '    <input type="color" class="wz-fmt-color-picker" id="wzFmtColorPicker" title="자유 색상 선택" value="#1c2b3a">'
    + '    <button type="button" class="wz-fmt-color-btn" data-color="var(--blue-600)" style="background:var(--blue-600);" title="파랑"></button>'
    + '    <button type="button" class="wz-fmt-color-btn" data-color="var(--orange-700)" style="background:var(--orange-700);" title="주황"></button>'
    + '    <button type="button" class="wz-fmt-color-btn" data-color="var(--green-700)" style="background:var(--green-700);" title="초록"></button>'
    + '    <button type="button" class="wz-fmt-color-btn" data-color="var(--gray-600)" style="background:var(--gray-600);" title="회색"></button>'
    + '    <button type="button" class="wz-fmt-color-btn wz-fmt-color-default" data-color="" title="기본(검정)"></button>'
    + '    <span class="wz-fmt-sep"></span>'
    + '    <button type="button" class="wz-fmt-btn" data-align="left" title="왼쪽 정렬">⇤</button>'
    + '    <button type="button" class="wz-fmt-btn" data-align="center" title="가운데 정렬">≡</button>'
    + '    <button type="button" class="wz-fmt-btn" data-align="right" title="오른쪽 정렬">⇥</button>'
    + '  </div>'
    + '</div>'

    + '<div class="wz-draft-banner" id="wzDraftBanner">'
    + '  <span class="wz-draft-banner-text">저장되지 않은 편집 내용이 있습니다.</span>'
    + '  <div class="wz-draft-banner-actions">'
    + '    <button type="button" class="wz-draft-banner-btn wz-draft-banner-btn-discard" id="wzDraftDiscardBtn">삭제</button>'
    + '    <button type="button" class="wz-draft-banner-btn wz-draft-banner-btn-restore" id="wzDraftRestoreBtn">복구</button>'
    + '  </div>'
    + '</div>'

    + '<div class="wz-save-toast" id="wzSaveToast"></div>';

  document.body.insertAdjacentHTML('beforeend', HTML);

  // ===================================================================
  // Logic (DOM references only use wz-prefixed ids/classes)
  // ===================================================================
  var editFab = document.getElementById('wzEditFab');
  var pwOverlay = document.getElementById('wzPwModalOverlay');
  var pwBox = document.getElementById('wzPwModalBox');
  var pwInput = document.getElementById('wzPwModalInput');
  var pwErr = document.getElementById('wzPwModalErr');
  var pwSubmit = document.getElementById('wzPwModalSubmit');
  var pwCancel = document.getElementById('wzPwModalCancel');
  var editToast = document.getElementById('wzEditToast');
  var commitMsgInput = document.getElementById('wzCommitMsgInput'); // P3-4
  var editCancelBtn = document.getElementById('wzEditCancelBtn');
  var editSaveBtn = document.getElementById('wzEditSaveBtn');
  var draftBanner = document.getElementById('wzDraftBanner');
  var draftRestoreBtn = document.getElementById('wzDraftRestoreBtn');
  var draftDiscardBtn = document.getElementById('wzDraftDiscardBtn');
  var saveToastEl = document.getElementById('wzSaveToast');

  var editableEls = [];
  var origInnerMap = new Map();
  var pendingRecoverDraft = null;
  var editPassword = null;
  var cachedToken = null; // F-1: set on successful decrypt in submitPassword, reused by doSave so the password is decrypted only once per auth.

  // Fix for a "save has no effect" bug: this module used to fetch window.location.href exactly
  // once at page-load time and reuse that single response as the diff baseline (originalSource)
  // for the entire session. That approach broke in two ways: (a) a Pages/CDN layer can hand back
  // a cached snapshot that differs from what's actually rendered, and (b) editing and saving more
  // than once in the same session pins the baseline to "the moment the page first loaded", so it
  // can't account for the file having changed through some other path in the meantime. Either way
  // the matching target (origCandidates) can end up structurally different from the live DOM
  // (editableEls), which can make a specific edit silently fail to match (and thus produce an
  // empty commit). Index-based matching itself is kept (assigning a unique id per element would
  // pollute the saved document, so that approach was not taken) — but the diff baseline is now
  // re-fetched from the repo's Files/Contents API (ref=branch) every time Save is pressed, so
  // it's always based on the latest committed state and fully bypasses CDN/browser caching.
  //
  // GitHub support: encodePath() encodes each path segment separately (GitHub's contents API
  // takes the path as literal '/'-separated segments in the URL, unlike GitLab's Files API which
  // wants the whole relative path percent-encoded as one opaque segment, slashes included).
  function encodePath(p){
    return p.split('/').map(encodeURIComponent).join('/');
  }
  // GitHub's contents API returns file content as base64 (chunked with embedded newlines) --
  // this is the same UTF-8-safe base64 decode as utf8ToBase64() below, run in reverse.
  function base64ToUtf8(b64){
    return decodeURIComponent(escape(atob(b64.replace(/\s/g, ''))));
  }
  async function fetchLatestGitLab(token){
    var url = GITLAB_HOST + '/api/v4/projects/' + encodeURIComponent(GITLAB_PROJECT_PATH)
      + '/repository/files/' + encodeURIComponent(GITLAB_FILE_PATH) + '/raw?ref=' + encodeURIComponent(GITLAB_BRANCH);
    var res = await fetch(url, {headers: {'PRIVATE-TOKEN': token}, cache: 'no-store'});
    // A: status code only -- the response body (error JSON from the provider) is never read into
    // the throw message. It would otherwise surface verbatim in the user-facing save-failure
    // toast, and provider error bodies are not guaranteed to be free of details we don't want
    // echoed back into the page (or logged wherever that toast text ends up).
    if (!res.ok){
      throw new Error('원본 최신본 조회 실패 (GitLab API ' + res.status + ')');
    }
    return {html: await res.text(), sha: null}; // GitLab's Files API has no sha-on-update requirement.
  }
  async function fetchLatestGitHub(token){
    var url = API_BASE + '/repos/' + GITLAB_PROJECT_PATH + '/contents/' + encodePath(GITLAB_FILE_PATH)
      + '?ref=' + encodeURIComponent(GITLAB_BRANCH);
    var res = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      cache: 'no-store'
    });
    if (!res.ok){
      throw new Error('원본 최신본 조회 실패 (GitHub API ' + res.status + ')'); // A: status only, see fetchLatestGitLab's comment above.
    }
    var json = await res.json();
    // m-3: GitHub's contents API returns an *array* (no .content field) when filePath resolves to a
    // directory instead of a file -- json.content would then be undefined, and base64ToUtf8(undefined)
    // throws an opaque TypeError deep inside atob() instead of a message that points at the actual
    // misconfiguration.
    if (!json || typeof json.content !== 'string') {
      throw new Error('filePath가 파일이 아닙니다 (GitHub API 응답에 content 없음 — 디렉터리 경로일 수 있습니다)');
    }
    // GitHub requires the file's current sha to be echoed back on the update commit (PUT), or
    // the write is rejected with 409 -- carry it alongside the html for buildEditedSource/commit.
    return {html: base64ToUtf8(json.content), sha: json.sha};
  }
  // NOTE: kept as a direct ternary (not routed through PROVIDERS below) intentionally --
  // test-github-provider.mjs extracts this function's source text and runs it concatenated with
  // ONLY fetchLatestGitHub/fetchLatestGitLab/encodePath/base64 helpers in an isolated vm sandbox
  // (no PROVIDERS in scope there), so a body that references PROVIDERS would throw
  // "PROVIDERS is not defined" in that test even though it works fine when this file loads normally.
  async function fetchLatest(token){
    return PROVIDER === 'github' ? fetchLatestGitHub(token) : fetchLatestGitLab(token);
  }

  function collectEditablesFrom(root){
    var all = Array.prototype.slice.call(root.querySelectorAll(EDIT_SEL));
    all = all.filter(function(el){ return !el.closest(EXCLUDE_ANCESTOR_SEL); });
    return all.filter(function(el){
      return !all.some(function(other){ return other !== el && el.contains(other); });
    });
  }
  function collectEditables(){
    editableEls = collectEditablesFrom(document);
    origInnerMap.clear(); // C1: full reset, not just overwrite -- avoids stale idx keys surviving a re-collect onto a shorter list.
    editableEls.forEach(function(el, idx){ origInnerMap.set(idx, el.innerHTML); });
  }
  // P3-1: collectEditablesFrom()'s O(n^2) containment filter used to run unconditionally at module
  // load, so every visitor who never edits (the common case for a published document) still paid
  // that cost on every page load. It is only ever needed once someone actually enters edit mode, so
  // the initial collection is deferred to the two requireAuth-success entry points below (FAB click
  // and draft-restore click) instead of running here. showDraftBannerIfAny() and
  // beforeUnloadHandler() do not read editableEls (only localStorage), so they are unaffected by
  // editableEls starting out empty.

  // B: sha256Hex() removed -- it existed only to compare against the now-removed pwHashHex
  // fallback (demo mode). Auth is decrypt-success-only (F-1); there is no other consumer.
  function b64ToBytes(b64){ return Uint8Array.from(atob(b64), function(c){ return c.charCodeAt(0); }); }
  async function decryptToken(password){
    var salt = b64ToBytes(TT_SALT_B64);
    var iv = b64ToBytes(TT_IV_B64);
    var ciphertext = b64ToBytes(TT_CIPHERTEXT_B64);
    var keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey(
      {name: 'PBKDF2', salt: salt, iterations: 600000, hash: 'SHA-256'},
      keyMaterial, {name: 'AES-GCM', length: 256}, false, ['decrypt']
    );
    var plainBuf = await crypto.subtle.decrypt({name: 'AES-GCM', iv: iv}, key, ciphertext);
    return new TextDecoder().decode(plainBuf);
  }

  // F-2: self-contained HTML sanitizer (zero external dependencies — no DOMPurify/CDN). Parses
  // the fragment into an inert <template> (its content is never attached to the live document, so
  // <script> inside it does not execute), then walks every element removing dangerous tags and
  // dangerous attributes in place. Applied at every sink where externally-sourced or
  // externally-restored HTML can reach the document: paste/drop (live input), draft restore
  // (localStorage, which any script on the same origin can write), and immediately before the
  // commit-time innerHTML write (defense in depth for the two sinks above, and for anything else
  // that might reach editableEls' innerHTML in the future).
  // N-1: keys are lowercase and matched against node.localName (always lowercase regardless of
  // namespace), not node.tagName (uppercase for HTML elements, but *lowercase* for SVG/MathML
  // foreign-content elements) -- an uppercase-keyed check against tagName silently lets
  // <svg><script> or <math><style> straight through, since 'script' !== 'SCRIPT'.
  var WZ_BAD_TAGS = {script: 1, iframe: 1, object: 1, embed: 1, link: 1, meta: 1, base: 1, form: 1, style: 1, noscript: 1};
  // N-2: a naive /^\s*javascript:/ test only strips LEADING whitespace, so a tab/newline/control
  // character embedded inside or before the scheme (e.g. "java\tscript:", "\x01javascript:")
  // survives the regex untouched -- but the browser's URL parser strips ASCII whitespace and C0
  // control characters from anywhere in the string before resolving the scheme, so the link still
  // navigates to (or a src still loads) a javascript: URL at click/render time. Fix: strip every
  // such character first, then match the resulting scheme against an explicit list rather than
  // trying to out-guess new obfuscation variants of "javascript:" one regex tweak at a time.
  function wzStripUrlNoise(v){
    // eslint-disable-next-line no-control-regex -- intentional: strips C0 controls, space, DEL, C1 controls (mirrors WHATWG URL parser's "C0 control or space" + tab/CR/LF trim behavior)
    return (v || '').replace(/[\x00-\x20\x7F-\x9F]/g, '');
  }
  function wzUrlIsDangerousHrefLike(v){
    var s = wzStripUrlNoise(v).toLowerCase();
    if (!s) return false;
    // href/xlink:href: block javascript/vbscript entirely, and data: (data: URLs render as full
    // documents/scripts in a new navigation context for <a>, unlike an <img src> data: image).
    return /^(javascript|vbscript|data):/.test(s);
  }
  function wzUrlIsDangerousSrcLike(v){
    var s = wzStripUrlNoise(v).toLowerCase();
    if (!s) return false;
    if (/^(javascript|vbscript):/.test(s)) return true;
    // src: allow data:image/* only (inline images are the only legitimate data: use here from the
    // rich-text toolbar / pasted images); any other data: MIME (e.g. data:text/html) is blocked.
    if (/^data:/.test(s)) return !/^data:image\//.test(s);
    return false;
  }
  function sanitizeHtmlFragment(html){
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
    var toRemove = [], node;
    while ((node = walker.nextNode())){
      var tag = (node.localName || node.tagName || '').toLowerCase();
      if (WZ_BAD_TAGS[tag]){ toRemove.push(node); continue; }
      Array.prototype.slice.call(node.attributes).forEach(function(attr){
        var name = attr.name.toLowerCase();
        var val = attr.value || '';
        if (name.indexOf('on') === 0) node.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'xlink:href') && wzUrlIsDangerousHrefLike(val)) node.removeAttribute(attr.name);
        else if (name === 'src' && wzUrlIsDangerousSrcLike(val)) node.removeAttribute(attr.name);
        else if (name === 'srcdoc') node.removeAttribute(attr.name);
        else if (name === 'style' && /expression|javascript:|url\s*\(/i.test(val)) node.removeAttribute(attr.name);
      });
    }
    toRemove.forEach(function(el){ if (el.parentNode) el.parentNode.removeChild(el); });
    return tpl.innerHTML;
  }

  var pwOnSuccess = null;
  function openPwModal(onSuccess){
    pwOnSuccess = onSuccess;
    pwInput.value = '';
    pwErr.classList.remove('show');
    pwOverlay.classList.add('active');
    setTimeout(function(){ pwInput.focus(); }, 50);
  }
  function closePwModal(){ pwOverlay.classList.remove('active'); }
  // F-1/B: the password verifier is "does AES-GCM decrypt succeed" -- the GCM auth tag itself
  // proves the password, so there is no separate plaintext-derived hash to compare against (unlike
  // the old sha256Hex(val) === pwHashHex check, which put a crackable verifier of the real
  // password in the page source). This is now the ONLY auth path (B removed the token-less demo
  // mode and its pwHashHex fallback -- a token is guaranteed to exist by the init guard above).
  async function submitPassword(){
    var val = pwInput.value;
    var ok = false, decryptedToken = null;
    try {
      decryptedToken = await decryptToken(val);
      ok = true;
    } catch (e) {
      ok = false;
    }
    if (ok){
      closePwModal();
      editPassword = val;
      cachedToken = decryptedToken;
      var cb = pwOnSuccess;
      if (cb) cb();
    } else {
      pwErr.classList.add('show');
      pwBox.classList.remove('wz-shake'); void pwBox.offsetWidth; pwBox.classList.add('wz-shake');
      pwInput.value = '';
      pwInput.focus();
    }
  }
  pwSubmit.addEventListener('click', submitPassword);
  pwInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') submitPassword(); });
  pwCancel.addEventListener('click', closePwModal);
  pwOverlay.addEventListener('click', function(e){ if (e.target === pwOverlay) closePwModal(); });
  // M-U1: focus trap + Escape-to-close. Before this, Tab from the last control (확인) escaped the
  // modal into whatever's behind it (e.g. the FAB), and there was no keyboard way to dismiss the
  // dialog short of a mouse click -- both are WCAG 2.1 keyboard-operability expectations for a
  // modal dialog.
  var pwFocusables = [pwInput, pwCancel, pwSubmit];
  pwBox.addEventListener('keydown', function(e){
    if (e.key === 'Escape'){ closePwModal(); return; }
    if (e.key !== 'Tab') return;
    var first = pwFocusables[0], last = pwFocusables[pwFocusables.length - 1];
    if (e.shiftKey){
      if (document.activeElement === first || pwFocusables.indexOf(document.activeElement) === -1){
        e.preventDefault(); last.focus();
      }
    } else if (document.activeElement === last){
      e.preventDefault(); first.focus();
    }
  });

  // The password gate stays open for the lifetime of the tab: once authenticated in a given tab
  // (editPassword captured), clicking the pencil icon or restoring a draft again re-enters edit
  // mode directly instead of showing the modal a second time. editPassword only ever lives in
  // this closure variable — it is never written to sessionStorage/localStorage — so reloading or
  // closing the tab clears it automatically (i.e. the gate has to be passed again), matching the
  // intended security boundary.
  function requireAuth(onReady){
    if (editPassword){ onReady(); return; }
    openPwModal(onReady);
  }

  // C2: the toolbar is 2 rows in practice (the format bar wraps under the label/actions row) and
  // grows to more rows on narrow viewports -- measure its actual rendered height (only accurate
  // once 'wz-edit-mode' has made it display:flex) and set body's padding-top to match, so the
  // title is never covered regardless of viewport width or how many rows the toolbar wraps to.
  var editToolbarEl = document.getElementById('wzEditToolbar');
  function measureAndSetToolbarPadding(){
    var h = editToolbarEl ? editToolbarEl.offsetHeight : 0;
    document.body.style.paddingTop = h ? (h + 4) + 'px' : '';
  }
  function enterEditMode(draftToApply){
    document.body.classList.add('wz-edit-mode');
    editableEls.forEach(function(el, idx){
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('data-wz-editable', 'true');
      // F-2 sink 2/3: a restored draft comes from localStorage, which any same-origin script (or a
      // stale draft saved before this fix) could have populated with unsanitized HTML — sanitize
      // before it re-enters the live document.
      if (draftToApply && draftToApply.edits && draftToApply.edits[idx] !== undefined){
        el.innerHTML = sanitizeHtmlFragment(draftToApply.edits[idx]);
      }
    });
    document.addEventListener('input', onEditableInput, true);
    document.addEventListener('paste', onEditablePaste, true);
    document.addEventListener('drop', onEditableDrop, true);
    hideDraftBanner(); // clears any banner-driven padding-top before we set the toolbar's own.
    measureAndSetToolbarPadding();
    window.addEventListener('resize', measureAndSetToolbarPadding);
  }
  function exitEditMode(){
    document.removeEventListener('input', onEditableInput, true);
    document.removeEventListener('paste', onEditablePaste, true);
    document.removeEventListener('drop', onEditableDrop, true);
    window.removeEventListener('resize', measureAndSetToolbarPadding);
    document.body.style.paddingTop = ''; // C2: drop the inline override so it can't outlive edit mode.
    clearTimeout(draftTimer);
    editableEls.forEach(function(el){
      el.removeAttribute('contenteditable');
      el.removeAttribute('data-wz-editable');
    });
    document.body.classList.remove('wz-edit-mode');
    if (commitMsgInput) commitMsgInput.value = ''; // P3-4: don't carry a stale memo into the next edit session.
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    // editPassword is intentionally not cleared here — see the tab-session auth note above.
    // Only a reload/tab close drops this closure variable and requires re-authentication.
  }
  // F-2 sink 1: paste/drop are the main live-input path for HTML into a contenteditable region.
  // Both are intercepted at the document level (capture phase) and scoped to editable elements via
  // closest() — no per-element binding needed since data-wz-editable is only present in edit mode.
  function insertSanitizedHtmlOrText(host, dataTransfer){
    if (!dataTransfer) return;
    var html = dataTransfer.getData('text/html');
    if (html){
      document.execCommand('insertHTML', false, sanitizeHtmlFragment(html));
    } else {
      var text = dataTransfer.getData('text/plain');
      if (text) document.execCommand('insertText', false, text);
    }
    notifyChanged(host);
  }
  function onEditablePaste(e){
    var host = e.target && e.target.closest ? e.target.closest('[data-wz-editable="true"]') : null;
    if (!host) return;
    e.preventDefault();
    insertSanitizedHtmlOrText(host, e.clipboardData);
  }
  function onEditableDrop(e){
    var host = e.target && e.target.closest ? e.target.closest('[data-wz-editable="true"]') : null;
    if (!host) return;
    e.preventDefault();
    insertSanitizedHtmlOrText(host, e.dataTransfer);
  }
  editFab.addEventListener('click', function(){ requireAuth(function(){ collectEditables(); enterEditMode(null); }); });

  editCancelBtn.addEventListener('click', function(){
    // m-2: the button being visually/functionally disabled during isSaving (toggled in doSave)
    // already blocks native clicks, but guard here too in case something dispatches a synthetic
    // click while the disabled state hasn't been applied yet.
    if (isSaving) return;
    if (!confirm('편집 내용을 취소하고 원래대로 되돌릴까요?')) return;
    clearTimeout(draftTimer);
    localStorage.removeItem(DRAFT_KEY);
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    location.reload();
  });

  // ---------- Rich-text mini toolbar ----------
  var lastEditableRange = null;
  document.addEventListener('selectionchange', function(){
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var node = range.commonAncestorContainer;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (el && el.closest('[data-wz-editable="true"]')) lastEditableRange = range.cloneRange();
  });
  function getActiveEditableHost(){
    if (!lastEditableRange) return null;
    var node = lastEditableRange.commonAncestorContainer;
    var el = node.nodeType === 1 ? node : node.parentElement;
    return el ? el.closest('[data-wz-editable="true"]') : null;
  }
  function notifyChanged(host){
    if (host) host.dispatchEvent(new Event('input', {bubbles: true}));
  }
  function applyInlineStyle(styleProp, styleVal){
    if (!lastEditableRange || lastEditableRange.collapsed){ setToast('서식을 적용할 텍스트를 먼저 선택하세요'); return; }
    var host = getActiveEditableHost();
    if (!host){ setToast('편집 가능한 영역 안에서 선택해 주세요'); return; }
    var range = lastEditableRange;
    var span = document.createElement('span');
    span.style[styleProp] = styleVal;
    var frag = range.extractContents();
    span.appendChild(frag);
    range.insertNode(span);
    var sel = window.getSelection();
    sel.removeAllRanges();
    var newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.addRange(newRange);
    lastEditableRange = newRange.cloneRange();
    notifyChanged(host);
  }
  function execAlignOrBold(cmd){
    var host = getActiveEditableHost();
    if (!host){ setToast('편집 가능한 영역 안에서 선택해 주세요'); return; }
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(lastEditableRange);
    document.execCommand(cmd);
    notifyChanged(host);
  }
  function preserveSelectionOnMousedown(el){
    el.addEventListener('mousedown', function(e){ e.preventDefault(); });
  }
  var fmtBoldBtn = document.getElementById('wzFmtBold');
  preserveSelectionOnMousedown(fmtBoldBtn);
  fmtBoldBtn.addEventListener('click', function(){ execAlignOrBold('bold'); });

  var fmtFontFamily = document.getElementById('wzFmtFontFamily');
  fmtFontFamily.addEventListener('change', function(){
    if (fmtFontFamily.value) applyInlineStyle('fontFamily', fmtFontFamily.value);
    fmtFontFamily.value = '';
  });
  // Removed the free-text font-size input field: it misbehaved in production and the underlying
  // cause was not chased down before deciding to cut it. Only the dropdown (10-50, step 5) remains.
  var fmtSizeSelect = document.getElementById('wzFmtSizeSelect');
  fmtSizeSelect.addEventListener('change', function(){
    if (fmtSizeSelect.value) applyInlineStyle('fontSize', fmtSizeSelect.value + 'px');
    fmtSizeSelect.value = '';
  });
  var fmtColorPicker = document.getElementById('wzFmtColorPicker');
  fmtColorPicker.addEventListener('input', function(){ applyInlineStyle('color', fmtColorPicker.value); });
  Array.prototype.forEach.call(document.querySelectorAll('.wz-fmt-color-btn'), function(btn){
    preserveSelectionOnMousedown(btn);
    btn.addEventListener('click', function(){
      var c = btn.getAttribute('data-color');
      applyInlineStyle('color', c || 'inherit');
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.wz-fmt-btn[data-align]'), function(btn){
    preserveSelectionOnMousedown(btn);
    btn.addEventListener('click', function(){
      var align = btn.getAttribute('data-align');
      execAlignOrBold(align === 'left' ? 'justifyLeft' : align === 'center' ? 'justifyCenter' : 'justifyRight');
    });
  });

  // ---------- localStorage autosave draft ----------
  var draftTimer = null;
  function onEditableInput(){
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraftToLocalStorage, 1000);
  }
  function saveDraftToLocalStorage(){
    var edits = {}, any = false;
    editableEls.forEach(function(el, idx){
      var now = el.innerHTML, orig = origInnerMap.get(idx);
      if (now !== orig){ edits[idx] = now; any = true; }
    });
    if (!any){ localStorage.removeItem(DRAFT_KEY); return; }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({savedAt: Date.now(), edits: edits})); }
    catch(e){
      // M-F1: this used to fail completely silently (quota exceeded, private/incognito mode
      // blocking localStorage, etc.) -- which also silently defeats the beforeunload/tab-close
      // recovery net (hasUnsavedDraft() reads the same key), so an edit could be lost with zero
      // warning of any kind. Surface it via the toolbar toast (visible during editing).
      setToast('초안 저장 실패(저장소 용량 등) — 저장 전 이탈 시 편집 내용이 사라질 수 있습니다');
    }
  }
  function hasUnsavedDraft(){ return !!localStorage.getItem(DRAFT_KEY); }

  // C3: the banner (~53px, more once M-U3's flex-wrap kicks in on narrow viewports) had no matching
  // body padding, so it sat on top of and covered page content -- most visibly the title. Measure
  // the banner's actual rendered height the same way measureAndSetToolbarPadding() does for the
  // toolbar, so it stays correct however many rows the banner wraps to.
  function measureAndSetBannerPadding(){
    var h = draftBanner ? draftBanner.offsetHeight : 0;
    document.body.style.paddingTop = h ? (h + 4) + 'px' : '';
  }
  function showDraftBannerIfAny(){
    var raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    var parsed;
    try { parsed = JSON.parse(raw); } catch(e){ localStorage.removeItem(DRAFT_KEY); return; }
    // R-3: a draft older than DRAFT_TTL_MS is dropped silently instead of offered for restore —
    // an ancient autosave is more likely stale/unwanted than something the user still wants back.
    if (!parsed.savedAt || (Date.now() - parsed.savedAt) > DRAFT_TTL_MS){
      localStorage.removeItem(DRAFT_KEY);
      return;
    }
    pendingRecoverDraft = parsed;
    draftBanner.classList.add('active');
    document.body.classList.add('wz-draft-banner-active');
    measureAndSetBannerPadding();
    window.addEventListener('resize', measureAndSetBannerPadding);
  }
  function hideDraftBanner(){
    draftBanner.classList.remove('active');
    document.body.classList.remove('wz-draft-banner-active');
    window.removeEventListener('resize', measureAndSetBannerPadding);
    document.body.style.paddingTop = ''; // C3: drop the inline override (enterEditMode sets its own right after).
  }
  draftDiscardBtn.addEventListener('click', function(){
    localStorage.removeItem(DRAFT_KEY);
    pendingRecoverDraft = null;
    hideDraftBanner();
  });
  draftRestoreBtn.addEventListener('click', function(){
    var draft = pendingRecoverDraft;
    requireAuth(function(){ collectEditables(); enterEditMode(draft); });
  });
  showDraftBannerIfAny();

  // ---------- Save (double-submit guard + DOM-index-matched diff + GitLab commit) ----------
  var isSaving = false, pendingSaveQueued = false, pendingSaveTimer = null, lastCommitAt = 0;
  function setToast(msg){ editToast.textContent = msg; }
  var saveToastTimer = null;
  function showSaveToast(msg, durationMs, isWarn){
    saveToastEl.textContent = msg;
    saveToastEl.classList.toggle('wz-save-toast-warn', !!isWarn);
    saveToastEl.classList.add('active');
    clearTimeout(saveToastTimer);
    saveToastTimer = setTimeout(function(){ saveToastEl.classList.remove('active'); }, durationMs || 4000);
  }
  function requestSave(){
    if (isSaving){ pendingSaveQueued = true; setToast('저장 진행 중… 완료 후 이어서 반영합니다'); return; }
    var sinceLast = Date.now() - lastCommitAt;
    if (lastCommitAt && sinceLast < SAVE_MERGE_WINDOW_MS){
      if (pendingSaveTimer){ setToast('60초 병합 대기 중…'); return; }
      var wait = SAVE_MERGE_WINDOW_MS - sinceLast;
      setToast('직전 저장 60초 이내 — ' + Math.ceil(wait / 1000) + '초 후 병합 저장');
      pendingSaveTimer = setTimeout(function(){ pendingSaveTimer = null; doSave(); }, wait);
      return;
    }
    doSave();
  }
  // sourceHtml is the diff baseline fetched fresh at save time ("latest committed state" via
  // fetchLatestOriginalHtml). Index-based matching is kept, but if the total candidate count in
  // that baseline differs from the live DOM's editableEls (meaning the document structure changed
  // in between), individual indices landing "in range" by coincidence can't be trusted — so the
  // whole thing is treated as a mismatch rather than silently applying some edits to the wrong
  // elements. This intentionally does not allow partial success: it aborts entirely and signals
  // via diff.mismatchCount instead.
  var WZ_LEAK_SCAN_SEL = 'script, iframe, object, embed, form, style, [onerror], [onclick], [onload], [onmouseover], [onfocus], [onmouseenter], [onmouseleave], [srcdoc]';
  // N-2 defense in depth: WZ_LEAK_SCAN_SEL above cannot express "an href/src whose *value* is a
  // dangerous scheme" as a CSS selector, so a dangerous-URL survivor (a gap in sanitizeHtmlFragment
  // that a future edit reintroduces, or a value crafted to defeat that specific regex) would
  // otherwise reach the commit undetected. Re-check every href/src/xlink:href within the edited
  // element, scoped the same way as WZ_LEAK_SCAN_SEL (this element only, not the whole document).
  function wzTargetHasDangerousUrl(target){
    var nodes = [target].concat(Array.prototype.slice.call(target.querySelectorAll('[href],[src],[xlink\\:href]')));
    return nodes.some(function(n){
      var href = n.getAttribute && n.getAttribute('href');
      var xhref = n.getAttribute && n.getAttribute('xlink:href');
      var src = n.getAttribute && n.getAttribute('src');
      if (href && wzUrlIsDangerousHrefLike(href)) return true;
      if (xhref && wzUrlIsDangerousHrefLike(xhref)) return true;
      if (src && wzUrlIsDangerousSrcLike(src)) return true;
      return false;
    });
  }
  function buildEditedSource(sourceHtml){
    var parser = new DOMParser();
    var doc = parser.parseFromString(sourceHtml, 'text/html');
    var origCandidates = collectEditablesFrom(doc);
    var structuralDrift = (origCandidates.length !== editableEls.length);
    var changedCount = 0, mismatchCount = 0, touchedCount = 0;
    var handlerLeakFound = false;
    editableEls.forEach(function(el, idx){
      var orig = origInnerMap.get(idx), now = el.innerHTML;
      if (orig === now) return;
      touchedCount++;
      var target = structuralDrift ? null : origCandidates[idx];
      if (!target){ mismatchCount++; return; }
      // C4 (minimal mitigation): index-based matching alone can't detect a same-count reshuffle
      // (paragraphs reordered without any added/removed) -- the index still resolves to *a* element,
      // just not the one this edit was made against. Full identity matching is out of scope here
      // (needs a per-element identifier, tracked separately); as a floor, verify the *remote*
      // baseline at this index still matches what our local session started from. If it doesn't,
      // this slot was touched by something outside this editing session (a reorder, or someone
      // else's commit) since we captured origInnerMap -- abort this index as a mismatch rather than
      // blindly overwriting whatever now sits at that position.
      if (target.innerHTML !== orig){ mismatchCount++; return; }
      // F-2 sink 3: defense in depth. Paste/drop and draft-restore are already sanitized at their
      // own sinks, but this is the last point before the edited HTML is written into the document
      // that gets committed — sanitize here too so no future or overlooked input path can slip
      // executable markup into the saved file.
      target.innerHTML = sanitizeHtmlFragment(now);
      // Assert the sanitize actually held, scoped to just this edited element — NOT the whole
      // document, because the whole document legitimately contains wz-editor's own
      // <script src="...wz-editor.js"> embed tag (and possibly other host-page scripts
      // unrelated to this feature), which would otherwise false-positive on every real save.
      if (target.querySelector(WZ_LEAK_SCAN_SEL) || wzTargetHasDangerousUrl(target)) handlerLeakFound = true;
      changedCount++;
    });
    var leaked = [];
    if (doc.querySelector('[contenteditable]')) leaked.push('contenteditable');
    if (doc.querySelector('[data-wz-editable]')) leaked.push('data-wz-editable');
    if (handlerLeakFound) leaked.push('script-or-handler');
    var html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    return {html: html, changedCount: changedCount, mismatchCount: mismatchCount, touchedCount: touchedCount, structuralDrift: structuralDrift, leaked: leaked};
  }
  function utf8ToBase64(str){ return btoa(unescape(encodeURIComponent(str))); }
  // P3-4: the commit message box is a plain API request body field (not rendered as HTML anywhere),
  // so this is hygiene rather than an XSS sanitizer -- collapse newlines/tabs (a multi-line commit
  // body isn't useful for this single-line memo field, and a raw newline in a GitLab/GitHub commit
  // message API field is otherwise harmless but visually messy in the resulting commit log) and cap
  // length defensively (the input already has maxlength, but a value set programmatically or pasted
  // in a way that bypasses it should not be trusted blindly).
  function sanitizeCommitMessage(raw){
    var s = String(raw || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > 200 ? s.slice(0, 200) : s;
  }
  // P3-4: commitMessage is an optional param (defaulted to the module's original hardcoded string
  // when falsy) -- kept optional rather than required so a direct call with the old 2/3-arg shape
  // (as the existing scratchpad regression tests and this file's own default-fallback callers do)
  // keeps behaving exactly as before.
  async function commitToGitLab(newHtml, token, commitMessage){
    var url = GITLAB_HOST + '/api/v4/projects/' + encodeURIComponent(GITLAB_PROJECT_PATH)
      + '/repository/files/' + encodeURIComponent(GITLAB_FILE_PATH);
    var res = await fetch(url, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'PRIVATE-TOKEN': token},
      body: JSON.stringify({
        branch: GITLAB_BRANCH,
        content: utf8ToBase64(newHtml),
        encoding: 'base64',
        commit_message: commitMessage || 'report: in-page edit'
      })
    });
    // A: status only -- see fetchLatestGitLab's comment above (same reasoning for the commit path).
    if (!res.ok){
      throw new Error('GitLab API ' + res.status);
    }
    return res.json();
  }
  async function commitGitHub(newHtml, token, sha, commitMessage){
    var url = API_BASE + '/repos/' + GITLAB_PROJECT_PATH + '/contents/' + encodePath(GITLAB_FILE_PATH);
    var res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        message: commitMessage || 'report: in-page edit',
        content: utf8ToBase64(newHtml),
        branch: GITLAB_BRANCH,
        sha: sha // required by GitHub's contents API when updating an existing file -- omitting it (or a stale value) is rejected with 409.
      })
    });
    if (!res.ok){
      throw new Error('GitHub API ' + res.status); // A: status only.
    }
    return res.json();
  }
  // NOTE: same reason as fetchLatest() above -- test-github-provider.mjs and
  // test-a-error-body-redaction.mjs extract commitGitHub/commitToGitLab (and this dispatcher)
  // individually and run them without PROVIDERS in scope.
  async function commitFile(newHtml, token, sha, commitMessage){
    return PROVIDER === 'github' ? commitGitHub(newHtml, token, sha, commitMessage) : commitToGitLab(newHtml, token, commitMessage);
  }
  async function doSave(){
    isSaving = true;
    editSaveBtn.disabled = true;
    editCancelBtn.disabled = true; // m-2: cancel used to stay clickable during save and race location.reload() against the in-flight PUT.
    // P3-2: staged progress text instead of one static "저장 중…" for the whole fetch->diff->commit
    // span, which can take a noticeable moment on a large document. Kept to plain toast-text updates
    // (no spinner/progress-bar widget) -- proportionate to what a sequence of 3 short network/CPU
    // steps needs.
    setToast('최신본 확인 중…');
    try {
      // F-1: reuse the token decrypted at auth time (cachedToken) instead of re-decrypting here —
      // avoids a second PBKDF2 derivation (600k iterations) on every save. Falls back to a fresh
      // decrypt only defensively (e.g. cachedToken somehow unset while editPassword is present).
      var token = cachedToken || await decryptToken(editPassword);
      var latest = await fetchLatest(token); // {html, sha} -- sha is null for GitLab, required by GitHub's update commit.
      setToast('변경 반영 중…');
      var diff = buildEditedSource(latest.html);
      if (diff.touchedCount === 0){
        setToast('변경된 내용이 없습니다');
        return;
      }
      if (diff.mismatchCount > 0 || diff.structuralDrift){
        // P3-3: distinguish *why* the safe-merge check failed instead of one generic "구조가
        // 변경되어" message for both causes. structuralDrift (origCandidates.length !== editableEls.length,
        // see buildEditedSource) means the element COUNT itself changed -- true structural drift.
        // A non-structural mismatch (C4's index-identity check: `target.innerHTML !== orig`) means the
        // count is the same but the specific slot this edit targeted was altered by something outside
        // this editing session (someone else's commit, or a same-count reorder) since this session's
        // baseline was captured -- that is a genuine multi-editor collision, not a structure change,
        // and deserves its own wording so the user understands why a plain refresh+redo is needed.
        var conflictMsg = diff.structuralDrift
          ? ('반영 불가 ' + diff.mismatchCount + '건 — 원본 문서 구조(요소 개수)가 변경되어 편집을 안전하게 반영할 수 없습니다(커밋 중단). 새로고침 후 다시 편집해 주세요.')
          : ('다른 곳에서 이 문서가 수정되어(편집 충돌) 안전하게 반영할 수 없습니다 — 새로고침 후 다시 편집해 주세요. (충돌 ' + diff.mismatchCount + '건)');
        throw new Error(conflictMsg);
      }
      if (diff.leaked.length){
        throw new Error('내부 검증 실패: 저장본에 편집 UI 잔재 발견(' + diff.leaked.join(',') + ') — 커밋 중단');
      }
      setToast('커밋 중…');
      // P3-4: optional user-entered commit memo (sanitizeCommitMessage strips newlines/control chars
      // and caps length; falls back to the module's default message when empty).
      var commitMsg = sanitizeCommitMessage(commitMsgInput ? commitMsgInput.value : '');
      await commitFile(diff.html, token, latest.sha, commitMsg);
      lastCommitAt = Date.now();
      localStorage.removeItem(DRAFT_KEY);
      // C1: re-baseline against the now-committed DOM state. Without this, origInnerMap stays
      // pinned to the value from the very first page load, so (a) a second edit-and-save in the same
      // tab session sees every already-committed element as "changed" and recommits it verbatim
      // (duplicate commit with no real diff), and (b) if someone else's commit landed between our
      // save and a later one in this tab, a subsequent no-op re-save could still carry our stale
      // local copy over their change. Re-collecting resets both editableEls and origInnerMap to the
      // DOM as it stands right after this commit succeeded.
      collectEditables();
      var isPartial = diff.changedCount < diff.touchedCount;
      var successMsg = '저장됨 — 사이트 반영까지 1~2분(파이프라인). 반영 ' + diff.changedCount + '건 / 전체 편집 ' + diff.touchedCount + '건';
      setToast(successMsg);
      exitEditMode();
      showSaveToast(successMsg, 5000, isPartial);
    } catch(err){
      setToast('저장 실패: ' + (err && err.message ? err.message : '알 수 없는 오류') + ' (편집 내용은 유지됩니다)');
    } finally {
      isSaving = false;
      editSaveBtn.disabled = false;
      editCancelBtn.disabled = false;
      if (pendingSaveQueued){ pendingSaveQueued = false; requestSave(); }
    }
  }
  editSaveBtn.addEventListener('click', requestSave);

  function beforeUnloadHandler(e){
    if (hasUnsavedDraft()){ e.preventDefault(); e.returnValue = ''; }
  }
  window.addEventListener('beforeunload', beforeUnloadHandler);
})();
