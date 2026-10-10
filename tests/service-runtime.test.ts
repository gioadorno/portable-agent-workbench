import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { WorkbenchService } from '../src/service.js';
import { defaultProfile, initializeProject, sha256 } from '../src/policy.js';
import { runCommand } from '../src/runner.js';
import * as Git from '../src/git.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

function git(root: string, ...args: string[]): string { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function fixture(t: test.TestContext, duration = 2800, leaseMs = 2000) {
  const root = mkdtempSync(path.join(tmpdir(), 'aw-service-runtime-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, '.agentkit/artifacts/child-completed.txt');
  const profile = defaultProfile(); profile.policy.leaseMs = leaseMs; profile.commands.unit = { argv: [process.execPath, '-e', `require('node:fs').writeFileSync(process.argv[1]+'.started', 'started');setTimeout(() => { require('node:fs').writeFileSync(process.argv[1], 'completed'); console.log('validation passed'); }, ${duration})`, marker], cwd: '.', timeoutMs: 10000 };
  initializeProject(root, profile); mkdirSync(path.join(root, '.agentkit/artifacts'), { recursive: true }); writeFileSync(path.join(root, 'PLAN.md'), 'Fix source'); writeFileSync(path.join(root, 'source.cjs'), 'module.exports=1;\n');
  git(root, 'init', '-b', 'main'); git(root,'config','core.autocrlf','false'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
  const service = new WorkbenchService(root); t.after(() => service.close()); service.core.approvePlan('PLAN.md');
  service.core.createTask({ id: 'T1', title: 'Fix value', requirement: 'Export correct output', acceptance: ['Output is 2'], dependencies: [], scope: ['source.cjs'], requiredChecks: ['unit'] });
  const claim = service.claim('T1', { host: 'codex', sessionId: 'builder', workerId: 'worker', role: 'implementer' });
  writeFileSync(path.join(claim.worktree!, 'source.cjs'), 'module.exports=2;\n'); git(claim.worktree!, 'add', 'source.cjs'); git(claim.worktree!, 'commit', '-m', 'fix'); service.submit(claim.token);
  return { root, service, claim, marker };
}
test('verification renews a short lease while a longer approved command runs', async t => {
  const { service, claim, marker } = fixture(t);
  await service.verify(claim.token, 'unit');
  assert.equal(existsSync(marker), true); assert.ok(service.core.getTask('T1').claim!.expiresAt > claim.expiresAt);
  assert.doesNotThrow(() => service.core.heartbeatTask(claim.token));
});
test('policy revocation during validation aborts the child before its delayed effect', async t => {
  const { root, service, claim, marker } = fixture(t, 2600, 2000);
  const timer = setTimeout(() => writeFileSync(path.join(root, 'PLAN.md'), 'Untrusted edit while command runs'), 60);
  const started = Date.now();
  try { await assert.rejects(service.verify(claim.token, 'unit'), /approval|changed|revoked/i); }
  finally { clearTimeout(timer); }
  assert.ok(Date.now() - started < 2400, 'revocation should terminate the running command promptly'); assert.equal(existsSync(marker), false);
  await new Promise(resolve => setTimeout(resolve, 2700)); assert.equal(existsSync(marker), false); assert.throws(() => service.core.assertApproved(), /approval/i);
});
test('runner AbortSignal terminates the subprocess and records failed evidence', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'aw-abort-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController(); const marker = path.join(root, 'completed'); const timer = setTimeout(() => controller.abort(new Error('Policy revoked')), 40);
  try {
    const evidence = await runCommand(root, 'cancel', { argv: [process.execPath, '-e', "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), 400)", marker], cwd: '.', timeoutMs: 2000 }, { treeHash: 'tree', diffHash: 'diff' }, 65536, { signal: controller.signal });
    assert.equal(evidence.passed, false); assert.equal(existsSync(marker), false); assert.match(readFileSync(path.join(root, evidence.artifact), 'utf8'), /aborted|revoked/i);
  } finally { clearTimeout(timer); }
});
test('integration reconciliation rejects dirty project files without accepting state', async t => {
  const { root, service, claim } = fixture(t, 5, 10000); await service.verify(claim.token, 'unit'); const candidate = service.core.getTask('T1').candidate!;
  const grant = service.core.assignReviewer('T1', { host: 'opencode', sessionId: 'review', workerId: 'reviewer', role: 'reviewer' }, ['spec', 'code']);
  for (const kind of ['spec', 'code'] as const) service.recordReview(grant.token, { kind, verdict: 'pass', treeHash: candidate.treeHash, diffHash: candidate.diffHash, criteria: ['Output is 2'], findings: [] }); service.accept('T1');
  const receipt = path.join(root, `.agentkit/artifacts/integration-${sha256(claim.token)}.json`); writeFileSync(receipt, JSON.stringify({ version: 1, taskId: 'T1', candidate, status: 'prepared', at: Date.now() })); git(root, 'merge', '--ff-only', candidate.headCommit); writeFileSync(path.join(root, 'user-draft.txt'), 'Preserve user work');
  assert.throws(() => service.reconcileIntegration(claim.token, true), /dirty|clean/i); assert.equal(service.core.getTask('T1').status, 'verified'); assert.equal(readFileSync(path.join(root, 'user-draft.txt'), 'utf8'), 'Preserve user work');
});
test('integration lock recovery requires stopped worker and rejects a live owner PID', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'aw-lock-recover-')); t.after(() => rmSync(root, { recursive: true, force: true })); initializeProject(root);
  const lock = path.join(root, '.agentkit/integration.lock'); writeFileSync(lock, `${process.pid}\n`);
  assert.throws(() => Git.recoverIntegrationLock(root, false), /stopped/i); assert.throws(() => Git.recoverIntegrationLock(root, true), /live|running/i); assert.equal(existsSync(lock), true);
  const deadPid = execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim(); writeFileSync(lock, `${deadPid}\n`);
  assert.equal(Git.recoverIntegrationLock(root, true).recovered, true); assert.equal(existsSync(lock), false); assert.doesNotThrow(() => Git.integrationLock(root, () => undefined));
});
test('service readiness requires clean root at an integrated reviewed Git frontier', async t => {
  const { root, service, claim } = fixture(t, 5, 10000); await service.verify(claim.token, 'unit'); const candidate = service.core.getTask('T1').candidate!;
  const grant = service.core.assignReviewer('T1', { host: 'manual', sessionId: 'independent', workerId: 'reviewer', role: 'reviewer' }, ['spec', 'code']); for (const kind of ['spec', 'code'] as const) service.recordReview(grant.token, { kind, verdict: 'pass', treeHash: candidate.treeHash, diffHash: candidate.diffHash, criteria: ['Output is 2'], findings: [] }); service.accept('T1'); service.integrate(claim.token);
  assert.equal((service.readiness() as { local: { ready: boolean } }).local.ready, true);
  writeFileSync(path.join(root, 'user-draft.txt'), 'draft'); assert.equal((service.readiness() as { local: { ready: boolean } }).local.ready, false); rmSync(path.join(root, 'user-draft.txt'));
  writeFileSync(path.join(root, 'unreviewed.txt'), 'unreviewed'); git(root, 'add', 'unreviewed.txt'); git(root, 'commit', '-m', 'outside integrated candidate'); assert.equal((service.readiness() as { local: { ready: boolean } }).local.ready, false); assert.equal((service.readiness() as { release: { ready: boolean } }).release.ready, false);
});

