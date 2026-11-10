import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BrainStore, containsSecret } from './brain.js';
import type { BrainKind } from './brain.js';
import { buildPrompt } from './reflect-prompt.js';
import { clientSources, planFor } from './reflect-runners.js';
import type { ModelRunner, Spawn } from './reflect-runners.js';

export type { ModelRunner } from './reflect-runners.js';
export { claudeArgs, makeRunner } from './reflect-runners.js';
export interface Packet { text: string; ids: Set<string>; entryIds: Map<string, { project: string | null; status: string }>; projects: Set<string> }
export const PACKET_LIMIT = 60000;
const ENTRY_BUDGET = 12000;
const DAY = 86400000;

export interface Filter { sources: string[]; projects?: string[] | undefined }
// codex is opt-in: its runner is untested.
// Only claude can run with tools, MCP, hooks and plugins all off; cursor and codex are opt-in (see docs: Runners and isolation).
export const defaultSources: string[] = ['claude-code'];

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v : '').slice(0, n);
const json = <T>(v: unknown, fallback: T): T => { try { return typeof v === 'string' ? JSON.parse(v) as T : fallback; } catch { return fallback; } };

function sessionLine(row: Record<string, unknown>): string {
  const signals = json<Record<string, unknown> | null>(row.signals, null);
  const prompts = json<unknown[]>(row.prompts, []).filter((p): p is string => typeof p === 'string');
  const corrections = signals && Array.isArray(signals.correctionIndexes) ? signals.correctionIndexes.filter((i): i is number => Number.isInteger(i)) : [];
  // A correction at index i corrects the prompt before it; sessions with no corrections show their own prompts as the working examples.
  let shown: string[] = [];
  if (corrections.length) shown = corrections.filter(i => i >= 1 && i <= prompts.length).map(i => prompts[i - 1]!);
  else if (signals && signals.corrections === 0) shown = prompts;
  return JSON.stringify({ t: 'session', id: row.id, project: row.project, title: clip(row.title, 200), outcome: clip(row.outcome, 100),
    at: new Date(row.at as number).toISOString(), signals: signals && { prompts: signals.prompts, corrections: signals.corrections,
      correctionIndexes: signals.correctionIndexes, model: signals.model, toolErrors: signals.toolErrors },
    prompts: shown.slice(0, 6).map(p => clip(p, 600)) });
}
function recipeLine(row: Record<string, unknown>): string {
  const f = json<Record<string, unknown>>(row.fields, {});
  const list = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, 6).map(x => clip(x, 400));
  return JSON.stringify({ t: 'recipe', id: row.id, project: row.project, title: clip(row.title, 200), goal: clip(f.goal, 500), plan: clip(f.plan, 800),
    prompts: list(f.prompts), deadEnds: list(f.deadEnds), verification: clip(f.verification, 400), outcome: clip(f.outcome, 300) });
}

