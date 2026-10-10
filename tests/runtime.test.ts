import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {runCommand} from '../src/runner.js';
import {captureCandidate, createWorktree, integrateCandidate, rebaseCandidate, gitHead} from '../src/git.js';
function temp(t:test.TestContext){const p=mkdtempSync(path.join(tmpdir(),'aw-runtime-')); t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}
const fingerprint={treeHash:'tree',diffHash:'diff'};
test('validation argv never expands shell substitutions or injected separators',async t=>{
 const root=temp(t);const marker=path.join(root,'injected');
 const evidence=await runCommand(root,'argv',{argv:[process.execPath,'-e','console.log(process.argv[1])',`$(touch ${marker}); touch ${marker}`],cwd:'.',timeoutMs:2000},fingerprint);
 assert.equal(evidence.passed,true);assert.equal(existsSync(marker),false);
 assert.match(readFileSync(path.join(root,evidence.artifact),'utf8'),/\$\(touch/);
});
test('validation strips credentials from child environment and stored output',async t=>{
 const root=temp(t);process.env.WORKBENCH_TEST_SECRET='credential-that-must-not-propagate';t.after(()=>delete process.env.WORKBENCH_TEST_SECRET);
 const evidence=await runCommand(root,'env',{argv:[process.execPath,'-e',"console.log(process.env.WORKBENCH_TEST_SECRET || 'absent'); console.log('Authorization: Bearer topsecretvalue123')"],cwd:'.',timeoutMs:2000},fingerprint);
 const output=readFileSync(path.join(root,evidence.artifact),'utf8');assert.match(output,/absent/);assert.doesNotMatch(output,/topsecretvalue123/);
});
test('validation times out hung child and persists failure evidence',async t=>{
 const root=temp(t);const evidence=await runCommand(root,'timeout',{argv:[process.execPath,'-e','setInterval(()=>{},1000)'],cwd:'.',timeoutMs:60},fingerprint);
 assert.equal(evidence.passed,false);assert.match(readFileSync(path.join(root,evidence.artifact),'utf8'),/timed out/i);
});
test('validation fails excessive output rather than accepting truncated success',async t=>{
 const root=temp(t);const evidence=await runCommand(root,'noise',{argv:[process.execPath,'-e',"console.log('x'.repeat(200000))"],cwd:'.',timeoutMs:2000},fingerprint,1024);
 assert.equal(evidence.passed,false);assert.ok(readFileSync(path.join(root,evidence.artifact)).length<5000);
});
test('validation rejects cwd traversal and symlink escape',async t=>{
 const root=temp(t);await assert.rejects(runCommand(root,'escape',{argv:[process.execPath,'-e',''],cwd:'../',timeoutMs:2000},fingerprint));
 const outside=temp(t);symlinkSync(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(runCommand(root,'escape',{argv:[process.execPath,'-e',''],cwd:'link',timeoutMs:2000},fingerprint));
});
function git(root:string,...args:string[]){return execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();}
function repo(t:test.TestContext){const root=temp(t);git(root,'init','-b','main');git(root,'config','core.autocrlf','false');git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');writeFileSync(path.join(root,'.gitignore'),'.agentkit/\n');writeFileSync(path.join(root,'a.txt'),'base\n');git(root,'add','.');git(root,'commit','-m','base');return root;}
test('isolated Git candidate includes actual files and rejects uncommitted work',t=>{
 const root=repo(t);const base=git(root,'rev-parse','HEAD');const wt=createWorktree(root,'sample','abcdef0123');writeFileSync(path.join(wt,'a.txt'),'fixed\n');assert.throws(()=>captureCandidate(root,wt,base),/commit|clean|dirty/i);
 git(wt,'add','a.txt');git(wt,'commit','-m','fix');const snap=captureCandidate(root,wt,base);assert.deepEqual(snap.files,['a.txt']);assert.notEqual(snap.treeHash,git(root,'rev-parse','HEAD^{tree}'));integrateCandidate(root,snap);assert.equal(readFileSync(path.join(root,'a.txt'),'utf8'),'fixed\n');
});
test('Git integration protects dirty user files and stale base',t=>{
 const root=repo(t);const base=git(root,'rev-parse','HEAD');const wt=createWorktree(root,'sample','abcdef0123');writeFileSync(path.join(wt,'a.txt'),'fixed\n');git(wt,'add','a.txt');git(wt,'commit','-m','fix');const snap=captureCandidate(root,wt,base);
 writeFileSync(path.join(root,'private.txt'),'user work');assert.throws(()=>integrateCandidate(root,snap),/dirty|clean/i);assert.equal(readFileSync(path.join(root,'private.txt'),'utf8'),'user work');rmSync(path.join(root,'private.txt'));writeFileSync(path.join(root,'b.txt'),'other task');git(root,'add','b.txt');git(root,'commit','-m','other');assert.throws(()=>integrateCandidate(root,snap),/base|stale/i);
});

test('candidate repository identity rejects a nested unrelated Git repository',t=>{
 const root=repo(t);const base=git(root,'rev-parse','HEAD');const foreign=path.join(root,'.agentkit','worktrees','foreign');mkdirSync(foreign,{recursive:true});git(foreign,'init','-b','main');git(foreign,'config','user.name','Fixture');git(foreign,'config','user.email','fixture@example.invalid');writeFileSync(path.join(foreign,'a.txt'),'unrelated');git(foreign,'add','.');git(foreign,'commit','-m','unrelated');assert.throws(()=>captureCandidate(root,foreign,base),/another repository|identity/i);
});

test('primary linked worktrees and nested project folders cannot mutate external Git metadata',t=>{
 const root=repo(t);const linked=temp(t);git(root,'worktree','add',linked,'-b','external-fixture');const before=git(root,'worktree','list','--porcelain');
 assert.throws(()=>createWorktree(linked,'escape','token'),/metadata|registered root|outside/i);assert.equal(git(root,'worktree','list','--porcelain'),before);
 const nested=path.join(root,'nested');mkdirSync(nested);assert.throws(()=>createWorktree(nested,'escape','token'),/registered root|top.level/i);assert.equal(git(root,'worktree','list','--porcelain'),before);
});
test('foreign candidate rebase is rejected before modifying its repository',t=>{
 const root=repo(t);const foreign=path.join(root,'.agentkit','foreign');mkdirSync(foreign,{recursive:true});git(foreign,'init','-b','main');git(foreign,'config','user.name','Fixture');git(foreign,'config','user.email','fixture@example.invalid');writeFileSync(path.join(foreign,'b.txt'),'foreign');git(foreign,'add','.');git(foreign,'commit','-m','foreign');const before=git(foreign,'rev-parse','HEAD');
 assert.throws(()=>rebaseCandidate(root,foreign),/another repository|identity/i);assert.equal(git(foreign,'rev-parse','HEAD'),before);
});
test('inherited Git routing variables cannot redirect toolkit repository operations',t=>{
 const root=repo(t),foreign=repo(t);writeFileSync(path.join(foreign,'b.txt'),'foreign');git(foreign,'add','.');git(foreign,'commit','-m','foreign');const expected=git(root,'rev-parse','HEAD');const old=process.env.GIT_DIR;process.env.GIT_DIR=path.join(foreign,'.git');try{assert.equal(gitHead(root),expected);}finally{if(old===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=old;}
});
