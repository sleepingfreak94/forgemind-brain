import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBrainCli } from '../src/cli.js';
import { BrainStore } from '../src/brain.js';
import { acceptAdr, createAdr, createRecipe } from '../src/documents.js';
import { reflect } from '../src/reflect.js';
import { exportVault } from '../src/vault.js';
import { safeName } from '../src/vault-notes.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-vault-')));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const signals = { prompts: 2, corrections: 1, correctionIndexes: [1], model: 'm1', assistantTurns: 3, toolErrors: 2, durationMs: null };
const adr = (title: string, supersedes?: string) => ({ title, context: 'c', decision: 'd', alternatives: 'a', consequences: 'q', supersedes });
const opts = { prompts: true, includeProposed: false };

function seed() {
  const base = join(root, `c${n++}`), brain = join(base, 'brain');
  const pa = join(base, 'alpha'), pb = join(base, 'beta');
  const store = new BrainStore(brain);
  const rec = (project: string, key: string, title: string) => store.record({ project, source: 'claude-code', key, title, summary: 'did things', files: ['src/a.ts'],
    outcome: 'ok', evidence: [], prompts: ['first <script>alert(1)</script> prompt', 'no, with ``` fence'], signals });
  const s1 = rec(pa, 'k1', 'He said "hi": a\nb'), s2 = rec(pa, 'k2', 'second'), s3 = rec(pb, 'k3', 'beta work');
  const a1 = createAdr(store, pa, 'cli', null, adr('Use sqlite')); acceptAdr(store, pa, 'ADR-1');
  const a2 = createAdr(store, pa, 'cli', null, adr('Use sqlite WAL', 'ADR-1')); acceptAdr(store, pa, 'ADR-2');
  const r = createRecipe(store, pa, 'cli', null, { goal: `Ship it ${s1}`, plan: 'p', prompts: [], deadEnds: [], verification: 'v', outcome: 'o', files: [] });
  const approved = store.propose({ kind: 'lesson', project: pa, text: 'Prefer small PRs', reason: `reflect: worked in ${s1} and ${r.id}`, evidence: [s2] }); store.approve(approved);
  const proposed = store.propose({ kind: 'pattern', project: pb, text: 'Pending idea', reason: 'r', evidence: [] });
  const global = store.propose({ kind: 'convention', project: null, text: 'Always test', reason: 'r', evidence: [] }); store.approve(global);
  store.close();
  return { base, brain, pa, pb, ids: { s1, s2, s3, a1, a2, r: r.id, approved, proposed, global } };
}
const files = (dir: string, sub: string) => readdirSync(join(dir, sub));
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');
const exported = (brain: string, to: string, extra = {}) => exportVault(brain, { ...opts, to, ...extra });

