import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { Workbench } from '../src/core.js';
import { initializeProject, readProfile, sha256, PROFILE_FILE } from '../src/policy.js';
import { confinedPath, redact } from '../src/security.js';
import type { TaskInput, WorkerIdentity, CandidateSnapshot } from '../src/types.js';

const roots: string[] = [];
const instances: Workbench[] = [];
afterEach(() => { for (const w of instances.splice(0)) w.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workbench-core-')); roots.push(root);
  initializeProject(root); const profile = readProfile(root); profile.commands.unit = { argv: [process.execPath, '--test'], cwd: '.', timeoutMs: 10000 }; writeFileSync(join(root, PROFILE_FILE), JSON.stringify(profile)); writeFileSync(join(root, 'PLAN.md'), 'Implement approved tasks.\n');
  const w = new Workbench(root); instances.push(w); w.approvePlan('PLAN.md');
  return { root, w };
}
const worker: WorkerIdentity = { host: 'codex', sessionId: 's1', workerId: 'w1', role: 'implementer' };
const reviewer: WorkerIdentity = { host: 'opencode', sessionId: 's2', workerId: 'r1', role: 'reviewer' };
function task(id = 'T1', extra: Partial<TaskInput> = {}): TaskInput {
  return { id, title: `Implement ${id}`, requirement: `Requirement ${id}`, acceptance: ['works'], dependencies: [], scope: ['src/**'], requiredChecks: ['unit'], ...extra };
}
function candidate(root: string, extra: Partial<CandidateSnapshot> = {}): CandidateSnapshot {
  mkdirSync(join(root, '.agentkit/worktrees/T1'), { recursive: true });
  return { baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), treeHash: 'c'.repeat(40), diffHash: 'd'.repeat(64), files: ['src/main.ts'], worktree: join(root, '.agentkit/worktrees/T1'), ...extra };
}
function evidence(w: Workbench, root: string, token: string, c: CandidateSnapshot, passed = true) {
  const file = join(root, '.agentkit/result.txt'); writeFileSync(file, passed ? 'passed' : 'failed');
  return w.addEvidence(token, { checkId: 'unit', exitCode: passed ? 0 : 1, passed, treeHash: c.treeHash, diffHash: c.diffHash, artifact: file, artifactHash: sha256(readFileSync(file)), startedAt: Date.now() - 20, finishedAt: Date.now() });
}
function review(w: Workbench, taskId: string, c: CandidateSnapshot, kinds: ('spec'|'code'|'security')[] = ['spec', 'code']) {
  const grant = w.assignReviewer(taskId, kinds.includes('security') ? { ...reviewer, role: 'security' } : reviewer, kinds);
  for (const kind of kinds) w.recordReview(grant.token, { verdict: 'pass', kind, treeHash: c.treeHash, diffHash: c.diffHash, criteria: ['works'], findings: [] });
}

