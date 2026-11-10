import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { closeAttachments, copyAttachments, openAttachments, removeAttachments } from './attachments.js';
import { dirname, isAbsolute, join } from 'node:path';
import { privatePath, strayMigrationFiles } from './validation.js';

export type BrainKind = 'convention' | 'lesson' | 'decision' | 'pattern';
export type BrainStatus = 'proposed' | 'approved' | 'rejected' | 'retired';
export interface BrainEntry {
  id: string; kind: BrainKind; project: string | null; text: string; evidence: string[];
  reason: string; status: BrainStatus; createdAt: number; reviewedAt: number | null; reviewNote: string | null;
}

export type BrainSource = 'harness' | 'claude-code' | 'cursor' | 'codex';
/** Sources a client may name with --source (harness is only old history). */
export const clientSources = ['claude-code', 'cursor', 'codex'] as const;
export interface BrainHistory {
  id: string; project: string; source: BrainSource; title: string; summary: string; files: string[];
  outcome: string; evidence: string[]; attachments: string[]; at: number;
}
const sources: readonly string[] = ['harness', ...clientSources];
const kinds: readonly string[] = ['convention', 'lesson', 'decision', 'pattern'];
const statuses: readonly string[] = ['proposed', 'approved', 'rejected', 'retired'];
/** The generic key/token/secret/password pattern also refuses harmless text such as "token: use refresh flow"; that is intended. */
const secrets = [/gh[po]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /\bsk-[A-Za-z0-9_-]{16,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /(key|token|secret|password)\s*[:=]/i];

/** Local owner state; never a directory under the repository. */
export function defaultBrainDirectory(): string { return join(homedir(), '.forgemind'); }

export function containsSecret(value: string): boolean { return secrets.some(pattern => pattern.test(value)); }
function noSecret(value: string): void {
  if (containsSecret(value)) throw new Error('refusing to store a secret');
}
function limited(value: unknown, min: number, max: number, name: string): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new Error(`invalid ${name}`);
  noSecret(value);
  return value;
}
function absolute(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('project must be an absolute path');
  return value;
}
const order = 'ORDER BY created_at, id';
/**
 * Schema v5 contract (shared by the capture, documents and reflect features):
 * - history.prompts: JSON string[] of the user's exact prompts, secret-redacted; each <= 4000 chars, at most 50, total <= 20000. NULL when unknown.
 * - history.signals: JSON {prompts: number, corrections: number, correctionIndexes: number[], model: string | null,
 *   assistantTurns: number, toolErrors: number, durationMs: number | null}. NULL when unknown.
 * - documents: kind 'adr' (number per project from 1; status proposed -> accepted | rejected, accepted -> superseded)
 *   or 'recipe' (no number; status 'recorded'). fields is the JSON input: ADR {context, decision, alternatives, consequences};
 *   recipe {goal, plan, prompts: string[], deadEnds: string[], verification, outcome, files: string[]}. body is the rendered markdown.
 */
