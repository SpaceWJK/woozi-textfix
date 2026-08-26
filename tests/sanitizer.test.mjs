// R2: formal unit tests for wz-editor.js's HTML sanitizer family (sanitizeHtmlFragment,
// wzUrlIsDangerousHrefLike/SrcLike, wzStripUrlNoise). Extracts the REAL source (never a
// re-implementation) via lib/extract-wz.mjs and runs it in a node:vm sandbox backed by a minimal
// hand-rolled DOM (see makeMiniDomSandbox in lib/extract-wz.mjs for why: zero external
// dependencies, matching wz-editor.js's own "Zero external dependencies" contract).
//
// Purity contract under test: these functions must depend on nothing but their own arguments (and,
// for sanitizeHtmlFragment, the DOM primitives passed into the sandbox) -- no CFG/GITLAB_*/PROVIDER/
// token/module-level state. That's what makes them safely extractable and independently testable at
// all; a future edit that makes any of them reach for outer module state would break this
// extraction (ReferenceError) before it could break anything else.
//
// Run: node --test tests/sanitizer.test.mjs   (from the textfix skill root)
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readWzSource, extractSanitizerModule, makeMiniDomSandbox } from './lib/extract-wz.mjs';

const wzSrc = readWzSource();
const sanitizerSrc = extractSanitizerModule(wzSrc);

function makeSandbox() {
  const dom = makeMiniDomSandbox();
  const sandbox = { document: dom.document, NodeFilter: dom.NodeFilter, console };
  vm.createContext(sandbox);
  vm.runInContext(
    sanitizerSrc + '\n' +
    'globalThis.__sanitize = sanitizeHtmlFragment;\n' +
    'globalThis.__hrefDangerous = wzUrlIsDangerousHrefLike;\n' +
    'globalThis.__srcDangerous = wzUrlIsDangerousSrcLike;\n' +
    'globalThis.__stripNoise = wzStripUrlNoise;\n',
    sandbox,
    { filename: 'wz-sanitizer-extract.js' }
  );
  return sandbox;
}

// ---------------------------------------------------------------------------
// Purity: the extraction itself must succeed with ONLY document/NodeFilter/console in scope --
// if any of these functions referenced outer module state (CFG, GITLAB_*, PROVIDER, token vars),
// this vm.runInContext call would throw ReferenceError before any test below could run.
// ---------------------------------------------------------------------------
test('sanitizer functions extract and run standalone with no module-level state in scope', () => {
  assert.doesNotThrow(() => makeSandbox());
});

// ---------------------------------------------------------------------------
// wzStripUrlNoise -- strips C0 controls, space, DEL, C1 controls from anywhere in the string
// ---------------------------------------------------------------------------
test('wzStripUrlNoise removes embedded tab/newline/control chars, not just leading whitespace', () => {
  const sb = makeSandbox();
  assert.equal(sb.__stripNoise('java\tscript:alert(1)'), 'javascript:alert(1)');
  assert.equal(sb.__stripNoise('java\nscript:alert(1)'), 'javascript:alert(1)');
  assert.equal(sb.__stripNoise('\x01javascript:alert(1)'), 'javascript:alert(1)');
  assert.equal(sb.__stripNoise('java\x7Fscript:alert(1)'), 'javascript:alert(1)'); // DEL
  assert.equal(sb.__stripNoise('  https://example.com  '), 'https://example.com');
});

// ---------------------------------------------------------------------------
// wzUrlIsDangerousHrefLike / wzUrlIsDangerousSrcLike -- scheme judgement (N-2 control-char evasion)
// ---------------------------------------------------------------------------
test('href judged dangerous: javascript:/vbscript:/data: in plain and control-char-obfuscated form', () => {
  const sb = makeSandbox();
  assert.equal(sb.__hrefDangerous('javascript:alert(1)'), true);
  assert.equal(sb.__hrefDangerous('JavaScript:alert(1)'), true, 'case-insensitive scheme match');
  assert.equal(sb.__hrefDangerous('java\tscript:alert(1)'), true, 'N-2: tab inside scheme must not evade');
  assert.equal(sb.__hrefDangerous('java\nscript:alert(1)'), true, 'N-2: newline inside scheme must not evade');
  assert.equal(sb.__hrefDangerous('\x01javascript:alert(1)'), true, 'N-2: leading C0 control must not evade');
  assert.equal(sb.__hrefDangerous('vbscript:msgbox(1)'), true);
  assert.equal(sb.__hrefDangerous('data:text/html,<script>alert(1)</script>'), true, 'href data: is always dangerous (full-document navigation)');
});

test('href judged safe for ordinary link schemes', () => {
  const sb = makeSandbox();
  assert.equal(sb.__hrefDangerous('https://example.com/report.html'), false);
  assert.equal(sb.__hrefDangerous('mailto:a@example.com'), false);
  assert.equal(sb.__hrefDangerous('#section-2'), false);
  assert.equal(sb.__hrefDangerous(''), false);
});

