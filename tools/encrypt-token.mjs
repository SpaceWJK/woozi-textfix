#!/usr/bin/env node
/*!
 * encrypt-token.mjs — encrypts a GitLab access token into the three constants
 * (tokenSaltB64 / tokenIvB64 / tokenCipherB64) that wz-editor.js's embed config expects.
 *
 * ===== Usage =====
 *   node encrypt-token.mjs --token-file <path to a file containing the token> --password-stdin
 *   node encrypt-token.mjs --token-env <NAME of an env var holding the token> --password-stdin
 *   (then type/paste the edit password and press Enter on stdin)
 *   --token-file and --token-env are mutually exclusive; exactly one is required.
 *
 * Example (interactive):
 *   node encrypt-token.mjs --token-file "C:\Users\me\Desktop\token.txt" --password-stdin
 *   > myEditPassword
 *
 * Example (piped, e.g. from a password manager CLI — never from a literal in your shell history):
 *   your-pw-manager-cli get "wz-editor edit password" | node encrypt-token.mjs --token-file token.txt --password-stdin
 *
 * Example (--token-env, for automated/scripted callers that already hold the token in an env var
 * and cannot write it to a file first — see design principle #1 below for why this exists):
 *   TOKEN=glpat-xxxx node encrypt-token.mjs --token-env TOKEN --password-stdin
 *
 * ===== Design principles (security) =====
 * 1. The token value is never accepted via argv — that closes off the exposure path where a
 *    process listing / command-line inspection (ps, Get-CimInstance Win32_Process, wmic, etc.)
 *    would leak the plaintext token. It is accepted one of two ways: a file path (--token-file,
 *    the caller reads the token from disk beforehand) or an environment VARIABLE NAME
 *    (--token-env, only the *name* travels on argv — never the value; this script reads the
 *    actual token from process.env[NAME] itself). --token-env exists because some automated
 *    callers (e.g. a skill that must not write a secret to a temp file, and cannot use a shell
 *    command like `printenv TOKEN > file` to get it into one either — that command is itself
 *    hard-blocked by this repo's bash-guard env-var-bulk-dump/echo-printf-secret-env rules)
 *    already hold the token in an environment variable and have no safe path to a file. A
 *    process's *environment* is not exposed by the same inspection surface that leaks argv (ps/
 *    wmic/Get-CimInstance list command lines, not environment blocks), so --token-env has a
 *    narrower exposure surface than passing the token itself as an argv value would, even though
 *    it is not as narrow as --token-file's (a compromised process on the same machine with
 *    permission to read another process's environment block — e.g. /proc/<pid>/environ on Linux,
 *    or an administrator on Windows — still could; a plain `ps`/`Get-CimInstance` listing cannot).
 * 2. F-4: the edit password is only ever accepted via --password-stdin (read from stdin, one
 *    line). It is no longer accepted as a positional argv value — argv is visible to any other
 *    process on the machine via a process listing, and (unlike the token, which lives only in a
 *    file you delete afterward) the password is also the long-lived secret end users type into
 *    the page, so the same exposure path applies to it. Passing it positionally is now rejected.
 * 3. The only output is the three values (salt / iv / ciphertext, all Base64). Neither the token
 *    nor the password is ever written to any output channel (stdout, stderr, or a log).
 * 4. After running this script, delete the file you passed via --token-file immediately. That
 *    deletion is the caller's responsibility (this script does not do it automatically, so the
 *    caller has an explicit, observable action to confirm it happened).
 *
 * ===== Algorithm =====
 * - PBKDF2 (SHA-256, 600,000 iterations — OWASP 2023 minimum recommendation for PBKDF2-HMAC-SHA256)
 *   derives a 256-bit AES key from the password (16-byte random salt). Must match wz-editor.js's
 *   decryptToken() iteration count exactly, or decryption fails.
 * - AES-256-GCM encryption (12-byte random iv)
 * - The ciphertext output is "ciphertext + GCM auth tag" concatenated (matching the WebCrypto
 *   SubtleCrypto.decrypt convention), because wz-editor.js's decryptToken() needs to be able to
 *   pass it straight into crypto.subtle.decrypt(...) as-is.
 *
 * Zero external dependencies — only Node's built-in crypto/fs modules.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

function fail(msg) {
  console.error('[encrypt-token] ' + msg);
  console.error('Usage: node encrypt-token.mjs (--token-file <path to token file> | --token-env <NAME of an env var holding the token>) --password-stdin');
  console.error('  (the edit password is read from stdin, one line, after launch)');
  process.exit(1);
}

function parseArgs(argv) {
  const tfIdx = argv.indexOf('--token-file');
  const teIdx = argv.indexOf('--token-env');
  if (tfIdx !== -1 && teIdx !== -1) {
    fail('--token-file and --token-env are mutually exclusive — pass exactly one.');
  }
  if (tfIdx === -1 && teIdx === -1) {
    fail('One of --token-file or --token-env is required.');
  }

  let tokenSource;
  let consumedIdx;
  if (tfIdx !== -1) {
    const tokenFile = argv[tfIdx + 1];
    if (!tokenFile) fail('--token-file requires a path argument.');
    tokenSource = { kind: 'file', tokenFile };
    consumedIdx = tfIdx;
  } else {
    const tokenEnvName = argv[teIdx + 1];
    if (!tokenEnvName) fail('--token-env requires an environment variable NAME argument (not the token value itself).');
    tokenSource = { kind: 'env', tokenEnvName };
    consumedIdx = teIdx;
  }

  const rest = argv.filter((_, i) => i !== consumedIdx && i !== consumedIdx + 1);

  // F-4: the password must come from stdin, never from argv (a process listing on this machine
  // can read argv of any process — a positional password argument leaks the same way the token
  // used to before --token-file was introduced). Any leftover positional argument here means the
  // caller tried the old argv-password calling convention; reject it explicitly rather than
  // silently accepting it as something else.
  if (!rest.includes('--password-stdin')) {
    fail('The edit password must be supplied via --password-stdin (read from stdin) — passing it as a command-line argument is no longer accepted because argv is visible to other processes on the machine.');
  }
  const leftover = rest.filter((a) => a !== '--password-stdin');
  if (leftover.length) {
    fail('Unexpected extra argument(s): ' + leftover.join(' ') + ' — the password is read from stdin only, not passed on the command line.');
  }

  return tokenSource;
}

function readTokenFile(path) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    fail('Could not read token file: ' + path + ' (' + e.code + ')');
  }
  const token = raw.replace(/\r?\n$/, '').trim();
  if (!token) fail('Token file is empty: ' + path);
  return token;
}

function readTokenFromEnv(varName) {
  // Only varName (a NAME, not a secret) ever appears in argv/logs here. The actual value is read
  // directly from this process's own environment — never printed, never echoed back.
  const raw = process.env[varName];
  if (raw === undefined) {
    fail('Environment variable ' + varName + ' is not set. Set it before invoking (e.g. `export ' + varName + '=<token>` / `$env:' + varName + '=\'<token>\'`), then pass --token-env ' + varName + ' — never pass the token value itself as an argument.');
  }
  const token = raw.replace(/\r?\n$/, '').trim();
  if (!token) fail('Environment variable ' + varName + ' is empty.');
  return token;
}

function readPasswordFromStdin() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch (e) {
    fail('Could not read password from stdin (' + (e.code || e.message) + ') — pipe it in or type it and press Enter/Ctrl-D.');
  }
  const password = raw.replace(/\r?\n$/, '').split(/\r?\n/)[0];
  if (!password) fail('No password received on stdin.');
  return password;
}

// R-2: not a hard block (an operator may have a deliberately chosen strong-but-short passphrase,
// or vice versa this heuristic can't fully judge) — just a warning so a clearly weak choice
// (e.g. "1234", "password") doesn't go in unnoticed. Never blocks execution.
function warnIfWeakPassword(password) {
  const problems = [];
  if (password.length < 12) problems.push('length < 12 characters');
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasOther = /[^a-zA-Z0-9]/.test(password);
  const classCount = [hasLower, hasUpper, hasDigit, hasOther].filter(Boolean).length;
  if (classCount <= 1) problems.push('only one character class (e.g. all lowercase, or all digits)');
  if (problems.length) {
    console.error('[encrypt-token] WARNING: password looks weak (' + problems.join('; ') + '). Continuing anyway — use a stronger password if this protects anything sensitive.');
  }
}

function encrypt(token, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12); // AES-GCM standard 96-bit nonce
  const key = crypto.pbkdf2Sync(password, salt, 600000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // WebCrypto AES-GCM convention: ciphertext with the auth tag appended, used as-is.
  const ciphertextWithTag = Buffer.concat([encrypted, authTag]);
  return {
    saltB64: salt.toString('base64'),
    ivB64: iv.toString('base64'),
    ciphertextB64: ciphertextWithTag.toString('base64')
  };
}

function main() {
  const tokenSource = parseArgs(process.argv.slice(2));
  const token = tokenSource.kind === 'file'
    ? readTokenFile(tokenSource.tokenFile)
    : readTokenFromEnv(tokenSource.tokenEnvName);
  const password = readPasswordFromStdin();
  warnIfWeakPassword(password);
  const { saltB64, ivB64, ciphertextB64 } = encrypt(token, password);

  console.log('# Three values to paste into wz-editor.js\'s WZ_EDITOR_CONFIG (the token itself is never printed)');
  console.log("tokenSaltB64: '" + saltB64 + "',");
  console.log("tokenIvB64: '" + ivB64 + "',");
  console.log("tokenCipherB64: '" + ciphertextB64 + "',");
  console.error('');
  if (tokenSource.kind === 'file') {
    console.error('[encrypt-token] Done. Delete the file you passed via --token-file (' + tokenSource.tokenFile + ') now.');
  } else {
    console.error('[encrypt-token] Done. Unset the environment variable ' + tokenSource.tokenEnvName + ' now (e.g. `unset ' + tokenSource.tokenEnvName + '` / `Remove-Item Env:' + tokenSource.tokenEnvName + '`) so it does not linger in this shell session.');
  }
}

main();
