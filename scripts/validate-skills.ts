import {readFileSync,readdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {sha256} from '../src/policy.js';
const root=process.cwd();const names=readdirSync(path.join(root,'skills'));const errors:string[]=[];
const manifest=JSON.parse(readFileSync(path.join(root,'upstream','manifest.json'),'utf8'));
for(const name of names){
 const dir=path.join(root,'skills',name);const content=readFileSync(path.join(dir,'SKILL.md'),'utf8');const match=/^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
 if(!match){errors.push(name+': missing frontmatter');continue;}const meta=parse(match[1]!);
 if(meta.name!==name||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)||typeof meta.description!=='string'||meta.description.length<1||meta.description.length>1024)errors.push(name+': invalid name/description');
 function walk(folder:string){for(const e of readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,e.name);if(e.isDirectory()){walk(file);continue;}if(!e.name.endsWith('.md'))continue;
 const text=readFileSync(file,'utf8').replace(/```[\s\S]*?```/g,'');for(const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){let ref=m[1]!;if(/^(?:https?:|mailto:|#|\/|plugin:)/.test(ref))continue;ref=ref.split('#')[0]!.split(' ')[0]!;if(!ref||ref.includes('<')||ref.includes('{')||ref.includes('…'))continue;const resolved=path.resolve(path.dirname(file),ref);if(!existsSync(resolved))errors.push(`${name}: missing reference ${ref}`);}
 }}walk(dir);
}
for(const patch of manifest.patches){const actual=readFileSync(path.join(root,patch.file));if(sha256(actual)!==patch.adaptedHash)errors.push(`Unrecorded adaptation: ${patch.file}`);}
for(const expected of manifest.namespacedSkills)if(!names.includes(expected))errors.push(`Missing upstream skill: ${expected}`);
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log(JSON.stringify({skills:names.length,pinnedRevision:manifest.revision,valid:true}));