test('closing a service aborts its active validation process group', async t=>{
 const {service,claim,marker}=fixture(t,450,10000);
 const validation=service.verify(claim.token,'unit');
 const timer=setTimeout(()=>service.close(),70);
 try{await assert.rejects(validation,/closed|abort|stopped/i);}finally{clearTimeout(timer);}
 await new Promise(resolve=>setTimeout(resolve,500));assert.equal(existsSync(marker),false);
});

test('CLI SIGTERM awaits validation termination before process exit',{skip:process.platform==='win32'},async t=>{
 const {root,claim,marker}=fixture(t,1500,10000);const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const child=spawn(process.execPath,['--import','tsx',path.join(packageRoot,'src/cli.ts'),'--project',root,'verify','--token',claim.token,'--check','unit'],{cwd:packageRoot,stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume();const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const limit=Date.now()+10000;while(!existsSync(marker+'.started')&&Date.now()<limit&&child.exitCode===null)await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(existsSync(marker+'.started'),true,stderr);child.kill('SIGTERM');assert.equal(await exited,143);
 await new Promise(resolve=>setTimeout(resolve,1700));assert.equal(existsSync(marker),false,'validation child must not outlive graceful CLI shutdown');
});

test('MCP client disconnect aborts active validation rather than leaving an orphan',async t=>{
 const {root,claim,marker}=fixture(t,1500,10000);const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.join(packageRoot,'src/cli.ts'),'--project',root,'mcp'],cwd:packageRoot,stderr:'pipe'});const client=new Client({name:'disconnect-test',version:'1'});t.after(async()=>client.close());await client.connect(transport);
 const validating=client.callTool({name:'verify_task',arguments:{token:claim.token,checkId:'unit'}}).catch(error=>error);const limit=Date.now()+10000;
 while(!existsSync(marker+'.started')&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(existsSync(marker+'.started'),true);
 await client.close();await validating;await new Promise(resolve=>setTimeout(resolve,1700));assert.equal(existsSync(marker),false,'disconnected host must not retain a running validator');
});
