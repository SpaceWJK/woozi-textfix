// stepA2_deploy_ux: tests for the deploy-status tracking + stale self-save re-entry guard added on
// top of the universal collection heuristic (stepA_universal). Extracts the REAL source via
// lib/extract-wz.mjs and runs it in node:vm sandboxes -- never a hand re-implementation.
//
// Master's real-usage bug this addresses: save (commit) succeeds instantly, but the GitLab Pages
// deploy that actually serves the page lags 1-2 minutes behind. A user who reloads before that
// catches up sees stale (pre-edit) content, assumes the save failed, re-edits, and then hits a
// "someone else edited this" conflict that is actually just their own prior save.
//
// Run: node --test tests/deploy-guard.test.mjs   (from the textfix skill root)
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  readWzSource, extractDeployGuardPureModule, extractDeployNetworkModule,
  extractDeployStorageModule, makeFakeLocalStorage
} from './lib/extract-wz.mjs';

const wzSrc = readWzSource();

// ---------------------------------------------------------------------------
// Pure decision functions -- no sandbox globals needed at all beyond the extracted functions
// themselves (they take everything as plain arguments).
// ---------------------------------------------------------------------------
function makePureSandbox() {
  const pureSrc = extractDeployGuardPureModule(wzSrc);
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(
    pureSrc + '\n' +
    'globalThis.__fns = { parseLastSaveRecord, serializeLastSaveRecord, isLastSaveRecordStaleByAge, ' +
    'isLastSaveRecordMismatched, shouldPruneLastSaveRecord, mapGitLabPipelinesToDeployStatus, ' +
    'mapGitHubCommitStatusToDeployStatus, shouldWarnBeforeReentry, isConflictAgainstOwnRecentSave, shouldStopPolling };\n',
    sandbox,
    { filename: 'wz-deploy-guard-pure-extract.js' }
  );
  return sandbox.__fns;
}

test('pure deploy-guard functions extract and run standalone with zero module-level state in scope', () => {
  assert.doesNotThrow(() => makePureSandbox());
});

test('parseLastSaveRecord: valid shape round-trips, anything else is null (never throws)', () => {
  const fns = makePureSandbox();
  const good = fns.serializeLastSaveRecord('docs/a.html', 'abc123', 1700000000000);
  // Spread into a plain object of THIS realm before comparing -- the parsed object was created
  // inside the vm sandbox's separate context, so it has a different Object.prototype than this
  // file's own object literals; deepStrictEqual (what assert.deepEqual aliases under strict mode)
  // treats that as "not reference-equal" even when every own property matches.
  assert.deepEqual({ ...fns.parseLastSaveRecord(good) }, { docPath: 'docs/a.html', sha: 'abc123', ts: 1700000000000 });
  assert.equal(fns.parseLastSaveRecord(null), null, 'missing key');
  assert.equal(fns.parseLastSaveRecord(''), null, 'empty string');
  assert.equal(fns.parseLastSaveRecord('not json{'), null, 'corrupt JSON must not throw');
  assert.equal(fns.parseLastSaveRecord('{"docPath":"a"}'), null, 'missing sha/ts');
  assert.equal(fns.parseLastSaveRecord('{"docPath":"a","sha":"x","ts":"not-a-number"}'), null, 'wrong-typed ts');
  assert.equal(fns.parseLastSaveRecord('null'), null, 'JSON null');
  assert.equal(fns.parseLastSaveRecord('[]'), null, 'JSON array, not an object with the right shape');
});

test('isLastSaveRecordStaleByAge: exactly Master\'s 15-minute window semantics', () => {
  const fns = makePureSandbox();
  const WINDOW = 15 * 60 * 1000;
  const now = 1_000_000_000_000;
  assert.equal(fns.isLastSaveRecordStaleByAge(null, now, WINDOW), true, 'no record = stale (nothing to guard with)');
  assert.equal(fns.isLastSaveRecordStaleByAge({ ts: now - 1000 }, now, WINDOW), false, '1s old: fresh');
  assert.equal(fns.isLastSaveRecordStaleByAge({ ts: now - WINDOW }, now, WINDOW), false, 'exactly at the window boundary: not yet stale');
  assert.equal(fns.isLastSaveRecordStaleByAge({ ts: now - WINDOW - 1 }, now, WINDOW), true, '1ms past the window: stale');
});

test('isLastSaveRecordMismatched: null remoteSha (unknown) is NEVER treated as a mismatch', () => {
  const fns = makePureSandbox();
  const record = { docPath: 'a', sha: 'S1', ts: 0 };
  assert.equal(fns.isLastSaveRecordMismatched(record, null), false, 'unknown remote state must not be pruned as if mismatched');
  assert.equal(fns.isLastSaveRecordMismatched(record, 'S1'), false, 'same sha: not mismatched');
  assert.equal(fns.isLastSaveRecordMismatched(record, 'S2'), true, 'different sha: mismatched (someone else committed)');
  assert.equal(fns.isLastSaveRecordMismatched(null, 'S2'), false, 'no record to begin with');
});

