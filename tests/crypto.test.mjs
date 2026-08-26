// R2: formal unit tests for wz-editor.js's crypto/base64 pure functions (decryptToken, b64ToBytes,
// base64ToUtf8, utf8ToBase64). Extracts the REAL source via lib/extract-wz.mjs and runs it in a
// node:vm sandbox backed by Node's real WebCrypto (globalThis.crypto.subtle) -- the same technique
// scratchpad's test-crypto-roundtrip.mjs already used, formalized here as a `node --test` file.
//
// Purity contract under test: decryptToken/b64ToBytes/base64ToUtf8/utf8ToBase64 must depend on
// nothing but their own arguments plus the injected TT_SALT_B64/TT_IV_B64/TT_CIPHERTEXT_B64 (which
// decryptToken reads as free variables by design -- see wz-editor.js's own module-level vars of the
// same name) and the standard crypto/atob/btoa/TextEncoder/TextDecoder globals. No CFG/GITLAB_*/
// PROVIDER state.
//
// Run: node --test tests/crypto.test.mjs   (from the textfix skill root)
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWzSource, extractCryptoModule, ENCRYPT_TOOL_PATH } from './lib/extract-wz.mjs';
const wzSrc = readWzSource();
const { b64ToBytesFn, decryptTokenFn, base64ToUtf8Fn, utf8ToBase64Fn } = extractCryptoModule(wzSrc);

