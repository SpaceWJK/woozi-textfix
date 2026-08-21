#!/usr/bin/env node
/*!
 * encrypt-token.mjs — encrypts a GitLab access token into the three constants
 * (tokenSaltB64 / tokenIvB64 / tokenCipherB64) that wz-editor.js's embed config expects.
 *
 * ===== Usage =====
 *   node encrypt-token.mjs --token-file <path to a file containing the token> <edit password>
 *
 * Example:
 *   node encrypt-token.mjs --token-file "C:\Users\me\Desktop\token.txt" "myEditPassword"
 *
 * ===== Design principles (security) =====
 * 1. The token is only ever read from the file given via --token-file. It is never accepted
 *    via argv or an environment variable — that closes off the exposure path where a process
 *    listing / command-line inspection (ps, Get-CimInstance Win32_Process, etc.) would leak the
 *    plaintext token. Only the second positional argument (the password) is passed via argv.
 * 2. The only output is the three values (salt / iv / ciphertext, all Base64). The token itself
 *    is never written to any output channel (stdout, stderr, or a log).
 * 3. After running this script, delete the file you passed via --token-file immediately. That
 *    deletion is the caller's responsibility (this script does not do it automatically, so the
 *    caller has an explicit, observable action to confirm it happened).
 *
 * ===== Algorithm =====
 * - PBKDF2 (SHA-256, 100,000 iterations) derives a 256-bit AES key from the password (16-byte
 *   random salt)
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
  console.error('Usage: node encrypt-token.mjs --token-file <path to token file> <edit password>');
  process.exit(1);
}

function parseArgs(argv) {
  const tfIdx = argv.indexOf('--token-file');
  if (tfIdx === -1) fail('--token-file is required.');
  const tokenFile = argv[tfIdx + 1];
  if (!tokenFile) fail('--token-file requires a path argument.');

  const rest = argv.filter((_, i) => i !== tfIdx && i !== tfIdx + 1);
  const password = rest[0];
  if (!password) fail('The edit password (second positional argument) is required.');

  return { tokenFile, password };
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

function encrypt(token, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12); // AES-GCM standard 96-bit nonce
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
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
  const { tokenFile, password } = parseArgs(process.argv.slice(2));
  const token = readTokenFile(tokenFile);
  const { saltB64, ivB64, ciphertextB64 } = encrypt(token, password);

  console.log('# Three values to paste into wz-editor.js\'s WZ_EDITOR_CONFIG (the token itself is never printed)');
  console.log("tokenSaltB64: '" + saltB64 + "',");
  console.log("tokenIvB64: '" + ivB64 + "',");
  console.log("tokenCipherB64: '" + ciphertextB64 + "',");
  console.error('');
  console.error('[encrypt-token] Done. Delete the file you passed via --token-file (' + tokenFile + ') now.');
}

main();