test('src judged dangerous: javascript:/vbscript: always, data: only when non-image MIME', () => {
  const sb = makeSandbox();
  assert.equal(sb.__srcDangerous('javascript:alert(1)'), true);
  assert.equal(sb.__srcDangerous('java\tscript:alert(1)'), true, 'N-2: control-char obfuscation must not evade in src either');
  assert.equal(sb.__srcDangerous('data:text/html,<script>alert(1)</script>'), true, 'non-image data: MIME blocked in src');
  assert.equal(sb.__srcDangerous('data:image/png;base64,iVBORw0KGgo='), false, 'inline images are the one legitimate data: use for src');
});

// ---------------------------------------------------------------------------
// sanitizeHtmlFragment -- structural tag stripping, including SVG/MathML foreign content
// ---------------------------------------------------------------------------
test('sanitizeHtmlFragment removes a bare <script> tag entirely', () => {
  const sb = makeSandbox();
  const out = sb.__sanitize('<p>hi</p><script>alert(1)</script>');
  assert.ok(!/script/i.test(out), 'no script tag survives: ' + out);
  assert.ok(/<p>hi<\/p>/.test(out));
});

test('sanitizeHtmlFragment removes <script> nested inside <svg> (foreign content, N-1 regression)', () => {
  const sb = makeSandbox();
  const out = sb.__sanitize('<svg><script>alert(1)</script></svg>');
  assert.ok(!/script/i.test(out), 'svg-wrapped script must still be stripped: ' + out);
});

test('sanitizeHtmlFragment removes <style> nested inside <math> (foreign content, N-1 regression)', () => {
  const sb = makeSandbox();
  const out = sb.__sanitize('<math><style>body{}</style></math>');
  assert.ok(!/<style/i.test(out), 'math-wrapped style must still be stripped: ' + out);
});

test('sanitizeHtmlFragment removes iframe/object/embed/form/meta/base/link/noscript', () => {
  const sb = makeSandbox();
  for (const tag of ['iframe', 'object', 'embed', 'form', 'meta', 'base', 'link', 'noscript']) {
    const out = sb.__sanitize('<p>x</p><' + tag + '></' + tag + '>');
    assert.ok(!new RegExp('<' + tag, 'i').test(out), tag + ' must be stripped: ' + out);
  }
});

test('sanitizeHtmlFragment strips on* event-handler attributes', () => {
  const sb = makeSandbox();
  const out = sb.__sanitize('<p onclick="alert(1)" onmouseover="alert(2)">hi</p>');
  assert.ok(!/onclick/i.test(out) && !/onmouseover/i.test(out), 'handler attrs must be stripped: ' + out);
  assert.ok(/hi/.test(out), 'text content preserved');
});

test('sanitizeHtmlFragment strips dangerous href (plain and control-char-obfuscated)', () => {
  const sb = makeSandbox();
  const out1 = sb.__sanitize('<a href="javascript:alert(1)">click</a>');
  assert.ok(!/javascript:/i.test(out1), 'plain javascript: href must be stripped: ' + out1);
  const out2 = sb.__sanitize('<a href="java\tscript:alert(1)">click</a>');
  assert.ok(!/javascript:/i.test(out2) && !/java\tscript:/i.test(out2), 'N-2 obfuscated href must be stripped: ' + out2);
});

test('sanitizeHtmlFragment strips dangerous src but keeps a legitimate data:image src', () => {
  const sb = makeSandbox();
  const outBad = sb.__sanitize('<img src="javascript:alert(1)">');
  assert.ok(!/javascript:/i.test(outBad), 'dangerous img src must be stripped: ' + outBad);
  const outGood = sb.__sanitize('<img src="data:image/png;base64,iVBORw0KGgo=">');
  assert.ok(/data:image\/png/.test(outGood), 'legitimate inline image src must survive: ' + outGood);
});

test('sanitizeHtmlFragment strips srcdoc and dangerous inline style (expression/url/javascript:)', () => {
  const sb = makeSandbox();
  const out1 = sb.__sanitize('<iframe srcdoc="<script>1</script>"></iframe>');
  assert.ok(!/srcdoc/i.test(out1), 'srcdoc must be stripped (iframe itself is also removed): ' + out1);
  const out2 = sb.__sanitize('<p style="background:url(javascript:alert(1))">x</p>');
  assert.ok(!/style=/.test(out2) || !/javascript:/i.test(out2), 'dangerous inline style must be stripped: ' + out2);
});

test('sanitizeHtmlFragment preserves ordinary formatting markup untouched', () => {
  const sb = makeSandbox();
  const out = sb.__sanitize('<p><b>bold</b> and <span style="color:#333">colored</span> text</p>');
  assert.ok(/<b>bold<\/b>/.test(out));
  assert.ok(/color:#333/.test(out), 'benign inline style survives: ' + out);
});
