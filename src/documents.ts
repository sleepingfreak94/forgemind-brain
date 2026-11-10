import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { containsSecret } from './brain.js';
import type { BrainStore } from './brain.js';

export type DocKind = 'adr' | 'recipe';
export type DocStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded' | 'recorded';
export type DocSource = 'claude-code' | 'cursor' | 'codex' | 'cli' | 'reflect';
export interface Document {
  id: string; project: string; kind: DocKind; number: number | null; title: string; status: DocStatus; body: string;
  fields: Record<string, unknown>; supersedes: string | null; supersededBy: string | null; source: DocSource;
  session: string | null; createdAt: number; updatedAt: number;
}
export interface AdrInput { title: string; context: string; decision: string; alternatives: string; consequences: string; supersedes?: string | undefined }
export interface RecipeInput { goal: string; plan: string; prompts: string[]; deadEnds: string[]; verification: string; outcome: string; files: string[] }

const TITLE_MAX = 200, FIELD_MAX = 8000, BODY_MAX = 40000, MAX_PROMPTS = 50, PROMPT_MAX = 4000, PROMPTS_TOTAL = 20000;
const ADR_FIELDS = ['context', 'decision', 'alternatives', 'consequences'] as const;
const DOC_SOURCES: readonly string[] = ['claude-code', 'cursor', 'codex', 'cli', 'reflect'];
type Row = Record<string, unknown>;

export const adrLabel = (n: number): string => `ADR-${String(n).padStart(4, '0')}`;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const sha = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

function text(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new Error(`invalid ${name}`);
  if (containsSecret(value)) throw new Error('refusing to store a secret');
  return value;
}
function list(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`invalid ${name}`);
  return (value as unknown[]).map(item => text(item, name, 0, maxLength));
}
function check(project: unknown, source: unknown): string {
  if (typeof project !== 'string' || !isAbsolute(project)) throw new Error('project must be an absolute path');
  if (typeof source !== 'string' || !DOC_SOURCES.includes(source)) throw new Error('invalid source');
  return project;
}

/** Replace each secret-looking token (and the value after a `key:` token) with [redacted]; whole lines are the fallback. */
export function redact(value: string): string {
  if (!containsSecret(value)) return value;
  const parts = value.split(/(\s+)/);
  for (let i = 0; i < parts.length; i += 2) {
    if (!containsSecret(parts[i]!)) continue;
    const hadSeparator = /[:=]$/.test(parts[i]!);
    parts[i] = '[redacted]';
    if (hadSeparator && i + 2 < parts.length) parts[i + 2] = '[redacted]';
  }
  let out = parts.join('');
  if (containsSecret(out)) out = out.split('\n').map(line => containsSecret(line) ? '[redacted]' : line).join('\n');
  return containsSecret(out) ? '[redacted]' : out;
}

const section = (heading: string, content: string): string => `\n## ${heading}\n${content}\n`;
const bullets = (items: string[]): string => items.length ? items.map(item => `- ${item}`).join('\n') : 'None';

function renderAdr(number: number, title: string, status: string, at: number, f: Record<string, string>, supersedes: string | null): string {
  return `# ${adrLabel(number)}: ${title}\n\nStatus: ${status}\nDate: ${day(at)}\n` + section('Context', f.context!)
    + section('Decision', f.decision!) + section('Alternatives considered', f.alternatives!) + section('Consequences', f.consequences!)
    + section('Supersedes', supersedes ?? 'None');
}
function renderRecipe(goal: string, at: number, f: RecipeInput): string {
  return `# Recipe: ${goal}\n\nStatus: recorded\nDate: ${day(at)}\n` + section('Plan', f.plan)
    + section('Prompts (exact)', f.prompts.length ? f.prompts.map((p, i) => `${i + 1}. ${p.replace(/\n/g, '\n   ')}`).join('\n') : 'None')
    + section('Dead ends', bullets(f.deadEnds)) + section('Verification', f.verification) + section('Outcome', f.outcome)
    + section('Files', bullets(f.files));
}

