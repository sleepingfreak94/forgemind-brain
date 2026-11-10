import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrainCli } from '../src/cli.js';
import { BrainStore } from '../src/brain.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-cli-')));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function setup() {
  const base = join(root, `case${counter++}`);
  const brain = join(base, 'brain'), ws = join(base, 'ws'), ws2 = join(base, 'ws2');
  mkdirSync(ws, { recursive: true }); mkdirSync(ws2);
  return { base, brain, ws, ws2 };
}
function run(brain: string, args: string[]) {
  let out = '';
  let code = -1;
  assert.doesNotThrow(() => { code = runBrainCli([...args, '--brain-dir', brain], { write: t => { out += t; } }); });
  assert.equal(out.split('\n').filter(Boolean).length, 1);
  assert.ok(out.endsWith('\n'));
  return { code, json: JSON.parse(out) as Record<string, any>, out };
}

test('a fresh brain directory works without setup', () => {
  const { brain, ws } = setup();
  const first = run(brain, ['list', '--workspace', ws]);
  assert.equal(first.code, 0); assert.deepEqual(first.json, { entries: [] });
  const added = run(brain, ['add', '--workspace', ws, '--kind', 'lesson', '--text', 'Shared.', '--reason', 'r']);
  assert.equal(added.code, 0); assert.match(added.json.id, /^[0-9a-f]{16}$/);
  const list = run(brain, ['list', '--workspace', ws]);
  assert.equal(list.json.entries.length, 1); assert.equal(list.json.entries[0].project, ws);
  assert.deepEqual(run(brain, ['history', '--workspace', ws]).json, { history: [] });
  assert.equal(lstatSync(join(brain, 'brain.sqlite')).mode & 0o777, 0o600);
  assert.equal(run(brain, ['map', '--workspace', ws, '--space', 'company']).code, 2);
});

test('add, list, lifecycle', () => {
  const { brain, ws } = setup();
  const a = run(brain, ['add', '--workspace', ws, '--kind', 'convention', '--text', 'Use tabs.', '--reason', 'owner']);
  const b = run(brain, ['add', '--workspace', ws, '--kind', 'lesson', '--text', 'Wide lesson.', '--reason', 'owner', '--scope', 'global']);
  assert.match(a.json.id, /^[0-9a-f]{16}$/); assert.match(b.json.id, /^[0-9a-f]{16}$/);
  const list = run(brain, ['list', '--workspace', ws]);
  assert.equal(list.json.entries.length, 2);
  const byId = new Map(list.json.entries.map((e: any) => [e.id, e]));
  assert.equal((byId.get(a.json.id) as any).project, ws);
  assert.equal((byId.get(b.json.id) as any).project, null);
  assert.equal(run(brain, ['list', '--workspace', ws, '--status', 'approved']).json.entries.length, 0);
  const store = new BrainStore(brain);
  assert.equal(store.approved(ws).length, 0);
  store.close();
  assert.equal(run(brain, ['approve', '--workspace', ws, '--id', a.json.id]).code, 0);
  assert.equal(run(brain, ['show', '--workspace', ws, '--id', a.json.id]).json.entry.status, 'approved');
  assert.equal(run(brain, ['retire', '--workspace', ws, '--id', a.json.id]).code, 0);
  assert.equal(run(brain, ['reject', '--workspace', ws, '--id', b.json.id, '--note', 'no']).code, 0);
  assert.equal(run(brain, ['show', '--workspace', ws, '--id', b.json.id]).json.entry.reviewNote, 'no');
  assert.equal(run(brain, ['approve', '--workspace', ws, '--id', b.json.id]).code, 1);
});

