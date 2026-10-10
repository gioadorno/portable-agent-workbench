import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { confinedPath } from './security.js';
import type { Profile } from './types.js';

export const PROJECT_DIR = '.agentkit';
export const PROFILE_FILE = '.agentkit/project.yaml';
export const STATE_FILE = '.agentkit/state.sqlite';
export function sha256(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }

const text = z.string().min(1).max(10000);
const schema = z.object({
  version: z.literal(1), context: z.array(text).max(200), roles: z.record(text).refine(v => Object.keys(v).length > 0, 'At least one role is required'),
  commands: z.record(z.object({ argv: z.array(text).min(1).max(200), cwd: text, timeoutMs: z.number().int().min(1).max(3600000) }).strict()),
  policy: z.object({ maxWorkers: z.number().int().min(1).max(64), leaseMs: z.number().int().min(1).max(3600000), sensitivePaths: z.array(text).max(200) }).strict(),
  plan: text.optional(),
}).strict();
export function validateProfile(input: unknown): Profile { return schema.parse(input) as Profile; }
export function defaultProfile(): Profile {
  return { version: 1, context: [], roles: { implementer: 'Implement scoped tasks', reviewer: 'Independent specification and code review', security: 'Independent security review', human: 'Human review' }, commands: {}, policy: { maxWorkers: 3, leaseMs: 900000, sensitivePaths: ['**/auth/**', '**/security/**', '**/privacy/**', '**/payment*/**', '**/migration*/**', '**/config/**', '**/config.*', '**/*.config.*', '**/package.json', '**/*lock*', '.agentkit/**'] } };
}
export function initializeProject(root: string, profile?: Profile): Profile {
  mkdirSync(root, { recursive: true });
  const dir = confinedPath(root, PROJECT_DIR); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = confinedPath(root, PROFILE_FILE);
  if (!existsSync(file)) writeFileSync(file, stringify(validateProfile(profile ?? defaultProfile())), { flag: 'wx', mode: 0o600 });
  const ignore = confinedPath(root, '.gitignore');
  const lines = ['.agentkit/state.sqlite*', '.agentkit/artifacts/', '.agentkit/worktrees/', '.agentkit/quarantine/', '.agentkit/backups/', '.agentkit/*.lock'];
  const existing = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const missing = lines.filter(line => !existing.split(/\r?\n/).includes(line));
  if (missing.length) appendFileSync(ignore, `${existing && !existing.endsWith('\n') ? '\n' : ''}\n# Agent workbench local state\n${missing.join('\n')}\n`);
  return readProfile(root);
}
export function readProfile(root: string): Profile {
  const doc = parseDocument(readFileSync(confinedPath(root, PROFILE_FILE, true), 'utf8'), { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Invalid profile YAML: ${doc.errors[0]?.message}`);
  const profile = validateProfile(doc.toJS({ maxAliasCount: 20 }));
  for (const file of profile.context) confinedPath(root, file, true);
  for (const command of Object.values(profile.commands)) confinedPath(root, command.cwd, true);
  if (profile.plan) confinedPath(root, profile.plan, true);
  return profile;
}

export function validateScope(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').includes('..') || /[\[\]{}!]/.test(value)) throw new Error('Unsafe or unsupported scope path');
  return value.replace(/^\.\//, '').replace(/\/$/, '');
}
function globRegex(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(out + '$');
}
export function matchesScope(file: string, scope: string): boolean {
  const p = validateScope(scope); const f = validateScope(file);
  if (!/[?*]/.test(p)) return f === p || f.startsWith(p + '/');
  return globRegex(p).test(f);
}
function staticPrefix(scope: string): string { const s = validateScope(scope); const at = s.search(/[?*]/); if (at === -1) return s; const prefix = s.slice(0, at); return prefix.slice(0, prefix.lastIndexOf('/') + 1).replace(/\/$/, ''); }
/** Conservative intersection: ambiguous wildcard scopes conflict rather than allow concurrent edits. */
export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some(left => b.some(right => {
    if (matchesScope(left, right) || matchesScope(right, left)) return true;
    const p = staticPrefix(left), q = staticPrefix(right);
    return !p || !q || p === q || p.startsWith(q + '/') || q.startsWith(p + '/');
  }));
}
