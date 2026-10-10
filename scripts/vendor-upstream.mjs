// Explicit, offline adaptation of an owner-selected Git checkout. Never fetches updates.
import {execFileSync} from 'node:child_process';
import {cpSync,mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parse,stringify} from 'yaml';
const source=path.resolve(process.argv[2]??'');if(!process.argv[2])throw new Error('Pass reviewed upstream Git checkout');
const pinned=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const entries=[];
for(const category of ['engineering','productivity'])for(const entry of readdirSync(path.join(source,'skills',category),{withFileTypes:true})){
 if(!entry.isDirectory()||!existsSync(path.join(source,'skills',category,entry.name,'SKILL.md')))continue;
 entries.push({category,name:entry.name});
}
const names=entries.map(e=>e.name).sort((a,b)=>b.length-a.length);
const hash=contents=>createHash('sha256').update(contents).digest('hex');
const patches=[];
for(const entry of entries){
 const original=path.join(source,'skills',entry.category,entry.name);const raw=path.join(root,'upstream','mattpocock','skills',entry.category,entry.name);
 mkdirSync(path.dirname(raw),{recursive:true});cpSync(original,raw,{recursive:true});
 const dest=path.join(root,'skills','mp-'+entry.name);mkdirSync(path.dirname(dest),{recursive:true});cpSync(original,dest,{recursive:true});
 function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isSymbolicLink())throw new Error('Upstream symlink rejected');if(e.isDirectory()){walk(file);continue;}if(!e.name.endsWith('.md'))continue;
  const before=readFileSync(file,'utf8');let after=before;
  for(const name of names){after=after.replace(new RegExp('(?<![A-Za-z0-9./:_-])/'+name+'(?![A-Za-z0-9_-])','g'),'/mp-'+name);}
  after=after.replace(/\bSkill tool\b/g,'native skill-loading mechanism').replace(/\bAskUserQuestion\b/g,'native user-question mechanism');
  if(e.name==='SKILL.md'){
   const parts=/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(after);if(!parts)throw new Error('Invalid upstream skill '+entry.name);
   const metadata=parse(parts[1]);metadata.name='mp-'+entry.name;metadata.metadata={...(metadata.metadata??{}),'workbench/source':'mattpocock/skills','workbench/revision':pinned};
   after='---\n'+stringify(metadata).trimEnd()+'\n---\n'+`\n## Host adaptation\nUse the host's native skill loading, questioning and delegation tools. Resolve original skill names in this document to installed mp- names (for example tdd means mp-tdd); keep issue labels and filenames unchanged. Preserve manual invocation restrictions. If parallel delegation or isolated worktrees are unavailable, use sequential execution and report the capability limit. When using Workbench, its approved plan, ownership and verification gates govern this workflow; do not close work from prose claims alone.\n\n`+parts[2];
  }
  writeFileSync(file,after);if(before!==after)patches.push({file:path.relative(root,file).replaceAll(path.sep,'/'),sourceHash:hash(before),adaptedHash:hash(after)});
 }}walk(dest);
}
cpSync(path.join(source,'LICENSE'),path.join(root,'upstream','mattpocock','LICENSE'));
writeFileSync(path.join(root,'upstream','manifest.json'),JSON.stringify({source:'https://github.com/mattpocock/skills',revision:pinned,categories:['engineering','productivity'],license:'MIT',namespacedSkills:entries.map(e=>'mp-'+e.name).sort(),adaptations:['mp- namespace and cross-skill references','host-neutral skill/question tool names','native delegation with sequential fallback','approved Workbench gates'],patches},null,2)+'\n');
writeFileSync(path.join(root,'THIRD_PARTY_NOTICES.md'),`# Third-party notices\n\nMatt Pocock skills: https://github.com/mattpocock/skills\nPinned revision: ${pinned}\nCopyright (c) 2026 Matt Pocock. MIT License; full notice preserved at upstream/mattpocock/LICENSE.\n\nOriginal engineering/productivity skill trees are preserved in upstream/mattpocock/skills. Adapted copies are namespaced mp- under skills. The manifest records original/adapted hashes and transformations. Native dependency licenses are provided in each npm package.\n`);
console.log(JSON.stringify({revision:pinned,skills:entries.length,patches:patches.length}));