test('notes, frontmatter and wikilinks', () => {
  const s = seed(), to = join(s.base, 'v');
  const r = exported(s.brain, to) as any;
  assert.deepEqual(r.counts, { projects: 2, sessions: 3, adrs: 2, recipes: 1, lessons: 2, notes: 12 });
  assert.equal(r.truncated, false);
  assert.ok(existsSync(join(to, '.forgemind-vault')));
  assert.deepEqual(files(to, 'Projects').sort(), ['alpha.md', 'beta.md']);
  const hub = read(to, 'Projects/alpha.md');
  assert.match(hub, /\[\[ADRs\/ADR-0002 Use sqlite WAL \(alpha\)\]\]/);
  assert.match(hub, /\[\[Lessons\/lesson Prefer small PRs /);
  assert.match(hub, /\[\[Sessions\/\d{4}-\d\d-\d\d second /);
  const a1 = read(to, `ADRs/${files(to, 'ADRs').find(f => f.startsWith('ADR-0001'))}`);
  assert.match(a1, /type: "adr"/); assert.match(a1, /Superseded by: \[\[ADRs\/ADR-0002 Use sqlite WAL \(alpha\)\]\]/); assert.match(a1, /Project: \[\[Projects\/alpha\]\]/);
  assert.match(read(to, `ADRs/${files(to, 'ADRs').find(f => f.startsWith('ADR-0002'))}`), /Supersedes: \[\[ADRs\/ADR-0001 Use sqlite \(alpha\)\]\]/);
  const recipe = read(to, `Recipes/${files(to, 'Recipes')[0]}`);
  assert.match(recipe, new RegExp(`Sessions: \\[\\[Sessions/[^\\]]*${s.ids.s1.slice(0, 6)}\\]\\]`));
  const lessons = files(to, 'Lessons');
  assert.equal(lessons.length, 2); // approved only
  const lesson = read(to, `Lessons/${lessons.find(f => f.includes('small PRs'))}`);
  assert.match(lesson, new RegExp(`\\[\\[Sessions/[^\\]]*${s.ids.s1.slice(0, 6)}\\]\\]`));
  assert.match(lesson, new RegExp(`\\[\\[Recipes/[^\\]]*${s.ids.r.slice(0, 6)}\\]\\]`));
  assert.match(lesson, new RegExp(`\\[\\[Sessions/[^\\]]*${s.ids.s2.slice(0, 6)}\\]\\]`));
  assert.match(read(to, `Lessons/${lessons.find(f => f.includes('Always test'))}`), /Project: \[\[Global\]\]/);
  assert.match(read(to, 'Global.md'), /Always test|\[\[Lessons\/convention Always test/);
  const index = read(to, 'index.md');
  assert.match(index, /projects: 2/); assert.match(index, /\[\[Projects\/beta\]\]/); assert.match(index, /Generated /);
  const session = read(to, `Sessions/${files(to, 'Sessions').find(f => f.includes('second'))}`);
  assert.match(session, /- Source: claude-code/); assert.match(session, /model: m1/); assert.match(session, /toolErrors: 2/); assert.match(session, /`src\/a.ts`/);
  assert.ok(!/<script/i.test(session)); // stripped
  assert.match(session, /## Prompts/); assert.match(session, /no, with ``` fence/);
  const withProposed = exported(s.brain, join(s.base, 'v2'), { includeProposed: true }) as any;
  assert.equal(withProposed.counts.lessons, 3);
});

test('YAML escaping keeps a hostile title on one line', () => {
  const s = seed(), to = join(s.base, 'v'); exported(s.brain, to);
  const note = read(to, `Sessions/${files(to, 'Sessions').find(f => f.includes('hi'))}`);
  const fm = note.split('---\n')[1]!;
  assert.match(fm, /title: "He said \\"hi\\": a\\nb"/);
  for (const line of fm.trimEnd().split('\n')) assert.match(line, /^[a-z]+: /);
});

test('file-name sanitizing', () => {
  assert.ok(!/[/\\:*?"<>|#^[\]]/.test(safeName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')));
  assert.ok(!safeName('../../etc/passwd').includes('..'));
  assert.equal(safeName('..'), 'untitled');
  assert.ok(safeName('x'.repeat(500)).length <= 60);
  const s = seed(); const store = new BrainStore(s.brain);
  store.record({ project: s.pa, source: 'cursor', key: 'evil', title: '../../escape/'.repeat(20), summary: '', files: [], outcome: 'ok', evidence: [] }); store.close();
  const to = join(s.base, 'v'); exported(s.brain, to);
  assert.ok(!existsSync(join(s.base, 'escape')));
  for (const f of files(to, 'Sessions')) assert.ok(f.length < 120 && !f.includes('..'));
});

test('--no-prompts leaves the exact prompts out', () => {
  const s = seed(), to = join(s.base, 'v'); exported(s.brain, to, { prompts: false });
  for (const f of files(to, 'Sessions')) assert.ok(!read(to, `Sessions/${f}`).includes('## Prompts'));
});

test('refuses unmarked non-empty dir, repo dir, relative path; warns for cloud folders', () => {
  const s = seed(), user = join(s.base, 'mine'); mkdirSync(user); writeFileSync(join(user, 'note.md'), 'x');
  assert.throws(() => exported(s.brain, user), /not a ForgeMind vault/);
  assert.equal(readFileSync(join(user, 'note.md'), 'utf8'), 'x');
  const repo = join(s.base, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true });
  assert.throws(() => exported(s.brain, join(repo, 'sub', 'vault')), /git repository/);
  assert.ok(existsSync((exported(s.brain, join(repo, 'ok'), { allowRepo: true }) as any).vault as string));
  assert.throws(() => exported(s.brain, 'relative/dir'), /absolute/);
  const empty = join(s.base, 'empty'); mkdirSync(empty);
  assert.deepEqual((exported(s.brain, empty) as any).warnings, []);
  assert.equal(((exported(s.brain, join(s.base, 'Dropbox', 'v')) as any).warnings as string[]).length, 1);
});

test('regeneration keeps .obsidian and code, drops stale notes, and sets private modes', () => {
  const s = seed(), to = join(s.base, 'v'); exported(s.brain, to);
  mkdirSync(join(to, '.obsidian')); writeFileSync(join(to, '.obsidian/app.json'), '{}');
  mkdirSync(join(to, 'code/repo'), { recursive: true }); writeFileSync(join(to, 'code/repo/g.md'), 'g');
  writeFileSync(join(to, 'stale.md'), 's');
  exported(s.brain, to);
  assert.equal(read(to, '.obsidian/app.json'), '{}'); assert.equal(read(to, 'code/repo/g.md'), 'g');
  assert.ok(!existsSync(join(to, 'stale.md')));
  assert.deepEqual(readdirSync(s.base).filter(f => f.startsWith('v.')), []);
  for (const rel of ['', 'Sessions', 'Projects']) assert.equal(statSync(join(to, rel)).mode & 0o777, 0o700);
  for (const rel of ['index.md', '.forgemind-vault', `Projects/alpha.md`]) assert.equal(statSync(join(to, rel)).mode & 0o777, 0o600);
  assert.equal(statSync(join(s.brain, 'vault-config.json')).mode & 0o777, 0o600);
});

test('caps truncate and report', () => {
  const s = seed(), to = join(s.base, 'v');
  const r = exported(s.brain, to, { caps: { sessions: 2, perProject: 1, notes: 5000 } }) as any;
  assert.equal(r.counts.sessions, 2); assert.equal(r.truncated, true); assert.equal(r.omitted, 1);
  assert.equal([...read(to, 'Projects/alpha.md').matchAll(/\[\[Sessions\//g)].length, 1);
  const r2 = exported(s.brain, to, { caps: { sessions: 2000, perProject: 50, notes: 9 } }) as any;
  assert.ok(r2.counts.notes <= 9); assert.equal(r2.truncated, true);
  assert.equal(readdirSync(to, { recursive: true }).filter(f => String(f).endsWith('.md')).length, r2.counts.notes);
});

test('project name collisions get a hash; --projects filters', () => {
  const s = seed(), other = join(s.base, 'x', 'alpha'), store = new BrainStore(s.brain);
  store.record({ project: other, source: 'codex', key: 'k', title: 't', summary: '', files: [], outcome: 'ok', evidence: [] }); store.close();
  const to = join(s.base, 'v'); exported(s.brain, to);
  assert.equal(files(to, 'Projects').filter(f => f.startsWith('alpha ')).length, 2);
  const only = exported(s.brain, join(s.base, 'v2'), { projects: [s.pb] }) as any;
  assert.equal(only.counts.projects, 1);
});

test('CLI export, --status, and refusals', () => {
  const s = seed(), to = join(s.base, 'v');
  const run = (a: string[]) => { let out = ''; const code = runBrainCli([...a, '--brain-dir', s.brain], { write: t => { out += t; } }); return { code, json: JSON.parse(out) as any }; };
  assert.equal(run(['export', '--to', to]).code, 2);
  const ok = run(['export', '--obsidian', '--to', to, '--no-prompts']);
  assert.equal(ok.code, 0); assert.equal(ok.json.counts.sessions, 3);
  const st = run(['export', '--obsidian', '--status']);
  assert.equal(st.json.vault, to); assert.equal(st.json.last.counts.sessions, 3);
  assert.equal(run(['export', '--obsidian', '--to', 'rel']).code, 2);
  assert.equal(run(['export', '--obsidian', '--to', s.base]).code, 1);
  const def = run(['export', '--obsidian']); // default location: <brain>/vault, private
  assert.equal(def.json.vault, join(s.brain, 'vault'));
});

test('reflect refreshes the vault, and a failed refresh never fails reflect', () => {
  const s = seed(), to = join(s.base, 'v'); exported(s.brain, to, { prompts: false });
  const store = new BrainStore(s.brain);
  store.record({ project: s.pa, source: 'claude-code', key: 'fresh', title: 'brand new session', summary: '', files: [], outcome: 'ok', evidence: [] }); store.close();
  const model = () => '{"proposals":[],"summary":"ok"}';
  const r = reflect(s.brain, { days: 2, run: model }) as any;
  assert.equal(r.vault.refreshed, true); assert.equal(r.vault.counts.sessions, 4);
  assert.ok(files(to, 'Sessions').some(f => f.includes('brand new')));
  assert.ok(!read(to, `Sessions/${files(to, 'Sessions')[0]}`).includes('## Prompts')); // same options as the export
  // Break the recorded location: it is now inside a git repo.
  const repo = join(s.base, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true }); mkdirSync(join(repo, 'v'));
  writeFileSync(join(repo, 'v', '.forgemind-vault'), '');
  writeFileSync(join(s.brain, 'vault-config.json'), JSON.stringify({ to: join(repo, 'v'), prompts: true, includeProposed: false }));
  const bad = reflect(s.brain, { days: 2, run: model }) as any;
  assert.equal(bad.vault.refreshed, false); assert.match(bad.vault.error, /git repository/);
  assert.ok(Array.isArray(bad.sources));
  // No vault at all: no key.
  const t = seed();
  assert.equal('vault' in (reflect(t.brain, { days: 2, run: model }) as any), false);
});
