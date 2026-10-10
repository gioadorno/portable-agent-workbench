import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {confinedPath,redact} from './security.js';
import type {EvidenceInput} from './types.js';
export interface ValidationCommand {argv:string[];cwd:string;timeoutMs:number}
export interface RunCommandOptions { signal?: AbortSignal }
export async function runCommand(root:string,checkId:string,command:ValidationCommand,fingerprint:{treeHash:string;diffHash:string},maxOutputBytes=65536,options:RunCommandOptions={}):Promise<EvidenceInput>{
 if(!command.argv.length || command.argv.some(x=>typeof x!=='string'||x.includes('\0')))throw new Error('Invalid command argv');
 if(!Number.isSafeInteger(command.timeoutMs)||command.timeoutMs<1||command.timeoutMs>3600000)throw new Error('Invalid command timeout');
 const cwd=confinedPath(root,command.cwd,true);
 const dir=confinedPath(root,'.agentkit/artifacts');mkdirSync(dir,{recursive:true,mode:0o700});
 const artifact=path.posix.join('.agentkit/artifacts',`${randomUUID()}.json`);const startedAt=Date.now();
 const env:NodeJS.ProcessEnv={};for(const key of ['PATH','LANG','LC_ALL','TMPDIR','TEMP','TMP','SystemRoot','SYSTEMROOT','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
 const result=await new Promise<{exitCode:number|null;output:string;failure:string|undefined}>(resolve=>{
  if(options.signal?.aborted){resolve({exitCode:null,output:'',failure:`Validation aborted: ${String(options.signal.reason ?? 'cancelled')}`});return;}
  const child=spawn(command.argv[0]!,command.argv.slice(1),{cwd,env,shell:false,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
  const chunks:Buffer[]=[];let size=0;let failure:string|undefined;let settled=false;
  const kill=()=>{try{if(process.platform==='win32'&&child.pid)execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});else if(child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{child.kill('SIGKILL');}};
  const timer=setTimeout(()=>{failure ??= 'Validation timed out';kill();},command.timeoutMs);
  const abort=()=>{failure ??= `Validation aborted: ${String(options.signal?.reason ?? 'cancelled')}`;kill();};
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)abort();
  const collect=(chunk:Buffer)=>{if(size>=maxOutputBytes)return;const take=chunk.subarray(0,maxOutputBytes-size);chunks.push(take);size+=take.length;if(chunk.length>take.length||size>=maxOutputBytes){failure='Validation output limit exceeded';kill();}};
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  const finish=(exitCode:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);resolve({exitCode,output:Buffer.concat(chunks).toString('utf8'),failure});};
  child.on('error',error=>{failure=`Validation could not start: ${error.message}`;finish(null);});child.on('close',finish);
 });
 const finishedAt=Date.now();const passed=result.exitCode===0&&!result.failure;
 const contents=JSON.stringify({checkId,passed,exitCode:result.exitCode,startedAt,finishedAt,output:redact(result.output),failure:result.failure ? redact(result.failure) : undefined},null,2);
 writeFileSync(confinedPath(root,artifact),contents,{mode:0o600,flag:'wx'});
 return {checkId,exitCode:result.exitCode,passed,treeHash:fingerprint.treeHash,diffHash:fingerprint.diffHash,artifact,artifactHash:createHash('sha256').update(contents).digest('hex'),startedAt,finishedAt};
}
