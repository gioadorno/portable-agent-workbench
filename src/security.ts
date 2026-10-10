import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

function inside(root: string, target: string): boolean { return target === root || target.startsWith(root + path.sep); }

/** Resolve only paths in this project, including every existing ancestor's symlink target. */
export function confinedPath(root: string, relative: string, mustExist = false): string {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split('/').includes('..')) throw new Error('Unsafe path traversal');
  const base = realpathSync(root);
  const target = path.resolve(base, relative || '.');
  if (!inside(base, target)) throw new Error('Path outside project root');
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (existsSync(current)) {
      const actual = realpathSync(current);
      if (!inside(base, actual)) throw new Error('Symlink path escapes project root');
    } else {
      // existsSync is false for dangling symlinks; lstat distinguishes them from absent paths.
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('Dangling symlink path'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  if (mustExist && !existsSync(target)) throw new Error(`Path does not exist: ${relative}`);
  return target;
}

/** Best effort redaction; content-free exports are the default protection. */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/(\b(?:authorization\s*:\s*bearer|bearer)\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)\b\s*[=:]\s*["']?)[^\s,"'<>]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
