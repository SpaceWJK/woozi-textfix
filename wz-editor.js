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
 *       gitlabHost: 'https://gitlab.example.com',
 *       projectPath: 'your-group/your-repo',           // URL-encoded internally by the module
 *       filePath: 'docs/report.html',                   // path relative to the repo root
 *       branch: 'main',
 *       pwHashHex: '<hex SHA-256 of your edit password>',
 *       tokenSaltB64: '<output of tools/encrypt-token.mjs>',
 *       tokenIvB64: '<output of tools/encrypt-token.mjs>',
 *       tokenCipherB64: '<output of tools/encrypt-token.mjs>',
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
 */
(function(){
  'use strict';

  var CFG = window.WZ_EDITOR_CONFIG || {};
  if (!CFG.pwHashHex) {
    console.warn('[wz-editor] WZ_EDITOR_CONFIG.pwHashHex is missing — module will not initialize.');
    return;
  }

  var GITLAB_HOST = CFG.gitlabHost || 'https://gitlab.example.com';
  var GITLAB_PROJECT_PATH = CFG.projectPath || '';
  var GITLAB_FILE_PATH = CFG.filePath || '';
  var GITLAB_BRANCH = CFG.branch || 'main';
  var PW_HASH_HEX = CFG.pwHashHex;
  var TT_SALT_B64 = CFG.tokenSaltB64 || '';
  var TT_IV_B64 = CFG.tokenIvB64 || '';
  var TT_CIPHERTEXT_B64 = CFG.tokenCipherB64 || '';
  var DRAFT_KEY = 'wzEditorDraft::' + (GITLAB_FILE_PATH || location.pathname);
  var SAVE_MERGE_WINDOW_MS = 60000;

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
    + '  border:1px solid #e3e7ec;background:rgba(255,255,255,.85);color:#9aa4b2;'
    + '  display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 12px rgba(18,35,63,.1);'
    + '  transition:color .15s,opacity .15s;opacity:.9;}'
    + '.wz-edit-fab:hover{color:#5b6472;}'
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
    + '.wz-edit-toolbar-actions{display:flex;gap:8px;margin-left:auto;}'
    + '.wz-edit-toolbar-btn{padding:6px 16px;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid transparent;}'
    + '.wz-edit-toolbar-btn-cancel{background:rgba(255,255,255,.12);color:#fff;}'
    + '.wz-edit-toolbar-btn-cancel:hover{background:rgba(255,255,255,.2);}'
    + '.wz-edit-toolbar-btn-save{background:#15803d;color:#fff;}'
    + '.wz-edit-toolbar-btn-save:hover{background:#1f8a52;}'
    + '.wz-edit-toolbar-btn:disabled{opacity:.5;cursor:default;}'
    + 'body.wz-edit-mode{padding-top:78px;}'

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

    + '.wz-draft-banner{position:fixed;top:0;left:0;right:0;z-index:260;display:none;align-items:center;gap:14px;'
    + '  padding:10px 20px;background:#fff7ed;border-bottom:2px solid #c2410c;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
    + '.wz-draft-banner.active{display:flex;}'
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
    + '  <div class="wz-pw-modal-box" id="wzPwModalBox">'
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
  // re-fetched from the GitLab commit API (raw, ref=branch) every time Save is pressed, so it's
  // always based on the latest committed state and fully bypasses CDN/browser caching.
  async function fetchLatestOriginalHtml(token){
    var url = GITLAB_HOST + '/api/v4/projects/' + encodeURIComponent(GITLAB_PROJECT_PATH)
      + '/repository/files/' + encodeURIComponent(GITLAB_FILE_PATH) + '/raw?ref=' + encodeURIComponent(GITLAB_BRANCH);
    var res = await fetch(url, {headers: {'PRIVATE-TOKEN': token}, cache: 'no-store'});
    if (!res.ok){
      var body = '';
      try { body = await res.text(); } catch(e){}
      throw new Error('원본 최신본 조회 실패 (GitLab API ' + res.status + ')' + (body ? (' ' + body.slice(0, 120)) : ''));
    }
    return res.text();
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
    editableEls.forEach(function(el, idx){ origInnerMap.set(idx, el.innerHTML); });
  }
  collectEditables();

  async function sha256Hex(str){
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.prototype.map.call(new Uint8Array(buf), function(b){ return b.toString(16).padStart(2, '0'); }).join('');
  }
  function b64ToBytes(b64){ return Uint8Array.from(atob(b64), function(c){ return c.charCodeAt(0); }); }
  async function decryptToken(password){
    var salt = b64ToBytes(TT_SALT_B64);
    var iv = b64ToBytes(TT_IV_B64);
    var ciphertext = b64ToBytes(TT_CIPHERTEXT_B64);
    var keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey(
      {name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256'},
      keyMaterial, {name: 'AES-GCM', length: 256}, false, ['decrypt']
    );
    var plainBuf = await crypto.subtle.decrypt({name: 'AES-GCM', iv: iv}, key, ciphertext);
    return new TextDecoder().decode(plainBuf);
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
  async function submitPassword(){
    var val = pwInput.value;
    var hex = await sha256Hex(val);
    if (hex === PW_HASH_HEX){
      closePwModal();
      editPassword = val;
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

  function enterEditMode(draftToApply){
    document.body.classList.add('wz-edit-mode');
    editableEls.forEach(function(el, idx){
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('data-wz-editable', 'true');
      if (draftToApply && draftToApply.edits && draftToApply.edits[idx] !== undefined){
        el.innerHTML = draftToApply.edits[idx];
      }
    });
    document.addEventListener('input', onEditableInput, true);
    hideDraftBanner();
  }
  function exitEditMode(){
    document.removeEventListener('input', onEditableInput, true);
    clearTimeout(draftTimer);
    editableEls.forEach(function(el){
      el.removeAttribute('contenteditable');
      el.removeAttribute('data-wz-editable');
    });
    document.body.classList.remove('wz-edit-mode');
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    // editPassword is intentionally not cleared here — see the tab-session auth note above.
    // Only a reload/tab close drops this closure variable and requires re-authentication.
  }
  editFab.addEventListener('click', function(){ requireAuth(function(){ enterEditMode(null); }); });

  editCancelBtn.addEventListener('click', function(){
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
    catch(e){}
  }
  function hasUnsavedDraft(){ return !!localStorage.getItem(DRAFT_KEY); }

  function showDraftBannerIfAny(){
    var raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    try { pendingRecoverDraft = JSON.parse(raw); } catch(e){ localStorage.removeItem(DRAFT_KEY); return; }
    draftBanner.classList.add('active');
    document.body.classList.add('wz-draft-banner-active');
  }
  function hideDraftBanner(){
    draftBanner.classList.remove('active');
    document.body.classList.remove('wz-draft-banner-active');
  }
  draftDiscardBtn.addEventListener('click', function(){
    localStorage.removeItem(DRAFT_KEY);
    pendingRecoverDraft = null;
    hideDraftBanner();
  });
  draftRestoreBtn.addEventListener('click', function(){
    var draft = pendingRecoverDraft;
    requireAuth(function(){ enterEditMode(draft); });
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
  function buildEditedSource(sourceHtml){
    var parser = new DOMParser();
    var doc = parser.parseFromString(sourceHtml, 'text/html');
    var origCandidates = collectEditablesFrom(doc);
    var structuralDrift = (origCandidates.length !== editableEls.length);
    var changedCount = 0, mismatchCount = 0, touchedCount = 0;
    editableEls.forEach(function(el, idx){
      var orig = origInnerMap.get(idx), now = el.innerHTML;
      if (orig === now) return;
      touchedCount++;
      var target = structuralDrift ? null : origCandidates[idx];
      if (!target){ mismatchCount++; return; }
      target.innerHTML = now;
      changedCount++;
    });
    var leaked = [];
    if (doc.querySelector('[contenteditable]')) leaked.push('contenteditable');
    if (doc.querySelector('[data-wz-editable]')) leaked.push('data-wz-editable');
    var html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    return {html: html, changedCount: changedCount, mismatchCount: mismatchCount, touchedCount: touchedCount, structuralDrift: structuralDrift, leaked: leaked};
  }
  function utf8ToBase64(str){ return btoa(unescape(encodeURIComponent(str))); }
  async function commitToGitLab(newHtml, token){
    var url = GITLAB_HOST + '/api/v4/projects/' + encodeURIComponent(GITLAB_PROJECT_PATH)
      + '/repository/files/' + encodeURIComponent(GITLAB_FILE_PATH);
    var res = await fetch(url, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'PRIVATE-TOKEN': token},
      body: JSON.stringify({
        branch: GITLAB_BRANCH,
        content: utf8ToBase64(newHtml),
        encoding: 'base64',
        commit_message: 'report: in-page edit'
      })
    });
    if (!res.ok){
      var body = '';
      try { body = await res.text(); } catch(e){}
      throw new Error('GitLab API ' + res.status + (body ? (' ' + body.slice(0, 120)) : ''));
    }
    return res.json();
  }
  async function doSave(){
    isSaving = true;
    editSaveBtn.disabled = true;
    setToast('저장 중…');
    try {
      var token = await decryptToken(editPassword);
      var latestOriginal = await fetchLatestOriginalHtml(token);
      var diff = buildEditedSource(latestOriginal);
      if (diff.touchedCount === 0){
        setToast('변경된 내용이 없습니다');
        return;
      }
      if (diff.mismatchCount > 0 || diff.structuralDrift){
        throw new Error('반영 불가 ' + diff.mismatchCount + '건 — 원본 문서 구조가 변경되어 편집을 안전하게 반영할 수 없습니다(커밋 중단). 새로고침 후 다시 편집해 주세요.');
      }
      if (diff.leaked.length){
        throw new Error('내부 검증 실패: 저장본에 편집 UI 잔재 발견(' + diff.leaked.join(',') + ') — 커밋 중단');
      }
      await commitToGitLab(diff.html, token);
      lastCommitAt = Date.now();
      localStorage.removeItem(DRAFT_KEY);
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
      if (pendingSaveQueued){ pendingSaveQueued = false; requestSave(); }
    }
  }
  editSaveBtn.addEventListener('click', requestSave);

  function beforeUnloadHandler(e){
    if (hasUnsavedDraft()){ e.preventDefault(); e.returnValue = ''; }
  }
  window.addEventListener('beforeunload', beforeUnloadHandler);
})();
