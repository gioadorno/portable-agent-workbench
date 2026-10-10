import {execFileSync} from 'node:child_process';
import {mkdirSync,realpathSync,existsSync,writeFileSync,unlinkSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {confinedPath} from './security.js';
import type {CandidateSnapshot} from './types.js';
function git(cwd:string,...args:string[]):string {return execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}}).trimEnd();}
export function gitHead(root:string){return git(root,'rev-parse','HEAD').trim();}
export function gitClean(root:string){return git(root,'status','--porcelain','--untracked-files=all')==='';}
function sha(value:string){return createHash('sha256').update(value).digest('hex');}
function validateCommit(commit:string){if(!/^[a-f0-9]{40,64}$/.test(commit))throw new Error('Expected exact Git commit hash');}
export function createWorktree(root:string,taskId:string,token:string):string {
 const suffix=sha(`${taskId}:${token}`).slice(0,20);const dir=confinedPath(root,'.agentkit/worktrees');mkdirSync(dir,{recursive:true});
 const target=confinedPath(root,`.agentkit/worktrees/${suffix}`);if(existsSync(target))throw new Error('Worktree already exists');
 git(root,'worktree','add','-b',`agentkit/${suffix}`,target,'HEAD');return target;
}
export function captureCandidate(root:string,worktree:string,baseCommit:string):CandidateSnapshot {
 validateCommit(baseCommit);const resolved=confinedPath(root,path.relative(root,worktree).split(path.sep).join('/'),true);
 const common=realpathSync(path.resolve(root,git(root,'rev-parse','--git-common-dir').trim()));
 const candidateCommon=realpathSync(path.resolve(resolved,git(resolved,'rev-parse','--git-common-dir').trim()));
 if(common!==candidateCommon)throw new Error('Candidate belongs to another repository');
 if(!gitClean(resolved))throw new Error('Candidate worktree must be clean and committed');
 git(resolved,'merge-base','--is-ancestor',baseCommit,'HEAD');
 const headCommit=gitHead(resolved);const treeHash=git(resolved,'rev-parse','HEAD^{tree}').trim();
 const files=git(resolved,'diff','--name-only','-z','--no-renames',baseCommit,headCommit).split('\0').filter(Boolean);
 for(const f of files){if(f.startsWith('/')||f.split('/').includes('..')||/[\x00-\x1f]/.test(f))throw new Error('Unsafe changed path');}
 const diff=git(resolved,'diff','--binary','--no-ext-diff','--no-textconv',baseCommit,headCommit);
 return {baseCommit,headCommit,treeHash,diffHash:sha(diff),files,worktree:resolved};
}
export function integrateCandidate(root:string,snapshot:CandidateSnapshot):void {
 validateCommit(snapshot.headCommit);validateCommit(snapshot.baseCommit);
 if(!gitClean(root))throw new Error('Integration requires a clean checkout; preserve dirty user files');
 if(gitHead(root)!==snapshot.baseCommit)throw new Error('Stale integration base; rebase candidate and obtain fresh review');
 const actual=captureCandidate(root,snapshot.worktree,snapshot.baseCommit);
 if(actual.headCommit!==snapshot.headCommit||actual.treeHash!==snapshot.treeHash||actual.diffHash!==snapshot.diffHash)throw new Error('Candidate changed after review');
 git(root,'merge','--ff-only',snapshot.headCommit);
}
export function integrationLock<T>(root:string,action:()=>T):T {
 const lock=confinedPath(root,'.agentkit/integration.lock');writeFileSync(lock,`${process.pid}\n`,{flag:'wx',mode:0o600});
 try{return action();}finally{unlinkSync(lock);}
}

export function rebaseCandidate(root:string,worktree:string):string {
 const candidate=confinedPath(root,path.relative(root,worktree).split(path.sep).join('/'),true);
 if(!gitClean(candidate))throw new Error('Commit candidate changes before rebase');
 const base=gitHead(root);validateCommit(base);
 git(candidate,'rebase','--no-autostash',base);return base;
}

export function recoverIntegrationLock(root:string,workerStopped:boolean):{recovered:boolean}{
 if(!workerStopped)throw new Error('Confirm native worker stopped before lock recovery');
 const lock=confinedPath(root,'.agentkit/integration.lock');if(!existsSync(lock))return {recovered:false};
 const contents=readFileSync(lock,'utf8');if(!/^[1-9][0-9]*\n?$/.test(contents))throw new Error('Malformed integration lock requires manual inspection');
 const pid=Number(contents.trim());if(!Number.isSafeInteger(pid)||pid>2147483647)throw new Error('Invalid lock PID');
 try{process.kill(pid,0);throw new Error('Integration lock owner is still live');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
 if(readFileSync(lock,'utf8')!==contents)throw new Error('Integration lock ownership changed during recovery');
 unlinkSync(lock);return {recovered:true};
}
