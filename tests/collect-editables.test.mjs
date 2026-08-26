// stepA_universal (textfix-ux-redesign): tests for the generic default text-node collection
// heuristic that replaces wz-editor.js's old hardcoded report-only class selector
// (collectEditablesBySelector / collectEditablesHeuristic / collectEditablesFrom). Extracts the REAL
// source via lib/extract-wz.mjs and runs it in a node:vm sandbox backed by a second, purpose-built
// mini-DOM (see extractCollectModule/parseMiniDocument in lib/extract-wz.mjs for why this doesn't
// reuse makeMiniDomSandbox: TreeWalker(SHOW_TEXT)/closest()/contains() are a different DOM surface
// than the sanitizer sandbox implements, and touching that one risks the 14 sanitizer tests it
// already backs).
//
// Three acceptance invariants (per the task brief) are checked on every fixture, using an
// INDEPENDENT reference model (referenceOwnTextElements below) rather than re-deriving the expected
// set via the same TreeWalker-based algorithm under test -- recomputing the expectation with the
// same computation as the implementation would make the check tautological (development.md §12.6's
// "expect(add(a,b)).toBe(a+b)" anti-pattern). referenceOwnTextElements instead does a plain recursive
// descent over childNodes and checks each element's OWN immediate children for a non-whitespace Text
// node -- a differently-shaped traversal over the same specification, so it can catch a real omission
// bug in the implementation rather than agreeing with it by construction.
//
// Run: node --test tests/collect-editables.test.mjs   (from the textfix skill root)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readWzSource, extractCollectModule, parseMiniDocument, COLLECT_NODE_FILTER } from './lib/extract-wz.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const wzSrc = readWzSource();
const collectSrc = extractCollectModule(wzSrc);

function makeSandbox() {
  const sandbox = { NodeFilter: COLLECT_NODE_FILTER, console };
  vm.createContext(sandbox);
  vm.runInContext(
    collectSrc + '\nglobalThis.__collect = collectEditablesFrom;\n',
    sandbox,
    { filename: 'wz-collect-extract.js' }
  );
  return sandbox;
}

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

const EXCLUDE_ANCESTOR_SEL_TEST_COPY =
  '.wz-edit-toolbar, .wz-pw-modal-overlay, .wz-draft-banner, .wz-save-toast, .wz-edit-fab';
const STRUCTURAL_TAGS = new Set(['script', 'style', 'noscript', 'template']);

// Independent reference model -- see file header. Returns every element that has, as a DIRECT
// (non-recursive) child, at least one non-whitespace Text node, excluding wz-* UI chrome and
// script/style/noscript/template subtrees (which are also skipped entirely, matching "자체 및 내부").
function referenceOwnTextElements(doc) {
  const out = [];
  (function rec(node) {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (STRUCTURAL_TAGS.has(child.localName)) continue; // skip subtree entirely
      if (child.closest(EXCLUDE_ANCESTOR_SEL_TEST_COPY)) continue; // skip subtree entirely
      const hasOwnText = child.childNodes.some(c => c.nodeType === 3 && /\S/.test(c.nodeValue));
      if (hasOwnText) out.push(child);
      rec(child);
    }
  })(doc.body);
  return out;
}

function sig(el) {
  const ownText = el.childNodes.filter(c => c.nodeType === 3).map(c => c.nodeValue).join('');
  return el.tagName + '|' + (el.getAttribute('class') || '') + '|' + ownText.trim();
}

const FIXTURE_NAMES = ['report-style.html', 'prose-mixed.html', 'table-centric.html', 'card-div.html'];