function toDocument(row: Row): Document {
  return { id: row.id as string, project: row.project as string, kind: row.kind as DocKind, number: row.number as number | null,
    title: row.title as string, status: row.status as DocStatus, body: row.body as string,
    fields: JSON.parse(row.fields as string) as Record<string, unknown>, supersedes: row.supersedes as string | null,
    supersededBy: row.superseded_by as string | null, source: row.source as DocSource, session: row.session as string | null,
    createdAt: row.created_at as number, updatedAt: row.updated_at as number };
}

function find(store: BrainStore, project: string, ref: string, kind?: DocKind): Document {
  const { db } = store.connection;
  const adr = /^(?:adr-?)?0*(\d+)$/i.exec(ref.trim());
  const row = (adr && db.prepare("SELECT * FROM documents WHERE project = ? AND kind = 'adr' AND number = ?").get(project, Number(adr[1])))
    || db.prepare('SELECT * FROM documents WHERE project = ? AND id = ?').get(project, ref);
  if (!row || (kind !== undefined && row.kind !== kind)) throw new Error('unknown document');
  return toDocument(row);
}
export function getDocument(store: BrainStore, project: string, ref: string): Document { return find(store, check(project, 'cli'), text(ref, 'id', 1, 100)); }

function audit(store: BrainStore, action: string, id: string, now: number): void {
  store.connection.db.prepare('INSERT INTO audit (action, entry, at) VALUES (?, ?, ?)').run(action, id, now);
}

export function createAdr(store: BrainStore, project: string, source: DocSource, session: string | null | undefined, input: AdrInput): Document {
  check(project, source);
  const title = text(input.title, 'title', 1, TITLE_MAX);
  const f: Record<string, string> = {};
  for (const name of ADR_FIELDS) f[name] = text(input[name], name, 1, FIELD_MAX);
  const raw: unknown = input.supersedes;
  if (raw !== undefined && typeof raw !== 'string') throw new Error('invalid supersedes');
  const { db, transaction } = store.connection;
  const id = transaction(() => {
    const old = raw === undefined ? null : find(store, project, raw, 'adr');
    const number = db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM documents WHERE project = ? AND kind = 'adr'").get(project)!.n as number;
    const now = Date.now();
    const body = renderAdr(number, title, 'proposed', now, f, old ? adrLabel(old.number!) : null);
    if (body.length > BODY_MAX) throw new Error('invalid body');
    const docId = sha([project, 'adr', number]);
    db.prepare("INSERT INTO documents VALUES (?, ?, 'adr', ?, ?, 'proposed', ?, ?, ?, NULL, ?, ?, ?, ?)")
      .run(docId, project, number, title, body, JSON.stringify(f), old?.id ?? null, source, session ?? null, now, now);
    audit(store, 'doc-create', docId, now);
    return docId;
  });
  return find(store, project, id);
}

function settle(store: BrainStore, project: string, ref: string, to: 'accepted' | 'rejected', note?: string): void {
  check(project, 'cli');
  const { db, transaction } = store.connection;
  transaction(() => {
    const doc = find(store, project, ref, 'adr');
    if (doc.status !== 'proposed') throw new Error(`invalid transition from ${doc.status} to ${to}`);
    const now = Date.now();
    const fields = note === undefined ? doc.fields : { ...doc.fields, reviewNote: text(note, 'note', 0, 2000) };
    const old = to === 'accepted' && doc.supersedes ? find(store, project, doc.supersedes, 'adr') : null;
    if (old && old.status !== 'accepted' && old.status !== 'proposed') throw new Error(`cannot supersede a ${old.status} ADR`);
    const update = db.prepare('UPDATE documents SET status = ?, body = ?, fields = ?, superseded_by = ?, updated_at = ? WHERE id = ?');
    const back = (d: Document, status: string, by: string | null, f: unknown): void => {
      const body = renderAdr(d.number!, d.title, status, d.createdAt, d.fields as Record<string, string>,
        d.supersedes ? adrLabel(find(store, project, d.supersedes, 'adr').number!) : null);
      update.run(status, body, JSON.stringify(f), by, now, d.id);
    };
    back(doc, to, null, fields);
    audit(store, to === 'accepted' ? 'doc-accept' : 'doc-reject', doc.id, now);
    if (old) { back(old, 'superseded', doc.id, old.fields); audit(store, 'doc-supersede', old.id, now); }
  });
}
export function acceptAdr(store: BrainStore, project: string, ref: string): void { settle(store, project, ref, 'accepted'); }
export function rejectAdr(store: BrainStore, project: string, ref: string, note?: string): void { settle(store, project, ref, 'rejected', note); }

