import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BrainStore, containsSecret } from './brain.js';
import type { BrainKind } from './brain.js';
import { buildPrompt } from './reflect-prompt.js';

/** Takes the prompt, returns the model's answer text. Injected in tests. */
export type ModelRunner = (prompt: string) => string;
export interface Packet { text: string; ids: Set<string>; entryIds: Map<string, string | null>; projects: Set<string> }
export const PACKET_LIMIT = 60000;
const ENTRY_BUDGET = 12000;
const DAY = 86400000;

// No tools and no MCP servers, so transcript text cannot trigger actions; sonnet is the current alias.
export const claudeArgs = ['-p', '--output-format', 'json', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
export const defaultRunner: ModelRunner = prompt => {
  const r = spawnSync('claude', claudeArgs, { input: prompt, encoding: 'utf8', timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`model run failed: ${r.error?.message ?? r.stderr.slice(0, 200)}`);
  const body = JSON.parse(r.stdout) as { result?: unknown; is_error?: unknown };
  if (body.is_error || typeof body.result !== 'string') throw new Error('model run failed: bad envelope');
  return body.result;
};

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
export function buildPacket(directory: string, days: number, now = Date.now()): Packet {
  new BrainStore(directory).close(); // opens and migrates; the reads below are my own SQL
  const db = new DatabaseSync(join(directory, 'brain.sqlite'), { readOnly: true });
  try {
    const since = now - days * DAY;
    const items: { project: string; at: number; id: string; line: string }[] = [];
    for (const r of db.prepare('SELECT * FROM history WHERE at >= ? ORDER BY at DESC').all(since))
      items.push({ project: r.project as string, at: r.at as number, id: r.id as string, line: sessionLine(r) });
    for (const r of db.prepare("SELECT * FROM documents WHERE kind = 'recipe' AND updated_at >= ? ORDER BY updated_at DESC").all(since))
      items.push({ project: r.project as string, at: r.updated_at as number, id: r.id as string, line: recipeLine(r) });
    const entryLines: string[] = [], entryIds = new Map<string, string | null>();
    let used = 0;
    for (const r of db.prepare("SELECT * FROM entries WHERE status IN ('approved','proposed') ORDER BY status, created_at DESC").all()) {
      const line = JSON.stringify({ t: 'entry', id: r.id, status: r.status, kind: r.kind, project: r.project, text: clip(r.text, 300) });
      if (used + line.length + 1 > ENTRY_BUDGET) break;
      used += line.length + 1; entryLines.push(line); entryIds.set(r.id as string, r.project as string | null);
    }
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
    const text = [`window: last ${days} days; ${lines.length} sessions/recipes`, ...lines, ...entryLines].join('\n');
    return { text, ids, entryIds, projects };
  } finally { db.close(); }
}

export interface Proposal { project: string | null; kind: BrainKind; text: string; reason: string; evidence: string[] }
export interface Parsed { proposals: Proposal[]; retire: { id: string; reason: string }[]; duplicates: { keep: string; drop: string[]; reason: string }[]; summary: string }
const kinds = ['lesson', 'convention', 'pattern', 'decision'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Strictly validate the model's answer; anything off-schema or unknown to the packet is dropped. Never throws on content. */
export function parseAnswer(raw: string, packet: Packet): Parsed {
  const out: Parsed = { proposals: [], retire: [], duplicates: [], summary: '' };
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  let data: unknown;
  try { data = JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error('model answer is not valid JSON'); }
  if (!isObj(data)) throw new Error('model answer is not a JSON object');
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
  const approvedId = (id: unknown): id is string => typeof id === 'string' && packet.entryIds.has(id);
  for (const r of Array.isArray(data.retire) ? data.retire : [])
    if (isObj(r) && approvedId(r.id)) out.retire.push({ id: r.id, reason: clip(r.reason, 500) });
  for (const d of Array.isArray(data.duplicates) ? data.duplicates : []) {
    if (!isObj(d) || !approvedId(d.keep)) continue;
    const drop = strs(d.drop).filter(id => packet.entryIds.has(id) && id !== d.keep);
    if (drop.length) out.duplicates.push({ keep: d.keep, drop, reason: clip(d.reason, 500) });
  }
  return out;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export function reportMarkdown(parsed: Parsed, proposed: { id: string; proposal: Proposal }[], entries: Map<string, string | null>, now: Date): string {
  const lines = [`# Reflect report ${now.toISOString()}`, '', parsed.summary || '(no summary)', '', '## Proposed (pending your approval)', ''];
  if (!proposed.length) lines.push('Nothing proposed.');
  for (const { id, proposal: p } of proposed) lines.push(`- \`${id}\` [${p.kind}] ${p.project ?? 'all projects'}: ${p.text}`, `  - reason: ${p.reason}`, `  - evidence: ${p.evidence.join(', ')}`);
  lines.push('', '## Suggested retirements (not applied)', '');
  if (!parsed.retire.length) lines.push('None.');
  for (const r of parsed.retire) lines.push(`- \`${r.id}\`: ${r.reason}`);
  lines.push('', '## Suggested merges (not applied)', '');
  if (!parsed.duplicates.length) lines.push('None.');
  for (const d of parsed.duplicates) lines.push(`- keep \`${d.keep}\`, drop ${d.drop.map(x => `\`${x}\``).join(', ')}: ${d.reason}`);
  const by = (list: { id: string; project: string | null }[]) => {
    const m = new Map<string, string[]>();
    for (const { id, project } of list) m.set(project ?? '<project>', [...(m.get(project ?? '<project>') ?? []), id]);
    return m;
  };
  const cmds: string[] = [];
  for (const [ws, ids] of by(proposed.map(({ id, proposal }) => ({ id, project: proposal.project }))))
    cmds.push(`npm run brain -- approve --workspace ${q(ws)} --ids ${ids.join(',')}`, `npm run brain -- reject --workspace ${q(ws)} --ids ${ids.join(',')} --note "not useful"`);
  for (const [ws, ids] of by(parsed.retire.map(r => ({ id: r.id, project: entries.get(r.id) ?? null }))))
    cmds.push(`npm run brain -- retire --workspace ${q(ws)} --ids ${ids.join(',')}`);
  lines.push('', '## Commands (review, then run what you agree with; `<project>` = a workspace that can see the entry)', '', '```', ...cmds, '```', '');
  return lines.join('\n');
}

function withLock<T>(directory: string, work: () => T): T {
  const lock = join(directory, 'lock');
  try { if (Date.now() - statSync(lock).mtimeMs > 1800000) rmSync(lock); } catch { /* none */ }
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

export function reflect(brainDir: string, options: { days: number; dryRun?: boolean; run?: ModelRunner | undefined; now?: Date }): Record<string, unknown> {
  const now = options.now ?? new Date();
  const packet = buildPacket(brainDir, options.days, now.getTime());
  const prompt = buildPrompt(packet.text);
  if (options.dryRun) return { packetChars: packet.text.length, sessionsAndRecipes: packet.ids.size, prompt };
  const dir = reflectDirectory(brainDir);
  return withLock(dir, () => {
    const parsed = parseAnswer((options.run ?? defaultRunner)(prompt), packet);
    const store = new BrainStore(brainDir);
    const proposed: { id: string; proposal: Proposal }[] = [];
    try {
      for (const proposal of parsed.proposals) {
        try { proposed.push({ id: store.propose({ ...proposal, reason: `reflect: ${proposal.reason}` }), proposal }); } catch { /* refused proposals are dropped */ }
      }
    } finally { store.close(); }
    const p = (n: number) => String(n).padStart(2, '0');
    const path = join(dir, `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.md`);
    writeFileSync(path, reportMarkdown(parsed, proposed, packet.entryIds, now), { mode: 0o600 });
    chmodSync(path, 0o600);
    return { report: path, proposed: proposed.map(x => x.id), retire: parsed.retire.length, duplicates: parsed.duplicates.length };
  });
}
