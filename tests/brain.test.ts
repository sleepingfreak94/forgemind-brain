import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { BrainStore, defaultBrainDirectory } from '../src/brain.js';

function withDir(run: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'brain-')));
  try { chmodSync(dir, 0o700); run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const base = { kind: 'lesson' as const, text: 'Use small commits.', evidence: ['git:abc'], reason: 'seen often' };

test('default directory', () => { assert.equal(defaultBrainDirectory(), join(homedir(), '.forgemind')); });

test('propose is idempotent and lifecycle is audited', () => withDir(dir => {
  const s = new BrainStore(dir);
  const id = s.propose(base);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(s.propose(base), id);
  assert.equal(s.list().length, 1);
  s.approve(id); s.retire(id);
  assert.deepEqual(s.audit().map(a => a.action), ['propose', 'approve', 'retire']);
  assert.throws(() => s.approve(id), /transition/);
  assert.throws(() => s.retire(id), /transition/);
  const r = s.propose({ ...base, text: 'other' });
  s.reject(r, 'no');
  assert.throws(() => s.approve(r), /transition/);
  assert.throws(() => s.retire(r), /transition/);
  s.close();
}));

test('approved scoping', () => withDir(dir => {
  const s = new BrainStore(dir);
  const a = s.propose({ ...base, project: '/repo/a' }), b = s.propose({ ...base, project: '/repo/b' }), g = s.propose(base);
  const p = s.propose({ ...base, project: '/repo/a', text: 'pending' });
  for (const id of [a, b, g]) s.approve(id);
  assert.deepEqual(s.approved('/repo/a').map(e => e.id).sort(), [a, g].sort());
  assert.equal(s.list({ status: 'proposed' })[0]!.id, p);
  assert.equal(s.list({ project: '/repo/b' }).length, 1);
  s.close();
}));

test('validation and secrets', () => withDir(dir => {
  const s = new BrainStore(dir);
  assert.throws(() => s.propose({ ...base, kind: 'rule' as never }), /kind/);
  assert.throws(() => s.propose({ ...base, text: '' }), /text/);
  assert.throws(() => s.propose({ ...base, text: 'x'.repeat(2001) }), /text/);
  s.propose({ ...base, text: 'x'.repeat(2000) });
  assert.throws(() => s.propose({ ...base, reason: 'x'.repeat(2001) }), /reason/);
  assert.throws(() => s.propose({ ...base, evidence: Array(21).fill('a') }), /evidence/);
  assert.throws(() => s.propose({ ...base, evidence: ['x'.repeat(301)] }), /evidence/);
  assert.throws(() => s.propose({ ...base, project: 'rel' }), /absolute/);
  const bad = ['ghp_' + 'a'.repeat(30), 'gho_' + 'a'.repeat(30), 'github_pat_' + 'a'.repeat(30), 'sk-' + 'a'.repeat(20),
    'AKIA' + 'A'.repeat(16), 'xoxb-' + '1'.repeat(12), 'password=hunter2', 'api_key: x'];
  const before = s.audit().length;
  for (const v of bad) {
    assert.throws(() => s.propose({ ...base, text: v }), /secret/);
    assert.throws(() => s.propose({ ...base, reason: v }), /secret/);
    assert.throws(() => s.propose({ ...base, evidence: [v] }), /secret/);
  }
  assert.equal(s.audit().length, before);
  s.close();
}));

test('directory checks', () => withDir(dir => {
  assert.throws(() => new BrainStore('relative'), /absolute/);
  if (process.platform !== 'win32') {
    const alias = join(dir, 'alias'); symlinkSync(dir, alias);
    assert.throws(() => new BrainStore(alias), /canonical/);
  }
}));

test('the brain is one file in the directory and persists', () => withDir(dir => {
  const p = new BrainStore(dir); const id = p.propose(base); p.close();
  assert.equal(existsSync(join(dir, 'brain.sqlite')), true);
  const again = new BrainStore(dir); assert.equal(again.list()[0]!.id, id); again.close();
}));

function legacyBrain(dir: string): string {
  const home = join(dir, 'brain', 'personal');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const old = new BrainStore(dir); old.propose(base); old.close();
  const file = join(home, 'brain.sqlite');
  copyFileSync(join(dir, 'brain.sqlite'), file); chmodSync(file, 0o600);
  rmSync(join(dir, 'brain.sqlite'));
  return file;
}

test('migrates <dir>/brain/personal/brain.sqlite by copying it', { skip: process.platform === 'win32' }, () => withDir(dir => {
  const legacy = legacyBrain(dir);
  const company = join(dir, 'brain', 'company'); mkdirSync(company, { mode: 0o700 });
  const other = new DatabaseSync(join(company, 'brain.sqlite')); other.exec('CREATE TABLE secret_company (x TEXT)'); other.close();
  const before = readFileSync(legacy);
  const s = new BrainStore(dir);
  assert.equal(s.list().length, 1);
  s.propose({ ...base, text: 'added after the move' }); s.close();
  assert.equal(statSync(join(dir, 'brain.sqlite')).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(legacy), before);
  assert.equal(statSync(legacy).mode & 0o777, 0o600);
  const check = new DatabaseSync(join(dir, 'brain.sqlite'));
  assert.equal(check.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'secret_company'").get(), undefined);
  check.close();
}));

test('migration runs once and never overwrites the new file', { skip: process.platform === 'win32' }, () => withDir(dir => {
  legacyBrain(dir);
  const s = new BrainStore(dir); s.propose({ ...base, text: 'only in the new file' }); s.close();
  const reopened = new BrainStore(dir);
  assert.equal(reopened.list().length, 2); reopened.close();
}));

test('permissions, links and schema version', { skip: process.platform === 'win32' }, () => withDir(dir => {
  new BrainStore(dir).close();
  const home = dir, file = join(dir, 'brain.sqlite');
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  chmodSync(home, 0o755); assert.throws(() => new BrainStore(dir), /private/); chmodSync(home, 0o700);
  chmodSync(file, 0o644); assert.throws(() => new BrainStore(dir), /private/); chmodSync(file, 0o600);
  const copy = join(dir, 'hard'); linkSync(file, copy);
  assert.throws(() => new BrainStore(dir), /unsafe/); rmSync(copy);
  const moved = join(dir, 'moved'); renameSync(file, moved); symlinkSync(moved, file);
  assert.throws(() => new BrainStore(dir), /unsafe/); rmSync(file); renameSync(moved, file);
  const raw = new DatabaseSync(file); raw.exec('PRAGMA user_version = 99'); raw.close();
  assert.throws(() => new BrainStore(dir), /unsupported/);
}));

const run = { source: 'harness' as const, project: '/repo/a', key: 'run-1', title: 'T', summary: 'did it', files: ['a.ts'], outcome: 'completed', evidence: ['task-1'] };

test('record is idempotent and history is newest first', () => withDir(dir => {
  const s = new BrainStore(dir);
  const id = s.record(run);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(s.record(run), id);
  assert.deepEqual(s.audit().map(a => a.action), ['record']);
  s.record({ ...run, key: 'run-2', title: 'second' });
  s.record({ ...run, key: 'run-3', title: 'third' });
  s.record({ ...run, key: 'other', project: '/repo/b' });
  const rows = s.history('/repo/a');
  assert.deepEqual(rows.map(r => r.title), ['third', 'second', 'T']);
  assert.deepEqual(rows[2]!.files, ['a.ts']);
  assert.deepEqual(rows[2]!.evidence, ['task-1']);
  assert.equal(s.history('/repo/a', 2).length, 2);
  assert.throws(() => s.history('/repo/a', 0), /limit/);
  assert.throws(() => s.history('/repo/a', 201), /limit/);
  assert.throws(() => s.history('/repo/a', 1.5), /limit/);
  assert.equal(s.list().length, 0);
  assert.equal(s.approved('/repo/a').length, 0);
  s.close();
}));

test('record validates limits and refuses secrets', () => withDir(dir => {
  const s = new BrainStore(dir);
  assert.throws(() => s.record({ ...run, source: 'x' as never }), /source/);
  assert.throws(() => s.record({ ...run, project: 'rel' }), /absolute/);
  assert.throws(() => s.record({ ...run, title: '' }), /title/);
  assert.throws(() => s.record({ ...run, title: 'x'.repeat(301) }), /title/);
  assert.throws(() => s.record({ ...run, summary: 'x'.repeat(4001) }), /summary/);
  assert.throws(() => s.record({ ...run, outcome: '' }), /outcome/);
  assert.throws(() => s.record({ ...run, key: 'k'.repeat(201) }), /key/);
  assert.throws(() => s.record({ ...run, files: Array(201).fill('a') }), /files/);
  assert.throws(() => s.record({ ...run, files: ['x'.repeat(1025)] }), /files/);
  assert.throws(() => s.record({ ...run, evidence: Array(21).fill('a') }), /evidence/);
  assert.throws(() => s.record({ ...run, evidence: ['x'.repeat(301)] }), /evidence/);
  s.record({ ...run, summary: '', files: [] });
  const bad = 'password=hunter2';
  const before = s.audit().length;
  for (const field of ['title', 'summary', 'outcome', 'key']) assert.throws(() => s.record({ ...run, key: 'z', [field]: bad }), /secret/);
  assert.throws(() => s.record({ ...run, key: 'z', files: [bad] }), /secret/);
  assert.throws(() => s.record({ ...run, key: 'z', evidence: [bad] }), /secret/);
  assert.equal(s.audit().length, before);
  s.close();
}));

test('version 1 and 2 databases migrate to 3 (history keeps rows, accepts codex); version 4 is refused', { skip: process.platform === 'win32' }, () => withDir(dir => {
  const first = new BrainStore(dir);
  const id = first.propose(base); first.close();
  const file = join(dir, 'brain.sqlite');
  const raw = new DatabaseSync(file); raw.exec('DROP TABLE history; PRAGMA user_version = 1'); raw.close();
  const s = new BrainStore(dir);
  assert.equal(s.list()[0]!.id, id);
  s.record(run); assert.equal(s.history('/repo/a').length, 1);
  s.close();
  const v2 = new DatabaseSync(file);
  v2.exec(`DROP TABLE history; CREATE TABLE history (id TEXT PRIMARY KEY, project TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('harness','claude-code','cursor')), title TEXT NOT NULL,
    summary TEXT NOT NULL, files TEXT NOT NULL, outcome TEXT NOT NULL, evidence TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
    INSERT INTO history VALUES ('old', '/repo/a', 'cursor', 'old row', '', '[]', 'done', '[]', 1); PRAGMA user_version = 2`);
  v2.close();
  const up = new BrainStore(dir);
  assert.equal(up.history('/repo/a')[0]!.title, 'old row');
  up.record({ ...run, key: 'c', source: 'codex' });
  assert.equal(up.history('/repo/a')[0]!.source, 'codex');
  assert.equal(up.list()[0]!.id, id);
  up.close();
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 3);
  check.exec('PRAGMA user_version = 4'); check.close();
  assert.throws(() => new BrainStore(dir), /unsupported/);
}));
