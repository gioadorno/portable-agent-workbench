import {Workbench} from './core.js';
import type {WorkerIdentity,ReviewInput} from './types.js';
import {captureCandidate,createWorktree,gitClean,gitHead,integrateCandidate,integrationLock,rebaseCandidate} from './git.js';
import {execFileSync} from 'node:child_process';
import {runCommand} from './runner.js';
import {confinedPath} from './security.js';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {sha256} from './policy.js';
export class WorkbenchService {
 readonly core:Workbench;
 private readonly validations=new Map<AbortController,Promise<void>>();
 constructor(readonly root:string){this.core=new Workbench(root);}
 close(){for(const controller of this.validations.keys())controller.abort(new Error('Validation aborted: service stopped'));this.core.close();}
 async shutdown(){for(const controller of this.validations.keys())controller.abort(new Error('Validation aborted: session stopped'));await Promise.allSettled([...this.validations.values()]);this.core.close();}
 claim(id:string,worker:WorkerIdentity){
  this.core.assertApproved();gitHead(this.root);
  const claim=this.core.claimTask(id,worker);
  try{const worktree=createWorktree(this.root,id,claim.token);return this.core.attachWorktree(claim.token,worktree);}catch(error){throw new Error(`Claim ${id} retained for explicit recovery after isolation failure: ${String(error)}`);}
 }
 rebase(token:string){
  this.core.assertApproved();this.core.heartbeatTask(token);
  const task=this.core.listTasks().find(x=>x.claim?.token===token);if(!task?.claim?.worktree)throw new Error('No owned candidate worktree');
  const base=rebaseCandidate(this.root,task.claim.worktree);return this.core.rebaseClaim(token,base);
 }
 submit(token:string){
  this.core.assertApproved();const task=this.core.listTasks().find(x=>x.claim?.token===token);if(!task?.claim?.worktree)throw new Error('No owned candidate worktree');
  const baseCommit=(task.claim as typeof task.claim & {baseCommit?:string}).baseCommit ?? gitHead(this.root);
  return this.core.submitTask(token,captureCandidate(this.root,task.claim.worktree,baseCommit));
 }
 async verify(token:string,checkId:string){
  const profile=this.core.assertApproved();const command=profile.commands[checkId];if(!command)throw new Error('Check is not in approved command allowlist');
  const task=this.core.listTasks().find(x=>x.claim?.token===token);if(!task?.candidate)throw new Error('Submit committed candidate before verification');
  this.core.heartbeatTask(token);const candidate=task.candidate;
  const commandRoot=candidate.worktree;
  const bounded=command;
  const controller=new AbortController();let heartbeatFailure:Error|undefined;let finished!:()=>void;this.validations.set(controller,new Promise<void>(resolve=>{finished=resolve;}));
  const heartbeat=setInterval(()=>{try{this.core.heartbeatTask(token);}catch(error){heartbeatFailure=error instanceof Error?error:new Error(String(error));controller.abort(heartbeatFailure);clearInterval(heartbeat);}},Math.max(1,Math.min(1000,Math.floor(profile.policy.leaseMs/3))));
  try{
  const evidence=await runCommand(commandRoot,checkId,bounded,candidate,65536,{signal:controller.signal});
  // Candidate-local artifacts are copied into the canonical project evidence store.
  if(commandRoot!==this.root){
   const contents=readFileSync(confinedPath(commandRoot,evidence.artifact));
   const target=confinedPath(this.root,evidence.artifact);mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
   writeFileSync(target,contents,{flag:'wx',mode:0o600});
  }
  controller.signal.throwIfAborted();
  if(heartbeatFailure)throw heartbeatFailure;
  this.core.heartbeatTask(token);
  const current=captureCandidate(this.root,candidate.worktree,candidate.baseCommit);
  if(current.treeHash!==candidate.treeHash||current.diffHash!==candidate.diffHash)throw new Error('Validation changed candidate; commit and resubmit with fresh review');
  return this.core.addEvidence(token,evidence);
  }finally{clearInterval(heartbeat);this.validations.delete(controller);finished();}
 }
 recordReview(token:string,input:ReviewInput){
  return this.core.recordReview(token,input);
 }
 accept(id:string){
  const task=this.core.getTask(id);if(!task.candidate)throw new Error('No candidate');
  const actual=captureCandidate(this.root,task.candidate.worktree,task.candidate.baseCommit);
  if(actual.treeHash!==task.candidate.treeHash||actual.diffHash!==task.candidate.diffHash)throw new Error('Stale candidate review');
  return this.core.markVerified(id);
 }
 private receiptPath(token:string){return confinedPath(this.root,`.agentkit/artifacts/integration-${sha256(token)}.json`);}
 integrate(token:string){
  return integrationLock(this.root,()=>{
   this.core.assertApproved();
   const task=this.core.listTasks().find(x=>x.claim?.token===token);if(!task?.candidate)throw new Error('No owned candidate');
   const receipt=this.receiptPath(token);mkdirSync(path.dirname(receipt),{recursive:true,mode:0o700});
   this.core.checkpoint(`integration-prepared:${task.id}:${task.candidate.headCommit}`);
   writeFileSync(receipt,JSON.stringify({version:1,taskId:task.id,candidate:task.candidate,status:'prepared',at:Date.now()}),{mode:0o600});
   const result=this.core.withIntegration(token,()=>{integrateCandidate(this.root,task.candidate!);return task.candidate!;});
   writeFileSync(receipt,JSON.stringify({version:1,taskId:task.id,candidate:task.candidate,status:'complete',at:Date.now()}),{mode:0o600});
   return result;
  });
 }
 reconcileIntegration(token:string,workerStopped:boolean){
  if(!workerStopped)throw new Error('Stop native worker and confirm before integration reconciliation');
  return integrationLock(this.root,()=>{
   this.core.assertApproved();
   if(!gitClean(this.root))throw new Error('Integration reconciliation requires a clean project checkout; preserve dirty user files');
   const task=this.core.listTasks().find(x=>x.claim?.token===token);if(!task?.candidate)throw new Error('No owned integration candidate');
   const receipt=JSON.parse(readFileSync(this.receiptPath(token),'utf8'));
   if(receipt.version!==1||receipt.status!=='prepared'||receipt.taskId!==task.id||JSON.stringify(receipt.candidate)!==JSON.stringify(task.candidate))throw new Error('No matching prepared integration receipt');
   if(gitHead(this.root)!==task.candidate.headCommit)throw new Error('Git HEAD does not prove candidate integration');
   const actual=captureCandidate(this.root,task.candidate.worktree,task.candidate.baseCommit);
   if(actual.treeHash!==task.candidate.treeHash||actual.diffHash!==task.candidate.diffHash)throw new Error('Recovered candidate changed');
   const result=this.core.reconcileIntegratedTask(token,actual);
   writeFileSync(this.receiptPath(token),JSON.stringify({...receipt,status:'complete',reconciledAt:Date.now()}),{mode:0o600});
   return result;
  });
 }
 readiness(){
  const state=this.core.readiness() as {local:{ready:boolean;reasons:string[]};staging:{ready:boolean;reasons:string[]};release:{ready:boolean;reasons:string[]}};
  const rootReasons:string[]=[];
  try{
   if(!gitClean(this.root))rootReasons.push('Project checkout is dirty; current user changes have not been verified');
   const head=gitHead(this.root);const integrated=this.core.listTasks().filter(task=>task.status==='integrated'&&task.verified&&task.candidate);
   if(!integrated.length||!integrated.some(task=>task.candidate!.headCommit===head))rootReasons.push('Project Git HEAD is not a reviewed integrated candidate frontier');
   for(const task of integrated){try{execFileSync('git',['merge-base','--is-ancestor',task.candidate!.headCommit,head],{cwd:this.root,stdio:'ignore',timeout:5000});}catch{rootReasons.push(`${task.id}: integrated candidate is not an ancestor of current project HEAD`);}}
  }catch{rootReasons.push('Project Git state could not be verified');}
  if(rootReasons.length)for(const dimension of [state.local,state.staging,state.release]){dimension.ready=false;dimension.reasons=[...new Set([...dimension.reasons,...rootReasons])];}
  return state;
 }
}