test('usage errors exit 2', () => {
  const { brain, ws } = setup();
  const cases: string[][] = [[], ['bogus'], ['list', '--workspace', ws, '--bogus', '1'], ['list', '--workspace', ws, '--workspace', ws],
    ['list', '--workspace'],
    ['add', '--workspace', ws, '--kind', 'lesson', '--text', 'x', '--reason', 'r', '--scope', 'bogus'],
    ['add', '--workspace', ws, '--kind', 'lesson', '--text', 'x', '--reason', 'r', '--scope', 'space']];
  for (const c of cases) {
    let out = ''; let code = -1;
    assert.doesNotThrow(() => { code = runBrainCli(c.length ? [...c, '--brain-dir', brain] : c, { write: t => { out += t; } }); });
    assert.equal(code, 2); assert.ok('error' in JSON.parse(out));
  }
});

test('secrets refused without echo', () => {
  const { brain, ws } = setup();
  const r = run(brain, ['add', '--workspace', ws, '--kind', 'lesson', '--text', 'password=hunter2', '--reason', 'r']);
  assert.notEqual(r.code, 0); assert.ok(!r.out.includes('hunter2'));
});

test('history lists this workspace only', () => {
  const { brain, ws, ws2 } = setup();
  const store = new BrainStore(brain);
  const base = { source: 'harness' as const, summary: '', files: [], outcome: 'completed', evidence: [] };
  store.record({ ...base, project: ws, key: 'r1', title: 'first' });
  store.record({ ...base, project: ws, key: 'r2', title: 'second' });
  const shot = join(ws, 'a.png'); writeFileSync(shot, 'i');
  store.record({ ...base, project: ws, key: 'r4', title: 'with shot', attachments: [shot] });
  store.record({ ...base, project: ws2, key: 'r3', title: 'elsewhere' });
  store.close();
  const all = run(brain, ['history', '--workspace', ws]);
  assert.equal(all.code, 0);
  assert.deepEqual(all.json.history.map((h: any) => h.title), ['with shot', 'second', 'first']);
  assert.match(all.json.history[0].attachments[0], /1-a\.png$/);
  assert.equal(run(brain, ['history', '--workspace', ws, '--limit', '1']).json.history.length, 1);
  for (const bad of ['0', '201', 'abc']) assert.equal(run(brain, ['history', '--workspace', ws, '--limit', bad]).code, 2);
});

function legacy(brain: string): void {
  const store = new BrainStore(brain); store.propose({ kind: 'lesson', text: 'old', evidence: [], reason: 'r' }); store.close();
  const home = join(brain, 'brain', 'personal'); mkdirSync(home, { recursive: true, mode: 0o700 });
  copyFileSync(join(brain, 'brain.sqlite'), join(home, 'brain.sqlite')); rmSync(join(brain, 'brain.sqlite'));
}

test('migrate command copies the legacy brain, then refuses to run again', { skip: process.platform === 'win32' }, () => {
  const { brain, ws } = setup();
  legacy(brain);
  assert.equal(run(brain, ['list', '--workspace', ws]).code, 1);
  const r = run(brain, ['migrate']);
  assert.equal(r.code, 0); assert.deepEqual(r.json, { ok: true, entries: 1, history: 0 });
  assert.equal(run(brain, ['list', '--workspace', ws]).json.entries.length, 1);
  const again = run(brain, ['migrate']);
  assert.equal(again.code, 2); assert.match(again.json.error, /already exists/);
  assert.equal(run(brain, ['migrate', '--workspace', ws]).code, 2);
});

test('concurrent migrate calls: exactly one wins and the brain is intact', { skip: process.platform === 'win32' }, async () => {
  const { brain } = setup();
  legacy(brain);
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
  const go = () => new Promise<number>(done => { spawn('node', [cli, 'migrate', '--brain-dir', brain], { stdio: 'ignore' }).on('close', code => done(code ?? -1)); });
  const codes = await Promise.all([go(), go(), go()]);
  assert.deepEqual(codes.slice().sort(), [0, 2, 2]);
  const db = new DatabaseSync(join(brain, 'brain.sqlite'));
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.equal(db.prepare('SELECT count(*) AS n FROM entries').get()?.n, 1);
  db.close();
  assert.equal(readdirSync(brain).filter(n => n.startsWith('.brain.migrating')).length, 0);
});
