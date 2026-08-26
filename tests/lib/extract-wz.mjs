// Shared brace-balanced source extraction for wz-editor.js unit tests.
//
// wz-editor.js is a single self-invoking IIFE with zero exports (by design -- see the file's own
// header comment: "Zero external dependencies, single file... can be attached to and detached from
// any static HTML document"). Adding `module.exports`/`export` to the canonical asset would pollute
// a file that is meant to be pasted verbatim into arbitrary host documents, so these tests don't
// touch it. Instead they extract the exact source text of the pure functions under test (never a
// hand re-implementation) and execute that text in a `node:vm` sandbox -- the same technique already
// used by the scratchpad regression tests (test-crypto-roundtrip.mjs, test-github-provider.mjs,
// etc.) that this Phase 2 refactor must keep passing.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Resolve relative to this file (tests/lib/) so the suite is portable across machines/checkouts.
export const WZ_EDITOR_PATH = fileURLToPath(new URL('../../wz-editor.js', import.meta.url));
export const ENCRYPT_TOOL_PATH = fileURLToPath(new URL('../../tools/encrypt-token.mjs', import.meta.url));

export function readWzSource() {
  return fs.readFileSync(WZ_EDITOR_PATH, 'utf8');
}

// Walks forward from `needle`, brace-counting (skipping string/template literals and // and /* */
// comments so an apostrophe or brace inside one doesn't desync the count), until the enclosing
// block's own closing brace. Returns the full slice from `needle` through that closing brace.
export function extractBalanced(src, needle) {
  const start = src.indexOf(needle);
  if (start === -1) return null;
  const braceStart = src.indexOf('{', start);
  let depth = 0, i = braceStart, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = (nl === -1 ? src.length : nl); continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = (end === -1 ? src.length : end + 1); continue; }
    if (c === '\'' || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// Extracts the sanitizer family (WZ_BAD_TAGS + wzStripUrlNoise + wzUrlIsDangerousHrefLike +
// wzUrlIsDangerousSrcLike + sanitizeHtmlFragment) and runs it in a DOM-backed vm sandbox. These
// functions are pure with respect to module state (they only touch their own arguments and, for
// sanitizeHtmlFragment, the DOM APIs passed in via the sandbox) -- no CFG/GITLAB_*/PROVIDER/token
// state leaks in, which this test suite treats as the "purity" contract to guard.
export function extractSanitizerModule(src) {
  const varStart = src.indexOf('var WZ_BAD_TAGS');
  if (varStart === -1) throw new Error('WZ_BAD_TAGS declaration not found in wz-editor.js');
  const varLine = src.slice(varStart, src.indexOf(';', varStart) + 1);
  const stripFn = extractBalanced(src, 'function wzStripUrlNoise(');
  const hrefFn = extractBalanced(src, 'function wzUrlIsDangerousHrefLike(');
  const srcFn = extractBalanced(src, 'function wzUrlIsDangerousSrcLike(');
  const sanitizeFn = extractBalanced(src, 'function sanitizeHtmlFragment(');
  if (!(stripFn && hrefFn && srcFn && sanitizeFn)) {
    throw new Error('One or more sanitizer functions not found in wz-editor.js -- extraction anchors may be stale');
  }
  return [varLine, stripFn, hrefFn, srcFn, sanitizeFn].join('\n');
}

export function extractCryptoModule(src) {
  const b64ToBytesFn = extractBalanced(src, 'function b64ToBytes(');
  const decryptTokenFn = extractBalanced(src, 'async function decryptToken(');
  const base64ToUtf8Fn = extractBalanced(src, 'function base64ToUtf8(');
  const utf8ToBase64Fn = extractBalanced(src, 'function utf8ToBase64(str){');
  if (!(b64ToBytesFn && decryptTokenFn && base64ToUtf8Fn && utf8ToBase64Fn)) {
    throw new Error('One or more crypto functions not found in wz-editor.js -- extraction anchors may be stale');
  }
  return { b64ToBytesFn, decryptTokenFn, base64ToUtf8Fn, utf8ToBase64Fn };
}

// Runs `document.createElement('template')` + TreeWalker-based sanitization for real -- Node has no
// built-in DOM, so this test suite needs a minimal one. Rather than pull in an external dependency
// (jsdom etc., which would violate the "external dependencies: 0" contract for anything shipped
// under skills/textfix), this hand-rolls just enough of the DOM surface sanitizeHtmlFragment
// actually calls: document.createElement, template.innerHTML get/set (backed by a tiny HTML
// tokenizer), document.createTreeWalker over elements, node.attributes/removeAttribute/localName,
// and parentNode/removeChild for detaching bad nodes.
export function makeMiniDomSandbox() {
  function escapeAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
  class MiniElement {
    constructor(tagName) {
      this.localName = tagName.toLowerCase();
      this.tagName = this.localName.toUpperCase();
      this._attrs = new Map(); // insertion-ordered name(lowercased) -> {name(original case), value}
      this.childNodes = [];
      this.parentNode = null;
    }
    get attributes() {
      return Array.from(this._attrs.values()).map(a => ({ name: a.name, value: a.value }));
    }
    getAttribute(name) {
      const a = this._attrs.get(name.toLowerCase());
      return a ? a.value : null;
    }
    setAttribute(name, value) { this._attrs.set(name.toLowerCase(), { name, value: String(value) }); }
    removeAttribute(name) { this._attrs.delete(name.toLowerCase()); }
    appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; }
    removeChild(node) {
      const i = this.childNodes.indexOf(node);
      if (i !== -1) this.childNodes.splice(i, 1);
      node.parentNode = null;
      return node;
    }
    querySelectorAll(sel) {
      // Only used by wzTargetHasDangerousUrl in the real file, not by sanitizeHtmlFragment's own
      // TreeWalker path -- sanitizeHtmlFragment doesn't call querySelectorAll, so a stub that
      // returns [] is sufficient for this sanitizer-only sandbox.
      return [];
    }
    get innerHTML() { return this.childNodes.map(c => serialize(c)).join(''); }
    set innerHTML(html) { this.childNodes = parseFragment(html, this); }
  }
  class MiniText {
    constructor(data) { this.data = data; this.nodeType = 3; this.parentNode = null; }
  }

  const VOID_TAGS = { br: 1, img: 1, hr: 1, input: 1, meta: 1, link: 1, base: 1 };

  // Manual quote-aware scanner for the tag boundary specifically -- a single regex over the whole
  // fragment (the earlier approach) cannot correctly find where a start tag ends when an attribute
  // VALUE itself contains '<' or '>' (e.g. srcdoc="<script>1</script>"): `[^<>]*?` inside a regex
  // can't consume those characters even when they're safely inside a quoted value, so the match
  // fails/desyncs. A real HTML tokenizer tracks quote state character-by-character; this mirrors
  // just that much of it (attribute VALUES only -- tag/attribute NAMES are not allowed to contain
  // quotes in real HTML either, so this is not a meaningful simplification for those).
  function findTagEnd(html, gtSearchStart) {
    let inQuote = null;
    for (let i = gtSearchStart; i < html.length; i++) {
      const c = html[i];
      if (inQuote) { if (c === inQuote) inQuote = null; continue; }
      if (c === '"' || c === '\'') { inQuote = c; continue; }
      if (c === '>') return i;
    }
    return -1;
  }
  function parseAttrs(el, attrStr) {
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
    let am;
    while ((am = attrRe.exec(attrStr))) {
      const name = am[1];
      const val = am[3] !== undefined ? am[3] : (am[4] !== undefined ? am[4] : (am[2] || ''));
      el.setAttribute(name, val);
    }
  }
  function parseFragment(html, ownerParent) {
    // Each stack frame tracks its own `owner` (the MiniElement whose childNodes this frame is
    // populating, or `ownerParent` for the root/document-fragment level) so every pushed child gets
    // a correct .parentNode -- needed for sanitizeHtmlFragment's `el.parentNode.removeChild(el)`.
    const stack = [{ children: [], owner: ownerParent }];
    let pos = 0;
    while (pos < html.length) {
      const lt = html.indexOf('<', pos);
      const top = stack[stack.length - 1];
      if (lt === -1) {
        if (pos < html.length) {
          const t = new MiniText(html.slice(pos));
          t.parentNode = top.owner;
          top.children.push(t);
        }
        break;
      }
      if (lt > pos) {
        const t = new MiniText(html.slice(pos, lt));
        t.parentNode = top.owner;
        top.children.push(t);
      }
      const isClose = html[lt + 1] === '/';
      const nameStart = isClose ? lt + 2 : lt + 1;
      const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(nameStart));
      if (!nameMatch) { // not a real tag (e.g. a lone '<') -- treat '<' as text and move on
        const t = new MiniText('<');
        t.parentNode = top.owner;
        top.children.push(t);
        pos = lt + 1;
        continue;
      }
      const tag = nameMatch[0].toLowerCase();
      const gt = findTagEnd(html, nameStart + nameMatch[0].length);
      if (gt === -1) { pos = html.length; break; } // unterminated tag -- stop (fixtures are well-formed)
      if (isClose) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tag === tag) { stack.length = i; break; }
        }
        pos = gt + 1;
        continue;
      }
      const selfClosing = html[gt - 1] === '/';
      const attrStr = html.slice(nameStart + nameMatch[0].length, selfClosing ? gt - 1 : gt);
      const el = new MiniElement(tag);
      el.parentNode = top.owner;
      parseAttrs(el, attrStr);
      top.children.push(el);
      if (!(selfClosing || VOID_TAGS[tag])) {
        stack.push({ tag, children: el.childNodes, owner: el });
      }
      pos = gt + 1;
    }
    return stack[0].children;
  }

  function serialize(node) {
    if (node.nodeType === 3) return escapeText(node.data);
    const attrs = node.attributes.map(a => ' ' + a.name + '="' + escapeAttr(a.value) + '"').join('');
    if (VOID_TAGS[node.localName]) return '<' + node.localName + attrs + '>';
    return '<' + node.localName + attrs + '>' + node.childNodes.map(serialize).join('') + '</' + node.localName + '>';
  }
  function escapeText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function walkElements(root) {
    const out = [];
    (function rec(node) {
      for (const child of node.childNodes) {
        if (child.nodeType !== 3) { out.push(child); rec(child); }
      }
    })(root);
    return out;
  }

  const documentShim = {
    createElement(tag) {
      if (tag === 'template') {
        const tpl = new MiniElement('template');
        // `.content` mirrors real <template>: assigning innerHTML populates a distinct fragment,
        // read back via tpl.content.innerHTML per sanitizeHtmlFragment's own usage.
        Object.defineProperty(tpl, 'content', {
          get() { return tpl; } // simplification: template IS its own content container here.
        });
        return tpl;
      }
      return new MiniElement(tag);
    },
    createTreeWalker(root /*, whatToShow */) {
      const nodes = walkElements(root);
      let idx = -1;
      return { nextNode() { idx++; return idx < nodes.length ? nodes[idx] : null; } };
    }
  };

  return {
    document: documentShim,
    NodeFilter: { SHOW_ELEMENT: 1 }
  };
}
