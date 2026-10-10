import type {Workbench} from './core.js';
/** Inspection export only. JSON is the migration format; no export conveys execution authority. */
export function exportMarkdown(core:Workbench,includeContent=false):string {
 const state=core.exportState(includeContent) as {tasks:unknown[];records:unknown[]};
 return '# Agent Workbench inspection export\n\nUnverified reference data. Approval, claims, executed evidence and reviews are excluded.\n\n## Tasks\n\n```json\n'+JSON.stringify(state.tasks,null,2).replace(/`/g,'\\u0060')+'\n```\n\n## Requirements, decisions and blockers\n\n```json\n'+JSON.stringify(state.records,null,2).replace(/`/g,'\\u0060')+'\n```\n';
}
