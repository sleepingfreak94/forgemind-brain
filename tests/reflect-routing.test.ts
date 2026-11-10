import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBrainCli } from '../src/cli.js';
import { BrainStore } from '../src/brain.js';
import { reflect } from '../src/reflect.js';
import { codexArgs, cursorArgs, claudeArgs, makeCodexRunner, makeCursorRunner, makeCustomRunner, parseCustom, planFor, resultText } from '../src/reflect-runners.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-routing-')));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const now = new Date('2026-11-11T10:00:00Z');
function setup() {
  const brain = join(root, `r${n++}`, 'brain');
  new BrainStore(brain).close();
  const db = new DatabaseSync(join(brain, 'brain.sqlite'));
  const row = (id: string, source: string, title: string) => db.prepare('INSERT INTO history (id, project, source, title, summary, files, outcome, evidence, at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, '/p', source, title, 's', '[]', 'ok', '[]', now.getTime() - 1);
  return { brain, db, row };
}
const ok = '{"summary":"s","proposals":[]}';

test('each source gets its own packet and its own runner call; no cross-source data', () => {
  const { brain, row } = setup();
  row('claude01', 'claude-code', 'CLAUDE-SECRET'); row('cursor01', 'cursor', 'CURSOR-SECRET'); row('codex001', 'codex', 'CODEX-SECRET');
  new BrainStore(brain).propose({ kind: 'lesson', text: 'shared entry', evidence: [], reason: 'r' });
  const calls: { prompt: string; cwd: string }[] = [];
  const r = reflect(brain, { days: 2, now, filter: { sources: ['claude-code', 'cursor', 'codex'] }, run: (prompt, cwd) => { calls.push({ prompt, cwd }); return ok; } });
  assert.equal(calls.length, 3);
  for (const [i, own] of ['CLAUDE', 'CURSOR', 'CODEX'].entries()) {
    for (const other of ['CLAUDE', 'CURSOR', 'CODEX']) assert.equal(calls[i]!.prompt.includes(`${other}-SECRET`), other === own);
    assert.ok(calls[i]!.prompt.includes('shared entry'));
  }
  assert.deepEqual(calls.map(c => c.cwd), [join(brain, 'reflect'), join(brain, 'reflect', 'run-cursor'), join(brain, 'reflect', 'run-codex')]);
  const text = readFileSync(r.report as string, 'utf8');
  for (const s of ['claude-code', 'cursor', 'codex']) assert.match(text, new RegExp(`## Source ${s}`));
});

test('a source with no rows or no CLI is skipped with a note; the others still run', () => {
  const { brain, row } = setup();
  row('claude01', 'claude-code', 'a'); row('cursor01', 'cursor', 'b');
  let ran = 0;
  const spawn = ((cmd: string) => { ran++; assert.equal(cmd, 'claude'); return { status: 0, stdout: JSON.stringify({ result: ok }), stderr: '' }; }) as any;
  const r = reflect(brain, { days: 2, now, spawn, has: c => c !== 'cursor-agent' });
  assert.equal(ran, 1);
  assert.deepEqual(r.sources, [{ source: 'claude-code', status: 'ok' }, { source: 'cursor', status: '`cursor-agent` not found on PATH' }]);
  assert.match(readFileSync(r.report as string, 'utf8'), /Skipped: `cursor-agent` not found on PATH/);
});

test('a failing source does not stop others; all failing is an error', () => {
  const { brain, row } = setup();
  row('claude01', 'claude-code', 'a'); row('cursor01', 'cursor', 'b');
  let call = 0;
  const run = () => { if (call++ === 0) throw new Error('boom'); return ok; };
  assert.match(readFileSync(reflect(brain, { days: 2, now, run }).report as string, 'utf8'), /Skipped: failed: boom/);
  assert.throws(() => reflect(brain, { days: 2, now, run: () => { throw new Error('down'); } }), /down/);
});

test('proposals can only cite ids from their own source packet', () => {
  const { brain, row } = setup();
  row('claude01', 'claude-code', 'a'); row('cursor01', 'cursor', 'b');
  const answer = (id: string) => JSON.stringify({ summary: 's', proposals: [{ project: null, kind: 'lesson', text: `tip ${id}`, reason: 'r', evidence: [id] }] });
  const r = reflect(brain, { days: 2, now, run: prompt => answer(prompt.includes('claude01') ? 'cursor01' : 'cursor01') });
  assert.equal((r.proposed as string[]).length, 1); // cited by the cursor source only; the claude source's citation was dropped
  assert.deepEqual((r.sources as any[]).map(s => s.status), ['ok', 'ok']);
});

test('runner args, cwd, env and parsing for cursor and codex (fake spawn)', () => {
  const dir = join(root, 'cwd');
  let seen: any;
  const spawn = (out: string) => ((cmd: string, args: string[], o: any) => { seen = { cmd, args, o };
    const i = args.indexOf('--output-last-message'); if (i >= 0) writeFileSync(args[i + 1]!, 'LAST MESSAGE'); return { status: 0, stdout: out, stderr: '' }; }) as any;
  assert.equal(makeCursorRunner(spawn('{"type":"result","is_error":false,"result":"CURSOR ANSWER"}'))('PROMPT', join(dir, 'cur')), 'CURSOR ANSWER');
  assert.equal(seen.cmd, 'cursor-agent');
  const tmp = seen.o.cwd as string;
  assert.deepEqual(seen.args, [...cursorArgs, '--workspace', tmp, 'PROMPT']);
  assert.ok(tmp.startsWith(realpathSync(tmpdir())) && !tmp.includes('.forgemind'));
  assert.equal(existsSync(tmp), false); // removed after the run
  assert.ok(!seen.args.includes('--approve-mcps'));
  const boom = (() => ({ status: 1, stdout: '', stderr: 'x' })) as any;
  let used = '';
  assert.throws(() => makeCursorRunner(((c: string, a: string[], o: any) => { used = o.cwd; return boom(); }) as any)('p', ''), /model run failed/);
  assert.equal(existsSync(used), false);
  assert.deepEqual(cursorArgs.slice(0, 7), ['-p', '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled']);
  assert.equal(seen.o.env.FORGEMIND_BRAIN_HOOK, 'off');
  assert.equal(makeCodexRunner(spawn('stdout text'))('PROMPT', join(dir, 'cod')), 'LAST MESSAGE');
  assert.equal(seen.cmd, 'codex');
  assert.deepEqual(seen.args.slice(0, 4), ['exec', '--sandbox', 'read-only', '--skip-git-repo-check']);
  assert.deepEqual(codexArgs, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check']);
  assert.equal(seen.args.at(-1), '-');
  assert.equal(seen.o.input, 'PROMPT');
  assert.equal(seen.o.env.FORGEMIND_BRAIN_HOOK, 'off');
  const noFile = ((_c: string, _a: string[], _o: any) => ({ status: 0, stdout: 'fallback', stderr: '' })) as any;
  assert.equal(makeCodexRunner(noFile)('p', join(dir, 'cod2')), 'fallback');
  assert.equal(resultText('plain text'), 'plain text');
  assert.equal(resultText('noise\n{"result":"last"}'), 'last');
  assert.throws(() => resultText('{"is_error":true,"result":"x"}'), /model run failed/);
  assert.ok(claudeArgs.includes('--safe-mode'));
});

test('custom runner validation and use', () => {
  const exe = join(root, 'my-runner.sh'); writeFileSync(exe, '#!/bin/sh\ncat >/dev/null\n'); chmodSync(exe, 0o755);
  const plain = join(root, 'plain.txt'); writeFileSync(plain, 'x');
  assert.deepEqual(parseCustom(`cursor=${exe}`), { cursor: exe });
  for (const bad of ['cursor=rel/path', `bogus=${exe}`, `cursor=${plain}`, `cursor=${join(root, 'missing')}`, exe, `cursor=${exe}\ncursor=${exe}`])
    assert.throws(() => parseCustom(bad), /invalid --runner/);
  let seen: any;
  const spawn = ((cmd: string, args: string[], o: any) => { seen = { cmd, args, o }; return { status: 0, stdout: 'ANSWER', stderr: '' }; }) as any;
  assert.equal(makeCustomRunner(exe, spawn)('P', join(root, 'cu')), 'ANSWER');
  assert.deepEqual([seen.cmd, seen.args, seen.o.input], [exe, [], 'P']);
  const plan = planFor('codex', { codex: exe }, spawn, () => false);
  assert.ok(plan.run && !plan.skip); // a custom runner needs no CLI on PATH
  assert.equal(planFor('codex', {}, spawn, () => false).skip, '`codex` not found on PATH');
  assert.equal(planFor('codex', {}, spawn, () => true).untested, true);
  const out: string[] = [];
  assert.equal(runBrainCli(['reflect', '--dry-run', '--runner', 'cursor=rel', '--brain-dir', join(root, 'b')], { write: t => { out.push(t); } }), 2);
  assert.equal(runBrainCli(['reflect', '--dry-run', '--runner', `cursor=${exe}`, '--runner', `codex=${exe}`, '--brain-dir', join(root, 'b')], { write: t => { out.push(t); } }), 0);
  assert.match(out.at(-1)!, /custom runner/);
});

test('schedule passes --runner and --sources through', async () => {
  const { schedule } = await import('../src/schedule.js');
  const exe = join(root, 'sched.sh'); writeFileSync(exe, '#!/bin/sh\n'); chmodSync(exe, 0o755);
  const brain = join(root, 'sbrain'); mkdirSync(join(brain, 'bin'), { recursive: true }); writeFileSync(join(brain, 'bin', 'cli.js'), '');
  const deps = { plistDir: join(root, 'agents'), launchctl: () => {}, platform: 'darwin', uid: 1 };
  const out: string[] = [];
  const code = runBrainCli(['schedule', '--every', '48h', '--sources', 'cursor,codex', '--runner', `cursor=${exe}`, '--runner', `codex=${exe}`, '--brain-dir', brain], { write: t => { out.push(t); } }, { schedule: deps });
  assert.equal(code, 0);
  const xml = readFileSync(join(root, 'agents', 'com.forgemind.brain.reflect.plist'), 'utf8');
  assert.ok(xml.includes(`<string>--sources</string><string>cursor,codex</string><string>--runner</string><string>cursor=${exe}</string><string>--runner</string><string>codex=${exe}</string>`));
  assert.equal(existsSync(join(root, 'agents')), true);
  void schedule;
});

test('a personal project entry stays out of another source packet; global entries go everywhere', () => {
  const { brain, row } = setup();
  row('claude01', 'claude-code', 'a');
  const db = new DatabaseSync(join(brain, 'brain.sqlite'));
  db.prepare('INSERT INTO history (id, project, source, title, summary, files, outcome, evidence, at) VALUES (?,?,?,?,?,?,?,?,?)').run('cursor01', '/office', 'cursor', 'b', 's', '[]', 'ok', '[]', now.getTime() - 1);
  db.close();
  const s = new BrainStore(brain);
  s.propose({ kind: 'lesson', text: 'PERSONAL entry', evidence: [], reason: 'r', project: '/p' });
  s.propose({ kind: 'lesson', text: 'OFFICE entry', evidence: [], reason: 'r', project: '/office' });
  s.propose({ kind: 'lesson', text: 'GLOBAL entry', evidence: [], reason: 'r' }); s.close();
  const prompts: Record<string, string> = {};
  reflect(brain, { days: 2, now, run: prompt => { prompts[prompt.includes('cursor01') ? 'cursor' : 'claude'] = prompt; return ok; } });
  assert.ok(!prompts.cursor!.includes('PERSONAL') && prompts.cursor!.includes('OFFICE') && prompts.cursor!.includes('GLOBAL'));
  assert.ok(!prompts.claude!.includes('OFFICE') && prompts.claude!.includes('PERSONAL'));
});

test('codex is not in the default sources; a failed report write still returns the proposed ids', () => {
  const { brain, row } = setup();
  row('codex001', 'codex', 'c'); row('claude01', 'claude-code', 'a');
  let calls = 0;
  reflect(brain, { days: 2, now, run: () => { calls++; return ok; } });
  assert.equal(calls, 1);
  reflect(brain, { days: 2, now, filter: { sources: ['codex'] }, run: () => { calls++; return ok; } });
  assert.equal(calls, 2);
  const answer = JSON.stringify({ summary: 's', proposals: [{ project: null, kind: 'lesson', text: 'tip', reason: 'r', evidence: ['claude01'] }] });
  const stamp = new Date('2026-11-12T10:00:00Z');
  const p = (n: number) => String(n).padStart(2, '0');
  mkdirSync(join(brain, 'reflect', `${stamp.getFullYear()}-${p(stamp.getMonth() + 1)}-${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}.md`), { recursive: true });
  const r = reflect(brain, { days: 2, now: stamp, run: () => answer });
  assert.equal(r.report, undefined);
  assert.ok(typeof r.reportError === 'string');
  assert.equal((r.proposed as string[]).length, 1);
});