test('initialization preserves existing profile and ignores private state', () => {
  const { root } = fixture(); const before = readFileSync(join(root, PROFILE_FILE), 'utf8');
  initializeProject(root); assert.equal(readFileSync(join(root, PROFILE_FILE), 'utf8'), before);
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /state/);
  assert.equal(readProfile(root).policy.maxWorkers, 3);
});
test('duplicate IDs and dependency cycles are rejected; semantic copies warn', () => {
  const { w } = fixture(); w.createTask(task('A', { dependencies: ['B'] }));
  assert.throws(() => w.createTask(task('A')), /already|duplicate/i);
  assert.throws(() => w.createTask(task('B', { dependencies: ['A'] })), /cycle/i);
  const a = w.createTask(task('C', { title: 'Fix the critical parser', requirement: 'Handle malformed input safely' }));
  const b = w.createTask(task('D', { title: a.title, requirement: a.requirement }));
  assert.ok(b.warnings?.some(x => /duplicate/i.test(x)));
});
test('independent connections atomically claim and enforce overlapping scopes', () => {
  const { root, w } = fixture(); const other = new Workbench(root); instances.push(other);
  w.createTask(task()); w.createTask(task('T2', { scope: ['src/main.ts'] }));
  w.claimTask('T1', worker);
  assert.throws(() => other.claimTask('T1', { ...worker, sessionId: 's3' }), /claim|active/i);
  assert.throws(() => other.claimTask('T2', { ...worker, sessionId: 's3' }), /overlap|scope/i);
});
test('glob prefixes intersect and maximum workers applies to disjoint claims', () => {
  const { root, w } = fixture();
  const p = readProfile(root); p.policy.maxWorkers = 1; writeFileSync(join(root, PROFILE_FILE), JSON.stringify(p)); w.approvePlan('PLAN.md');
  w.createTask(task('T1', { scope: ['src/components/*.tsx'] })); w.createTask(task('T2', { scope: ['docs/**'] }));
  w.claimTask('T1', worker); assert.throws(() => w.claimTask('T2', { ...worker, workerId: 'w2' }), /maximum|limit/i);
});
test('profile and plan edits invalidate approval and existing tokens', () => {
  const { root, w } = fixture(); w.createTask(task()); const c = w.claimTask('T1', worker);
  writeFileSync(join(root, 'PLAN.md'), 'Changed plan');
  assert.throws(() => w.assertApproved(), /approv|changed/i); assert.throws(() => w.heartbeatTask(c.token), /approv|changed/i);
  w.approvePlan('PLAN.md'); writeFileSync(join(root, PROFILE_FILE), readFileSync(join(root, PROFILE_FILE), 'utf8') + '\n# untrusted edit\n');
  assert.throws(() => w.assertApproved(), /approv|changed/i);
});
test('expired claims remain fenced until stopped-worker recovery quarantines worktree', () => {
  const { root, w } = fixture(); const p = readProfile(root); p.policy.leaseMs = 10; writeFileSync(join(root, PROFILE_FILE), JSON.stringify(p)); w.approvePlan('PLAN.md');
  w.createTask(task()); const snap = candidate(root); const c = w.claimTask('T1', worker, snap.worktree);
  const until = Date.now() + 20; while (Date.now() < until) {}
  assert.throws(() => w.submitTask(c.token, snap), /expired/i);
  assert.throws(() => w.recoverTask('T1', false), /stopped/i);
  w.recoverTask('T1', true); assert.throws(() => w.heartbeatTask(c.token), /revok|claim/i);
  assert.ok(readdirSync(join(root, '.agentkit/quarantine')).length);
  assert.equal(w.claimTask('T1', { ...worker, workerId: 'w2' }).taskId, 'T1');
});
test('candidate actual files must fit scope and sensitive changes require security review', () => {
  const { root, w } = fixture(); w.createTask(task('T1', { scope: ['**'] })); const c = w.claimTask('T1', worker);
  const snap = candidate(root, { files: ['src/auth/login.ts'] }); w.submitTask(c.token, snap); evidence(w, root, c.token, snap); review(w, 'T1', snap);
  assert.throws(() => w.markVerified('T1'), /security/i);
  review(w, 'T1', snap, ['security']); assert.equal(w.markVerified('T1').status, 'verified'); w.integrateTask(c.token, snap);
  const bad = w.createTask(task('T2', { scope: ['docs/**'] })); const c2 = w.claimTask(bad.id, { ...worker, workerId: 'w2' });
  assert.throws(() => w.submitTask(c2.token, candidate(root, { files: ['src/outside.ts'] })), /scope/i);
});
test('review grants reject same worker or session and missing criteria', () => {
  const { root, w } = fixture(); w.createTask(task()); const c = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(c.token, snap);
  assert.throws(() => w.assignReviewer('T1', worker, ['spec']), /independ|self/i);
  assert.throws(() => w.assignReviewer('T1', { ...reviewer, sessionId: worker.sessionId }, ['code']), /independ|self/i);
  const grant = w.assignReviewer('T1', reviewer, ['spec']);
  assert.throws(() => w.recordReview(grant.token, { verdict: 'pass', kind: 'code', treeHash: snap.treeHash, diffHash: snap.diffHash, criteria: ['works'], findings: [] }), /grant|kind/i);
  assert.throws(() => w.recordReview(grant.token, { verdict: 'pass', kind: 'spec', treeHash: snap.treeHash, diffHash: snap.diffHash, criteria: [], findings: [] }), /criteria|acceptance/i);
});
test('checks must pass with candidate hashes, and changed candidates invalidate old evidence', () => {
  const { root, w } = fixture(); w.createTask(task()); const c = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(c.token, snap); evidence(w, root, c.token, snap, false); review(w, 'T1', snap);
  assert.throws(() => w.markVerified('T1'), /check|evidence/i);
  evidence(w, root, c.token, snap); assert.equal(w.markVerified('T1').status, 'verified');
  const changed = { ...snap, treeHash: 'e'.repeat(40), diffHash: 'f'.repeat(64) }; w.submitTask(c.token, changed);
  assert.throws(() => w.markVerified('T1'), /check|evidence/i);
});
test('unresolved findings and stale artifacts prevent verification', () => {
  const { root, w } = fixture(); w.createTask(task()); const c = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(c.token, snap); evidence(w, root, c.token, snap);
  const grant = w.assignReviewer('T1', reviewer, ['spec', 'code']);
  for (const kind of ['spec', 'code'] as const) w.recordReview(grant.token, { verdict: 'pass', kind, treeHash: snap.treeHash, diffHash: snap.diffHash, criteria: ['works'], findings: [{ severity: 'high', message: 'Wrong behavior', resolved: false }] });
  assert.throws(() => w.markVerified('T1'), /finding|review/i);
  review(w, 'T1', snap); writeFileSync(join(root, '.agentkit/result.txt'), 'tampered');
  assert.throws(() => w.markVerified('T1'), /artifact|evidence/i);
});
test('integration is fenced and dependencies become ready only after integration', () => {
  const { root, w } = fixture(); w.createTask(task()); w.createTask(task('T2', { dependencies: ['T1'], scope: ['docs/**'] }));
  const c = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(c.token, snap); evidence(w, root, c.token, snap); review(w, 'T1', snap); w.markVerified('T1');
  assert.equal(w.getTask('T2').status, 'blocked'); assert.throws(() => w.integrateTask(c.token, { ...snap, headCommit: 'e'.repeat(40) }), /candidate|snapshot/i);
  assert.equal(w.integrateTask(c.token, snap).status, 'integrated'); assert.equal(w.getTask('T2').status, 'ready');
  assert.throws(() => w.submitTask(c.token, snap), /revok|claim|integrated/i);
});
test('checkpoint resume reports interrupted live claims without approving them', () => {
  const { root, w } = fixture(); w.createTask(task()); w.claimTask('T1', worker); w.checkpoint('paused'); w.close();
  const resumed = new Workbench(root); instances.push(resumed); const state = resumed.resume() as { activeClaims: unknown[], checkpoint: { label: string } };
  assert.equal(state.activeClaims.length, 1); assert.equal(state.checkpoint.label, 'paused');
  assert.equal((resumed.readiness() as { staging: { ready: boolean }, release: { ready: boolean } }).release.ready, false);
});
test('imports cannot preserve approval, evidence, reviews, or completion', () => {
  const { root, w } = fixture(); w.createTask(task()); const c = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(c.token, snap); evidence(w, root, c.token, snap); review(w, 'T1', snap); w.markVerified('T1'); w.integrateTask(c.token, snap);
  const imported = fixture().w; imported.importState(w.exportState(true));
  assert.equal(imported.getTask('T1').status, 'ready'); assert.equal(imported.getTask('T1').candidate, undefined); assert.throws(() => imported.assertApproved(), /approv/i);
  const empty = imported.exportState(true) as { evidence?: unknown[], reviews?: unknown[] }; assert.equal(empty.evidence?.length ?? 0, 0); assert.equal(empty.reviews?.length ?? 0, 0);
});
test('exports omit content by default and redact likely secrets even with content', () => {
  const { w } = fixture(); w.createTask(task('T1', { requirement: 'token=sk-proj-123456789012345678901234567890 secret', title: 'Build endpoint' }));
  assert.doesNotMatch(JSON.stringify(w.exportState()), /12345678901234567890/);
  assert.doesNotMatch(JSON.stringify(w.exportState(true)), /12345678901234567890/);
  assert.match(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), /REDACTED/);
});
test('paths reject traversal and symlink escapes, and state is isolated per root', () => {
  const { root } = fixture(); const outside = fixture().root; symlinkSync(outside, join(root, 'escape'), process.platform==='win32'?'junction':'dir');
  assert.throws(() => confinedPath(root, '../secret'), /path|outside|travers/i); assert.throws(() => confinedPath(root, 'escape/file'), /path|outside|escape/i);
  assert.equal(confinedPath(root, 'new/file'), join(root, 'new/file'));
  const isolated = fixture().w; assert.equal(isolated.listTasks().length, 0);
});
test('schema migration creates a backup and events cannot be rewritten', () => {
  const { root, w } = fixture(); w.createTask(task()); w.close();
  const dbPath = join(root, '.agentkit/state.sqlite'); const raw = new Database(dbPath); raw.pragma('user_version = 0'); raw.close();
  const reopened = new Workbench(root); instances.push(reopened); assert.equal(reopened.getTask('T1').id, 'T1');
  assert.ok(readdirSync(join(root, '.agentkit/backups')).some(n => n.endsWith('.sqlite')));
  const db = new Database(dbPath); assert.throws(() => db.prepare('DELETE FROM events').run(), /append|immutable/i); db.close();
});
test('approval invalidation fences tokens while scopes stay reserved until recovery', () => {
  const { root, w } = fixture(); w.createTask(task()); const snap = candidate(root); const claim = w.claimTask('T1', worker, snap.worktree);
  writeFileSync(join(root, 'PLAN.md'), 'New plan'); assert.throws(() => w.assertApproved(), /approval/i); w.approvePlan('PLAN.md');
  assert.throws(() => w.submitTask(claim.token, snap), /revoked/i);
  assert.throws(() => w.claimTask('T1', { ...worker, workerId: 'replacement' }), /active|recover/i);
  w.recoverTask('T1', true); assert.equal(w.claimTask('T1', { ...worker, workerId: 'replacement' }).taskId, 'T1');
});
test('integration callback rolls back state on Git failure and fences synchronous commit', () => {
  const { root, w } = fixture(); w.createTask(task()); const c = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(c.token, snap); evidence(w, root, c.token, snap); review(w, 'T1', snap); w.markVerified('T1');
  assert.throws(() => w.withIntegration(c.token, () => { throw new Error('Git failed'); }), /Git failed/); assert.equal(w.getTask('T1').status, 'verified');
  assert.equal(w.withIntegration(c.token, () => 'merged'), 'merged'); assert.equal(w.getTask('T1').status, 'integrated');
});
test('context changes invalidate candidate checks and worker roles cannot review', () => {
  const { root, w } = fixture(); writeFileSync(join(root, 'CONTEXT.md'), 'original'); const p = readProfile(root); p.context.push('CONTEXT.md'); writeFileSync(join(root, PROFILE_FILE), JSON.stringify(p)); w.approvePlan('PLAN.md');
  w.createTask(task()); const c = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(c.token, snap);
  assert.throws(() => w.assignReviewer('T1', { ...reviewer, role: 'implementer' }, ['spec']), /role/i);
  writeFileSync(join(root, 'CONTEXT.md'), 'new context'); assert.throws(() => w.addEvidence(c.token, { checkId: 'unit', exitCode: 0, passed: true, treeHash: snap.treeHash, diffHash: snap.diffHash, artifact: 'none', artifactHash: 'a'.repeat(64), startedAt: 0, finishedAt: 0 }), /approval/i);
});
test('overlapping wildcard task scopes conflict across claims', () => {
  const { w } = fixture(); w.createTask(task('T1', { scope: ['src/components/*.tsx'] })); w.createTask(task('T2', { scope: ['src/**/Button.tsx'] })); w.claimTask('T1', worker);
  assert.throws(() => w.claimTask('T2', { ...worker, workerId: 'w2' }), /overlap/i);
});
test('worktree attachment cannot quarantine the project or arbitrary content', () => {
  const { root, w } = fixture(); w.createTask(task()); const c = w.claimTask('T1', worker);
  assert.throws(() => w.attachWorktree(c.token, root), /worktree/i);
  mkdirSync(join(root, 'important')); assert.throws(() => w.attachWorktree(c.token, join(root, 'important')), /worktree/i);
  const snap = candidate(root); assert.equal(w.attachWorktree(c.token, snap.worktree).worktree, snap.worktree);
});
test('import retains structural requirements decisions and blockers as unverified records', () => {
  const { w } = fixture(); w.createTask(task()); w.recordRequirement({ id: 'R1', text: 'Endpoint handles malformed input' }); w.recordDecision({ id: 'D1', text: 'Use parser', rationale: 'Safer' }); w.recordBlocker({ id: 'B1', taskId: 'T1', text: 'Need fixture' });
  const target = fixture().w; target.importState(w.exportState(true)); const output = target.exportState(true) as { records: { id: string; imported?: boolean }[] };
  assert.deepEqual(output.records.map(r => r.id).sort(), ['B1', 'D1', 'R1']); assert.ok(output.records.every(r => r.imported));
});
test('transactional drift detection durably revokes approval even after bytes are restored', () => {
  const { root, w } = fixture(); w.createTask(task()); const claim = w.claimTask('T1', worker); const original = readFileSync(join(root, 'PLAN.md'));
  writeFileSync(join(root, 'PLAN.md'), 'Untrusted plan edit'); assert.throws(() => w.heartbeatTask(claim.token), /approval/i);
  writeFileSync(join(root, 'PLAN.md'), original); assert.throws(() => w.heartbeatTask(claim.token), /approval|revoked/i); assert.throws(() => w.assertApproved(), /approval/i);
  w.approvePlan('PLAN.md'); assert.throws(() => w.heartbeatTask(claim.token), /revoked/i);
});
test('actual code requires code review even when worker declares code false', () => {
  const { root, w } = fixture(); w.createTask(task('T1', { code: false })); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap, ['spec']);
  assert.throws(() => w.markVerified('T1'), /code review/i);
});
test('actual code with empty or unapproved checks cannot be accepted at submission', () => {
  for (const requiredChecks of [[], ['unapproved']]) {
    const { root, w } = fixture(); w.createTask(task('T1', { code: false, requiredChecks })); const claim = w.claimTask('T1', worker);
    assert.throws(() => w.submitTask(claim.token, candidate(root)), /approved|check/i);
  }
});
test('documentation-only candidates may use spec review without command checks', () => {
  const { root, w } = fixture(); w.createTask(task('T1', { scope: ['docs/**'], code: false, requiredChecks: [] })); const claim = w.claimTask('T1', worker); const snap = candidate(root, { files: ['docs/usage.md'] }); w.submitTask(claim.token, snap); review(w, 'T1', snap, ['spec']);
  assert.equal(w.markVerified('T1').status, 'verified');
});
test('skills instructions and config prose count as behavioral changes', () => {
  for (const file of ['skills/review/SKILL.md', 'AGENTS.md', 'instructions/worker.md', 'config/policy.md']) {
    const { root, w } = fixture(); w.createTask(task('T1', { scope: ['**'], code: false, requiredChecks: [] })); const claim = w.claimTask('T1', worker);
    assert.throws(() => w.submitTask(claim.token, candidate(root, { files: [file] })), /check/i);
  }
});
test('lease valid at integration entry remains authorized when action crosses its deadline', () => {
  const { root, w } = fixture(); w.createTask(task()); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap); w.markVerified('T1');
  const originalNow = Date.now;
  try { const result = w.withIntegration(claim.token, () => { writeFileSync(join(root, 'merged.txt'), 'Git action completed'); Date.now = () => claim.expiresAt + 1; return 'merged'; }); assert.equal(result, 'merged'); assert.equal(w.getTask('T1').status, 'integrated'); }
  finally { Date.now = originalNow; }
});
test('policy changes during integration action durably revoke approval', () => {
  const { root, w } = fixture(); w.createTask(task()); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap); w.markVerified('T1'); const plan = readFileSync(join(root, 'PLAN.md'));
  assert.throws(() => w.withIntegration(claim.token, () => { writeFileSync(join(root, 'PLAN.md'), 'merged changed context'); return 'merged'; }), /approval/i);
  writeFileSync(join(root, 'PLAN.md'), plan); assert.throws(() => w.assertApproved(), /approval/i); assert.notEqual(w.getTask('T1').status, 'verified');
});
test('get and list immediately show stale candidates and blocked dependencies after policy edits', () => {
  const { root, w } = fixture(); w.createTask(task()); w.createTask(task('T2', { dependencies: ['T1'], scope: ['docs/**'] })); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap); w.markVerified('T1'); w.integrateTask(claim.token, snap);
  writeFileSync(join(root, 'PLAN.md'), 'changed'); assert.equal(w.getTask('T1').status, 'stale'); assert.equal(w.getTask('T1').verified, false); assert.equal(w.getTask('T2').status, 'blocked'); assert.equal(w.listTasks()[0]?.status, 'stale');
});
test('external dimensions require owner evidence bound to current integrated candidates', () => {
  const { root, w } = fixture(); w.createTask(task()); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap); w.markVerified('T1'); w.integrateTask(claim.token, snap);
  mkdirSync(join(root, '.agentkit/artifacts'), { recursive: true }); const evidenceRef = '.agentkit/artifacts/staging.txt'; writeFileSync(join(root, evidenceRef), 'Owner verified staging deployment'); const artifactHash = sha256(readFileSync(join(root, evidenceRef)));
  w.recordExternalGate({ id: 'staging-smoke', dimension: 'staging', passed: true, evidenceRef, artifactHash, owner: 'project-owner' });
  let ready = w.readiness() as { staging: { ready: boolean }, release: { ready: boolean } }; assert.equal(ready.staging.ready, true); assert.equal(ready.release.ready, false);
  w.recordExternalGate({ id: 'release-approval', dimension: 'release', passed: true, evidenceRef, artifactHash, owner: 'project-owner' }); assert.equal((w.readiness() as { release: { ready: boolean } }).release.ready, true);
  writeFileSync(join(root, evidenceRef), 'changed external receipt'); ready = w.readiness() as typeof ready; assert.equal(ready.staging.ready, false); assert.equal(ready.release.ready, false);
});
test('external evidence rejects secrets mismatched hashes and unintegrated work', () => {
  const { root, w } = fixture(); w.createTask(task()); const evidenceRef = '.agentkit/gate.txt'; writeFileSync(join(root, evidenceRef), 'Authorization: Bearer secrettoken123456789');
  assert.throws(() => w.recordExternalGate({ id: 'secret', dimension: 'staging', passed: true, evidenceRef, artifactHash: sha256(readFileSync(join(root, evidenceRef))), owner: 'owner' }), /secret|credential/i);
  writeFileSync(join(root, evidenceRef), 'Owner evidence'); assert.throws(() => w.recordExternalGate({ id: 'bad-hash', dimension: 'staging', passed: true, evidenceRef, artifactHash: '0'.repeat(64), owner: 'owner' }), /hash/i);
  assert.throws(() => w.recordExternalGate({ id: 'unfinished', dimension: 'staging', passed: true, evidenceRef, artifactHash: sha256(readFileSync(join(root, evidenceRef))), owner: 'owner' }), /integrated|verified/i);
});
test('obvious no-op commands cannot count as meaningful code checks', () => {
  const { root, w } = fixture(); const profile = readProfile(root); profile.commands.unit = { argv: ['/bin/true'], cwd: '.', timeoutMs: 1000 }; writeFileSync(join(root, PROFILE_FILE), JSON.stringify(profile)); w.approvePlan('PLAN.md');
  w.createTask(task()); const claim = w.claimTask('T1', worker); assert.throws(() => w.submitTask(claim.token, candidate(root)), /meaningful/i);
});
test('reapproved integrated code can be claimed for revalidation with a new token', () => {
  const { root, w } = fixture(); w.createTask(task()); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap); w.markVerified('T1'); w.integrateTask(claim.token, snap);
  writeFileSync(join(root, 'PLAN.md'), 'New approved policy'); assert.throws(() => w.assertApproved(), /approval/i); w.approvePlan('PLAN.md');
  assert.notEqual(w.claimTask('T1', { ...worker, sessionId: 's3' }).token, claim.token);
});
test('approval generations prevent old check evidence revival within the same clock tick', () => {
  const originalNow = Date.now; Date.now = () => 1000000;
  try {
    const { root, w } = fixture(); w.createTask(task()); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); const originalPlan = readFileSync(join(root, 'PLAN.md'));
    writeFileSync(join(root, 'PLAN.md'), 'changed'); assert.throws(() => w.heartbeatTask(claim.token), /approval/i); writeFileSync(join(root, 'PLAN.md'), originalPlan); w.approvePlan('PLAN.md'); w.recoverTask('T1', true);
    const fresh = w.claimTask('T1', { ...worker, sessionId: 'fresh' }); const sameCandidate = candidate(root); w.submitTask(fresh.token, sameCandidate); review(w, 'T1', sameCandidate);
    assert.throws(() => w.markVerified('T1'), /stale|check/i);
  } finally { Date.now = originalNow; }
});
test('external gate failures remain blockers and export import never grants readiness', () => {
  const { root, w } = fixture(); w.createTask(task()); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap); w.markVerified('T1'); w.integrateTask(claim.token, snap);
  writeFileSync(join(root, '.agentkit/gate.txt'), 'Device validation recorded by owner'); const input = { id: 'devices', dimension: 'staging' as const, passed: false, evidenceRef: '.agentkit/gate.txt', artifactHash: sha256(readFileSync(join(root, '.agentkit/gate.txt'))), owner: 'owner' };
  w.recordExternalGate(input); assert.equal((w.readiness() as { staging: { ready: boolean } }).staging.ready, false); w.recordExternalGate({ ...input, passed: true }); assert.equal((w.readiness() as { staging: { ready: boolean } }).staging.ready, true);
  const exported = w.exportState(true) as Record<string, unknown>; assert.equal(exported.externalGates, undefined); const imported = fixture().w; imported.importState({ ...exported, externalGates: [{ ...input, passed: true }], readiness: { staging: { ready: true }, release: { ready: true } } }); assert.equal((imported.readiness() as { staging: { ready: boolean }, release: { ready: boolean } }).staging.ready, false); assert.equal((imported.readiness() as { release: { ready: boolean } }).release.ready, false);
});
test('owner reconciliation finalizes exact expired reviewed candidate after Git success', () => {
  const { root, w } = fixture(); w.createTask(task()); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap); w.markVerified('T1');
  const originalNow = Date.now; Date.now = () => claim.expiresAt + 1;
  try { assert.throws(() => w.integrateTask(claim.token, snap), /expired/i); assert.throws(() => w.reconcileIntegratedTask(claim.token, { ...snap, headCommit: 'f'.repeat(40) }), /candidate|snapshot/i); assert.equal(w.reconcileIntegratedTask(claim.token, snap).status, 'integrated'); }
  finally { Date.now = originalNow; }
});
test('owner reconciliation cannot finalize revoked or recovered claims', () => {
  const { root, w } = fixture(); w.createTask(task()); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap); w.markVerified('T1'); w.recoverTask('T1', true);
  assert.throws(() => w.reconcileIntegratedTask(claim.token, snap), /revoked|claim/i);
});
test('rebasing a claim accepts only current project Git HEAD and invalidates candidate evidence and reviews', () => {
  const { root, w } = fixture();
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Core Fixture'); git('config', 'user.email', 'fixture@example.invalid'); writeFileSync(join(root, 'base.txt'), 'base'); git('add', 'base.txt', 'PLAN.md', '.gitignore', '.agentkit/project.yaml'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  w.createTask(task()); const claim = w.claimTask('T1', worker); const snap = candidate(root, { baseCommit: base }); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap);
  const grant = w.assignReviewer('T1', reviewer, ['spec', 'code']); for (const kind of ['spec', 'code'] as const) w.recordReview(grant.token, { verdict: 'pass', kind, treeHash: snap.treeHash, diffHash: snap.diffHash, criteria: ['works'], findings: [] }); w.markVerified('T1');
  writeFileSync(join(root, 'other.txt'), 'integrated parallel task'); git('add', 'other.txt'); git('commit', '-m', 'parallel task'); const head = git('rev-parse', 'HEAD');
  assert.throws(() => w.rebaseClaim(claim.token, '0'.repeat(40)), /head|base|commit/i); assert.throws(() => w.rebaseClaim(claim.token, base), /head|base|commit/i);
  assert.equal(w.rebaseClaim(claim.token, head).baseCommit, head); assert.equal(w.getTask('T1').status, 'claimed'); assert.equal(w.getTask('T1').candidate, undefined);
  assert.throws(() => w.recordReview(grant.token, { verdict: 'pass', kind: 'spec', treeHash: snap.treeHash, diffHash: snap.diffHash, criteria: ['works'], findings: [] }), /revoked/i);
  const next = { ...snap, baseCommit: head }; w.submitTask(claim.token, next); review(w, 'T1', next); assert.throws(() => w.markVerified('T1'), /stale|check/i);
});
test('global unresolved blockers prevent local verification and release readiness', () => {
  const { root, w } = fixture(); w.createTask(task()); const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap); w.recordBlocker({ id: 'global-dependency', text: 'Need deployment access' });
  assert.throws(() => w.markVerified('T1'), /blocker/i); w.resolveBlocker('global-dependency'); w.markVerified('T1'); w.integrateTask(claim.token, snap);
  writeFileSync(join(root, '.agentkit/external.txt'), 'Owner validated environment'); const gate = { evidenceRef: '.agentkit/external.txt', artifactHash: sha256(readFileSync(join(root, '.agentkit/external.txt'))), owner: 'owner', passed: true }; w.recordExternalGate({ ...gate, id: 'staging', dimension: 'staging' }); w.recordExternalGate({ ...gate, id: 'release', dimension: 'release' });
  assert.equal((w.readiness() as { release: { ready: boolean } }).release.ready, true); w.recordBlocker({ id: 'global-risk', text: 'Provider delivery not approved' });
  const ready = w.readiness() as { local: { ready: boolean }, staging: { ready: boolean }, release: { ready: boolean } }; assert.equal(ready.local.ready, false); assert.equal(ready.staging.ready, false); assert.equal(ready.release.ready, false);
});
test('records cannot overwrite another kind or reassign blocker scope', () => {
  const { w } = fixture(); w.createTask(task()); w.createTask(task('T2')); w.recordBlocker({ id: 'blocked', taskId: 'T1', text: 'Need owner evidence' });
  assert.throws(() => w.recordRequirement({ id: 'blocked', text: 'Overwrite blocker' }), /kind|collision/i); assert.throws(() => w.recordBlocker({ id: 'blocked', taskId: 'T2', text: 'Move blocker' }), /scope|task/i);
  assert.equal((w.exportState(true) as { records: { id: string; kind: string; taskId?: string }[] }).records.find(r => r.id === 'blocked')?.kind, 'blocker');
});
test('import rejects duplicate incoming record IDs across kinds', () => {
  const { w } = fixture(); const exported = w.exportState(true) as Record<string, unknown>;
  assert.throws(() => w.importState({ ...exported, records: [{ id: 'duplicate', kind: 'blocker', text: 'Gate unresolved' }, { id: 'duplicate', kind: 'requirement', text: 'Bypass blocker' }] }), /duplicate|collision/i);
});
test('readRecords returns bounded redacted global memory and task-scoped blockers evidence and reviews', () => {
  const { root, w } = fixture(); w.createTask(task()); w.createTask(task('T2', { scope: ['docs/**'] }));
  for (let i = 0; i < 105; i++) w.recordRequirement({ id: `R${i}`, text: i === 104 ? 'token=sk-proj-123456789012345678901234567890' : `Requirement ${i}` }); w.recordDecision({ id: 'D1', text: 'Use local storage', rationale: 'Keep project isolated' });
  w.recordBlocker({ id: 'B-global', text: 'Need owner input' }); w.recordBlocker({ id: 'B-one', taskId: 'T1', text: 'Need parser fixture' }); w.recordBlocker({ id: 'B-two', taskId: 'T2', text: 'Need documentation fixture' });
  const claim = w.claimTask('T1', worker); const snap = candidate(root); w.submitTask(claim.token, snap); evidence(w, root, claim.token, snap); review(w, 'T1', snap);
  const records = w.readRecords('T1') as { requirements: { id: string }[], decisions: { id: string }[], blockers: { id: string }[], evidence: unknown[], reviews: unknown[] };
  assert.equal(records.requirements.length, 100); assert.equal(records.decisions[0]?.id, 'D1'); assert.deepEqual(records.blockers.map(r => r.id).sort(), ['B-global', 'B-one']); assert.equal(records.evidence.length, 1); assert.equal(records.reviews.length, 2); assert.doesNotMatch(JSON.stringify(records), /12345678901234567890|"token"/);
});
test('owner blocker resolution requires current policy approval', () => {
  const { root, w } = fixture(); w.recordBlocker({ id: 'blocker', text: 'Need approval' }); writeFileSync(join(root, 'PLAN.md'), 'changed policy'); assert.throws(() => w.resolveBlocker('blocker'), /approval/i);
});

test('recorded decision changes invalidate checks reviews and dependent readiness',()=>{
 const {root,w}=fixture();w.recordDecision({id:'D',text:'First decision',rationale:'Original constraint'});w.createTask(task());const claim=w.claimTask('T1',worker);const snap=candidate(root);w.submitTask(claim.token,snap);evidence(w,root,claim.token,snap);review(w,'T1',snap);w.markVerified('T1');
 w.recordDecision({id:'D',text:'Changed decision',rationale:'New constraint'});w.recordDecision({id:'D',text:'First decision',rationale:'Original constraint'});assert.equal(w.getTask('T1').status,'stale');assert.throws(()=>w.markVerified('T1'),/stale|review/i);w.submitTask(claim.token,snap);review(w,'T1',snap);assert.throws(()=>w.markVerified('T1'),/stale|check/i);
 evidence(w,root,claim.token,snap);w.markVerified('T1');w.integrateTask(claim.token,snap);w.recordDecision({id:'D',text:'Another constraint',rationale:'Revalidate existing implementation'});assert.equal(w.getTask('T1').status,'stale');assert.doesNotThrow(()=>w.claimTask('T1',{...worker,sessionId:'revalidation'}));
});
