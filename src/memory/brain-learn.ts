import type { BrainKind } from './brain.js';

export interface BrainProposal { kind: BrainKind; text: string; evidence: string[]; reason: string }
export type Runner = (args: string[]) => string;
export interface LearnOptions { run: Runner; limit?: number }

const MAX_TEXT = 300;
const pct = (n: number, m: number): number => Math.round(100 * n / m);
const share = (n: number, m: number): string => `${n} of ${m} (${pct(n, m)}%)`;
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function top(counter: Map<string, number>, k = 3): [string, number][] {
  return [...counter.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, k);
}
const safeToken = (s: string): boolean => /^[a-z0-9][a-z0-9._-]{0,29}$/.test(s);
const safeHeading = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9 &()/-]{0,39}$/.test(s);
const cap = (s: string): string => s.slice(0, MAX_TEXT);
const list = (c: Map<string, number>): string => top(c).map(([k, n]) => `${k} (${n})`).join(', ');
function bump(c: Map<string, number>, key: string): void { c.set(key, (c.get(key) ?? 0) + 1); }

function limitOf(options: LearnOptions): number {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid limit');
  return limit;
}

const conventional = /^([a-z]+)(?:\(([^)]+)\))?!?: \S/;

export function learnFromGit(options: LearnOptions): BrainProposal[] {
  const limit = limitOf(options);
  const out = options.run(['log', '-n', String(limit), '--no-merges', '--format=%x1e%H%x1f%s%x1f%(trailers:only,unfold)%x1f', '--shortstat']);
  const commits: { hash: string; subject: string; trailers: string; files: number }[] = [];
  for (const record of String(out).split('\u001e')) {
    if (record.trim() === '') continue;
    const f = record.split('\u001f');
    if (f.length < 4) continue;
    const hash = f[0]!.trim();
    if (!/^[0-9a-f]{1,64}$/.test(hash)) continue;
    const stat = f.slice(3).join(' ');
    const m = /(\d+) files? changed/.exec(stat) ?? /^\s*(\d+)\s*$/.exec(stat);
    commits.push({ hash, subject: f[1]!, trailers: f[2]!, files: m ? Number(m[1]) : 0 });
  }
  const total = commits.length;
  if (total < 3) return [];
  const reason = `Learned from git history (${total} commits).`;
  const ev = (cs: typeof commits): string[] => cs.slice(0, 5).map(c => `git:${c.hash.slice(0, 7)}`);
  const proposals: BrainProposal[] = [];

  const types = new Map<string, number>(), scopes = new Map<string, number>();
  const matching = commits.filter(c => conventional.test(c.subject));
  for (const c of matching) {
    const m = conventional.exec(c.subject)!;
    if (safeToken(m[1]!)) bump(types, m[1]!);
    if (m[2] !== undefined && safeToken(m[2])) bump(scopes, m[2]);
  }
  let text = `Commit subjects follow type(scope): description in ${share(matching.length, total)}.`;
  if (types.size) text += ` Common types: ${list(types)}.`;
  if (scopes.size) text += ` Common scopes: ${list(scopes)}.`;
  proposals.push({ kind: 'convention', text: cap(text), evidence: ev(matching.length ? matching : commits), reason });

  const co = commits.filter(c => /^co-authored-by:/im.test(c.trailers));
  proposals.push({ kind: 'convention', text: cap(`Commits carry a Co-Authored-By trailer in ${share(co.length, total)}.`),
    evidence: ev(co.length ? co : commits), reason });

  proposals.push({ kind: 'pattern', text: cap(`The median commit changes ${median(commits.map(c => c.files))} files (${total} commits).`),
    evidence: ev(commits), reason });

  try {
    const refs = String(options.run(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])).split('\n');
    const prefixes = new Map<string, number>();
    let branches = 0;
    for (const line of refs) {
      const rest = line.trim().split('/').slice(1).join('/');
      if (rest === '' || rest === 'HEAD' || rest === 'main' || rest === 'master') continue;
      branches++;
      const i = rest.indexOf('/');
      if (i > 0 && safeToken(rest.slice(0, i))) bump(prefixes, rest.slice(0, i + 1));
    }
    const best = top(prefixes, 1)[0];
    if (best && best[1] >= 2) {
      proposals.push({ kind: 'convention', text: cap(`Remote branches most often use the prefix ${best[0]} (${best[1]} of ${branches} branches, ${pct(best[1], branches)}%).`),
        evidence: [`branch:${best[0]}`], reason });
    }
  } catch { /* branch data is optional */ }
  return proposals;
}

const prUrl = /^https:\/\/[A-Za-z0-9.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

export function learnFromGitHub(options: LearnOptions): BrainProposal[] {
  const limit = limitOf(options);
  const parsed: unknown = JSON.parse(options.run(['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', 'number,url,title,body,reviews']));
  if (!Array.isArray(parsed)) throw new Error('unexpected gh output');
  const prs: { url: string; title: string; body: string; reviews: unknown[] }[] = [];
  for (const item of parsed as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.url !== 'string' || !prUrl.test(o.url)) continue;
    prs.push({ url: o.url, title: typeof o.title === 'string' ? o.title : '', body: typeof o.body === 'string' ? o.body : '',
      reviews: Array.isArray(o.reviews) ? o.reviews as unknown[] : [] });
  }
  const total = prs.length;
  if (total < 3) return [];
  const reason = `Learned from merged GitHub PRs (${total} PRs).`;
  const urls = (ps: typeof prs): string[] => ps.slice(0, 5).map(p => p.url);
  const proposals: BrainProposal[] = [];

  const types = new Map<string, number>();
  const matching = prs.filter(p => conventional.test(p.title));
  for (const p of matching) { const t = conventional.exec(p.title)![1]!; if (safeToken(t)) bump(types, t); }
  let text = `PR titles follow type(scope): description in ${share(matching.length, total)}.`;
  if (types.size) text += ` Common types: ${list(types)}.`;
  proposals.push({ kind: 'convention', text: cap(text), evidence: urls(matching.length ? matching : prs), reason });

  const counts = new Map<string, number>(), positions = new Map<string, number>();
  for (const p of prs) {
    const seen: string[] = [];
    for (const m of p.body.matchAll(/^## (.+)$/gm)) {
      const h = m[1]!.trim();
      if (safeHeading(h) && !seen.includes(h)) seen.push(h);
    }
    seen.forEach((h, i) => { bump(counts, h); positions.set(h, (positions.get(h) ?? 0) + i); });
  }
  const need = Math.ceil(total / 2);
  const headings = [...counts.entries()].filter(([, n]) => n >= need)
    .map(([h, n]) => ({ h, mean: positions.get(h)! / n }))
    .sort((a, b) => a.mean - b.mean || (a.h < b.h ? -1 : a.h > b.h ? 1 : 0)).map(x => `## ${x.h}`);
  if (headings.length) {
    proposals.push({ kind: 'convention', text: cap(`PR bodies usually contain the sections ${headings.join(', ')} (in at least half of ${total} PRs).`),
      evidence: urls(prs), reason });
  }

  const sent = prs.filter(p => p.reviews.some(r => !!r && typeof r === 'object' && (r as Record<string, unknown>).state === 'CHANGES_REQUESTED'));
  proposals.push({ kind: 'pattern', text: cap(`Reviews sent back ${sent.length} of ${total} merged PRs (${pct(sent.length, total)}%) with requested changes.`),
    evidence: urls(sent.length ? sent : prs), reason });
  return proposals;
}