for (const name of FIXTURE_NAMES) {
  const html = readFixture(name);

  test(`[${name}] 누락 0 -- every element with its own visible text is covered by some collected element`, () => {
    const sb = makeSandbox();
    const doc = parseMiniDocument(html);
    const results = sb.__collect(doc, null);
    const expectedCandidates = referenceOwnTextElements(doc);
    assert.ok(expectedCandidates.length > 0, 'fixture sanity: reference model found at least one candidate');
    for (const candidate of expectedCandidates) {
      const covered = results.some(r => r === candidate || r.contains(candidate));
      assert.ok(covered, 'not covered by any collected element: ' + sig(candidate));
    }
  });

  test(`[${name}] 중첩 0 -- no collected element contains another collected element`, () => {
    const sb = makeSandbox();
    const doc = parseMiniDocument(html);
    const results = sb.__collect(doc, null);
    assert.ok(results.length > 0, 'fixture sanity: heuristic collected at least one element');
    for (let i = 0; i < results.length; i++) {
      for (let j = 0; j < results.length; j++) {
        if (i === j) continue;
        assert.ok(
          !results[i].contains(results[j]),
          sig(results[i]) + ' contains ' + sig(results[j])
        );
      }
    }
  });

  test(`[${name}] 결정성 -- re-parsing and re-collecting the same HTML yields the same count and order`, () => {
    const sb = makeSandbox();
    const docA = parseMiniDocument(html);
    const docB = parseMiniDocument(html); // independent parse -- fresh element identities
    const resultsA = sb.__collect(docA, null);
    const resultsB = sb.__collect(docB, null);
    assert.equal(resultsA.length, resultsB.length, 'element count differs between two collection passes');
    assert.deepEqual(resultsA.map(sig), resultsB.map(sig), 'element order/identity signature differs between two collection passes');
  });

  test(`[${name}] wz-editor UI chrome text is never collected`, () => {
    const sb = makeSandbox();
    const doc = parseMiniDocument(html);
    const results = sb.__collect(doc, null);
    for (const el of results) {
      assert.equal(el.closest(EXCLUDE_ANCESTOR_SEL_TEST_COPY), null, sig(el) + ' is inside wz-editor UI chrome');
    }
  });

  test(`[${name}] script/style/noscript/template text is never collected`, () => {
    const sb = makeSandbox();
    const doc = parseMiniDocument(html);
    const results = sb.__collect(doc, null);
    for (const el of results) {
      assert.equal(el.closest('script, style, noscript, template'), null, sig(el) + ' is inside a structural-exclude tag');
    }
  });
}

// ---------------------------------------------------------------------------
// Fixture-specific hand-authored assertions (non-tautological: expected substrings/structure below
// were read directly off the fixture file by a human, not derived by running the algorithm).
// ---------------------------------------------------------------------------

test('[prose-mixed.html] mixed content keeps the OUTER <p> as the single edit target, not the nested <span>', () => {
  const sb = makeSandbox();
  const doc = parseMiniDocument(readFixture('prose-mixed.html'));
  const results = sb.__collect(doc, null);
  const withNestedSpan = results.find(el =>
    el.localName === 'p' && el.childNodes.some(c => c.nodeType === 1 && c.localName === 'span')
  );
  assert.ok(withNestedSpan, 'expected to find the <p> that has a nested <span> child among the collected elements');
  const spanInsideIt = withNestedSpan.childNodes.find(c => c.nodeType === 1 && c.localName === 'span');
  assert.ok(!results.includes(spanInsideIt), 'the nested <span> must NOT also be separately collected (outermost-wins)');
});

test('[prose-mixed.html] excluded regions never leak their text into any collected element', () => {
  const sb = makeSandbox();
  const doc = parseMiniDocument(readFixture('prose-mixed.html'));
  const results = sb.__collect(doc, null);
  const joined = results.map(el => el.childNodes.filter(c => c.nodeType === 3).map(c => c.nodeValue).join('')).join('\n');
  assert.ok(!joined.includes('prose fixture'), 'script content must not appear in any collected element\'s own text');
  assert.ok(!joined.includes('가짜 태그'), 'script content (including HTML-looking text inside it) must not leak');
  assert.ok(!joined.includes('지원하지 않습니다'), 'noscript content must not appear');
  assert.ok(!joined.includes('템플릿 행 텍스트'), 'template content must not appear');
  assert.ok(!joined.includes('비밀번호 입력'), 'wz-pw-modal-overlay chrome text must not appear');
  assert.ok(!joined.includes('저장되었습니다'), 'wz-save-toast chrome text must not appear');
});

test('[prose-mixed.html] real prose is actually collected (own-text coverage, spot check)', () => {
  const sb = makeSandbox();
  const doc = parseMiniDocument(readFixture('prose-mixed.html'));
  const results = sb.__collect(doc, null);
  const allOwnText = results.map(el => el.childNodes.filter(c => c.nodeType === 3).map(c => c.nodeValue).join('')).join('\n');
  assert.ok(allOwnText.includes('왜 문서마다 편집 셀렉터를 따로 지정해야 했는가'), 'h1 text should be collected verbatim');
  assert.ok(allOwnText.includes('대안 설계'), 'h2 text should be collected verbatim');
  assert.ok(allOwnText.includes('장점: 문서 구조에 의존하지 않는다'), 'li text should be collected verbatim');
});