test('shouldPruneLastSaveRecord: age OR mismatch, never on absence, never on unknown remote', () => {
  const fns = makePureSandbox();
  const WINDOW = 15 * 60 * 1000;
  const now = 1_000_000_000_000;
  const fresh = { docPath: 'a', sha: 'S1', ts: now - 1000 };
  const stale = { docPath: 'a', sha: 'S1', ts: now - WINDOW - 1 };
  assert.equal(fns.shouldPruneLastSaveRecord(null, now, null, WINDOW), false);
  assert.equal(fns.shouldPruneLastSaveRecord(fresh, now, 'S1', WINDOW), false, 'fresh + matching remote: keep');
  assert.equal(fns.shouldPruneLastSaveRecord(fresh, now, null, WINDOW), false, 'fresh + unknown remote: keep (fail-open)');
  assert.equal(fns.shouldPruneLastSaveRecord(fresh, now, 'S2', WINDOW), true, 'fresh but remote moved on: prune');
  assert.equal(fns.shouldPruneLastSaveRecord(stale, now, 'S1', WINDOW), true, 'stale even if remote still matches: prune');
});

test('mapGitLabPipelinesToDeployStatus: success/failed/canceled/pending/empty/malformed', () => {
  const fns = makePureSandbox();
  assert.equal(fns.mapGitLabPipelinesToDeployStatus([{ status: 'success' }]), 'success');
  assert.equal(fns.mapGitLabPipelinesToDeployStatus([{ status: 'failed' }]), 'failed');
  assert.equal(fns.mapGitLabPipelinesToDeployStatus([{ status: 'canceled' }]), 'failed');
  assert.equal(fns.mapGitLabPipelinesToDeployStatus([{ status: 'running' }]), 'pending');
  assert.equal(fns.mapGitLabPipelinesToDeployStatus([{ status: 'created' }]), 'pending', 'unrecognized status collapses to pending, never throws');
  assert.equal(fns.mapGitLabPipelinesToDeployStatus([]), 'pending', 'no pipeline yet -- keep waiting, not a failure');
  assert.equal(fns.mapGitLabPipelinesToDeployStatus(null), 'pending', 'malformed body -- degrade to pending, never throw');
  assert.equal(fns.mapGitLabPipelinesToDeployStatus(undefined), 'pending');
  assert.equal(fns.mapGitLabPipelinesToDeployStatus({ notAnArray: true }), 'pending');
});

test('mapGitHubCommitStatusToDeployStatus: success/failure/error/pending/malformed', () => {
  const fns = makePureSandbox();
  assert.equal(fns.mapGitHubCommitStatusToDeployStatus({ state: 'success' }), 'success');
  assert.equal(fns.mapGitHubCommitStatusToDeployStatus({ state: 'failure' }), 'failed');
  assert.equal(fns.mapGitHubCommitStatusToDeployStatus({ state: 'error' }), 'failed');
  assert.equal(fns.mapGitHubCommitStatusToDeployStatus({ state: 'pending' }), 'pending');
  assert.equal(fns.mapGitHubCommitStatusToDeployStatus(null), 'pending');
  assert.equal(fns.mapGitHubCommitStatusToDeployStatus({}), 'pending');
});

test('shouldWarnBeforeReentry: only warns on a CONFIRMED pending status for our own record (안전 편향)', () => {
  const fns = makePureSandbox();
  const record = { docPath: 'a', sha: 'S1', ts: 0 };
  assert.equal(fns.shouldWarnBeforeReentry(record, 'pending'), true, 'confirmed still-deploying: warn');
  assert.equal(fns.shouldWarnBeforeReentry(record, 'success'), false, 'already live: stay silent, safe to edit');
  assert.equal(fns.shouldWarnBeforeReentry(record, 'failed'), false, 'failed will never become live by waiting -- warning would mislead, stay silent');
  assert.equal(fns.shouldWarnBeforeReentry(null, 'pending'), false, 'no record at all: nothing to warn about');
});

test('isConflictAgainstOwnRecentSave: friendlier-message trigger condition', () => {
  const fns = makePureSandbox();
  const record = { docPath: 'a', sha: 'S1', ts: 0 };
  assert.equal(fns.isConflictAgainstOwnRecentSave(record, 'S1'), true);
  assert.equal(fns.isConflictAgainstOwnRecentSave(record, 'S2'), false, 'different remote head: a real third-party edit');
  assert.equal(fns.isConflictAgainstOwnRecentSave(record, null), false, 'unknown remote head: cannot claim it is our own save');
  assert.equal(fns.isConflictAgainstOwnRecentSave(null, 'S1'), false, 'no local record at all');
});