/** The last `days` of history and recipes across all projects, newest first, shared fairly between projects. */
export function buildPacket(directory: string, days: number, now = Date.now(), filter: Filter = { sources: defaultSources }): Packet {
  new BrainStore(directory).close(); // opens and migrates; the reads below are my own SQL
  const db = new DatabaseSync(join(directory, 'brain.sqlite'), { readOnly: true });
  try {
    const since = now - days * DAY;
    const marks = (list: string[]) => list.map(() => '?').join(',');
    const only = `source IN (${marks(filter.sources)})${filter.projects ? ` AND project IN (${marks(filter.projects)})` : ''}`;
    const args = [...filter.sources, ...(filter.projects ?? [])];
    const items: { project: string; at: number; id: string; line: string }[] = [];
    for (const r of db.prepare(`SELECT * FROM history WHERE at >= ? AND ${only} ORDER BY at DESC`).all(since, ...args))
      items.push({ project: r.project as string, at: r.at as number, id: r.id as string, line: sessionLine(r) });
    for (const r of db.prepare(`SELECT * FROM documents WHERE kind = 'recipe' AND updated_at >= ? AND ${only} ORDER BY updated_at DESC`).all(since, ...args))
      items.push({ project: r.project as string, at: r.updated_at as number, id: r.id as string, line: recipeLine(r) });
    const queues = new Map<string, typeof items>();
    for (const item of items.sort((a, b) => b.at - a.at)) queues.set(item.project, [...(queues.get(item.project) ?? []), item]);
    let budget = PACKET_LIMIT - ENTRY_BUDGET - 200;
    const ids = new Set<string>(), lines: string[] = [], projects = new Set<string>();
    // Round-robin across projects so a busy project cannot crowd out the others.
    for (let live = true; live && budget > 0;) {
      live = false;
      for (const queue of queues.values()) {
        const item = queue.shift();
        if (!item) continue;
        live = true;
        if (item.line.length + 1 > budget) { queue.length = 0; continue; }
        budget -= item.line.length + 1; lines.push(item.line); ids.add(item.id); projects.add(item.project);
      }
    }
    // Entries of a project that is not in this packet stay out, so one source never learns another source's projects.
    const entryLines: string[] = [], entryIds: Packet['entryIds'] = new Map();
    let used = 0;
    for (const r of db.prepare("SELECT * FROM entries WHERE status IN ('approved','proposed') ORDER BY status, created_at DESC").all()) {
      if (r.project !== null && !projects.has(r.project as string)) continue;
      const line = JSON.stringify({ t: 'entry', id: r.id, status: r.status, kind: r.kind, project: r.project, text: clip(r.text, 300) });
      if (used + line.length + 1 > ENTRY_BUDGET) break;
      used += line.length + 1; entryLines.push(line); entryIds.set(r.id as string, { project: r.project as string | null, status: r.status as string });
    }
    const text = [`window: last ${days} days; ${lines.length} sessions/recipes`, ...lines, ...entryLines].join('\n');
    return { text, ids, entryIds, projects };
  } finally { db.close(); }
}

export interface Proposal { project: string | null; kind: BrainKind; text: string; reason: string; evidence: string[] }
export interface Parsed { proposals: Proposal[]; retire: { id: string; reason: string }[]; duplicates: { keep: string; drop: string[]; reason: string }[]; summary: string }
const kinds = ['lesson', 'convention', 'pattern', 'decision'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const schemaKeys = ['proposals', 'retire', 'duplicates', 'summary'];
function extractJson(raw: string): Record<string, unknown> {
  const text = raw.trim();
  const tries = [text, /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)?.[1] ?? ''];
  for (const t of tries) { try { const v: unknown = JSON.parse(t); if (isObj(v)) return v; } catch { /* next */ } }
  // Last resort for prose around the JSON: try bounded brace pairs until one parses as an object with a schema key.
  const starts = [...text.matchAll(/\{/g)].map(m => m.index).slice(0, 20);
  const ends = [...text.matchAll(/\}/g)].map(m => m.index).slice(-20).reverse();
  for (const a of starts) for (const b of ends) if (b > a) {
    try { const v: unknown = JSON.parse(text.slice(a, b + 1)); if (isObj(v) && schemaKeys.some(k => k in v)) return v; } catch { /* next */ }
  }
  throw new Error('model answer is not valid JSON');
}