test('[table-centric.html] each <td>/<th> is its own editable, and <tr> itself is never collected', () => {
  const sb = makeSandbox();
  const doc = parseMiniDocument(readFixture('table-centric.html'));
  const results = sb.__collect(doc, null);
  assert.ok(!results.some(el => el.localName === 'tr'), '<tr> has no direct text of its own and must not be collected');
  assert.ok(results.some(el => el.localName === 'caption'), '<caption> should be its own collected element');
  const cellTexts = results
    .filter(el => el.localName === 'td' || el.localName === 'th')
    .map(el => el.childNodes.filter(c => c.nodeType === 3).map(c => c.nodeValue).join(''));
  assert.ok(cellTexts.some(t => t.includes('Issue Dashboard')), 'a plain data cell should be collected');
  assert.ok(cellTexts.some(t => t.includes('혼합 셀')), 'the mixed-content cell (text + <b>) should be collected at the <td> level');
});

test('[table-centric.html] mixed-content cell keeps <td> as the target, not the nested <b>', () => {
  const sb = makeSandbox();
  const doc = parseMiniDocument(readFixture('table-centric.html'));
  const results = sb.__collect(doc, null);
  const mixedTd = results.find(el =>
    el.localName === 'td' && el.childNodes.some(c => c.nodeType === 1 && c.localName === 'b')
  );
  assert.ok(mixedTd, 'expected the <td> with a nested <b> among the collected elements');
  const b = mixedTd.childNodes.find(c => c.nodeType === 1 && c.localName === 'b');
  assert.ok(!results.includes(b), '<b> must not be separately collected');
});

// Real-doc empirical finding (see the fixture's own comment on the "합계" cell): when a <td>'s
// ENTIRE content is wrapped in a single child element (no direct text of the <td>'s own), the
// child -- not the <td> -- ends up as the outermost editable, because <td> never seeds collection
// (it has no own direct text node to start from). Text is still fully covered; this asserts that
// specific, previously-undiscovered-by-the-synthetic-fixtures divergence explicitly so it stays a
// documented, intentional outcome rather than a silent surprise.
test('[table-centric.html] a <td> whose ENTIRE text is wrapped in one child collects the child, not the <td>', () => {
  const sb = makeSandbox();
  const doc = parseMiniDocument(readFixture('table-centric.html'));
  const results = sb.__collect(doc, null);
  const wrappedTd = results.find(el =>
    el.localName === 'td' &&
    el.childNodes.every(c => c.nodeType !== 3 || !/\S/.test(c.nodeValue)) && // no own direct visible text
    el.childNodes.some(c => c.nodeType === 1 && c.localName === 'b' && c.childNodes.some(cc => cc.nodeType === 3 && cc.nodeValue.includes('합계')))
  );
  assert.equal(wrappedTd, undefined, 'the wholly-wrapped <td> itself must NOT be collected (it has no own direct text)');
  const bDirect = results.find(el => el.localName === 'b' && el.childNodes.some(c => c.nodeType === 3 && c.nodeValue.includes('합계')));
  assert.ok(bDirect, 'the <b>합계</b> itself must be collected as the outermost element holding that text');
  const allText = results.map(el => el.childNodes.filter(c => c.nodeType === 3).map(c => c.nodeValue).join('')).join('\n');
  assert.ok(allText.includes('합계'), 'the text itself must still be present somewhere in the collected set (no information loss)');
});

test('[card-div.html] a wrapper div with only nested block children (no own text) is never collected', () => {
  const sb = makeSandbox();
  const doc = parseMiniDocument(readFixture('card-div.html'));
  const results = sb.__collect(doc, null);
  assert.ok(!results.some(el => el.getAttribute('class') === 'grid'), 'the .grid wrapper has no own text and must not be collected');
  assert.ok(!results.some(el => el.getAttribute('class') === 'cell'), '.cell wrappers (own text-less) must not be collected');
  assert.ok(results.some(el => el.localName === 'h4'), 'h4 inside a card should be collected');
});

test('[card-div.html] a div with BOTH direct text and a nested element wins as the outermost editable', () => {
  const sb = makeSandbox();
  const doc = parseMiniDocument(readFixture('card-div.html'));
  const results = sb.__collect(doc, null);
  const statusDiv = results.find(el =>
    el.localName === 'div' &&
    el.childNodes.some(c => c.nodeType === 3 && c.nodeValue.includes('상태:'))
  );
  assert.ok(statusDiv, 'expected the "상태: <span>정상</span>" div to be collected as a single unit');
  const nestedSpan = statusDiv.childNodes.find(c => c.nodeType === 1 && c.localName === 'span');
  assert.ok(nestedSpan, 'sanity: that div does have a nested span');
  assert.ok(!results.includes(nestedSpan), 'the nested <span> ("정상") must not also be separately collected');
});

