import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { confinedPath } from './security.js';
import { STATE_FILE } from './policy.js';

export const SCHEMA_VERSION = 2;
export class Store {
  readonly db: Database.Database;
  readonly file: string;
  private closed = false;
  constructor(readonly root: string) {
    this.file = confinedPath(root, STATE_FILE);
    const existed = existsSync(this.file);
    this.db = new Database(this.file);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > SCHEMA_VERSION) { this.db.close(); throw new Error('Database schema is newer than this workbench'); }
    if (version < SCHEMA_VERSION) {
      if (existed) {
        const backup = confinedPath(root, '.agentkit/backups'); mkdirSync(backup, { recursive: true, mode: 0o700 });
        this.db.prepare('VACUUM INTO ?').run(path.join(backup, `state-v${version}-${Date.now()}-${randomUUID()}.sqlite`));
      }
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS claims (token TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS evidence (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, token TEXT NOT NULL, data TEXT NOT NULL, context_hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS review_grants (token TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, token TEXT NOT NULL, data TEXT NOT NULL, context_hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL);
          CREATE TRIGGER IF NOT EXISTS immutable_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only immutable'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only immutable'); END;
        `);
        const columns = this.db.pragma('table_info(claims)') as { name: string }[];
        if (!columns.some(column => column.name === 'released')) this.db.exec('ALTER TABLE claims ADD COLUMN released INTEGER NOT NULL DEFAULT 0');
        this.db.exec('DROP INDEX IF EXISTS active_task_claim; CREATE UNIQUE INDEX active_task_claim ON claims(task_id) WHERE released=0');
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      }).immediate();
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    const storedRoot = this.get<string>('root');
    if (storedRoot && storedRoot !== root) { this.db.close(); throw new Error('State belongs to another project root; use explicit import'); }
    this.set('root', root);
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  get<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) as T : undefined; }
  set(key: string, value: unknown): void { if (value === undefined) this.db.prepare('DELETE FROM metadata WHERE key=?').run(key); else this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  event(type: string, data: unknown, taskId?: string): void { this.db.prepare('INSERT INTO events(at,type,task_id,data) VALUES(?,?,?,?)').run(Date.now(), type, taskId ?? null, JSON.stringify(data)); }
}
