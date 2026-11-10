import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { digest, serialize } from '../context-engine/validation.js';
import { canonicalWorkspace } from './documents.js';

const historyDDL = `CREATE TABLE run_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  body TEXT,
  recorded_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
) STRICT`;
function normalizedDDL(sql: string): string { return sql.replace(/\s+/g, '').toLowerCase(); }
/** Deliberately limited to the expected history definition and absence of triggers. */
function validateHistory(db: DatabaseSync): void {
  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'run_history' COLLATE NOCASE").get();
  if (typeof table?.sql !== 'string' || normalizedDDL(table.sql) !== normalizedDDL(historyDDL) ||
      db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'run_history' COLLATE NOCASE").get()) {
    throw new Error('invalid run_history schema');
  }
}
export function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('unsafe memory storage');
  if (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) throw new Error('memory storage must be private to the owner');
}
export function databasePath(directory: string, root: string, projectId: string): string {
  return join(directory, digest(serialize({ root, projectId })), 'memory.sqlite');
}
/** Owner-only persistence. Do not expose this connection or its directory to an agent. */
export class MemoryDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  constructor(directory: string, root: string, projectId: string) {
    canonicalWorkspace(root);
    const offset = relative(root, directory);
    if (!isAbsolute(directory) || !offset || !offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset)) throw new Error('memory storage must be outside the project');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error('memory storage must be canonical');
    privatePath(directory, true);
    const home = join(directory, digest(serialize({ root, projectId })));
    mkdirSync(home, { mode: 0o700, recursive: true }); privatePath(home, true);
    this.path = databasePath(directory, root, projectId);
    try { closeSync(openSync(this.path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privatePath(this.path, false);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { privatePath(this.path + suffix, false); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.db = new DatabaseSync(this.path, { timeout: 1000, enableForeignKeyConstraints: true });
    try {
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error('unsupported memory schema');
      this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;');
      this.transaction(() => {
        if (version !== 2) {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), project_id TEXT NOT NULL, workspace TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL,
              state TEXT NOT NULL, expires_at INTEGER, body TEXT) STRICT;
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(record_id UNINDEXED, title, text, tokenize='unicode61');
            CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY, action TEXT NOT NULL, record_id TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS deleted_sources (path TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(path, sha256)) STRICT;
            INSERT INTO memory_fts(memory_fts, rank) VALUES ('secure-delete', 1);
          `);
          if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'run_history' COLLATE NOCASE").get()) this.db.exec(historyDDL);
        }
        const identity = this.db.prepare('SELECT * FROM identity').get();
        if (!identity && version !== 2) this.db.prepare('INSERT INTO identity VALUES (1, ?, ?)').run(projectId, root);
        else if (!identity || identity.project_id !== projectId || identity.workspace !== root) throw new Error('memory database identity mismatch');
        validateHistory(this.db);
        if (version !== 2) this.db.exec('PRAGMA user_version = 2');
      });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { if (this.db.isOpen) this.db.close(); }
}
