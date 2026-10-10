#!/usr/bin/env node
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {createInterface} from 'node:readline/promises';
import {WorkbenchService} from './service.js';
import {initializeProject} from './policy.js';
import {confinedPath,redact} from './security.js';
import type {WorkerIdentity,TaskInput,Profile,ReviewInput} from './types.js';
const args=process.argv.slice(2);
function flag(name:string, fallback?:string){const i=args.indexOf(`--${name}`);if(i<0)return fallback;const v=args[i+1];if(!v||v.startsWith('--'))throw new Error(`Missing --${name} value`);args.splice(i,2);return v;}
function toggle(name:string){const i=args.indexOf(`--${name}`);if(i<0)return false;args.splice(i,1);return true;}
function required(name:string){const value=flag(name);if(!value)throw new Error(`Required --${name}`);return value;}
function output(value:unknown){process.stdout.write(JSON.stringify(value,null,2)+'\n');}
function validateArguments(command:string){
 const values:Record<string,string[]>={init:['profile'],approve:['plan'],'task-create':['file'],'task-claim':['task','host','session','worker'],'task-submit':['token'],'task-rebase':['token'],heartbeat:['token'],verify:['token','check'],'review-assign':['task','host','session','worker','kinds'],'review-record':['token','file'],accept:['task'],integrate:['token'],'reconcile-integration':['token'],recover:['task'],record:['kind','file'],'resolve-blocker':['id'],'external-gate':['file'],context:['task'],checkpoint:['label'],export:['file','format'],import:['file'],install:['host'],update:['host'],uninstall:['host'],doctor:['host'],status:[],readiness:[],resume:[],mcp:[],help:[],'recover-lock':[]};
 const booleans:Record<string,string[]>={approve:['yes'],'reconcile-integration':['worker-stopped'],recover:['worker-stopped'],'recover-lock':['worker-stopped'],export:['include-content'],install:['apply'],update:['apply'],uninstall:['apply']};
 if(!Object.hasOwn(values,command))throw new Error(`Unknown command: ${command}`);const seen=new Set<string>();
 for(let i=0;i<args.length;i++){const arg=args[i]!;if(!arg.startsWith('--'))throw new Error(`Unexpected argument: ${arg}`);const name=arg.slice(2);if(seen.has(name))throw new Error(`Duplicate option: ${arg}`);seen.add(name);if(values[command]!.includes(name)){const next=args[++i];if(!next||next.startsWith('--'))throw new Error(`Missing ${arg} value`);}else if(!(booleans[command]??[]).includes(name))throw new Error(`Unknown option: ${arg}`);}
}
async function main(){
 const root=path.resolve(flag('project',process.cwd())!);const command=args.shift()??'help';validateArguments(command);
 if(command==='help'){process.stdout.write('Agent Workbench\nUsage: agent-workbench --project <root> <command> [options]\nCommands: init, approve, task-create, task-claim, task-submit, task-rebase, heartbeat, verify, review-assign, review-record, accept, integrate, reconcile-integration, recover-lock, recover, record, resolve-blocker, external-gate, context, status, readiness, checkpoint, resume, export, import, install, update, uninstall, doctor, mcp\nSee docs/CLI.md for exact options.\n');return;}
 if(command==='init'){const file=flag('profile');output(initializeProject(root,file?parse(readFileSync(confinedPath(root,file,true),'utf8')) as Profile:undefined));return;}
 if(command==='mcp'){const {serveMcp}=await import('./mcp.js');await serveMcp(root);return;}
 if(['install','update','uninstall','doctor'].includes(command)){
  const {installHost,uninstallHost,doctor}=await import('./adapters.js');const host=flag('host','codex')!;const apply=toggle('apply');
  output(command==='doctor'?doctor(root,host):command==='uninstall'?uninstallHost(root,host,apply):installHost(root,host,apply));return;
 }
 const service=new WorkbenchService(root);const core=service.core;
 const stop=(code:number)=>{void service.shutdown().finally(()=>process.exit(code));};process.once('SIGTERM',()=>stop(143));process.once('SIGINT',()=>stop(130));
 try{
  switch(command){
   case 'approve':{
    const plan=required('plan');const yes=toggle('yes');
    if(!yes){if(!process.stdin.isTTY)throw new Error('Approval requires interactive terminal or explicit --yes by project owner');const rl=createInterface({input:process.stdin,output:process.stderr});try{const answer=await rl.question(`Approve current plan and command policy for ${root}? Type APPROVE: `);if(answer!=='APPROVE')throw new Error('Approval declined');}finally{rl.close();}}
    output(core.approvePlan(plan));break;
   }
   case 'task-create':output(core.createTask(JSON.parse(readFileSync(confinedPath(root,required('file'),true),'utf8')) as TaskInput));break;
   case 'task-claim':{const worker:WorkerIdentity={host:flag('host','manual') as WorkerIdentity['host'],sessionId:required('session'),workerId:required('worker'),role:'implementer'};output(service.claim(required('task'),worker));break;}
   case 'task-submit':output(service.submit(required('token')));break;
   case 'task-rebase':output(service.rebase(required('token')));break;
   case 'heartbeat':output(core.heartbeatTask(required('token')));break;
   case 'verify':output(await service.verify(required('token'),required('check')));break;
   case 'review-assign':{const kinds=required('kinds').split(',') as ReviewInput['kind'][];output(core.assignReviewer(required('task'),{host:flag('host','manual') as WorkerIdentity['host'],sessionId:required('session'),workerId:required('worker'),role:kinds.includes('security')?'security':'reviewer'},kinds));break;}
   case 'review-record':output(service.recordReview(required('token'),JSON.parse(readFileSync(confinedPath(root,required('file'),true),'utf8')) as ReviewInput));break;
   case 'accept':output(service.accept(required('task')));break;
   case 'integrate':output(service.integrate(required('token')));break;
   case 'reconcile-integration':output(service.reconcileIntegration(required('token'),toggle('worker-stopped')));break;
   case 'external-gate':output(core.recordExternalGate(JSON.parse(readFileSync(confinedPath(root,required('file'),true),'utf8'))));break;
   case 'record':{const kind=required('kind');const data=JSON.parse(readFileSync(confinedPath(root,required('file'),true),'utf8'));if(kind==='requirement')output(core.recordRequirement(data));else if(kind==='decision')output(core.recordDecision(data));else if(kind==='blocker')output(core.recordBlocker(data));else throw new Error('Unknown record kind');break;}
   case 'resolve-blocker':output(core.resolveBlocker(required('id')));break;
   case 'recover-lock':{const {recoverIntegrationLock}=await import('./git.js');output(recoverIntegrationLock(root,toggle('worker-stopped')));break;}
   case 'recover':{const stopped=toggle('worker-stopped');if(!stopped)throw new Error('Confirm worker stopped; inspect native session before recovery');output(core.recoverTask(required('task'),stopped));break;}
   case 'status':output(core.listTasks());break;
   case 'readiness':output(service.readiness());break;
   case 'checkpoint':output(core.checkpoint(flag('label','manual')!));break;
   case 'resume':output({...core.resume() as object,readiness:service.readiness()});break;
   case 'context':{const {buildContext}=await import('./context.js');output(buildContext(core,flag('task')));break;}
   case 'export':{const content=toggle('include-content');const dest=required('file');const format=flag('format','json');if(!['json','markdown'].includes(format!))throw new Error('Export format must be json or markdown');const {exportMarkdown}=await import('./export.js');writeFileSync(confinedPath(root,dest),format==='markdown'?exportMarkdown(core,content):JSON.stringify(core.exportState(content),null,2),{flag:'wx',mode:0o600});output({exported:dest,requiresInspection:true});break;}
   case 'import':output(core.importState(JSON.parse(readFileSync(confinedPath(root,required('file'),true),'utf8'))));break;
   default:throw new Error(`Unknown command: ${command}`);
  }
 }finally{service.close();}
}
main().catch(error=>{process.stderr.write(redact(error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;});
