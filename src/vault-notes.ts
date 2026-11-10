import { createHash } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BrainStore } from './brain.js';

export interface VaultOptions { prompts: boolean; includeProposed: boolean; projects?: string[] | undefined }
export interface Caps { sessions: number; perProject: number; notes: number }
export const defaultCaps: Caps = { sessions: 2000, perProject: 50, notes: 5000 };
export interface Counts { projects: number; sessions: number; adrs: number; recipes: number; lessons: number; notes: number }
export interface Built { notes: Map<string, string>; counts: Counts; omitted: number; hidden: number }
type Row = Record<string, unknown>;

/** Safe file-name part: no path separators, Obsidian/macOS-hostile characters, control characters or "..". */
export function safeName(value: string, max = 60): string {
  const s = value.replace(/[\u0000-\u001f\u007f\\/:*?"<>|#^[\]]/g, ' ').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim().slice(0, max).trim().replace(/^\.+|\.+$/g, '').trim();
  return s || 'untitled';
}
const hash6 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 6);
/** Unfenced note text: no HTML tag can survive (script, iframe, img beacons, split-tag bypasses). Prompts stay exact inside code fences. */
const esc = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A YAML double-quoted scalar (JSON is valid YAML): newlines and quotes are escaped, so a value never leaves its line. */
const q = (s: string): string => JSON.stringify(s).replace(new RegExp('[\\u0085\\u2028\\u2029]', 'g'), c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const frontmatter = (f: Record<string, string | number | null | string[]>): string => '---\n' + Object.entries(f).map(([k, v]) =>
  `${k}: ${v === null ? 'null' : typeof v === 'number' ? v : Array.isArray(v) ? `[${v.map(q).join(', ')}]` : q(v)}`).join('\n') + '\n---\n';
const iso = (ms: number): string => new Date(ms).toISOString();
const json = <T>(v: unknown, fallback: T): T => { try { return typeof v === 'string' ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const fence = (text: string): string => {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${ticks}\n${text}\n${ticks}`;
};
const link = (path: string): string => `[[${path}]]`;

export function buildNotes(brainDir: string, options: VaultOptions, caps: Caps = defaultCaps, now = new Date()): Built {
  new BrainStore(brainDir).close(); // opens and migrates; the reads below are my own SQL
  const db = new DatabaseSync(join(brainDir, 'brain.sqlite'), { readOnly: true });
  try {
    const keep = (p: unknown): boolean => p === null || !options.projects || options.projects.includes(p as string);
    const marks = options.projects ? ` AND project IN (${options.projects.map(() => '?').join(',')})` : '';
    const args = options.projects ?? [];
    // Hook captures without real prompts are hidden, as in brain_context.
    const auto = `evidence LIKE '["hook:%' AND (prompts IS NULL OR prompts = '[]')`;
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM history WHERE NOT (${auto})${marks}`).get(...args)!.n as number);
    const hidden = (db.prepare(`SELECT COUNT(*) AS n FROM history WHERE ${auto}${marks}`).get(...args)!.n as number);
    const history = db.prepare(`SELECT id, project, source, title, summary, files, outcome, evidence, at, attachments, prompts, signals FROM history WHERE NOT (${auto})${marks} ORDER BY at DESC, rowid DESC LIMIT ?`).all(...args, caps.sessions);
    const docs = db.prepare('SELECT id, project, kind, number, title, status, body, supersedes, superseded_by, session, created_at, updated_at FROM documents ORDER BY kind, COALESCE(number, 0), created_at, id').all().filter(r => keep(r.project));
    const statuses = options.includeProposed ? ['approved', 'proposed'] : ['approved'];
    const lessons = db.prepare('SELECT id, kind, project, text, evidence, reason, status, created_at FROM entries ORDER BY created_at, id').all().filter(r => statuses.includes(r.status as string) && keep(r.project));
    return render(brainDir, history, total, hidden, docs, lessons, options, caps, now);
  } finally { db.close(); }
}

function render(brainDir: string, historyAll: Row[], historyTotal: number, hidden: number, docsAll: Row[], lessonsAll: Row[], options: VaultOptions, caps: Caps, now: Date): Built {
  // Cap ADRs, recipes and lessons before naming them, so no hub or index links to a dropped note.
  let avail = Math.max(0, caps.notes - 2); // index and Global
  const cut = <T>(rows: T[]): T[] => { const kept = rows.slice(0, avail); avail -= kept.length; return kept; };
  const adrs = cut(docsAll.filter(d => d.kind === 'adr')), recipes = cut(docsAll.filter(d => d.kind === 'recipe')), lessonRows = cut(lessonsAll);
  const docs = [...adrs, ...recipes];
  const dropped = docsAll.length + lessonsAll.length - docs.length - lessonRows.length;
  const paths = [...new Set([...historyAll, ...docs, ...lessonRows].map(r => r.project).filter((p): p is string => typeof p === 'string'))].sort();
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(basename(p).toLowerCase(), (counts.get(basename(p).toLowerCase()) ?? 0) + 1);
  const projName = new Map(paths.map(p => [p, safeName(counts.get(basename(p).toLowerCase())! > 1 ? `${basename(p)} ${hash6(p)}` : basename(p), 80)]));
  const projLink = (p: unknown): string => typeof p === 'string' ? link(`Projects/${projName.get(p)}`) : link('Global');

  // File names first, so every wikilink target is known before any note is rendered.
  const used = new Set<string>();
  const name = (dir: string, base: string, id: string): string => {
    let path = `${dir}/${base}`;
    if (used.has(path.toLowerCase())) path = `${dir}/${base} ${hash6(id)}`; // APFS is case-insensitive
    used.add(path.toLowerCase()); return path;
  };
  const docPath = new Map<string, string>(), adrPath = new Map<string, string>();
  for (const d of adrs) {
    const n = `ADR-${String(d.number).padStart(4, '0')}`;
    const p = name('ADRs', `${n} ${safeName(d.title as string, 50)} (${projName.get(d.project as string)})`, d.id as string);
    docPath.set(d.id as string, p); adrPath.set(d.id as string, p);
  }
  for (const d of recipes) docPath.set(d.id as string, name('Recipes', `${safeName(d.title as string, 50)} ${(d.id as string).slice(0, 6)}`, d.id as string));
  const lessonPath = new Map(lessonRows.map(l => [l.id as string, name('Lessons', `${l.kind} ${safeName(l.text as string, 50)} ${(l.id as string).slice(0, 6)}`, l.id as string)]));
  const room = Math.max(0, Math.min(caps.sessions, avail - paths.length)); // projects come first
  const history = historyAll.slice(0, room);
  // With prompts off, a title taken from a prompt (hook captures, rows with prompts) must not leak.
  const titleOf = (h: Row): string => !options.prompts && (h.prompts !== null || (h.evidence as string).startsWith('["hook:'))
    ? `${h.source} session ${(h.id as string).slice(0, 6)}` : (h.title as string).replace(/\s+/g, ' ').slice(0, 120);
  const sessionPath = new Map(history.map(h => [h.id as string, name('Sessions', `${iso(h.at as number).slice(0, 10)} ${safeName(titleOf(h), 50)} ${(h.id as string).slice(0, 6)}`, h.id as string)]));

  const notes = new Map<string, string>();
  const idLinks = (text: string, targets: Map<string, string>[]): string[] =>
    [...new Set(text.match(/\b[0-9a-f]{16}\b/g) ?? [])].flatMap(id => targets.map(t => t.get(id)).filter((p): p is string => !!p)).map(link);
  const list = (items: string[]): string => items.length ? items.map(i => `- ${i}`).join('\n') : 'None';

  for (const h of history) {
    const signals = json<Record<string, unknown> | null>(h.signals, null);
    const prompts = json<string[] | null>(h.prompts, null);
    const files = json<string[]>(h.files, []), attach = json<string[]>(h.attachments, []);
    const href = (f: string): string => pathToFileURL(isAbsolute(f) ? f : join(brainDir, f)).href;
    notes.set(sessionPath.get(h.id as string)!, frontmatter({ type: 'session', project: h.project as string, status: h.outcome as string,
      date: iso(h.at as number), id: h.id as string, source: h.source as string, title: titleOf(h) })
      + `\n# ${esc(titleOf(h))}\n\nProject: ${projLink(h.project)}\n\n- Source: ${h.source}\n- Outcome: ${esc(h.outcome as string)}\n\n## Summary\n${esc(h.summary as string)}\n`
      + (signals ? `\n## Signals\n${list(['prompts', 'corrections', 'model', 'toolErrors'].map(k => `${k}: ${String(signals[k] ?? 'n/a')}`))}\n` : '')
      + `\n## Changed files\n${list(files.map(f => `\`${f.replace(/`/g, '')}\``))}\n`
      + (attach.length ? `\n## Attachments\n${list(attach.map(a => `<${href(a)}>`))}\n` : '')
      + (options.prompts && prompts?.length ? `\n## Prompts\n${prompts.map((p, i) => `${i + 1}.\n\n${fence(p)}`).join('\n\n')}\n` : ''));
  }
  for (const d of adrs) {
    const other = (id: unknown): string[] => typeof id === 'string' && adrPath.has(id) ? [link(adrPath.get(id)!)] : [];
    notes.set(docPath.get(d.id as string)!, frontmatter({ type: 'adr', project: d.project as string, status: d.status as string, number: d.number as number,
      date: iso(d.created_at as number), updated: iso(d.updated_at as number), id: d.id as string, title: d.title as string })
      + `\nProject: ${projLink(d.project)}\n\nSupersedes: ${other(d.supersedes).join(', ') || 'None'}\nSuperseded by: ${other(d.superseded_by).join(', ') || 'None'}\n\n${esc(d.body as string)}\n`);
  }
  for (const d of recipes) {
    const sessions = idLinks(`${d.body} ${d.session ?? ''}`, [sessionPath]);
    notes.set(docPath.get(d.id as string)!, frontmatter({ type: 'recipe', project: d.project as string, status: d.status as string,
      date: iso(d.created_at as number), id: d.id as string, title: d.title as string })
      + `\nProject: ${projLink(d.project)}\n${sessions.length ? `\nSessions: ${sessions.join(', ')}\n` : ''}\n${esc(d.body as string)}\n`);
  }
  for (const l of lessonRows) {
    const evidence = idLinks(`${l.reason} ${json<string[]>(l.evidence, []).join(' ')}`, [sessionPath, docPath]);
    notes.set(lessonPath.get(l.id as string)!, frontmatter({ type: 'lesson', kind: l.kind as string, project: (l.project as string | null), status: l.status as string,
      date: iso(l.created_at as number), id: l.id as string })
      + `\n# ${esc(l.text as string).replace(/\s+/g, ' ').slice(0, 120)}\n\nProject: ${projLink(l.project)}\n\n- Kind: ${l.kind}\n- Status: ${l.status}\n\n## Text\n${esc(l.text as string)}\n\n## Reason\n${esc(l.reason as string)}\n`
      + (evidence.length ? `\n## Evidence\n${list(evidence)}\n` : ''));
  }
  const hub = (title: string, front: Record<string, string | number | null | string[]>, own: (r: Row) => boolean, mine: (p: string | null) => boolean): string => {
    const sec = (head: string, items: string[]): string => items.length ? `\n## ${head}\n${list(items)}\n` : '';
    return frontmatter(front) + `\n# ${title}\n` + sec('ADRs', adrs.filter(own).map(d => `${link(docPath.get(d.id as string)!)} (${d.status})`))
      + sec('Recipes', recipes.filter(own).map(d => link(docPath.get(d.id as string)!)))
      + sec('Lessons', lessonRows.filter(l => mine(l.project as string | null)).map(l => `${link(lessonPath.get(l.id as string)!)} (${l.status})`))
      + sec(`Latest sessions (up to ${caps.perProject})`, history.filter(own).slice(0, caps.perProject).map(h => link(sessionPath.get(h.id as string)!)));
  };
  for (const p of paths) notes.set(`Projects/${projName.get(p)}`, hub(basename(p), { type: 'project', project: p, name: projName.get(p)!,
    sessions: history.filter(h => h.project === p).length }, r => r.project === p, x => x === p));
  notes.set('Global', hub('Global', { type: 'project', project: null, name: 'Global' }, () => false, x => x === null));
  const c: Counts = { projects: paths.length, sessions: history.length, adrs: adrs.length, recipes: recipes.length, lessons: lessonRows.length, notes: notes.size + 1 };
  notes.set('index', frontmatter({ type: 'index', generated: now.toISOString() }) + `\n# ForgeMind brain\n\nGenerated ${now.toISOString()}. Read-only view; regenerated by \`brain export --obsidian\`.\n\n`
    + list(Object.entries(c).map(([k, v]) => `${k}: ${v}`)) + `\n\n## Projects\n${list(paths.map(p => link(`Projects/${projName.get(p)}`)))}\n- ${link('Global')}\n`);
  const omitted = historyTotal - history.length + dropped;
  return { notes, counts: c, omitted, hidden };
}