test('shouldStopPolling: stops on success/failed immediately, or once the attempt budget is spent, never early on pending', () => {
  const fns = makePureSandbox();
  assert.equal(fns.shouldStopPolling('success', 1, 30), true);
  assert.equal(fns.shouldStopPolling('failed', 1, 30), true);
  assert.equal(fns.shouldStopPolling('pending', 1, 30), false);
  assert.equal(fns.shouldStopPolling('pending', 29, 30), false);
  assert.equal(fns.shouldStopPolling('pending', 30, 30), true, 'attempt budget exhausted = timeout');
});

// ---------------------------------------------------------------------------
// Network wrappers (fetchLatestCommitSha / checkDeployStatus) -- mocked fetch, both providers.
// Mirrors the sandbox-preset technique the (out-of-suite) scratchpad test-github-provider.mjs used
// for the Step A functions: PROVIDER/API_BASE/GITLAB_* are plain preset globals here, not extracted
// `var X = CFG.x` lines (CFG doesn't exist standalone).
// ---------------------------------------------------------------------------
function makeNetworkSandbox(fetchImpl, presets) {
  const networkSrc = extractDeployNetworkModule(wzSrc);
  const sandbox = Object.assign({
    console, encodeURIComponent, fetch: fetchImpl,
    PROVIDER: 'gitlab',
    API_BASE: 'https://api.github.com',
    GITLAB_HOST: 'https://gitlab.example.com',
    GITLAB_PROJECT_PATH: 'g/r',
    GITLAB_BRANCH: 'main'
  }, presets || {});
  vm.createContext(sandbox);
  vm.runInContext(
    networkSrc + '\nglobalThis.__fns = { fetchLatestCommitSha, checkDeployStatus };\n',
    sandbox,
    { filename: 'wz-deploy-network-extract.js' }
  );
  return sandbox;
}

test('fetchLatestCommitSha (GitLab): correct URL/header, extracts commit.id', async () => {
  let capturedUrl = null, capturedHeaders = null;
  const sb = makeNetworkSandbox(async (url, opts) => {
    capturedUrl = url; capturedHeaders = opts.headers;
    return { ok: true, json: async () => ({ id: 'deadbeef123' }) };
  });
  const sha = await sb.__fns.fetchLatestCommitSha('TOKEN123');
  assert.equal(sha, 'deadbeef123');
  assert.ok(capturedUrl.includes('/repository/commits/main'), 'URL: ' + capturedUrl);
  assert.equal(capturedHeaders['PRIVATE-TOKEN'], 'TOKEN123');
});

test('fetchLatestCommitSha (GitHub): correct URL/header, extracts .sha', async () => {
  let capturedUrl = null, capturedHeaders = null;
  const sb = makeNetworkSandbox(async (url, opts) => {
    capturedUrl = url; capturedHeaders = opts.headers;
    return { ok: true, json: async () => ({ sha: 'cafebabe456' }) };
  }, { PROVIDER: 'github' });
  const sha = await sb.__fns.fetchLatestCommitSha('TOKEN456');
  assert.equal(sha, 'cafebabe456');
  assert.ok(capturedUrl.includes('/commits/main'), 'URL: ' + capturedUrl);
  assert.equal(capturedHeaders['Authorization'], 'Bearer TOKEN456');
});

test('fetchLatestCommitSha: non-ok response or thrown fetch -> null, never throws', async () => {
  const sbNotOk = makeNetworkSandbox(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  assert.equal(await sbNotOk.__fns.fetchLatestCommitSha('T'), null);
  const sbThrows = makeNetworkSandbox(async () => { throw new Error('network down'); });
  assert.equal(await sbThrows.__fns.fetchLatestCommitSha('T'), null);
});

test('checkDeployStatus (GitLab): sha is passed through the pipelines query, status mapped correctly', async () => {
  let capturedUrl = null;
  const sb = makeNetworkSandbox(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ([{ status: 'success' }]) };
  });
  const status = await sb.__fns.checkDeployStatus('deadbeef123', 'TOKEN');
  assert.equal(status, 'success');
  assert.ok(capturedUrl.includes('pipelines?sha=deadbeef123'), 'URL: ' + capturedUrl);
});

test('checkDeployStatus (GitHub): sha in the status URL, state mapped correctly', async () => {
  let capturedUrl = null;
  const sb = makeNetworkSandbox(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ state: 'failure' }) };
  }, { PROVIDER: 'github' });
  const status = await sb.__fns.checkDeployStatus('cafebabe456', 'TOKEN');
  assert.equal(status, 'failed');
  assert.ok(capturedUrl.includes('/commits/cafebabe456/status'), 'URL: ' + capturedUrl);
});