export const DOCUMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('adr','recipe')), number INTEGER, title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected','superseded','recorded')),
    body TEXT NOT NULL, fields TEXT NOT NULL, supersedes TEXT, superseded_by TEXT,
    source TEXT NOT NULL CHECK(source IN ('claude-code','cursor','codex','cli','reflect')), session TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS documents_adr_number ON documents(project, number) WHERE kind = 'adr';
  CREATE INDEX IF NOT EXISTS documents_project ON documents(project, kind, updated_at);`;

/** Owner-only persistence of reviewed knowledge; one database file, `<directory>/brain.sqlite`. */
export class BrainStore {
  private readonly db: DatabaseSync;
  private readonly directory: string;
  constructor(directory: string) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('brain storage must be absolute');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error('brain storage must be canonical');
    privatePath(directory, true);
    this.directory = directory;
    const path = join(directory, 'brain.sqlite');
    if (!existsSync(path) && existsSync(join(directory, 'brain', 'personal', 'brain.sqlite')))
      throw new Error('legacy brain found; run `npm run brain -- migrate` after switching all configs');
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    try { privatePath(path, false); }
    catch (error) {
      const stray = strayMigrationFiles(directory)[0];
      if (stray !== undefined && (error as Error).message === 'unsafe memory storage')
        throw new Error(`unsafe memory storage: ${join(directory, stray)} is a leftover from a crashed migrate and is safe to delete`);
      throw error;
    }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { privatePath(path + suffix, false); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.db = new DatabaseSync(path, { timeout: 1000, enableForeignKeyConstraints: true });
    try {
      this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;');
      this.transaction(() => {
        // Read the version under the write lock so two opens cannot both run the upgrade.
        const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
        if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new Error('unsupported brain schema');
        // Version 2 history only allows three sources; rebuild it so 'codex' fits.
        if (version === 2) this.db.exec('ALTER TABLE history RENAME TO history_v2');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK(kind IN ('convention','lesson','decision','pattern')),
            project TEXT, text TEXT NOT NULL, evidence TEXT NOT NULL, reason TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected','retired')),
            created_at INTEGER NOT NULL, reviewed_at INTEGER, review_note TEXT) STRICT;
          CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY, action TEXT NOT NULL, entry TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, project TEXT NOT NULL,
            source TEXT NOT NULL CHECK(source IN ('harness','claude-code','cursor','codex')), title TEXT NOT NULL,
            summary TEXT NOT NULL, files TEXT NOT NULL, outcome TEXT NOT NULL, evidence TEXT NOT NULL, at INTEGER NOT NULL, attachments TEXT) STRICT;
        `);
        // Version 4 adds the nullable attachments column (older tables were created or kept without it).
        if (!this.db.prepare('PRAGMA table_info(history)').all().some(column => column.name === 'attachments'))
          this.db.exec('ALTER TABLE history ADD COLUMN attachments TEXT');
        if (version === 2) this.db.exec('INSERT INTO history (id, project, source, title, summary, files, outcome, evidence, at) SELECT * FROM history_v2; DROP TABLE history_v2');
        // Version 5: exact session prompts and measured signals on history, plus ADR and recipe documents.
        const historyColumns = new Set(this.db.prepare('PRAGMA table_info(history)').all().map(column => column.name));
        for (const column of ['prompts', 'signals'])
          if (!historyColumns.has(column)) this.db.exec(`ALTER TABLE history ADD COLUMN ${column} TEXT`);
        this.db.exec(DOCUMENTS_DDL);
        if (version !== 5) this.db.exec('PRAGMA user_version = 5');
      });
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  propose(input: { kind: BrainKind; project?: string | null; text: string; evidence: string[]; reason: string }): string {
    const rawKind: unknown = input.kind, rawProject: unknown = input.project, rawText: unknown = input.text;
    const rawReason: unknown = input.reason, rawEvidence: unknown = input.evidence;
    if (typeof rawKind !== 'string' || !kinds.includes(rawKind)) throw new Error('invalid kind');
    const text = limited(rawText, 1, 2000, 'text');
    const reason = limited(rawReason, 0, 2000, 'reason');
    if (!Array.isArray(rawEvidence) || rawEvidence.length > 20) throw new Error('invalid evidence');
    const evidence = (rawEvidence as unknown[]).map(item => limited(item, 0, 300, 'evidence'));
    const project = rawProject === undefined || rawProject === null ? null : absolute(rawProject);
    const id = createHash('sha256').update(JSON.stringify([rawKind, project, text])).digest('hex').slice(0, 16);
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(id)) return id;
      const now = Date.now();
      this.db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)')
        .run(id, rawKind, project, text, JSON.stringify(evidence), reason, 'proposed', now);
      this.db.prepare('INSERT INTO audit (action, entry, at) VALUES (?, ?, ?)').run('propose', id, now);
      return id;
    });
  }
  record(input: { project: string; source: BrainSource; key: string; title: string; summary: string; files: string[];
    outcome: string; evidence: string[]; attachments?: unknown }): string {
    const rawSource: unknown = input.source, rawFiles: unknown = input.files, rawEvidence: unknown = input.evidence;
    if (typeof rawSource !== 'string' || !sources.includes(rawSource)) throw new Error('invalid source');
    const project = limited(absolute(input.project), 1, 4096, 'project');
    const key = limited(input.key, 1, 200, 'key');
    const title = limited(input.title, 1, 300, 'title');
    const summary = limited(input.summary, 0, 4000, 'summary');
    const outcome = limited(input.outcome, 1, 200, 'outcome');
    if (!Array.isArray(rawFiles) || rawFiles.length > 200) throw new Error('invalid files');
    const files = (rawFiles as unknown[]).map(item => limited(item, 0, 1024, 'files'));
    if (!Array.isArray(rawEvidence) || rawEvidence.length > 20) throw new Error('invalid evidence');
    const evidence = (rawEvidence as unknown[]).map(item => limited(item, 0, 300, 'evidence'));
    const id = createHash('sha256').update(JSON.stringify([rawSource, project, key])).digest('hex').slice(0, 16);
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM history WHERE id = ?').get(id)) {
        if (Array.isArray(input.attachments) && input.attachments.length > 0) throw new Error('already recorded today; attachments not added');
        return id; // a repeat never copies files again
      }
      const sources = openAttachments(input.attachments);
      let stored: string[];
      try { stored = copyAttachments(this.directory, project, id, sources); } finally { closeAttachments(sources); }
      try {
        const now = Date.now();
        this.db.prepare('INSERT INTO history (id, project, source, title, summary, files, outcome, evidence, at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, project, rawSource, title, summary, JSON.stringify(files), outcome, JSON.stringify(evidence), now, stored.length ? JSON.stringify(stored) : null);
        this.db.prepare('INSERT INTO audit (action, entry, at) VALUES (?, ?, ?)').run('record', id, now);
      } catch (error) { if (stored[0]) removeAttachments(dirname(stored[0])); throw error; }
      return id;
    });
  }
  history(project: string, limit = 20): BrainHistory[] {
    const where = absolute(project);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid limit');
    return this.db.prepare('SELECT * FROM history WHERE project = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(where, limit).map(row => ({
      id: row.id as string, project: row.project as string, source: row.source as BrainSource, title: row.title as string,
      summary: row.summary as string, files: JSON.parse(row.files as string) as string[], outcome: row.outcome as string,
      evidence: JSON.parse(row.evidence as string) as string[], at: row.at as number,
      attachments: row.attachments === null ? [] : JSON.parse(row.attachments as string) as string[]
    }));
  }
  private rows(sql: string, params: string[]): BrainEntry[] {
    return this.db.prepare(sql).all(...params).map(row => ({
      id: row.id as string, kind: row.kind as BrainKind, project: row.project as string | null, text: row.text as string,
      evidence: JSON.parse(row.evidence as string) as string[], reason: row.reason as string, status: row.status as BrainStatus,
      createdAt: row.created_at as number, reviewedAt: row.reviewed_at as number | null, reviewNote: row.review_note as string | null
    }));
  }
  list(filter: { status?: BrainStatus; project?: string } = {}): BrainEntry[] {
    const where: string[] = [], params: string[] = [];
    if (filter.status !== undefined) {
      if (!statuses.includes(filter.status)) throw new Error('invalid status');
      where.push('status = ?'); params.push(filter.status);
    }
    if (filter.project !== undefined) { where.push('project = ?'); params.push(absolute(filter.project)); }
    return this.rows(`SELECT * FROM entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${order}`, params);
  }
  approved(project: string): BrainEntry[] {
    return this.rows(`SELECT * FROM entries WHERE status = 'approved' AND (project = ? OR project IS NULL) ${order}`, [absolute(project)]);
  }
  private change(id: string, to: BrainStatus, action: string, note?: string): void {
    const text = note === undefined ? null : limited(note, 0, 2000, 'note');
    this.transaction(() => {
      const row = this.db.prepare('SELECT status FROM entries WHERE id = ?').get(id);
      if (!row) throw new Error('unknown brain entry');
      const from = row.status as string;
      if (!(from === 'proposed' && (to === 'approved' || to === 'rejected')) && !(from === 'approved' && to === 'retired')) {
        throw new Error(`invalid transition from ${from} to ${to}`);
      }
      const now = Date.now();
      this.db.prepare('UPDATE entries SET status = ?, reviewed_at = ?, review_note = ? WHERE id = ?').run(to, now, text, id);
      this.db.prepare('INSERT INTO audit (action, entry, at) VALUES (?, ?, ?)').run(action, id, now);
    });
  }
  approve(id: string): void { this.change(id, 'approved', 'approve'); }
  reject(id: string, note?: string): void { this.change(id, 'rejected', 'reject', note); }
  retire(id: string): void { this.change(id, 'retired', 'retire'); }
  audit(): { action: string; entry: string; at: number }[] {
    return this.db.prepare('SELECT action, entry, at FROM audit ORDER BY sequence').all()
      .map(row => ({ action: row.action as string, entry: row.entry as string, at: row.at as number }));
  }
  close(): void { if (this.db.isOpen) this.db.close(); }

  /** Review many entries at once: every id is validated first and all change in one transaction, or none do. */
  changeMany(ids: string[], to: 'approved' | 'rejected' | 'retired', note?: string): void {
    const text = note === undefined ? null : limited(note, 0, 2000, 'note');
    const action = to === 'approved' ? 'approve' : to === 'rejected' ? 'reject' : 'retire';
    this.transaction(() => {
      for (const id of new Set(ids)) {
        const row = this.db.prepare('SELECT status FROM entries WHERE id = ?').get(id);
        if (!row) throw new Error(`unknown brain entry ${id}`);
        const from = row.status as string;
        if (!(from === 'proposed' && to !== 'retired') && !(from === 'approved' && to === 'retired')) throw new Error(`invalid transition from ${from} to ${to} for ${id}`);
        const now = Date.now();
        this.db.prepare('UPDATE entries SET status = ?, reviewed_at = ?, review_note = ? WHERE id = ?').run(to, now, text, id);
        this.db.prepare('INSERT INTO audit (action, entry, at) VALUES (?, ?, ?)').run(action, id, now);
      }
    });
  }}
