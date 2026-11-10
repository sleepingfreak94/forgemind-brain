import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { BrainStore, defaultBrainDirectory } from '../../src/memory/brain.js';

function withDir(run: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'brain-')));
  try { chmodSync(dir, 0o700); run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const base = { kind: 'lesson' as const, text: 'Use small commits.', evidence: ['git:abc'], reason: 'seen often' };

test('default directory', () => { assert.equal(defaultBrainDirectory(), join(homedir(), '.forgemind', 'brain')); });

test('propose is idempotent and lifecycle is audited', () => withDir(dir => {
  const s = new BrainStore(dir, 'personal');
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
  const s = new BrainStore(dir, 'personal');
  const a = s.propose({ ...base, project: '/repo/a' }), b = s.propose({ ...base, project: '/repo/b' }), g = s.propose(base);
  const p = s.propose({ ...base, project: '/repo/a', text: 'pending' });
  for (const id of [a, b, g]) s.approve(id);
  assert.deepEqual(s.approved('/repo/a').map(e => e.id).sort(), [a, g].sort());
  assert.equal(s.list({ status: 'proposed' })[0]!.id, p);
  assert.equal(s.list({ project: '/repo/b' }).length, 1);
  s.close();
}));

test('validation and secrets', () => withDir(dir => {
  const s = new BrainStore(dir, 'personal');
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

test('space and directory checks', () => withDir(dir => {
  assert.throws(() => new BrainStore(dir, 'team' as never), /space/);
  assert.equal(existsSync(join(dir, 'team')), false);
  assert.throws(() => new BrainStore('relative', 'personal'), /absolute/);
  if (process.platform !== 'win32') {
    const alias = join(dir, 'alias'); symlinkSync(dir, alias);
    assert.throws(() => new BrainStore(alias, 'personal'), /canonical/);
  }
}));

test('spaces are separate and persistent', () => withDir(dir => {
  const p = new BrainStore(dir, 'personal'); const id = p.propose(base); p.close();
  const c = new BrainStore(dir, 'company'); assert.equal(c.list().length, 0); c.close();
  const again = new BrainStore(dir, 'personal'); assert.equal(again.list()[0]!.id, id); again.close();
}));

test('permissions, links and schema version', { skip: process.platform === 'win32' }, () => withDir(dir => {
  new BrainStore(dir, 'personal').close();
  const home = join(dir, 'personal'), file = join(home, 'brain.sqlite');
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  chmodSync(home, 0o755); assert.throws(() => new BrainStore(dir, 'personal'), /private/); chmodSync(home, 0o700);
  chmodSync(file, 0o644); assert.throws(() => new BrainStore(dir, 'personal'), /private/); chmodSync(file, 0o600);
  const copy = join(dir, 'hard'); linkSync(file, copy);
  assert.throws(() => new BrainStore(dir, 'personal'), /unsafe/); rmSync(copy);
  const moved = join(dir, 'moved'); renameSync(file, moved); symlinkSync(moved, file);
  assert.throws(() => new BrainStore(dir, 'personal'), /unsafe/); rmSync(file); renameSync(moved, file);
  const raw = new DatabaseSync(file); raw.exec('PRAGMA user_version = 99'); raw.close();
  assert.throws(() => new BrainStore(dir, 'personal'), /unsupported/);
}));

const run = { source: 'harness' as const, project: '/repo/a', key: 'run-1', title: 'T', summary: 'did it', files: ['a.ts'], outcome: 'completed', evidence: ['task-1'] };

test('record is idempotent and history is newest first', () => withDir(dir => {
  const s = new BrainStore(dir, 'personal');
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
  const s = new BrainStore(dir, 'personal');
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

test('version 1 database migrates to 2; version 3 is refused', { skip: process.platform === 'win32' }, () => withDir(dir => {
  const first = new BrainStore(dir, 'personal');
  const id = first.propose(base); first.close();
  const file = join(dir, 'personal', 'brain.sqlite');
  const raw = new DatabaseSync(file); raw.exec('DROP TABLE history; PRAGMA user_version = 1'); raw.close();
  const s = new BrainStore(dir, 'personal');
  assert.equal(s.list()[0]!.id, id);
  s.record(run); assert.equal(s.history('/repo/a').length, 1);
  s.close();
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 2);
  check.exec('PRAGMA user_version = 3'); check.close();
  assert.throws(() => new BrainStore(dir, 'personal'), /unsupported/);
}));
