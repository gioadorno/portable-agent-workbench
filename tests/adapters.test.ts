import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {parse} from 'yaml';
import {installHost,uninstallHost,adaptSkill,doctor} from '../src/adapters.js';
function project(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'aw-adapter-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('OpenCode adaptation preserves manual-only skills and changes native tool language',()=>{
 const source='---\nname: implement\ndescription: Build approved work\ndisable-model-invocation: true\n---\nCall the Skill tool with `tdd`.\n';
 const result=adaptSkill(source,'opencode');const metadata=parse(result.split('---')[1]!).metadata;
 assert.equal(metadata['opencode/autoinvoke'],'false');assert.equal(metadata['opencode/slash'],'true');assert.doesNotMatch(result,/Call the Skill tool/);
});
test('host installation previews without writes and preserves user-owned config collision',t=>{
 const root=project(t);mkdirSync(path.join(root,'.opencode'),{recursive:true});writeFileSync(path.join(root,'opencode.json'),'user-owned');
 const preview=installHost(root,'opencode',false);assert.equal(existsSync(path.join(root,'.agentkit','install-opencode.json')),false);
 assert.throws(()=>installHost(root,'opencode',true),/collision|existing|owned/i);assert.equal(readFileSync(path.join(root,'opencode.json'),'utf8'),'user-owned');assert.ok(preview);
});
test('update/uninstall never overwrite user modifications and preserve unrelated files',t=>{
 const root=project(t);installHost(root,'opencode',true);const config=path.join(root,'opencode.json');const previous=readFileSync(config,'utf8');writeFileSync(config,previous+'\n ');
 assert.throws(()=>installHost(root,'opencode',true),/modified|collision/i);
 uninstallHost(root,'opencode',true);assert.equal(readFileSync(config,'utf8'),previous+'\n ');
});
test('installation is idempotent and removable when generated files are unchanged',t=>{
 const root=project(t);installHost(root,'codex',true);installHost(root,'codex',true);assert.ok(existsSync(path.join(root,'.codex','config.toml')));
 uninstallHost(root,'codex',true);assert.equal(existsSync(path.join(root,'.codex','config.toml')),false);
});
test('unknown hosts fail clearly without writing files',t=>{
 const root=project(t);assert.throws(()=>installHost(root,'unknown',true),/host/i);assert.throws(()=>doctor(root,'unknown'),/host/i);
});

test('Codex quoted tables and inline keys collide without modifying user TOML',t=>{
 for(const existing of ['[mcp_servers."agent_workbench"]\ncommand="existing"\n','mcp_servers = { agent_workbench = { command = "existing" } }\n','[agents . "aw_reviewer"]\ndescription="user"\n']){
  const root=project(t);mkdirSync(path.join(root,'.codex'));const file=path.join(root,'.codex/config.toml');writeFileSync(file,existing);
  assert.ok(installHost(root,'codex').collisions!.length);assert.throws(()=>installHost(root,'codex',true),/collision/);assert.equal(readFileSync(file,'utf8'),existing);
 }
});
