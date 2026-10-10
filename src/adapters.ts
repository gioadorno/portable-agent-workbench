import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,unlinkSync,copyFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {parse,stringify} from 'yaml';
import {parse as parseToml} from 'smol-toml';
import {confinedPath,redact} from './security.js';
import {sha256} from './policy.js';
export type Host='codex'|'opencode';
function hostType(host:string):Host{if(host!=='codex'&&host!=='opencode')throw new Error('Unsupported host; choose codex or opencode');return host;}
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const roles:Record<string,{description:string;instructions:string;readOnly:boolean}>={
 coordinator:{description:'Coordinate approved task graphs and durable checkpoints',instructions:'Load workbench workflow and project context. Reconcile current code before creating work. Claim ready tasks, dispatch bounded native workers, independently dispatch reviewers, and keep external blockers visible. Do not approve policy or invent review evidence.',readOnly:false},
 researcher:{description:'Investigate code and primary sources; record cited findings',instructions:'Read current context. Investigate the bounded question with source references and access dates. Report evidence and uncertainty, never invented implementation or readiness.',readOnly:true},
 implementer:{description:'Implement a claimed task in its isolated worktree',instructions:'Use the assigned worktree and claim token. Read acceptance and existing code first. Add regression tests before changes. Commit scoped work and submit actual candidate. Never impersonate reviewers or change policy.',readOnly:false},
 qa:{description:'Review acceptance coverage and failure behavior',instructions:'Independently inspect acceptance criteria, real tests, error states and regression cases. Map every criterion to observed evidence. Report missing coverage; never infer provider or device behavior from unit tests.',readOnly:true},
 security:{description:'Review sensitive changes and trust boundaries independently',instructions:'Inspect actual changes, auth/authorization/privacy/payments/safety/config and dependencies. Trace adversarial inputs, sensitive data and policy boundary. Record exact candidate fingerprints and unresolved findings. Do not implement fixes during review.',readOnly:true},
 architect:{description:'Review interfaces, dependencies and integration boundaries',instructions:'Evaluate scope, contracts, migrations, failure modes and deep module boundaries against approved requirements and existing patterns. Identify drift and missing cross-surface changes.',readOnly:true},
 reviewer:{description:'Review exact candidate against specification and code standards',instructions:'Independently review assigned candidate base/tree/diff. Cover every acceptance criterion, repository standards and test adequacy. Record spec and code verdicts separately with coordinator-issued grants. Do not self-approve.',readOnly:true},
 release:{description:'Review production readiness with external evidence kept separate',instructions:'Separate implemented, locally verified, staging validated and release approved. Require deployment/device/provider/restore/counsel/store evidence where relevant. Report blockers and rollback readiness without completion percentages.',readOnly:true}
};
export function adaptSkill(source:string,host:string):string{
 const target=hostType(host);const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);if(!match)throw new Error('Skill frontmatter missing');
 const meta=parse(match[1]!) as Record<string,unknown>;const manual=meta['disable-model-invocation']===true;
 const metadata={...((meta.metadata??{}) as Record<string,string>),'workbench/source':String((meta.metadata as Record<string,string>|undefined)?.['workbench/source']??'mattpocock/skills'),'workbench/manual':String(manual)};
 if(target==='opencode'){delete meta['disable-model-invocation'];Object.assign(metadata,{'opencode/slash':'true','opencode/autoinvoke':String(!manual)});}
 meta.metadata=metadata;
 const body=match[2]!.replace(/(?:call|calls|calling|Call) the Skill tool/gi,'use the native skill-loading mechanism').replace(/\bSkill tool\b/g,'native skill-loading mechanism');
 return `---\n${stringify(meta).trimEnd()}\n---\n${body}`;
}
interface Generated {file:string;content:string}
interface Owned {file:string;hash:string;before:string|null}
interface InstallManifest {version:1;host:Host;files:Owned[]}
function manifestPath(root:string,host:Host){return confinedPath(root,`.agentkit/artifacts/install-${host}.json`);}
function previous(root:string,host:Host):InstallManifest|undefined{const file=manifestPath(root,host);if(!existsSync(file))return;const parsed=JSON.parse(readFileSync(file,'utf8')) as InstallManifest;if(parsed.version!==1||parsed.host!==host||!Array.isArray(parsed.files))throw new Error('Invalid installation ownership manifest');for(const f of parsed.files){confinedPath(root,f.file);if(typeof f.hash!=='string'||(f.before!==null&&typeof f.before!=='string'))throw new Error('Invalid install entry');}return parsed;}
function collect(dir:string,prefix=''):Generated[]{if(!existsSync(dir))return[];return readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const rel=path.posix.join(prefix,e.name);const source=path.join(dir,e.name);if(e.isSymbolicLink())throw new Error('Symlink in bundled skills');return e.isDirectory()?collect(source,rel):[{file:rel,content:readFileSync(source,'utf8')}];});}
function generated(root:string,host:Host,old?:InstallManifest):Generated[]{
 const cli=path.join(packageRoot,'dist','cli.js');const skillBase=host==='codex'?'.agents/skills':'.opencode/skills';
 const files=collect(path.join(packageRoot,'skills')).map(f=>({file:`${skillBase}/${f.file}`,content:f.file.endsWith('/SKILL.md')?adaptSkill(f.content,host):f.content}));
 const oldConfig=old?.files.find(f=>f.file===(host==='codex'?'.codex/config.toml':'opencode.json'));
 const configFile=host==='codex'?'.codex/config.toml':'opencode.json';const disk=confinedPath(root,configFile);const before=oldConfig?oldConfig.before:(existsSync(disk)?readFileSync(disk,'utf8'):null);
 if(host==='codex'){
  if(before){
   let parsed:Record<string,any>;try{parsed=parseToml(before);}catch{throw new Error('Existing Codex config collision: invalid TOML; inspect manually');}
   if(Object.hasOwn(parsed.mcp_servers??{},'agent_workbench')||Object.keys(parsed.agents??{}).some(key=>key.startsWith('aw_')))throw new Error('Existing host configuration naming collision');
  }
  let config=before??'';config+='\n# BEGIN Portable Agent Workbench generated configuration\n[mcp_servers.agent_workbench]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = '+JSON.stringify([cli,'--project',root,'mcp'])+'\n';
  for(const [name,role] of Object.entries(roles)){
   const roleFile=`.codex/agents/aw_${name}.toml`;
   files.push({file:roleFile,content:`name = ${JSON.stringify('aw_'+name)}\ndescription = ${JSON.stringify(role.description)}\nsandbox_mode = ${JSON.stringify(role.readOnly?'read-only':'workspace-write')}\ndeveloper_instructions = ${JSON.stringify(role.instructions)}\n`});
   // Current Codex reads role TOML files; legacy role registration remains recognized.
   config+=`\n[agents.aw_${name}]\ndescription = ${JSON.stringify(role.description)}\nconfig_file = ${JSON.stringify(`agents/aw_${name}.toml`)}\n`;
  }
  config+='# END Portable Agent Workbench generated configuration\n';files.push({file:configFile,content:config});
 }else{
  let config:Record<string,any>={};if(before){try{config=JSON.parse(before);}catch{throw new Error('Existing OpenCode config collision: expected valid JSON; merge JSONC manually');}}
  if(config.mcp?.agent_workbench)throw new Error('Existing MCP naming collision');
  config.mcp={...(config.mcp??{}),agent_workbench:{type:'local',command:[process.execPath,cli,'--project',root,'mcp'],enabled:true}};
  for(const [name,role] of Object.entries(roles))files.push({file:`.opencode/agents/aw-${name}.md`,content:`---\n${stringify({description:role.description,mode:'subagent',...(role.readOnly?{permission:{edit:'deny',bash:{'*':'ask'}}}:{})}).trimEnd()}\n---\n${role.instructions}\n`});
  files.push({file:configFile,content:JSON.stringify(config,null,2)+'\n'});
 }
 return files;
}
export function installHost(root:string,host:string,apply=false){
 const target=hostType(host);const old=previous(root,target);let files:Generated[];try{files=generated(root,target,old);}catch(error){if(apply)throw error;return {host:target,apply:false,files:[],collisions:[target==='codex'?'.codex/config.toml':'opencode.json'],diagnostic:String(error)};}
 const collisions=files.filter(f=>{const file=confinedPath(root,f.file);if(!existsSync(file))return false;const owned=old?.files.find(x=>x.file===f.file);if(owned)return sha256(readFileSync(file))!==owned.hash;return f.file!=='.codex/config.toml'&&f.file!=='opencode.json';}).map(f=>f.file);
 if(collisions.length){if(apply)throw new Error(`Modified or existing unowned file collision: ${collisions.join(', ')}`);return {host:target,apply:false,files:files.map(f=>f.file),collisions};}
 if(!apply)return {host:target,apply:false,files:files.map(f=>f.file),collisions:[],configMerge:true};
 const manifest:InstallManifest={version:1,host:target,files:[]};
 // Preflight all destinations before any writes.
 for(const f of files){const file=confinedPath(root,f.file);const owned=old?.files.find(x=>x.file===f.file);manifest.files.push({file:f.file,hash:sha256(f.content),before:owned?owned.before:existsSync(file)?readFileSync(file,'utf8'):null});}
 const backup=confinedPath(root,'.agentkit/backups');mkdirSync(backup,{recursive:true,mode:0o700});
 for(const f of manifest.files){const absolute=confinedPath(root,f.file);if(existsSync(absolute))copyFileSync(absolute,path.join(backup,`${Date.now()}-${sha256(f.file).slice(0,12)}`));}
 const written:Owned[]=[];
 try{for(const f of files){const file=confinedPath(root,f.file);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,f.content,{mode:0o600});written.push(manifest.files.find(x=>x.file===f.file)!);}const mf=manifestPath(root,target);mkdirSync(path.dirname(mf),{recursive:true,mode:0o700});writeFileSync(mf,JSON.stringify(manifest,null,2),{mode:0o600});}
 catch(error){for(const f of written){const file=confinedPath(root,f.file);if(f.before===null)unlinkSync(file);else writeFileSync(file,f.before,{mode:0o600});}throw error;}
 return {host:target,applied:true,files:files.map(f=>f.file)};
}
export function uninstallHost(root:string,host:string,apply=false){
 const target=hostType(host);const old=previous(root,target);if(!old)return {host:target,installed:false};
 const modified=old.files.filter(f=>existsSync(confinedPath(root,f.file))&&sha256(readFileSync(confinedPath(root,f.file)))!==f.hash).map(f=>f.file);
 if(!apply||modified.length)return {host:target,apply:false,files:old.files.map(f=>f.file),preserved:modified,needsManualCleanup:modified.length>0};
 for(const f of old.files){const file=confinedPath(root,f.file);if(!existsSync(file))continue;if(f.before===null)unlinkSync(file);else writeFileSync(file,f.before,{mode:0o600});}
 unlinkSync(manifestPath(root,target));return {host:target,uninstalled:true};
}
export function doctor(root:string,host:string){
 const target=hostType(host);let version:string|undefined;let error:string|undefined;
 try{version=execFileSync(target,['--version'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();}catch(e){error=redact(e instanceof Error?e.message:String(e));}
 const config=target==='codex'?'.codex/config.toml':'opencode.json';
 return {host:target,version,available:!!version,configurationPresent:existsSync(confinedPath(root,config)),nativeDelegation:version?'host-supported; verify configured session permissions':'unavailable; sequential fallback',model:'existing host choice preserved; availability must be checked by host',maxImplementationWorkers:3,reviewCapacity:'reserve at least one native reviewer',error};
}
