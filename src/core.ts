import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { confinedPath, redact } from './security.js';
import { initializeProject, readProfile, sha256, PROFILE_FILE, matchesScope, scopesOverlap, validateScope } from './policy.js';
import { Store, SCHEMA_VERSION } from './store.js';
import type { Approval, Profile, TaskInput, TaskRecord, WorkerIdentity, ClaimRecord, CandidateSnapshot, EvidenceInput, ReviewInput, ExternalGateInput } from './types.js';

const nonempty = z.string().trim().min(1).max(100000);
const taskSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), title: nonempty, requirement: nonempty, acceptance: z.array(nonempty).min(1).max(500), dependencies: z.array(nonempty).max(1000), scope: z.array(nonempty).min(1).max(500), requiredChecks: z.array(nonempty).max(200), risk: z.enum(['normal', 'sensitive']).optional(), code: z.boolean().optional(), sourceRefs: z.array(nonempty).max(200).optional() }).strict();
const workerSchema = z.object({ host: z.enum(['codex', 'opencode', 'manual']), sessionId: nonempty, workerId: nonempty, role: nonempty }).strict();
const snapshotSchema = z.object({ baseCommit: nonempty, headCommit: nonempty, treeHash: nonempty, diffHash: nonempty, files: z.array(nonempty).max(100000), worktree: nonempty }).strict();
const evidenceSchema = z.object({ checkId: nonempty, exitCode: z.number().int().nullable(), passed: z.boolean(), treeHash: nonempty, diffHash: nonempty, artifact: nonempty, artifactHash: z.string().regex(/^[a-f0-9]{64}$/), startedAt: z.number().finite(), finishedAt: z.number().finite() }).strict();
const reviewSchema = z.object({ verdict: z.enum(['pass', 'fail']), kind: z.enum(['spec', 'code', 'security']), treeHash: nonempty, diffHash: nonempty, criteria: z.array(nonempty), findings: z.array(z.object({ severity: z.enum(['critical', 'high', 'medium', 'low']), message: nonempty, resolved: z.boolean() }).strict()) }).strict();
type InternalTask = TaskRecord & { submittedBy?: WorkerIdentity; contextStamp?: string; verifiedStamp?: string; integratedStamp?: string };
type Grant = { worker: WorkerIdentity; kinds: ReviewInput['kind'][]; candidateHash: string };
type ExternalGate = ExternalGateInput & { taskIds: string[]; approvalStamp: string; candidates: Record<string, string>; recordedAt: number };
type Row = { data: string };
const token = (): string => randomBytes(32).toString('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fingerprint = (value: CandidateSnapshot): string => sha256(JSON.stringify({ ...value, files: [...value.files].sort() }));
function unique(values: string[]): string[] { return [...new Set(values)]; }
class ApprovalDriftError extends Error {}

/** Trusted local coordinator. Host identities express structural separation, not cryptographic attestation. */
export class Workbench {
  public readonly root: string;
  private readonly store: Store;
  constructor(root: string) { initializeProject(root); this.root = realpathSync(root); this.store = new Store(this.root); }
  close(): void { this.store.close(); }
  /** The rejected operation rolls back first; drift revocation commits independently afterwards. */
  private transaction<T>(action: () => T): T {
    try { return this.store.transaction(action); }
    catch (error) {
      if (error instanceof ApprovalDriftError && !this.store.db.inTransaction && this.store.get<Approval>('approval')) this.store.transaction(() => this.invalidate(error.message));
      throw error;
    }
  }
  private writeTask(task: InternalTask): void { this.store.db.prepare('INSERT INTO tasks(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id, JSON.stringify(task)); }
  private rawTask(id: string): InternalTask { const row = this.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as Row | undefined; if (!row) throw new Error(`Unknown task: ${id}`); return JSON.parse(row.data) as InternalTask; }
  private rawTasks(): InternalTask[] { return (this.store.db.prepare('SELECT data FROM tasks ORDER BY id').all() as Row[]).map(r => JSON.parse(r.data) as InternalTask); }
  private claimFor(taskId: string): ClaimRecord | undefined { const row = this.store.db.prepare('SELECT data FROM claims WHERE task_id=? AND released=0').get(taskId) as Row | undefined; return row ? JSON.parse(row.data) as ClaimRecord : undefined; }
  private approvedStamp(): string { const a = this.store.get<Approval>('approval'); if (!a) throw new Error('Plan and profile approval required'); const memory=[...this.records('requirement'),...this.records('decision')].sort((left,right)=>String(left.id).localeCompare(String(right.id))); return sha256(JSON.stringify(memory.length?{approval:a,memory,generation:this.store.get<string>('memoryGeneration')}:a)); }
  private contextHash(profile: Profile): string { return sha256(JSON.stringify(profile.context.map(ref => ({ ref, hash: sha256(readFileSync(confinedPath(this.root, ref, true))) })))); }
  private absolute(input: string, mustExist = true): string { const relative = path.isAbsolute(input) ? path.relative(this.root, realpathSync(input)).split(path.sep).join('/') : input; return confinedPath(this.root, relative, mustExist); }
  private worktreePath(input: string): string { const directory = this.absolute(input); const parent = confinedPath(this.root, '.agentkit/worktrees'); if (!directory.startsWith(parent + path.sep) || !realpathSync(directory).startsWith(realpathSync(parent) + path.sep) || !statSync(directory).isDirectory()) throw new Error('Worktree must be an isolated directory in .agentkit/worktrees'); return directory; }
  private invalidate(reason: string): void {
    this.store.set('approval', undefined);
    this.store.db.prepare('UPDATE claims SET revoked=1 WHERE revoked=0').run();
    this.store.db.prepare('UPDATE review_grants SET revoked=1 WHERE revoked=0').run();
    for (const task of this.rawTasks()) { task.status = 'pending'; task.verified = false; delete task.verifiedStamp; this.writeTask(task); }
    this.store.event('approval.invalidated', { reason });
  }
  approvePlan(planFile: string): Approval {
    const file = confinedPath(this.root, planFile, true); if (!statSync(file).isFile()) throw new Error('Plan must be a file');
    const profile = readProfile(this.root); const approval: Approval = { profileHash: sha256(readFileSync(confinedPath(this.root, PROFILE_FILE, true))), planFile: path.relative(this.root, file).split(path.sep).join('/'), planHash: sha256(readFileSync(file)), contextHash: this.contextHash(profile), approvedAt: Date.now(), approvalId: randomUUID() };
    return this.transaction(() => {
      const before = this.store.get<Approval>('approval');
      if (before && (before.profileHash !== approval.profileHash || before.planHash !== approval.planHash || before.contextHash !== approval.contextHash || before.planFile !== approval.planFile)) this.invalidate('Explicit approval replaces changed profile, plan, or context');
      if (before && before.profileHash === approval.profileHash && before.planHash === approval.planHash && before.contextHash === approval.contextHash && before.planFile === approval.planFile) return before;
      this.store.set('approval', approval); this.store.event('plan.approved', approval); return approval;
    });
  }
  assertApproved(): Profile {
    const approval = this.store.get<Approval>('approval'); if (!approval) throw new Error('Plan and profile approval required');
    try {
      const profile = readProfile(this.root);
      if (sha256(readFileSync(confinedPath(this.root, PROFILE_FILE, true))) !== approval.profileHash || sha256(readFileSync(confinedPath(this.root, approval.planFile, true))) !== approval.planHash || this.contextHash(profile) !== approval.contextHash) throw new Error('Approved profile, plan, or context changed');
      return profile;
    } catch (error) {
      const drift = new ApprovalDriftError(`Approval invalidated: ${(error as Error).message}`);
      if (!this.store.db.inTransaction) this.store.transaction(() => this.invalidate(drift.message));
      throw drift;
    }
  }
  private approvalForRead(): boolean {
    if (!this.store.get<Approval>('approval')) return false;
    try { this.assertApproved(); return true; }
    catch (error) { if (error instanceof ApprovalDriftError && this.store.db.inTransaction) throw error; return false; }
  }
  private renderTask(id: string, approved: boolean): TaskRecord {
    const task = this.rawTask(id); const result = clone(task) as InternalTask;
    delete result.submittedBy; delete result.contextStamp; delete result.verifiedStamp; delete result.integratedStamp;
    result.approvalValid = approved;
    const claim = this.claimFor(id); if (claim) result.claim = claim;
    if (task.candidate && (!approved || task.contextStamp !== this.approvedStamp())) { result.status = 'stale'; result.verified = false; result.integrated = false; result.validationReason = 'Candidate requires current policy and context revalidation'; }
    else if (task.status === 'pending') result.status = task.dependencies.every(dep => { try { const d = this.rawTask(dep); return approved && d.status === 'integrated' && d.verified === true && d.integratedStamp === this.approvedStamp(); } catch { return false; } }) ? 'ready' : 'blocked';
    return result;
  }
  getTask(id: string): TaskRecord { return this.renderTask(id, this.approvalForRead()); }
  listTasks(): TaskRecord[] { const approved = this.approvalForRead(); return this.rawTasks().map(task => this.renderTask(task.id, approved)); }
  private validateTask(input: unknown): TaskInput {
    const result = taskSchema.parse(input) as TaskInput;
    result.dependencies = unique(result.dependencies); result.acceptance = unique(result.acceptance); result.scope = unique(result.scope.map(validateScope)); result.requiredChecks = unique(result.requiredChecks);
    if (result.dependencies.includes(result.id)) throw new Error('Dependency cycle');
    return result;
  }
  private assertDag(tasks: TaskInput[]): void {
    const graph = new Map(tasks.map(t => [t.id, t.dependencies])); const visiting = new Set<string>(), done = new Set<string>();
    const visit = (id: string): void => { if (visiting.has(id)) throw new Error('Dependency cycle rejected'); if (done.has(id)) return; visiting.add(id); for (const dep of graph.get(id) ?? []) visit(dep); visiting.delete(id); done.add(id); };
    for (const id of graph.keys()) visit(id);
  }
  createTask(input: TaskInput): TaskRecord {
    const task = this.validateTask(input);
    return this.transaction(() => {
      const existing = this.rawTasks(); if (existing.some(t => t.id === task.id)) throw new Error('Duplicate task ID already exists');
      this.assertDag([...existing, task]);
      const tokens = (t: TaskInput): Set<string> => new Set(`${t.title} ${t.requirement}`.toLowerCase().match(/[a-z0-9]+/g));
      const words = tokens(task); const duplicate = existing.find(t => { const other = tokens(t), both = [...words].filter(x => other.has(x)).length; return both / Math.max(1, new Set([...words, ...other]).size) >= 0.75; });
      const record: InternalTask = { ...task, status: 'pending', warnings: duplicate ? [`Possible semantic duplicate of ${duplicate.id}`] : [] };
      this.writeTask(record); this.store.event('task.created', task, task.id); return this.getTask(task.id);
    });
  }
  claimTask(id: string, identity: WorkerIdentity, worktree?: string): ClaimRecord {
    const worker = workerSchema.parse(identity) as WorkerIdentity;
    return this.transaction(() => {
      const profile = this.assertApproved(); if (!Object.hasOwn(profile.roles, worker.role)) throw new Error('Worker role is not in approved policy');
      const task = this.rawTask(id); if (this.claimFor(id)) throw new Error('Task has an active claim; recovery required');
      const publicStatus = this.getTask(id).status;
      const dependenciesReady = task.dependencies.every(dep => { const parent = this.rawTask(dep); return parent.status === 'integrated' && parent.verified === true && parent.integratedStamp === this.approvedStamp(); });
      if (!(publicStatus === 'ready' || (publicStatus === 'stale' && task.status === 'pending' && dependenciesReady))) throw new Error('Task is not ready; dependencies must be verified and integrated');
      const active = (this.store.db.prepare('SELECT data FROM claims WHERE released=0').all() as Row[]).map(r => JSON.parse(r.data) as ClaimRecord);
      if (active.length >= profile.policy.maxWorkers) throw new Error('Maximum worker limit reached');
      if (active.some(c => scopesOverlap(task.scope, this.rawTask(c.taskId).scope))) throw new Error('Task scope overlaps an active worker scope');
      const claim: ClaimRecord = { token: token(), taskId: id, worker, expiresAt: Date.now() + profile.policy.leaseMs };
      if (worktree) claim.worktree = this.worktreePath(worktree);
      if (existsSync(path.join(this.root, '.git'))) { try { claim.baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.root, encoding: 'utf8', timeout: 5000 }).trim(); } catch { throw new Error('Cannot capture claim base Git commit'); } }
      this.store.db.prepare('INSERT INTO claims(token,task_id,data) VALUES(?,?,?)').run(claim.token, id, JSON.stringify(claim));
      task.status = 'claimed'; this.writeTask(task); this.store.event('task.claimed', { worker, expiresAt: claim.expiresAt }, id); return clone(claim);
    });
  }
  private activeClaim(claimToken: string): ClaimRecord {
    this.assertApproved();
    const row = this.store.db.prepare('SELECT data,revoked FROM claims WHERE token=?').get(claimToken) as (Row & { revoked: number }) | undefined;
    if (!row || row.revoked) throw new Error('Unknown or revoked claim token');
    const claim = JSON.parse(row.data) as ClaimRecord; if (claim.expiresAt <= Date.now()) throw new Error('Claim lease expired; stopped-worker recovery required');
    return claim;
  }
  attachWorktree(claimToken: string, worktree: string): ClaimRecord {
    return this.transaction(() => { const claim = this.activeClaim(claimToken); const directory = this.worktreePath(worktree); if (claim.worktree && claim.worktree !== directory) throw new Error('Claim worktree is immutable'); claim.worktree = directory; this.store.db.prepare('UPDATE claims SET data=? WHERE token=?').run(JSON.stringify(claim), claimToken); this.store.event('claim.worktree-attached', { worktree: path.relative(this.root, directory).split(path.sep).join('/') }, claim.taskId); return claim; });
  }
  /** Owner service rebases Git first; this fences the fresh validation cycle to current project HEAD. */
  rebaseClaim(claimToken: string, baseCommit: string): ClaimRecord {
    return this.transaction(() => {
      const claim = this.activeClaim(claimToken);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit) || !existsSync(path.join(this.root, '.git'))) throw new Error('Rebase base must be current project Git HEAD');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.root, encoding: 'utf8', timeout: 5000 }).trim();
      if (baseCommit !== head) throw new Error('Rebase base commit differs from current project Git HEAD');
      const task = this.rawTask(claim.taskId); claim.baseCommit = baseCommit;
      this.store.db.prepare('UPDATE claims SET data=? WHERE token=? AND revoked=0 AND released=0').run(JSON.stringify(claim), claimToken);
      this.store.db.prepare('UPDATE evidence SET context_hash=? WHERE task_id=?').run(`revoked-rebase:${randomUUID()}`, task.id); this.revokeReviews(task.id);
      task.status = 'claimed'; task.verified = false; task.integrated = false; delete task.candidate; delete task.submittedBy; delete task.contextStamp; delete task.verifiedStamp; delete task.integratedStamp; this.writeTask(task);
      this.store.event('claim.rebased', { baseCommit, worker: claim.worker, evidenceInvalidated: true }, task.id); return clone(claim);
    });
  }
  heartbeatTask(claimToken: string): ClaimRecord { return this.transaction(() => { const claim = this.activeClaim(claimToken); claim.expiresAt = Date.now() + this.assertApproved().policy.leaseMs; this.store.db.prepare('UPDATE claims SET data=? WHERE token=? AND revoked=0').run(JSON.stringify(claim), claimToken); this.store.event('claim.heartbeat', { expiresAt: claim.expiresAt }, claim.taskId); return claim; }); }
  recoverTask(id: string, workerStopped: boolean): TaskRecord {
    if (workerStopped !== true) throw new Error('Recovery requires proof that the worker has stopped');
    return this.transaction(() => {
      const task = this.rawTask(id); const claim = this.claimFor(id); if (!claim) throw new Error('No active claim to recover');
      if (claim.worktree && existsSync(claim.worktree)) {
        const source = this.worktreePath(claim.worktree); const quarantine = confinedPath(this.root, '.agentkit/quarantine'); mkdirSync(quarantine, { recursive: true, mode: 0o700 });
        renameSync(source, path.join(quarantine, `${task.id}-${Date.now()}-${randomUUID()}`));
      }
      this.store.db.prepare('UPDATE claims SET revoked=1,released=1 WHERE token=?').run(claim.token); this.revokeReviews(id);
      task.status = 'pending'; task.verified = false; delete task.candidate; delete task.contextStamp; delete task.verifiedStamp; delete task.submittedBy; this.writeTask(task);
      this.store.event('claim.recovered', { worker: claim.worker, quarantined: Boolean(claim.worktree) }, id); return this.getTask(id);
    });
  }
  private revokeReviews(taskId: string): void { this.store.db.prepare('UPDATE review_grants SET revoked=1 WHERE task_id=?').run(taskId); }
  private requiresBehaviorReview(task: InternalTask, snapshot: CandidateSnapshot): boolean {
    if (task.code === true || !snapshot.files.length) return true;
    return snapshot.files.some(file => {
      const normalized = file.toLowerCase();
      if (normalized.split('/').some(part => part.startsWith('.') || /^(?:skills?|instructions?|prompts?|polic(?:y|ies)|config|configuration|scripts?|automation|agents?)$/.test(part))) return true;
      if (/^(?:agents|skill|claude|gemini|copilot-instructions|instructions|prompt|policy|config)\./.test(path.basename(normalized))) return true;
      return !/\.(?:md|txt|rst|adoc)$/.test(normalized);
    });
  }
  private assertBehaviorChecks(task: InternalTask, snapshot: CandidateSnapshot, profile: Profile): void {
    if (!this.requiresBehaviorReview(task, snapshot)) return;
    if (!task.requiredChecks.length) throw new Error('Actual code or behavior changes require at least one approved meaningful check');
    for (const check of task.requiredChecks) {
      const command = profile.commands[check];
      if (!command) throw new Error(`Required code check is not an approved command: ${check}`);
      const executable = path.basename(command.argv[0]!).toLowerCase().replace(/\.exe$/, '');
      if (['true', 'false', 'echo', 'printf', 'pwd', 'whoami', 'date', 'sleep', 'timeout', ':'].includes(executable)) throw new Error(`Code check must perform meaningful validation: ${check}`);
    }
  }
  submitTask(claimToken: string, input: CandidateSnapshot): TaskRecord {
    const snapshot = snapshotSchema.parse(input) as CandidateSnapshot;
    return this.transaction(() => {
      const claim = this.activeClaim(claimToken); const task = this.rawTask(claim.taskId); snapshot.worktree = this.worktreePath(snapshot.worktree);
      if (claim.worktree && snapshot.worktree !== claim.worktree) throw new Error('Candidate worktree does not match claim');
      if (claim.baseCommit && snapshot.baseCommit !== claim.baseCommit) throw new Error('Candidate base commit does not match claim');
      for (const file of snapshot.files) { validateScope(file); if (/[?*]/.test(file)) throw new Error('Candidate files must be actual paths'); if (!task.scope.some(scope => matchesScope(file, scope))) throw new Error(`Actual candidate file outside declared scope: ${file}`); confinedPath(snapshot.worktree, file); }
      this.assertBehaviorChecks(task, snapshot, this.assertApproved());
      if (task.status === 'integrated') throw new Error('Task already integrated');
      if (!task.candidate || fingerprint(task.candidate) !== fingerprint(snapshot)) { this.revokeReviews(task.id); task.verified = false; delete task.verifiedStamp; }
      if (!claim.worktree) { claim.worktree = snapshot.worktree; this.store.db.prepare('UPDATE claims SET data=? WHERE token=?').run(JSON.stringify(claim), claimToken); }
      task.candidate = snapshot; task.submittedBy = claim.worker; task.contextStamp = this.approvedStamp(); task.status = 'submitted'; this.writeTask(task);
      this.store.event('task.submitted', { candidate: snapshot, contextStamp: task.contextStamp }, task.id); return this.getTask(task.id);
    });
  }
  addEvidence(claimToken: string, input: EvidenceInput): { id: number } {
    const evidence = evidenceSchema.parse(input) as EvidenceInput;
    return this.transaction(() => {
      const claim = this.activeClaim(claimToken); const task = this.rawTask(claim.taskId); this.matchesCandidate(task, evidence);
      if (!task.requiredChecks.includes(evidence.checkId)) throw new Error('Evidence check is not required by this task');
      if (evidence.finishedAt < evidence.startedAt || evidence.finishedAt > Date.now() + 5000 || evidence.startedAt < 0) throw new Error('Invalid evidence timestamps');
      if (evidence.passed && evidence.exitCode !== 0) throw new Error('Passing evidence requires successful exit code');
      const artifact = this.absolute(evidence.artifact); if (!statSync(artifact).isFile() || sha256(readFileSync(artifact)) !== evidence.artifactHash) throw new Error('Evidence artifact hash mismatch');
      evidence.artifact = path.relative(this.root, artifact).split(path.sep).join('/');
      const row = this.store.db.prepare('INSERT INTO evidence(task_id,token,data,context_hash) VALUES(?,?,?,?)').run(task.id, claimToken, JSON.stringify(evidence), this.approvedStamp());
      task.verified = false; delete task.verifiedStamp; task.status = 'submitted'; this.writeTask(task); this.store.event('evidence.recorded', { checkId: evidence.checkId, passed: evidence.passed, artifactHash: evidence.artifactHash }, task.id); return { id: Number(row.lastInsertRowid) };
    });
  }
  private matchesCandidate(task: InternalTask, value: { treeHash: string; diffHash: string }): void { if (!task.candidate) throw new Error('Task has no submitted candidate'); if (value.treeHash !== task.candidate.treeHash || value.diffHash !== task.candidate.diffHash || task.contextStamp !== this.approvedStamp()) throw new Error('Stale candidate evidence or context'); }
  assignReviewer(taskId: string, identity: WorkerIdentity, kinds: ReviewInput['kind'][]): { token: string } {
    const worker = workerSchema.parse(identity) as WorkerIdentity;
    return this.transaction(() => {
      const profile = this.assertApproved(); const task = this.rawTask(taskId); if (!task.candidate || !task.submittedBy) throw new Error('Submitted candidate required before review grant');
      if (task.submittedBy.sessionId === worker.sessionId || task.submittedBy.workerId === worker.workerId) throw new Error('Independent reviewer required; self-review forbidden');
      if (!Object.hasOwn(profile.roles, worker.role) || !['reviewer', 'security', 'human'].includes(worker.role)) throw new Error('Role does not permit independent review');
      if (!kinds.length || kinds.some(kind => !['spec', 'code', 'security'].includes(kind))) throw new Error('Invalid review grant kinds');
      if (kinds.includes('security') && !['security', 'human'].includes(worker.role)) throw new Error('Security review requires security role');
      const grantToken = token(); const data: Grant = { worker, kinds: unique(kinds) as ReviewInput['kind'][], candidateHash: fingerprint(task.candidate) };
      this.store.db.prepare('INSERT INTO review_grants(token,task_id,data) VALUES(?,?,?)').run(grantToken, taskId, JSON.stringify(data)); this.store.event('review.granted', { worker, kinds }, taskId); return { token: grantToken };
    });
  }
  recordReview(reviewToken: string, input: ReviewInput): { id: number } {
    const review = reviewSchema.parse(input) as ReviewInput;
    return this.transaction(() => {
      this.assertApproved(); const row = this.store.db.prepare('SELECT task_id,data,revoked FROM review_grants WHERE token=?').get(reviewToken) as (Row & { task_id: string; revoked: number }) | undefined;
      if (!row || row.revoked) throw new Error('Unknown or revoked review grant'); const grant = JSON.parse(row.data) as Grant; const task = this.rawTask(row.task_id);
      this.matchesCandidate(task, review); if (!task.candidate || fingerprint(task.candidate) !== grant.candidateHash) throw new Error('Stale review grant');
      if (!grant.kinds.includes(review.kind)) throw new Error('Review kind is outside grant');
      if (review.verdict === 'pass' && task.acceptance.some(criterion => !review.criteria.includes(criterion))) throw new Error('Passing review must cover all acceptance criteria');
      const saved = this.store.db.prepare('INSERT INTO reviews(task_id,token,data,context_hash) VALUES(?,?,?,?)').run(task.id, reviewToken, JSON.stringify(review), this.approvedStamp());
      task.verified = false; delete task.verifiedStamp; task.status = 'submitted'; this.writeTask(task); this.store.event('review.recorded', { kind: review.kind, verdict: review.verdict, reviewer: grant.worker, findings: review.findings }, task.id); return { id: Number(saved.lastInsertRowid) };
    });
  }
  private verifyGate(task: InternalTask, integrated = false): void {
    const profile = this.assertApproved(); if (!task.candidate) throw new Error('Candidate required'); this.matchesCandidate(task, task.candidate);
    this.assertBehaviorChecks(task, task.candidate, profile);
    const evidenceRows = this.store.db.prepare('SELECT data,context_hash FROM evidence WHERE task_id=? ORDER BY id DESC').all(task.id) as (Row & { context_hash: string })[];
    for (const check of task.requiredChecks) {
      const row = evidenceRows.find(r => (JSON.parse(r.data) as EvidenceInput).checkId === check);
      if (!row) throw new Error(`Required check evidence missing: ${check}`); const e = JSON.parse(row.data) as EvidenceInput;
      if (row.context_hash !== this.approvedStamp() || e.treeHash !== task.candidate.treeHash || e.diffHash !== task.candidate.diffHash || !e.passed || e.exitCode !== 0) throw new Error(`Required check failed or stale: ${check}`);
      try { if (sha256(readFileSync(this.absolute(e.artifact))) !== e.artifactHash) throw new Error('changed'); } catch { throw new Error(`Evidence artifact changed or missing: ${check}`); }
    }
    const kinds: ReviewInput['kind'][] = this.requiresBehaviorReview(task, task.candidate) ? ['spec', 'code'] : ['spec'];
    const sensitive = task.risk === 'sensitive' || task.candidate.files.length === 0 || task.candidate.files.some(file => profile.policy.sensitivePaths.some(scope => matchesScope(file, scope)));
    if (sensitive) kinds.push('security');
    const reviews = this.store.db.prepare('SELECT r.data,r.context_hash,g.revoked FROM reviews r JOIN review_grants g ON r.token=g.token WHERE r.task_id=? ORDER BY r.id DESC').all(task.id) as (Row & { context_hash: string; revoked: number })[];
    for (const kind of kinds) {
      const row = reviews.find(r => (!r.revoked || (integrated && task.status === 'integrated' && task.integratedStamp === this.approvedStamp())) && (JSON.parse(r.data) as ReviewInput).kind === kind); if (!row) throw new Error(`Required ${kind} review missing`);
      const review = JSON.parse(row.data) as ReviewInput;
      if (row.context_hash !== this.approvedStamp() || review.treeHash !== task.candidate.treeHash || review.diffHash !== task.candidate.diffHash || review.verdict !== 'pass' || task.acceptance.some(c => !review.criteria.includes(c))) throw new Error(`${kind} review failed or stale`);
      if (review.findings.some(f => !f.resolved)) throw new Error(`Unresolved ${kind} review findings`);
    }
    if (!task.dependencies.every(id => { const dep = this.rawTask(id); return dep.status === 'integrated' && dep.verified === true && dep.integratedStamp === this.approvedStamp(); })) throw new Error('Dependencies are no longer verified and integrated');
    const blockers = this.records('blocker').filter(r => (!r.taskId || r.taskId === task.id) && !r.resolved); if (blockers.length) throw new Error('Task has unresolved blockers');
  }
  markVerified(taskId: string): TaskRecord { return this.transaction(() => { const task = this.rawTask(taskId); const claim = this.claimFor(taskId); if (!claim) throw new Error('Active claim required for verification'); this.activeClaim(claim.token); this.verifyGate(task); task.status = 'verified'; task.verified = true; task.verifiedStamp = this.approvedStamp(); this.writeTask(task); this.store.event('task.verified', { candidateHash: fingerprint(task.candidate!) }, taskId); return this.getTask(taskId); }); }
  private integrationGate(claimToken: string, snapshot?: CandidateSnapshot): InternalTask {
    const claim = this.activeClaim(claimToken); const task = this.rawTask(claim.taskId);
    if (task.status !== 'verified' || !task.verified || task.verifiedStamp !== this.approvedStamp() || !task.candidate) throw new Error('Task must be verified before integration');
    if (snapshot && fingerprint(task.candidate) !== fingerprint(snapshot)) throw new Error('Integration snapshot differs from verified candidate'); this.verifyGate(task); return task;
  }
  private finishIntegration(claimToken: string, task: InternalTask): TaskRecord { task.status = 'integrated'; task.integrated = true; task.integratedStamp = this.approvedStamp(); this.writeTask(task); this.store.db.prepare('UPDATE claims SET revoked=1,released=1 WHERE token=?').run(claimToken); this.revokeReviews(task.id); this.store.event('task.integrated', { candidateHash: fingerprint(task.candidate!) }, task.id); return this.getTask(task.id); }
  integrateTask(claimToken: string, snapshot: CandidateSnapshot): TaskRecord { return this.transaction(() => this.finishIntegration(claimToken, this.integrationGate(claimToken, snapshotSchema.parse(snapshot) as CandidateSnapshot))); }
  /** Owner-only crash reconciliation: service proves worker stopped and actual Git/receipt agreement. */
  reconcileIntegratedTask(claimToken: string, input: CandidateSnapshot): TaskRecord {
    const snapshot = snapshotSchema.parse(input) as CandidateSnapshot;
    return this.transaction(() => {
      this.assertApproved();
      const row = this.store.db.prepare('SELECT data,revoked,released FROM claims WHERE token=?').get(claimToken) as (Row & { revoked: number; released: number }) | undefined;
      if (!row || row.revoked || row.released) throw new Error('Unknown, revoked or released claim cannot be reconciled');
      const claim = JSON.parse(row.data) as ClaimRecord; const task = this.rawTask(claim.taskId);
      if (task.status !== 'verified' || !task.verified || task.verifiedStamp !== this.approvedStamp() || !task.candidate || fingerprint(task.candidate) !== fingerprint(snapshot)) throw new Error('Reconciliation requires the exact verified candidate snapshot');
      this.verifyGate(task); return this.finishIntegration(claimToken, task);
    });
  }
  withIntegration<T>(claimToken: string, action: () => T): T {
    return this.transaction(() => { const task = this.integrationGate(claimToken); const result = action(); if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Integration callback must be synchronous'); this.assertApproved(); this.finishIntegration(claimToken, task); return result; });
  }
  checkpoint(label: string): { id: string; label: string; at: number } { if (!label.trim()) throw new Error('Checkpoint label required'); return this.transaction(() => { const saved = { id: randomUUID(), label, at: Date.now(), tasks: this.listTasks().map(t => ({ id: t.id, status: t.status })), activeClaims: this.store.db.prepare('SELECT COUNT(*) AS count FROM claims WHERE released=0').get() }; this.store.set('checkpoint', saved); this.store.event('checkpoint.created', saved); return saved; }); }
  resume(): unknown {
    let approved = false; try { this.assertApproved(); approved = true; } catch {}
    return { root: this.root, approved, checkpoint: this.store.get('checkpoint') ?? null, tasks: this.listTasks(), activeClaims: (this.store.db.prepare('SELECT data,revoked FROM claims WHERE released=0').all() as (Row & { revoked: number })[]).map(r => { const c = JSON.parse(r.data) as ClaimRecord; return { ...c, revoked: Boolean(r.revoked), expired: c.expiresAt <= Date.now(), recoveryRequired: true }; }), readiness: this.readiness() };
  }
  readiness(): unknown {
    let approved = false; try { this.assertApproved(); approved = true; } catch {}
    const tasks = this.listTasks(); const reasons = [!approved ? 'Profile and plan approval required' : '', !tasks.length ? 'No tasks defined' : '', ...tasks.filter(t => t.status !== 'integrated' || !t.verified).map(t => `${t.id}: ${t.status}`)].filter(Boolean);
    if (approved) for (const task of tasks.filter(t => t.status === 'integrated' && t.verified)) { try { this.verifyGate(this.rawTask(task.id), true); } catch (error) { reasons.push(`${task.id}: ${(error as Error).message}`); } }
    for(const blocker of this.records('blocker').filter(r=>!r.resolved&&!r.taskId)) reasons.push(`Global blocker ${blocker.id}: ${blocker.text}`);
    const local = { ready: reasons.length === 0, reasons };
    const external = (dimension: ExternalGateInput['dimension'], priorReasons: string[] = []) => {
      const gates = Object.values(this.store.get<Record<string, ExternalGate>>('externalGates') ?? {}).filter(gate => gate.dimension === dimension);
      const blockers = [...(!local.ready ? ['Current local verification is incomplete'] : []), ...priorReasons];
      if (!gates.length) blockers.push(`Owner ${dimension} evidence has not been supplied`);
      for (const gate of gates) {
        if (!gate.passed) blockers.push(`${gate.id}: owner reported a failed external gate`);
        if (!approved || gate.approvalStamp !== this.approvedStamp()) blockers.push(`${gate.id}: approval or context is stale`);
        else if (gate.taskIds.some(id => { try { const t = this.rawTask(id); return t.status !== 'integrated' || !t.verified || !t.candidate || fingerprint(t.candidate) !== gate.candidates[id] || t.integratedStamp !== this.approvedStamp(); } catch { return true; } })) blockers.push(`${gate.id}: candidate coverage is stale`);
        try { if (sha256(readFileSync(this.absolute(gate.evidenceRef))) !== gate.artifactHash) throw new Error('changed'); } catch { blockers.push(`${gate.id}: evidence artifact changed or is missing`); }
      }
      const covered = new Set(gates.flatMap(gate => gate.taskIds));
      if (gates.length && tasks.some(task => !covered.has(task.id))) blockers.push(`Owner ${dimension} evidence does not cover every task`);
      return { ready: blockers.length === 0, reasons: unique(blockers), gates: gates.map(({ id, owner, passed, taskIds, evidenceRef, artifactHash, recordedAt }) => ({ id, owner, passed, taskIds, evidenceRef, artifactHash, recordedAt })) };
    };
    const staging = external('staging'); const release = external('release', staging.ready ? [] : ['Staging readiness has not passed']);
    return { local, staging, release };
  }
  /** Owner-only service entrypoint; no worker/MCP tool may expose this authority. */
  recordExternalGate(input: ExternalGateInput): ExternalGate {
    const value = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), dimension: z.enum(['staging', 'release']), passed: z.boolean(), evidenceRef: nonempty, artifactHash: z.string().regex(/^[a-f0-9]{64}$/), owner: nonempty, taskIds: z.array(nonempty).min(1).max(10000).optional() }).strict().parse(input) as ExternalGateInput;
    return this.transaction(() => {
      this.assertApproved(); const artifact = this.absolute(value.evidenceRef); const stat = statSync(artifact); if (!stat.isFile() || stat.size > 1048576) throw new Error('External evidence must be a local text artifact no larger than 1 MiB');
      const bytes = readFileSync(artifact); if (sha256(bytes) !== value.artifactHash) throw new Error('External evidence artifact hash mismatch');
      const contents = bytes.toString('utf8'); if (bytes.includes(0) || !Buffer.from(contents, 'utf8').equals(bytes)) throw new Error('External evidence must be UTF-8 text');
      if (redact(contents) !== contents || redact(value.owner) !== value.owner) throw new Error('External evidence contains likely secrets or credentials');
      const taskIds = unique(value.taskIds ?? this.rawTasks().map(task => task.id)); if (!taskIds.length) throw new Error('External gates require verified integrated task candidates');
      const candidates: Record<string, string> = {};
      for (const id of taskIds) { const task = this.rawTask(id); if (task.status !== 'integrated' || !task.verified || !task.candidate || task.integratedStamp !== this.approvedStamp()) throw new Error(`External gate requires currently verified integrated task: ${id}`); this.verifyGate(task, true); candidates[id] = fingerprint(task.candidate); }
      const gate: ExternalGate = { ...value, evidenceRef: path.relative(this.root, artifact).split(path.sep).join('/'), taskIds, candidates, approvalStamp: this.approvedStamp(), recordedAt: Date.now() };
      const gates = this.store.get<Record<string, ExternalGate>>('externalGates') ?? {}; if (Object.keys(gates).length >= 1000 && !Object.hasOwn(gates, gate.id)) throw new Error('Maximum external gate count reached');
      gates[gate.id] = gate; this.store.set('externalGates', gates); this.store.event('external-gate.recorded', gate); return clone(gate);
    });
  }
  private records(kind?: string): Array<Record<string, unknown>> { const rows = (kind ? this.store.db.prepare('SELECT data FROM records WHERE kind=?').all(kind) : this.store.db.prepare('SELECT data FROM records ORDER BY id').all()) as Row[]; return rows.map(r => JSON.parse(r.data) as Record<string, unknown>); }
  readRecords(taskId?:string):unknown {
    if(taskId)this.rawTask(taskId);
    const rows=(table:'evidence'|'reviews')=>taskId?(this.store.db.prepare(`SELECT id,data,context_hash FROM ${table} WHERE task_id=? ORDER BY id DESC LIMIT 100`).all(taskId) as (Row&{id:number;context_hash:string})[]).map(row=>({id:row.id,...JSON.parse(row.data),contextStamp:row.context_hash})):[];
    return JSON.parse(redact(JSON.stringify({requirements:this.records('requirement').slice(-100),decisions:this.records('decision').slice(-100),blockers:this.records('blocker').filter(r=>!taskId||!r.taskId||r.taskId===taskId).slice(-100),evidence:rows('evidence'),reviews:rows('reviews')})));
  }
  recordRequirement(input: { id: string; text: string; sourceRefs?: string[] }): unknown { return this.record('requirement', input); }
  recordDecision(input: { id: string; text: string; rationale: string }): unknown { return this.record('decision', input); }
  recordBlocker(input: { id: string; taskId?: string; text: string; resolved?: boolean }): unknown { if (input.taskId) this.rawTask(input.taskId); return this.record('blocker', { ...input, resolved: input.resolved ?? false }); }
  resolveBlocker(id: string): unknown { this.assertApproved(); const entry = this.records('blocker').find(r => r.id === id); if (!entry) throw new Error('Unknown blocker'); return this.record('blocker', { ...entry, id, resolved: true }); }
  private record(kind: string, input: { id: string; [key: string]: unknown }): unknown { if (!input.id || typeof input.text !== 'string' || !input.text.trim()) throw new Error('Record ID and text required'); return this.transaction(() => { const existing = this.store.db.prepare('SELECT kind,data FROM records WHERE id=?').get(input.id) as (Row & {kind:string}) | undefined; if(existing){ if(existing.kind!==kind)throw new Error('Record kind collision'); const prior=JSON.parse(existing.data); if(kind==='blocker'&&prior.taskId!==input.taskId)throw new Error('Blocker task scope is immutable'); } const data = { ...input, kind }; if((kind==='requirement'||kind==='decision')&&(!existing||JSON.stringify(JSON.parse(existing.data))!==JSON.stringify(data))){ this.store.set('memoryGeneration',randomUUID()); for(const task of this.rawTasks()){task.status='pending';task.verified=false;task.integrated=false;delete task.verifiedStamp;delete task.integratedStamp;this.writeTask(task);this.revokeReviews(task.id);} this.store.event('memory.context-changed',{id:input.id,kind}); } this.store.db.prepare('INSERT INTO records(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,data=excluded.data').run(input.id, kind, JSON.stringify(data)); this.store.event(`${kind}.recorded`, data); return data; }); }
  exportState(includeContent = false): unknown {
    const tasks = this.rawTasks().map(t => ({ id: t.id, title: includeContent ? t.title : '[content omitted]', requirement: includeContent ? t.requirement : '[content omitted]', acceptance: includeContent ? t.acceptance : t.acceptance.map(() => '[content omitted]'), dependencies: t.dependencies, scope: t.scope, requiredChecks: t.requiredChecks, risk: t.risk, code: t.code, sourceRefs: includeContent ? t.sourceRefs : undefined, status: t.status }));
    const records = includeContent ? this.records() : this.records().map(r => ({ id: r.id, kind: r.kind, taskId: r.taskId, resolved: r.resolved }));
    return JSON.parse(redact(JSON.stringify({ format: 'agent-workbench-state', version: 1, schemaVersion: SCHEMA_VERSION, verified: false, tasks, records, evidence: [], reviews: [], note: 'Structural export only. Approval, claims, evidence and completion cannot be imported.' })));
  }
  importState(data: unknown): unknown {
    const imported = z.object({ format: z.literal('agent-workbench-state'), version: z.literal(1), tasks: z.array(z.unknown()).max(10000), records: z.array(z.unknown()).optional() }).passthrough().parse(data);
    const tasks = imported.tasks.map(raw => { const value = raw as Record<string, unknown>; const fields = ['id', 'title', 'requirement', 'acceptance', 'dependencies', 'scope', 'requiredChecks', 'risk', 'code', 'sourceRefs']; const input = Object.fromEntries(fields.filter(k => value[k] !== undefined).map(k => [k, value[k]])); return this.validateTask(input); });
    if (new Set(tasks.map(t => t.id)).size !== tasks.length) throw new Error('Duplicate imported task IDs');
    const records = (imported.records ?? []).map(raw => z.object({ id: nonempty, kind: z.enum(['requirement', 'decision', 'blocker']), text: nonempty.optional(), rationale: nonempty.optional(), taskId: nonempty.optional(), sourceRefs: z.array(nonempty).optional() }).strip().parse(raw));
    if(new Set(records.map(r=>r.id)).size!==records.length)throw new Error('Duplicate imported record IDs');
    return this.transaction(() => { const existing = this.rawTasks(); if (tasks.some(t => existing.some(e => e.id === t.id))) throw new Error('Imported task ID already exists'); this.assertDag([...existing, ...tasks]); for (const record of records) { if (this.store.db.prepare('SELECT id FROM records WHERE id=?').get(record.id)) throw new Error('Imported record ID already exists'); if (record.taskId && ![...existing, ...tasks].some(t => t.id === record.taskId)) throw new Error('Imported blocker references unknown task'); } this.invalidate('Imported state is unverified'); for (const task of tasks) this.writeTask({ ...task, status: 'pending', verified: false, integrated: false, imported: true }); for (const record of records) this.record(record.kind, { ...record, text: record.text ?? '[content omitted]', resolved: false, imported: true }); this.store.event('state.imported', { taskIds: tasks.map(t => t.id), trusted: false }); return { imported: tasks.length, records: records.length, verified: false, approvalRequired: true }; });
  }
}