/** Strictly validate the model's answer; anything off-schema or unknown to the packet is dropped. Never throws on content. */
export function parseAnswer(raw: string, packet: Packet): Parsed {
  const out: Parsed = { proposals: [], retire: [], duplicates: [], summary: '' };
  const data = extractJson(raw);
  out.summary = clip(data.summary, 1000);
  for (const p of Array.isArray(data.proposals) ? data.proposals : []) {
    if (out.proposals.length >= 10) break;
    if (!isObj(p) || typeof p.text !== 'string' || typeof p.kind !== 'string' || !kinds.includes(p.kind)) continue;
    const project = p.project === null || p.project === undefined ? null : typeof p.project === 'string' && packet.projects.has(p.project) ? p.project : undefined;
    const evidence = strs(p.evidence).filter(id => packet.ids.has(id));
    const reason = clip(p.reason, 1900);
    if (project === undefined || !evidence.length || p.text.length < 1 || p.text.length > 300) continue;
    if (containsSecret(p.text) || containsSecret(reason)) continue;
    out.proposals.push({ project, kind: p.kind as BrainKind, text: p.text, reason, evidence });
  }
  const approvedId = (id: unknown): id is string => typeof id === 'string' && packet.entryIds.get(id)?.status === 'approved';
  for (const r of Array.isArray(data.retire) ? data.retire : [])
    if (isObj(r) && approvedId(r.id)) out.retire.push({ id: r.id, reason: clip(r.reason, 500) });
  for (const d of Array.isArray(data.duplicates) ? data.duplicates : []) {
    if (!isObj(d) || !approvedId(d.keep)) continue;
    const drop = strs(d.drop).filter(id => approvedId(id) && id !== d.keep);
    if (drop.length) out.duplicates.push({ keep: d.keep, drop, reason: clip(d.reason, 500) });
  }
  return out;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Model text becomes one quoted line: no headings, fences, lists or tables can be forged from it. */
const quote = (v: string): string => JSON.stringify(v.replace(/\s+/g, ' ').replace(/`/g, '').replace(/^[\s#>\-|*]+/, '').trim());
export interface SourceResult { source: string; runner: string; untested?: boolean | undefined; skipped?: string; parsed?: Parsed; proposed: { id: string; proposal: Proposal }[] }
export function reportMarkdown(results: SourceResult[], entries: Map<string, { project: string | null }>, now: Date): string {
  const lines = [`# Reflect report ${now.toISOString()}`, '', 'Each source was reflected only by its own tool, under whatever account that tool is logged into.'];
  for (const r of results) {
    lines.push('', `## Source ${r.source}`, '', `Runner: ${r.runner}${r.untested ? ' (UNTESTED)' : ''}`);
    if (r.skipped || !r.parsed) { lines.push('', `Skipped: ${r.skipped ?? 'no result'}`); continue; }
    lines.push('', `Summary (model text): ${quote(r.parsed.summary)}`, '', '### Proposed (pending your approval)', '');
    if (!r.proposed.length) lines.push('Nothing proposed.');
    for (const { id, proposal: p } of r.proposed) lines.push(`- \`${id}\` [${p.kind}] ${p.project ?? 'all projects'}: ${quote(p.text)}`, `  - reason: ${quote(p.reason)}`, `  - evidence: ${p.evidence.join(', ')}`);
    lines.push('', '### Suggested retirements (not applied)', '');
    if (!r.parsed.retire.length) lines.push('None.');
    for (const x of r.parsed.retire) lines.push(`- \`${x.id}\`: ${quote(x.reason)}`);
    lines.push('', '### Suggested merges (not applied)', '');
    if (!r.parsed.duplicates.length) lines.push('None.');
    for (const d of r.parsed.duplicates) lines.push(`- keep \`${d.keep}\`, drop ${d.drop.map(x => `\`${x}\``).join(', ')}: ${quote(d.reason)}`);
  }
  const by = (list: { id: string; project: string | null }[]) => {
    const m = new Map<string, string[]>();
    for (const { id, project } of list) m.set(project ?? '<project>', [...(m.get(project ?? '<project>') ?? []), id]);
    return m;
  };
  const cmds: string[] = [];
  for (const [ws, ids] of by(results.flatMap(r => r.proposed.map(({ id, proposal }) => ({ id, project: proposal.project })))))
    cmds.push(`npm run brain -- approve --workspace ${q(ws)} --ids ${ids.join(',')}`, `npm run brain -- reject --workspace ${q(ws)} --ids ${ids.join(',')} --note "not useful"`);
  for (const [ws, ids] of by(results.flatMap(r => (r.parsed?.retire ?? []).map(x => ({ id: x.id, project: entries.get(x.id)?.project ?? null })))))
    cmds.push(`npm run brain -- retire --workspace ${q(ws)} --ids ${ids.join(',')}`);
  lines.push('', '## Commands (review, then run what you agree with; `<project>` = a workspace that can see the entry)', '', '```', ...cmds, '```', '');
  return lines.join('\n');
}

function withLock<T>(directory: string, work: () => T): T {
  const lock = join(directory, 'lock');
  try {
    const before = statSync(lock);
    if (Date.now() - before.mtimeMs > 1800000) {
      // shortcut: a tiny window remains between this re-stat and the rm; acceptable for one owner running a job every 2 days
      const again = statSync(lock);
      if (again.ino === before.ino && again.mtimeMs === before.mtimeMs) rmSync(lock);
    }
  } catch { /* none */ }
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('another reflect run is in progress'); throw error; }
  try { return work(); } finally { closeSync(fd); rmSync(lock, { force: true }); }
}
export function reflectDirectory(brainDir: string): string {
  const dir = join(brainDir, 'reflect');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
export function lastReport(brainDir: string): { path: string; text: string } {
  const dir = reflectDirectory(brainDir);
  const name = readdirSync(dir).filter(n => /^\d{4}-\d\d-\d\d-\d{4}\.md$/.test(n)).sort().pop();
  if (!name) throw new Error('no reflect report yet');
  return { path: join(dir, name), text: readFileSync(join(dir, name), 'utf8') };
}

export interface ReflectOptions {
  days: number; filter?: Filter | undefined; dryRun?: boolean; now?: Date;
  /** Test override: used for every source instead of the tool's own CLI. */
  run?: ModelRunner | undefined; custom?: Record<string, string> | undefined; spawn?: Spawn | undefined; has?: ((command: string) => boolean) | undefined;
}
/** One packet and one model call per source, so no source's data ever reaches another tool or account. */
export function reflect(brainDir: string, options: ReflectOptions): Record<string, unknown> {
  const now = options.now ?? new Date();
  const filter = options.filter ?? { sources: defaultSources };
  const dir = reflectDirectory(brainDir);
  const packets = filter.sources.map(source => ({ source, packet: buildPacket(brainDir, options.days, now.getTime(), { ...filter, sources: [source] }) }));
  const plan = (source: string) => options.run ? { source, label: 'injected runner', run: options.run } : planFor(source, options.custom ?? {}, options.spawn, options.has);
  if (options.dryRun) return { sources: packets.map(({ source, packet }) => ({ source, packetChars: packet.text.length, sessionsAndRecipes: packet.ids.size,
    runner: plan(source).label, prompt: buildPrompt(packet.text) })) };
  return withLock(dir, () => {
    const results: SourceResult[] = [], entries = new Map<string, { project: string | null }>();
    const store = new BrainStore(brainDir);
    let failure: Error | undefined, succeeded = false;
    try {
      for (const { source, packet } of packets) {
        const p = plan(source);
        const base = { source, runner: p.label, untested: p.untested, proposed: [] as SourceResult['proposed'] };
        if (!packet.ids.size) { results.push({ ...base, skipped: 'no sessions or recipes in the window' }); continue; }
        if (!p.run) { results.push({ ...base, skipped: p.skip ?? 'no runner' }); continue; }
        try {
          const parsed = parseAnswer(p.run(buildPrompt(packet.text), source === 'claude-code' ? dir : join(dir, `run-${source}`)), packet);
          for (const [id, e] of packet.entryIds) entries.set(id, e);
          for (const proposal of parsed.proposals) {
            try { base.proposed.push({ id: store.propose({ ...proposal, reason: `reflect: ${proposal.reason}` }), proposal }); } catch { /* refused proposals are dropped */ }
          }
          results.push({ ...base, parsed }); succeeded = true;
        } catch (error) { failure ??= error as Error; results.push({ ...base, skipped: `failed: ${(error as Error).message.slice(0, 200)}` }); }
      }
    } finally { store.close(); }
    if (failure && !succeeded) throw failure;
    const q2 = (n: number) => String(n).padStart(2, '0');
    const path = join(dir, `${now.getFullYear()}-${q2(now.getMonth() + 1)}-${q2(now.getDate())}-${q2(now.getHours())}${q2(now.getMinutes())}.md`);
    const proposed = results.flatMap(r => r.proposed.map(x => x.id));
    let report: string | undefined, reportError: string | undefined;
    try { writeFileSync(path, reportMarkdown(results, entries, now), { mode: 0o600 }); chmodSync(path, 0o600); report = path; }
    catch (error) { reportError = (error as Error).message; } // the proposals are already stored; never lose their ids
    return { ...(report ? { report } : { reportError, note: 'report not written; proposals above are stored as proposed' }), proposed,
      retire: results.reduce((n, r) => n + (r.parsed?.retire.length ?? 0), 0), duplicates: results.reduce((n, r) => n + (r.parsed?.duplicates.length ?? 0), 0),
      sources: results.map(r => ({ source: r.source, status: r.skipped ?? 'ok' })) };
  });
}