// ---------------------------------------------------------------------------
// Backward-compat: config.editableSelector still routes through the old selector-based path
// unchanged (collectEditablesBySelector), with the same "drop wz-chrome, then drop nested
// duplicates" behavior it always had.
// ---------------------------------------------------------------------------

test('[report-style.html] override selector (config.editableSelector) still works via the legacy path', () => {
  const sb = makeSandbox();
  const doc = parseMiniDocument(readFixture('report-style.html'));
  const results = sb.__collect(doc, 'h1, .kpi-desc');
  assert.equal(results.length, 3, 'expected exactly the h1 plus the two .kpi-desc elements');
  assert.ok(results.some(el => el.localName === 'h1'));
  assert.equal(results.filter(el => el.getAttribute('class') === 'kpi-desc').length, 2);
});

test('[report-style.html] override selector never returns elements inside wz-editor UI chrome', () => {
  const sb = makeSandbox();
  const doc = parseMiniDocument(readFixture('report-style.html'));
  // A broad override that WOULD match inside the fab/toolbar chrome if the exclusion filter were
  // skipped -- 'span' matches both '.tag'/'.tl-badge' style content spans AND the fab/toolbar spans.
  const results = sb.__collect(doc, 'span');
  for (const el of results) {
    assert.equal(el.closest(EXCLUDE_ANCESTOR_SEL_TEST_COPY), null, 'override path leaked a UI-chrome span: ' + sig(el));
  }
});

// ---------------------------------------------------------------------------
// No-regression superset check: the new default heuristic, on the document the OLD hardcoded
// selector was tuned for, must collect at least everything the old selector would have (every old
// match is contained in-or-equal-to some heuristic result) -- i.e. going generic must never make a
// previously-editable report element stop being editable.
// ---------------------------------------------------------------------------

// Kept here ONLY as a literal snapshot of the pre-refactor DEFAULT_EDIT_SEL for this one comparison
// test -- wz-editor.js itself no longer defines this constant (see wz-editor.js's own comment on
// OVERRIDE_EDIT_SEL for why: the generic heuristic is now the default, this string is not read by
// the module at all).
const OLD_DEFAULT_EDIT_SEL = 'h1, h2, .page-title, .page-sub, .page-eyebrow, .section-label, .cover .lead, .cover .tag, '
  + 'p, li, td, th, .kpi-desc, .kpi-label, .kpi-value, .insight-title, .insight-body, .insight-tag, '
  + '.step-title, .step-time, .step-desc, .tl-step, .tl-q, .tl-result, .tl-learn, .tl-badge, .card h4, '
  + '.callout, .conclusion-label, .conclusion-body';
// The mini-DOM's querySelectorAll only understands bare-tag/.class tokens (no descendant
// combinators) -- '.cover .lead', '.cover .tag', and '.card h4' are dropped for this comparison,
// each replaced by its rightmost simple token so the comparison selector is still a (loose)
// superset of what the real selector would match in a real browser, never a subset. That keeps
// this a valid "new heuristic >= old selector" check: if it holds against the looser stand-in, it
// holds against the stricter real one too.
const OLD_DEFAULT_EDIT_SEL_FOR_MINIDOM = OLD_DEFAULT_EDIT_SEL
  .replace('.cover .lead', '.lead')
  .replace('.cover .tag', '.tag')
  .replace('.card h4', 'h4');

test('[report-style.html] new heuristic is a superset of the old hardcoded report selector', () => {
  const sb = makeSandbox();
  const docHeuristic = parseMiniDocument(readFixture('report-style.html'));
  const docOldSel = parseMiniDocument(readFixture('report-style.html'));
  const heuristicResults = sb.__collect(docHeuristic, null);
  const oldSelResults = sb.__collect(docOldSel, OLD_DEFAULT_EDIT_SEL_FOR_MINIDOM);
  assert.ok(oldSelResults.length > 0, 'fixture sanity: old selector matched something');
  assert.ok(heuristicResults.length >= oldSelResults.length, 'heuristic (' + heuristicResults.length + ') should collect at least as many elements as the old selector (' + oldSelResults.length + ')');
  for (const oldEl of oldSelResults) {
    const covered = heuristicResults.some(h => sig(h) === sig(oldEl));
    assert.ok(covered, 'old-selector match not represented among heuristic results: ' + sig(oldEl));
  }
});