export function createRecipe(store: BrainStore, project: string, source: DocSource, session: string | null | undefined, input: RecipeInput): Document {
  check(project, source);
  const goal = text(input.goal, 'goal', 1, TITLE_MAX);
  const rawPrompts: unknown = input.prompts;
  if (!Array.isArray(rawPrompts) || rawPrompts.length > MAX_PROMPTS || (rawPrompts as unknown[]).some(p => typeof p !== 'string' || p.length > PROMPT_MAX))
    throw new Error('invalid prompts');
  if ((rawPrompts as string[]).reduce((sum, p) => sum + p.length, 0) > PROMPTS_TOTAL) throw new Error('invalid prompts');
  const f: RecipeInput = { goal, plan: text(input.plan, 'plan', 1, FIELD_MAX), prompts: (rawPrompts as string[]).map(redact),
    deadEnds: list(input.deadEnds, 'deadEnds', 50, 1000), verification: text(input.verification, 'verification', 1, FIELD_MAX),
    outcome: text(input.outcome, 'outcome', 1, FIELD_MAX), files: list(input.files, 'files', 200, 1024) };
  const id = sha([project, 'recipe', goal, session ?? '']);
  const { db, transaction } = store.connection;
  transaction(() => {
    if (db.prepare('SELECT 1 FROM documents WHERE id = ?').get(id)) return;
    const now = Date.now();
    const body = renderRecipe(goal, now, f);
    if (body.length > BODY_MAX) throw new Error('invalid body');
    db.prepare("INSERT INTO documents VALUES (?, ?, 'recipe', NULL, ?, 'recorded', ?, ?, NULL, NULL, ?, ?, ?, ?)")
      .run(id, project, goal, body, JSON.stringify(f), source, session ?? null, now, now);
    audit(store, 'doc-create', id, now);
  });
  return find(store, project, id);
}

export function listDocuments(store: BrainStore, project: string, kind?: DocKind, status?: DocStatus): Omit<Document, 'body' | 'fields'>[] {
  check(project, 'cli');
  if (kind !== undefined && kind !== 'adr' && kind !== 'recipe') throw new Error('invalid kind');
  const rows = store.connection.db.prepare(`SELECT * FROM documents WHERE project = ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR status = ?)
    ORDER BY kind, COALESCE(number, 0), created_at, id`).all(project, kind ?? null, kind ?? null, status ?? null, status ?? null);
  return rows.map(row => { const { body, fields, ...rest } = toDocument(row); void body; void fields; return rest; });
}

export interface DocHit { id: string; label: string; kind: DocKind; status: DocStatus; title: string; snippet: string }
export const labelOf = (d: { kind: DocKind; number: number | null; id: string }): string => d.kind === 'adr' ? adrLabel(d.number!) : d.id;
export function searchDocuments(store: BrainStore, project: string, query: string, limit = 20): DocHit[] {
  check(project, 'cli');
  const q = text(query, 'query', 1, 200);
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = store.connection.db.prepare(`SELECT * FROM documents WHERE project = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR fields LIKE ? ESCAPE '\\')
    ORDER BY updated_at DESC, id LIMIT ?`).all(project, like, like, like, limit);
  return rows.map(toDocument).map(d => {
    const at = Math.max(0, d.body.toLowerCase().indexOf(q.toLowerCase()));
    return { id: d.id, label: labelOf(d), kind: d.kind, status: d.status, title: d.title,
      snippet: d.body.slice(Math.max(0, at - 40), at + 120).replace(/\s+/g, ' ').trim() };
  });
}
