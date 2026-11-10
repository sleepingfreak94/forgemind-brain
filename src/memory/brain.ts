import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { privatePath } from './database.js';

export type BrainSpace = 'personal' | 'company';
export type BrainKind = 'convention' | 'lesson' | 'decision' | 'pattern';
export type BrainStatus = 'proposed' | 'approved' | 'rejected' | 'retired';
export interface BrainEntry {
  id: string; kind: BrainKind; project: string | null; text: string; evidence: string[];
  reason: string; status: BrainStatus; createdAt: number; reviewedAt: number | null; reviewNote: string | null;
}

export type BrainSource = 'harness' | 'claude-code' | 'cursor';
export interface BrainHistory {
  id: string; project: string; source: BrainSource; title: string; summary: string; files: string[];
  outcome: string; evidence: string[]; at: number;
}
const sources: readonly string[] = ['harness', 'claude-code', 'cursor'];
const spaces: readonly string[] = ['personal', 'company'];
const kinds: readonly string[] = ['convention', 'lesson', 'decision', 'pattern'];
const statuses: readonly string[] = ['proposed', 'approved', 'rejected', 'retired'];
/** The generic key/token/secret/password pattern also refuses harmless text such as "token: use refresh flow"; that is intended. */
const secrets = [/gh[po]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /\bsk-[A-Za-z0-9_-]{16,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /(key|token|secret|password)\s*[:=]/i];

/** Local owner state; never a directory under the repository. */
export function defaultBrainDirectory(): string { return join(homedir(), '.forgemind', 'brain'); }

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

/** Owner-only persistence of reviewed knowledge; one isolated database per space. */
export class BrainStore {
  private readonly db: DatabaseSync;
  constructor(directory: string, space: BrainSpace) {
    if (typeof space !== 'string' || !spaces.includes(space)) throw new Error('invalid brain space');
    if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('brain storage must be absolute');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error('brain storage must be canonical');
    privatePath(directory, true);
    const home = join(directory, space);
    mkdirSync(home, { mode: 0o700, recursive: true }); privatePath(home, true);
    const path = join(home, 'brain.sqlite');
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privatePath(path, false);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { privatePath(path + suffix, false); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.db = new DatabaseSync(path, { timeout: 1000, enableForeignKeyConstraints: true });
    try {
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error('unsupported brain schema');
      this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;');
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK(kind IN ('convention','lesson','decision','pattern')),
            project TEXT, text TEXT NOT NULL, evidence TEXT NOT NULL, reason TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected','retired')),
            created_at INTEGER NOT NULL, reviewed_at INTEGER, review_note TEXT) STRICT;
          CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY, action TEXT NOT NULL, entry TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, project TEXT NOT NULL,
            source TEXT NOT NULL CHECK(source IN ('harness','claude-code','cursor')), title TEXT NOT NULL,
            summary TEXT NOT NULL, files TEXT NOT NULL, outcome TEXT NOT NULL, evidence TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
        `);
        if (version !== 2) this.db.exec('PRAGMA user_version = 2');
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
    outcome: string; evidence: string[] }): string {
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
      if (this.db.prepare('SELECT 1 FROM history WHERE id = ?').get(id)) return id;
      const now = Date.now();
      this.db.prepare('INSERT INTO history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, project, rawSource, title, summary, JSON.stringify(files), outcome, JSON.stringify(evidence), now);
      this.db.prepare('INSERT INTO audit (action, entry, at) VALUES (?, ?, ?)').run('record', id, now);
      return id;
    });
  }
  history(project: string, limit = 20): BrainHistory[] {
    const where = absolute(project);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid limit');
    return this.db.prepare('SELECT * FROM history WHERE project = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(where, limit).map(row => ({
      id: row.id as string, project: row.project as string, source: row.source as BrainSource, title: row.title as string,
      summary: row.summary as string, files: JSON.parse(row.files as string) as string[], outcome: row.outcome as string,
      evidence: JSON.parse(row.evidence as string) as string[], at: row.at as number
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
}