function makeSandbox(extra) {
  const sandbox = Object.assign({
    crypto: globalThis.crypto,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    console
  }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(
    b64ToBytesFn + '\n' + decryptTokenFn + '\n' + base64ToUtf8Fn + '\n' + utf8ToBase64Fn + '\n' +
    'globalThis.__decryptToken = decryptToken;\n' +
    'globalThis.__base64ToUtf8 = base64ToUtf8;\n' +
    'globalThis.__utf8ToBase64 = utf8ToBase64;\n',
    sandbox,
    { filename: 'wz-crypto-extract.js' }
  );
  return sandbox;
}

test('crypto functions extract and run standalone with only WebCrypto/atob/btoa/TextEncoder-Decoder in scope', () => {
  assert.doesNotThrow(() => makeSandbox({ TT_SALT_B64: 'AA==', TT_IV_B64: 'AA==', TT_CIPHERTEXT_B64: 'AA==' }));
});

// ---------------------------------------------------------------------------
// base64ToUtf8 <-> utf8ToBase64 round trip
// ---------------------------------------------------------------------------
test('utf8ToBase64/base64ToUtf8 round-trip ASCII', () => {
  const sb = makeSandbox({});
  const original = 'hello world 123';
  assert.equal(sb.__base64ToUtf8(sb.__utf8ToBase64(original)), original);
});

test('utf8ToBase64/base64ToUtf8 round-trip non-ASCII (Korean + accented Latin)', () => {
  const sb = makeSandbox({});
  const original = '한글 테스트 with café and émoji-free unicode';
  const encoded = sb.__utf8ToBase64(original);
  const decoded = sb.__base64ToUtf8(encoded);
  assert.equal(decoded, original);
});

test('base64ToUtf8 tolerates embedded whitespace/newlines in the base64 (GitHub contents API chunking)', () => {
  const sb = makeSandbox({});
  const raw = sb.__utf8ToBase64('chunked content test');
  const chunked = raw.match(/.{1,8}/g).join('\n'); // simulate GitHub's newline-chunked base64
  assert.equal(sb.__base64ToUtf8(chunked), 'chunked content test');
});

// ---------------------------------------------------------------------------
// decryptToken -- PBKDF2 600k round trip against the real encrypt-token.mjs CLI output
// ---------------------------------------------------------------------------
test('encrypt-token.mjs uses 600000 PBKDF2 iterations (matches decryptToken)', () => {
  const encSrc = fs.readFileSync(ENCRYPT_TOOL_PATH, 'utf8');
  const wzIterMatch = wzSrc.match(/iterations:\s*(\d+)/);
  const encIterMatch = encSrc.match(/pbkdf2Sync\([^,]+,[^,]+,\s*(\d+)/);
  assert.equal(wzIterMatch && wzIterMatch[1], '600000');
  assert.equal(encIterMatch && encIterMatch[1], '600000');
});

test('decryptToken(correct password) recovers the original token (600k PBKDF2 round trip)', { timeout: 30000 }, () => {
  const dummyTokenFile = path.join(os.tmpdir(), 'wz-test-token-' + process.pid + '.txt');
  const DUMMY_TOKEN = 'glpat-DUMMY-TOKEN-FOR-TEST-ONLY-0000000000';
  const PASSWORD = 'correct-horse-battery-staple-1';
  fs.writeFileSync(dummyTokenFile, DUMMY_TOKEN + '\n', 'utf8');
  try {
    const cli = spawnSync(process.execPath, [ENCRYPT_TOOL_PATH, '--token-file', dummyTokenFile, '--password-stdin'], {
      input: PASSWORD + '\n',
      encoding: 'utf8'
    });
    assert.equal(cli.status, 0, 'encrypt-token.mjs CLI must succeed: ' + (cli.stderr || ''));
    const stdout = cli.stdout || '';
    const extract = (key) => {
      const m = stdout.match(new RegExp(key + ":\\s*'([^']+)'"));
      return m ? m[1] : null;
    };
    const saltB64 = extract('tokenSaltB64');
    const ivB64 = extract('tokenIvB64');
    const cipherB64 = extract('tokenCipherB64');
    assert.ok(saltB64 && ivB64 && cipherB64, 'CLI stdout must contain salt/iv/cipher b64 values');

    const sb = makeSandbox({ TT_SALT_B64: saltB64, TT_IV_B64: ivB64, TT_CIPHERTEXT_B64: cipherB64 });
    return sb.__decryptToken(PASSWORD).then((decrypted) => {
      assert.equal(decrypted, DUMMY_TOKEN);
    });
  } finally {
    fs.unlinkSync(dummyTokenFile);
  }
});

test('decryptToken(wrong password) throws (AES-GCM auth tag mismatch rejects it)', { timeout: 30000 }, () => {
  const dummyTokenFile = path.join(os.tmpdir(), 'wz-test-token-wrongpw-' + process.pid + '.txt');
  const DUMMY_TOKEN = 'glpat-DUMMY-TOKEN-FOR-TEST-ONLY-0000000000';
  const PASSWORD = 'correct-horse-battery-staple-1';
  const WRONG_PASSWORD = 'wrong-password-xyz-2';
  fs.writeFileSync(dummyTokenFile, DUMMY_TOKEN + '\n', 'utf8');
  try {
    const cli = spawnSync(process.execPath, [ENCRYPT_TOOL_PATH, '--token-file', dummyTokenFile, '--password-stdin'], {
      input: PASSWORD + '\n',
      encoding: 'utf8'
    });
    assert.equal(cli.status, 0);
    const stdout = cli.stdout || '';
    const extract = (key) => {
      const m = stdout.match(new RegExp(key + ":\\s*'([^']+)'"));
      return m ? m[1] : null;
    };
    const sb = makeSandbox({ TT_SALT_B64: extract('tokenSaltB64'), TT_IV_B64: extract('tokenIvB64'), TT_CIPHERTEXT_B64: extract('tokenCipherB64') });
    return sb.__decryptToken(WRONG_PASSWORD).then(
      () => { throw new Error('decryptToken should have thrown for the wrong password'); },
      (err) => { assert.ok(err); }
    );
  } finally {
    fs.unlinkSync(dummyTokenFile);
  }
});

test('CLI rejects a password passed via argv (F-4: stdin-only, no plaintext-in-argv/process-list)', () => {
  const dummyTokenFile = path.join(os.tmpdir(), 'wz-test-token-argv-' + process.pid + '.txt');
  fs.writeFileSync(dummyTokenFile, 'glpat-DUMMY\n', 'utf8');
  try {
    const oldStyle = spawnSync(process.execPath, [ENCRYPT_TOOL_PATH, '--token-file', dummyTokenFile, 'some-password-as-argv'], { encoding: 'utf8' });
    assert.notEqual(oldStyle.status, 0, 'a positional password argument must be rejected');
  } finally {
    fs.unlinkSync(dummyTokenFile);
  }
});
