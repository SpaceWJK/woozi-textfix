#!/usr/bin/env node
/*!
 * embed-lint.mjs — validates that a wz-editor embed (the <!-- wz-editor:start -->..
 * <!-- wz-editor:end --> marker block /textfix attaches to a host HTML document) is wired
 * correctly, without needing a browser. Run it after attaching (or when auditing an existing
 * attachment) to catch four concrete misconfigurations before they reach a user's browser:
 *
 *   1. tokenCipherB64 missing/empty        -> wz-editor.js's own mandatory-token gate refuses to
 *                                              initialize the module at all; the edit button never
 *                                              appears.
 *   2. host (gitlabHost/apiBase) not https -> wz-editor.js's own gate ("not a valid https URL")
 *                                              rejects it — same dead-on-arrival failure as #1.
 *   3. allowedHosts doesn't contain the host's *origin* -> a hostname-only entry (no scheme), or
 *      an entry with a trailing path/query, silently fails the origin comparison inside
 *      wz-editor.js and the module refuses to initialize. This script parses the origin with the
 *      exact same `new URL(...).origin` wz-editor.js itself uses, so the two can never disagree.
 *   4. the wz-editor.js <script src="..."> path doesn't resolve to a real file relative to the
 *      HTML document -> a silent 404 in the browser console; the edit button never appears.
 *
 * ===== Usage =====
 *   node embed-lint.mjs <path to an HTML file with a wz-editor:start/end marker block>
 *
 * Prints one PASS/FAIL line per check to stdout. Exit code 0 if every check passes, 1 if any
 * check fails or the file/marker block/config can't be found or parsed at all.
 *
 * Zero external dependencies — only Node's built-in fs/path/vm modules. The WZ_EDITOR_CONFIG
 * assignment is evaluated by literally running the embed's own <script> text in a `window` vm
 * sandbox (the same technique tests/lib/extract-wz.mjs uses to test wz-editor.js's real source)
 * rather than hand-rolling a JS-object-literal parser — this mirrors what a real browser does
 * with that script and so can never disagree with it about what the config actually says.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function fail(msg) {
  console.error('[embed-lint] ' + msg);
  console.error('Usage: node embed-lint.mjs <html-path>');
  process.exit(1);
}

function readArg() {
  const htmlPath = process.argv[2];
  if (!htmlPath) fail('An HTML file path is required.');
  if (!fs.existsSync(htmlPath)) fail('File not found: ' + htmlPath);
  return htmlPath;
}

function extractMarkerBlock(html, htmlPath) {
  const startIdx = html.indexOf('<!-- wz-editor:start -->');
  const endIdx = html.indexOf('<!-- wz-editor:end -->');
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    fail('No <!-- wz-editor:start -->/<!-- wz-editor:end --> marker block found in ' + htmlPath + ' — is the editor attached?');
  }
  return html.slice(startIdx, endIdx);
}

// Finds the inline config <script> (no src attribute) whose body mentions WZ_EDITOR_CONFIG,
// deliberately distinct from the second <script src="..."> tag that loads wz-editor.js itself.
function extractConfig(block) {
  const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let configScript = null;
  while ((m = scriptRe.exec(block))) {
    if (m[1].includes('WZ_EDITOR_CONFIG')) { configScript = m[1]; break; }
  }
  if (!configScript) fail('No inline <script> assigning window.WZ_EDITOR_CONFIG found inside the marker block.');

  const sandbox = { window: {} };
  vm.createContext(sandbox);
  try {
    vm.runInContext(configScript, sandbox, { filename: 'wz-editor-config.js', timeout: 2000 });
  } catch (e) {
    fail('Could not evaluate the WZ_EDITOR_CONFIG <script> block: ' + e.message);
  }
  const cfg = sandbox.window.WZ_EDITOR_CONFIG;
  if (!cfg || typeof cfg !== 'object') fail('window.WZ_EDITOR_CONFIG was not set by the config <script> block.');
  return cfg;
}

function extractScriptSrc(block) {
  const m = block.match(/<script\s+[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
  return m ? m[1] : null;
}

function main() {
  const htmlPath = readArg();
  const html = fs.readFileSync(htmlPath, 'utf8');
  const block = extractMarkerBlock(html, htmlPath);
  const cfg = extractConfig(block);

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. tokenCipherB64 present and non-empty.
  const cipher = cfg.tokenCipherB64;
  check(
    'tokenCipherB64 present (non-empty)',
    typeof cipher === 'string' && cipher.length > 0,
    typeof cipher === 'string' ? 'length=' + cipher.length : 'missing or not a string'
  );

  // 2. host (gitlabHost or apiBase) starts with https://.
  const host = cfg.gitlabHost || cfg.apiBase || '';
  const hostIsHttps = typeof host === 'string' && /^https:\/\//i.test(host);
  check('host (gitlabHost/apiBase) starts with https://', hostIsHttps, 'host=' + JSON.stringify(host));

  // 3. allowedHosts contains the host's *origin* — computed the same way wz-editor.js computes
  //    it (new URL(host).origin), so a bare hostname or a URL with a path/query correctly fails.
  let hostOrigin = null;
  let originParseError = null;
  if (hostIsHttps) {
    try {
      hostOrigin = new URL(host).origin;
    } catch (e) {
      originParseError = e.message;
    }
  }
  const allowedHosts = Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts : [];
  const allowedHostsOk = hostOrigin !== null && allowedHosts.includes(hostOrigin);
  check(
    'allowedHosts includes host origin',
    allowedHostsOk,
    hostOrigin === null
      ? 'could not compute host origin' + (originParseError ? ' (' + originParseError + ')' : ' (host is not https)')
      : 'expected ' + hostOrigin + ', allowedHosts=' + JSON.stringify(allowedHosts)
  );

  // 4. the wz-editor.js <script src="..."> resolves to a real file next to the HTML document.
  const src = extractScriptSrc(block);
  let srcResolved = null;
  let srcExists = false;
  if (src) {
    srcResolved = path.resolve(path.dirname(htmlPath), src);
    srcExists = fs.existsSync(srcResolved);
  }
  check(
    'wz-editor.js <script src> resolves to a real file',
    Boolean(src) && srcExists,
    src ? srcResolved + (srcExists ? ' (exists)' : ' (NOT FOUND)') : 'no <script src="..."> found in marker block'
  );

  let allPass = true;
  for (const r of results) {
    console.log('[' + (r.ok ? 'PASS' : 'FAIL') + '] ' + r.name + (r.detail ? ' -- ' + r.detail : ''));
    if (!r.ok) allPass = false;
  }
  process.exit(allPass ? 0 : 1);
}

main();
