// embed-lint.mjs contract tests -- validates that a wz-editor embed's marker block
// (<!-- wz-editor:start -->..<!-- wz-editor:end -->) is wired correctly WITHOUT needing a
// browser: tokenCipherB64 present, host is https, allowedHosts contains the host's *origin*
// (matching wz-editor.js's own `new URL(...).origin` comparison exactly), and the wz-editor.js
// <script src="..."> resolves to a real file relative to the HTML document.
//
// Run: node --test tests/embed-lint.test.mjs   (from the textfix skill root)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WZ_EDITOR_PATH } from './lib/extract-wz.mjs';

export const EMBED_LINT_PATH = fileURLToPath(new URL('../tools/embed-lint.mjs', import.meta.url));

function makeFixtureHtml(dir, { host = 'https://gitlab.example.com', allowedHosts = ["'https://gitlab.example.com'"], cipher = 'AbCdEf123==', scriptSrc } = {}) {
  const htmlPath = path.join(dir, 'doc.html');
  const resolvedSrc = scriptSrc !== undefined ? scriptSrc : path.relative(dir, WZ_EDITOR_PATH).split(path.sep).join('/');
  const html = [
    '<!doctype html><html><body><h1>Fixture doc</h1>',
    '<!-- wz-editor:start -->',
    '<script>',
    '  window.WZ_EDITOR_CONFIG = {',
    "    provider: 'gitlab',",
    "    gitlabHost: '" + host + "',",
    "    tokenSaltB64: 'salt==',",
    "    tokenIvB64: 'iv==',",
    "    tokenCipherB64: '" + cipher + "',",
    '    allowedHosts: [' + allowedHosts.join(', ') + ']',
    '  };',
    '</script>',
    '<script src="' + resolvedSrc + '"></script>',
    '<!-- wz-editor:end -->',
    '</body></html>'
  ].join('\n');
  fs.writeFileSync(htmlPath, html, 'utf8');
  return htmlPath;
}

function run(htmlPath) {
  return spawnSync(process.execPath, [EMBED_LINT_PATH, htmlPath], { encoding: 'utf8' });
}

test('(a) a well-formed embed (allowedHosts as a real origin, real script src) -- all checks PASS, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-lint-ok-'));
  try {
    const htmlPath = makeFixtureHtml(dir);
    const res = run(htmlPath);
    assert.equal(res.status, 0, 'stdout: ' + res.stdout + ' stderr: ' + res.stderr);
    assert.doesNotMatch(res.stdout, /FAIL/);
    assert.match(res.stdout, /PASS.*tokenCipherB64/i);
    assert.match(res.stdout, /PASS.*https/i);
    assert.match(res.stdout, /PASS.*allowedHosts/i);
    assert.match(res.stdout, /PASS.*script src|PASS.*wz-editor\.js/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('(b) allowedHosts given as a bare hostname (no scheme) instead of an origin -- that specific check FAILs, others still PASS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-lint-hostname-'));
  try {
    // 'gitlab.example.com' (no https:// scheme) must NOT satisfy the allowedHosts-origin check,
    // even though a naive substring/contains check might be fooled by it.
    const htmlPath = makeFixtureHtml(dir, { allowedHosts: ["'gitlab.example.com'"] });
    const res = run(htmlPath);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /FAIL.*allowedHosts/i);
    // the other three checks are unaffected by this fixture and must still PASS
    assert.match(res.stdout, /PASS.*tokenCipherB64/i);
    assert.match(res.stdout, /PASS.*https/i);
    assert.match(res.stdout, /PASS.*script src|PASS.*wz-editor\.js/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('(c) <script src> points at a file that does not exist -- that check FAILs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-lint-missing-src-'));
  try {
    const htmlPath = makeFixtureHtml(dir, { scriptSrc: './does-not-exist-wz-editor.js' });
    const res = run(htmlPath);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /FAIL.*script src|FAIL.*wz-editor\.js/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tokenCipherB64 missing/empty -- that check FAILs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-lint-no-cipher-'));
  try {
    const htmlPath = makeFixtureHtml(dir, { cipher: '' });
    const res = run(htmlPath);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /FAIL.*tokenCipherB64/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('host given as http:// (not https) -- that check FAILs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-lint-http-'));
  try {
    const htmlPath = makeFixtureHtml(dir, { host: 'http://gitlab.example.com', allowedHosts: ["'http://gitlab.example.com'"] });
    const res = run(htmlPath);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /FAIL.*https/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no marker block found -- exits non-zero with a clear message, does not crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-lint-no-marker-'));
  try {
    const htmlPath = path.join(dir, 'plain.html');
    fs.writeFileSync(htmlPath, '<!doctype html><html><body>no editor here</body></html>', 'utf8');
    const res = run(htmlPath);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /marker/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing file argument / nonexistent path -- exits non-zero, does not crash', () => {
  const res1 = spawnSync(process.execPath, [EMBED_LINT_PATH], { encoding: 'utf8' });
  assert.notEqual(res1.status, 0);
  const res2 = spawnSync(process.execPath, [EMBED_LINT_PATH, path.join(os.tmpdir(), 'this-file-does-not-exist-embed-lint.html')], { encoding: 'utf8' });
  assert.notEqual(res2.status, 0);
});
