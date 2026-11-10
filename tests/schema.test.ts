import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainStore } from '../src/brain.js';

function withDir(run: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'brain-')));
  try { chmodSync(dir, 0o700); run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const run = { project: '/repo/a', source: 'cursor' as const, key: 'k', title: 'T', summary: 's', files: [], outcome: 'done', evidence: [] };

test('version 4 upgrades to 5 in place: history gains prompts and signals, documents table exists, rows kept', { skip: process.platform === 'win32' }, () => withDir(dir => {
  const first = new BrainStore(dir);
  first.record(run);
  first.close();
  const file = join(dir, 'brain.sqlite');
  const raw = new DatabaseSync(file);
  // Recreate the exact v4 shape: no prompts/signals columns, no documents table.
  raw.exec(`ALTER TABLE history DROP COLUMN prompts; ALTER TABLE history DROP COLUMN signals;
    DROP TABLE documents; PRAGMA user_version = 4`);
  raw.close();
  const s = new BrainStore(dir);
  assert.deepEqual(s.history('/repo/a').map(h => h.title), ['T']);
  s.close();
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 5);
  const columns = check.prepare('PRAGMA table_info(history)').all().map(c => c.name);
  assert.ok(columns.includes('prompts') && columns.includes('signals'));
  const docColumns = check.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
  assert.deepEqual(docColumns, ['id', 'project', 'kind', 'number', 'title', 'status', 'body', 'fields', 'supersedes',
    'superseded_by', 'source', 'session', 'created_at', 'updated_at']);
  // ADR numbers are unique per project; recipes have no number.
  const insert = check.prepare(`INSERT INTO documents VALUES (?, '/repo/a', ?, ?, 't', ?, 'b', '{}', NULL, NULL, 'cli', NULL, 1, 1)`);
  insert.run('a1', 'adr', 1, 'proposed');
  assert.throws(() => insert.run('a2', 'adr', 1, 'proposed'), /UNIQUE/);
  insert.run('r1', 'recipe', null, 'recorded');
  insert.run('r2', 'recipe', null, 'recorded');
  assert.throws(() => insert.run('x', 'note', null, 'recorded'), /CHECK/);
  check.close();
  // Reopening a v5 file is a no-op.
  new BrainStore(dir).close();
}));