test('checkDeployStatus: non-ok response or thrown fetch degrades to pending, never throws (never blocks the edit flow)', async () => {
  const sbNotOk = makeNetworkSandbox(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.equal(await sbNotOk.__fns.checkDeployStatus('S', 'T'), 'pending');
  const sbThrows = makeNetworkSandbox(async () => { throw new Error('network down'); });
  assert.equal(await sbThrows.__fns.checkDeployStatus('S', 'T'), 'pending');
});

// ---------------------------------------------------------------------------
// localStorage wrappers -- fake Storage (see makeFakeLocalStorage), real extracted read/write/clear.
// ---------------------------------------------------------------------------
function makeStorageSandbox(presets) {
  const storageSrc = extractDeployStorageModule(wzSrc);
  const fakeStorage = makeFakeLocalStorage();
  const sandbox = Object.assign({
    console, JSON, Date,
    localStorage: fakeStorage,
    GITLAB_FILE_PATH: 'docs/report.html',
    location: { pathname: '/fallback-path' }
  }, presets || {});
  vm.createContext(sandbox);
  vm.runInContext(
    storageSrc + '\nglobalThis.__fns = { readLastSaveRecord, writeLastSaveRecord, clearLastSaveRecord };\n' +
    'globalThis.__key = LAST_SAVE_KEY;\n',
    sandbox,
    { filename: 'wz-deploy-storage-extract.js' }
  );
  return { fns: sandbox.__fns, key: sandbox.__key, storage: fakeStorage };
}

test('LAST_SAVE_KEY follows the same namespace-prefix convention as the existing draft key (wzEditor* + "::" + doc path)', () => {
  const { key } = makeStorageSandbox();
  assert.equal(key, 'wzEditorLastSave::docs/report.html');
});

test('writeLastSaveRecord stores ONLY {docPath, sha, ts} -- overwrite, never a second key, no token/password/content', () => {
  const { fns, key, storage } = makeStorageSandbox();
  fns.writeLastSaveRecord('sha-one');
  assert.equal(storage._dump().size, 1, 'exactly one entry after one save');
  const record1 = fns.readLastSaveRecord();
  assert.deepEqual(Object.keys(record1).sort(), ['docPath', 'sha', 'ts']);
  assert.equal(record1.sha, 'sha-one');
  assert.equal(record1.docPath, 'docs/report.html');
  fns.writeLastSaveRecord('sha-two');
  assert.equal(storage._dump().size, 1, 'a second save overwrites, does not accumulate a second key');
  assert.equal(fns.readLastSaveRecord().sha, 'sha-two');
  assert.equal(storage.getItem(key) !== null, true);
});

// Master's explicit follow-up requirement: a stale (>15min) OR remote-mismatched record must be
// deleted on the next access, never left to accumulate. This exercises the REAL extracted
// read/clear wrappers together with the real pure staleness check (same composition
// evaluateReentryGuardAndProceed uses in wz-editor.js itself), not a re-implementation.
test('stale (>15min) last-save record is deleted on next access -- auto-cleanup, no accumulation', () => {
  const { fns, storage } = makeStorageSandbox();
  const WINDOW = 15 * 60 * 1000;
  const now = Date.now();
  // Simulate a record written 20 minutes ago by writing it directly with a backdated ts (writeLastSaveRecord
  // itself always stamps "now", so an old record can only arise from real elapsed time -- backdating the
  // raw stored JSON is the correct way to simulate "20 minutes have passed" without sleeping in a test).
  storage.setItem('wzEditorLastSave::docs/report.html', JSON.stringify({ docPath: 'docs/report.html', sha: 'stale-sha', ts: now - WINDOW - 1000 }));
  assert.equal(storage._dump().size, 1, 'sanity: the stale record is present before the access');
  const record = fns.readLastSaveRecord();
  assert.ok(record, 'sanity: it still parses as a well-formed record (staleness is a separate check, not a parse failure)');
  // This is the exact prune-on-access composition evaluateReentryGuardAndProceed performs.
  const isStale = (now - record.ts) > WINDOW;
  assert.equal(isStale, true);
  if (isStale) fns.clearLastSaveRecord();
  assert.equal(storage._dump().size, 0, 'stale record removed -- zero accumulation');
  assert.equal(fns.readLastSaveRecord(), null, 'next read sees nothing');
});

test('clearLastSaveRecord on an absent key is a harmless no-op', () => {
  const { fns, storage } = makeStorageSandbox();
  assert.doesNotThrow(() => fns.clearLastSaveRecord());
  assert.equal(storage._dump().size, 0);
});
