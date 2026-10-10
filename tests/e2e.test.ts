import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {WorkbenchService} from '../src/service.js';
import {initializeProject,defaultProfile} from '../src/policy.js';
import {integrationLock} from '../src/git.js';
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'aw-e2e-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function git(root:string,...args:string[]){return execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();}
test('CLI-to-MCP checkpoint preserves cross-host state and exposes no policy approval endpoint',async t=>{
 const root=fixture(t);initializeProject(root);mkdirSync(path.join(root,'docs'));writeFileSync(path.join(root,'docs','plan.md'),'Approved fixture plan');
 execFileSync(process.execPath,['--import','tsx',path.join(packageRoot,'src','cli.ts'),'--project',root,'approve','--plan','docs/plan.md','--yes'],{cwd:packageRoot});
 execFileSync(process.execPath,['--import','tsx',path.join(packageRoot,'src','cli.ts'),'--project',root,'checkpoint','--label','codex-handoff'],{cwd:packageRoot});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.join(packageRoot,'src','cli.ts'),'--project',root,'mcp'],cwd:packageRoot,stderr:'pipe'});const client=new Client({name:'opencode-fixture',version:'1'});
 t.after(async()=>client.close());await client.connect(transport);
 const tools=await client.listTools();assert.ok(tools.tools.some(x=>x.name==='resume'));assert.ok(!tools.tools.some(x=>/approve|assign.*review/.test(x.name)));
 const resumed=await client.callTool({name:'resume',arguments:{}});assert.match(JSON.stringify(resumed),/codex-handoff/);
 const invalid=await client.callTool({name:'verify_task',arguments:{token:'forged',checkId:'unapproved'}});assert.equal(invalid.isError,true);
});
test('real candidate completes checks, independent reviews, and fenced integration',async t=>{
 const root=fixture(t);const profile=defaultProfile();profile.commands.unit={argv:[process.execPath,'--test','source.test.cjs'],cwd:'.',timeoutMs:5000};initializeProject(root,profile);mkdirSync(path.join(root,'docs'));writeFileSync(path.join(root,'docs','plan.md'),'Fix fixture value');writeFileSync(path.join(root,'source.cjs'),'module.exports=1;\n');writeFileSync(path.join(root,'source.test.cjs'),"const assert=require('node:assert/strict'); assert.equal(require('./source.cjs'),2);\n");git(root,'init','-b','main');git(root,'config','core.autocrlf','false');git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');git(root,'add','.');git(root,'commit','-m','base');
 const service=new WorkbenchService(root);t.after(()=>service.close());const core=service.core;core.approvePlan('docs/plan.md');
 const acceptance=['Actual export equals 2'];core.createTask({id:'FIX-1',title:'Fix value',requirement:'Correct output',acceptance,dependencies:[],scope:['source.cjs'],requiredChecks:['unit']});
 const claim=service.claim('FIX-1',{host:'codex',sessionId:'implementation',workerId:'builder',role:'implementer'});writeFileSync(path.join(claim.worktree!,'source.cjs'),'module.exports=2;\n');git(claim.worktree!,'add','source.cjs');git(claim.worktree!,'commit','-m','fix');
 service.submit(claim.token);await service.verify(claim.token,'unit');const candidate=core.getTask('FIX-1').candidate!;
 assert.throws(()=>service.accept('FIX-1'),/review/i);
 assert.throws(()=>core.assignReviewer('FIX-1',{host:'opencode',sessionId:'implementation',workerId:'other',role:'reviewer'},['spec']),/independent|self/i);
 const grant=core.assignReviewer('FIX-1',{host:'opencode',sessionId:'independent',workerId:'reviewer',role:'reviewer'},['spec','code']);
 assert.throws(()=>service.recordReview(grant.token,{kind:'spec',verdict:'pass',treeHash:candidate.treeHash,diffHash:candidate.diffHash,criteria:[],findings:[]}),/acceptance/i);
 for(const kind of ['spec','code'] as const)service.recordReview(grant.token,{kind,verdict:'pass',treeHash:candidate.treeHash,diffHash:candidate.diffHash,criteria:acceptance,findings:[]});
 service.accept('FIX-1');const integrated=service.integrate(claim.token);assert.ok(integrated);assert.equal(core.getTask('FIX-1').status,'integrated');assert.equal(readFileSync(path.join(root,'source.cjs'),'utf8'),'module.exports=2;\n');assert.throws(()=>service.integrate(claim.token),/revoked|candidate|claim/i);
});
test('integration lock rejects concurrent merge entry rather than overwriting ownership',t=>{
 const root=fixture(t);initializeProject(root);integrationLock(root,()=>{assert.throws(()=>integrationLock(root,()=>undefined),/EEXIST/);});assert.doesNotThrow(()=>integrationLock(root,()=>undefined));
});

test('simultaneous independent processes cannot claim the same task',async t=>{
 const root=fixture(t);initializeProject(root);writeFileSync(path.join(root,'PLAN.md'),'Concurrent task ownership');const service=new WorkbenchService(root);t.after(()=>service.close());service.core.approvePlan('PLAN.md');service.core.createTask({id:'RACE',title:'Exclusive ownership',requirement:'One worker owns the task',acceptance:['Only one concurrent claimant succeeds'],dependencies:[],scope:['source.cjs'],requiredChecks:[]});
 const moduleUrl=new URL('../src/core.ts',import.meta.url).href;
 const claim=(worker:string)=>new Promise<{claimed:boolean;error?:string}>((resolve,reject)=>{
  const code=`import {Workbench} from ${JSON.stringify(moduleUrl)};const core=new Workbench(${JSON.stringify(root)});try{core.claimTask('RACE',{host:'codex',sessionId:${JSON.stringify(worker)},workerId:${JSON.stringify(worker)},role:'implementer'});console.log(JSON.stringify({claimed:true}));}catch(error){console.log(JSON.stringify({claimed:false,error:error.message}));}finally{core.close();}`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:packageRoot,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);child.once('error',reject);child.once('close',exit=>{try{if(exit!==0)throw new Error(errors);resolve(JSON.parse(output));}catch(error){reject(error);}});
 });
 const results=await Promise.all([claim('first'),claim('second')]);assert.equal(results.filter(result=>result.claimed).length,1);assert.match(results.find(result=>!result.claimed)!.error!,/claim|ready/i);
});

test('CLI rejects malformed approval flags before granting policy authority',t=>{
 const root=fixture(t);initializeProject(root);writeFileSync(path.join(root,'PLAN.md'),'Owner policy');
 for(const options of [['--yes','false'],['--yes','--unknown'],['--yes','--yes']])assert.throws(()=>execFileSync(process.execPath,['--import','tsx',path.join(packageRoot,'src/cli.ts'),'--project',root,'approve','--plan','PLAN.md',...options],{cwd:packageRoot,stdio:'pipe'}));
 const service=new WorkbenchService(root);t.after(()=>service.close());assert.throws(()=>service.core.assertApproved(),/approval/i);
});
