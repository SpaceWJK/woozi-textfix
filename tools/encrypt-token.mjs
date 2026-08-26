#!/usr/bin/env node
/*!
 * encrypt-token.mjs — encrypts a GitLab access token into the three constants
 * (tokenSaltB64 / tokenIvB64 / tokenCipherB64) that wz-editor.js's embed config expects.
 *
 * ===== Usage =====
 *   node encrypt-token.mjs --token-file <path to a file containing the token> --password-stdin
 *   (then type/paste the edit password and press Enter on stdin)
 *
 * Example (interactive):
 *   node encrypt-token.mjs --token-file "C:\Users\me\Desktop\token.txt" --password-stdin
 *   > myEditPassword
 *
 * Example (piped, e.g. from a password manager CLI — never from a literal in your shell history):
 *   your-pw-manager-cli get "wz-editor edit password" | node encrypt-token.mjs --token-file token.txt --password-stdin
 *
 * ===== Design principles (security) =====
 * 1. The token is only ever read from the file given via --token-file. It is never accepted
 *    via argv or an environment variable — that closes off the exposure path where a process
 *    listing / command-line inspection (ps, Get-CimInstance Win32_Process, etc.) would leak the
 *    plaintext token.
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
  console.error('Usage: node encrypt-token.mjs --token-file <path to token file> --password-stdin');
  console.error('  (the edit password is read from stdin, one line, after launch)');
  process.exit(1);
}

function parseArgs(argv) {
  const tfIdx = argv.indexOf('--token-file');
  if (tfIdx === -1) fail('--token-file is required.');
  const tokenFile = argv[tfIdx + 1];
  if (!tokenFile) fail('--token-file requires a path argument.');

  const rest = argv.filter((_, i) => i !== tfIdx && i !== tfIdx + 1);

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

  return { tokenFile };
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
  const { tokenFile } = parseArgs(process.argv.slice(2));
  const token = readTokenFile(tokenFile);
  const password = readPasswordFromStdin();
  warnIfWeakPassword(password);
  const { saltB64, ivB64, ciphertextB64 } = encrypt(token, password);

  console.log('# Three values to paste into wz-editor.js\'s WZ_EDITOR_CONFIG (the token itself is never printed)');
  console.log("tokenSaltB64: '" + saltB64 + "',");
  console.log("tokenIvB64: '" + ivB64 + "',");
  console.log("tokenCipherB64: '" + ciphertextB64 + "',");
  console.error('');
  console.error('[encrypt-token] Done. Delete the file you passed via --token-file (' + tokenFile + ') now.');
}

main();
