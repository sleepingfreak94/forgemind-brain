import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainStore } from '../src/brain.js';

function withDir(run: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'brain-')));
  try { chmodSync(dir, 0o700); run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const run = { source: 'harness' as const, project: '/repo/a', key: 'run-1', title: 'T', summary: 'did it', files: ['a.ts'], outcome: 'completed', evidence: ['task-1'] };

test('attachments are validated first, copied privately, stored on the row and never copied twice', { skip: process.platform === 'win32' }, () => withDir(dir => {
  const src = join(dir, 'src'); mkdirSync(src);
  const shot = join(src, 'password-hunter2 (1).PNG'); writeFileSync(shot, 'png-bytes');
  const bad = join(src, 'notes.txt'); writeFileSync(bad, 'x');
  const link = join(src, 'link.png'); symlinkSync(shot, link);
  const fifo = join(src, 'pipe.png'); execFileSync('mkfifo', [fifo]);
  const dirPng = join(src, 'dir.png'); mkdirSync(dirPng);
  const big = join(src, 'big.pdf'); writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
  const s = new BrainStore(dir);
  const rec = { ...run, key: 'att' };
  for (const attachments of [[shot, bad], [shot, link], [shot, dirPng], [shot, fifo], [shot, big], [shot, join(src, 'missing.png')], ['rel.png'], Array(11).fill(shot), 'x'])
    assert.throws(() => s.record({ ...rec, attachments }), /attachment/);
  assert.equal(existsSync(join(dir, 'files')), false);
  assert.equal(s.history('/repo/a').length, 0);
  const id = s.record({ ...rec, attachments: [shot, shot] });
  const [first, second] = s.history('/repo/a')[0]!.attachments;
  assert.match(first!, new RegExp(`/files/[0-9a-f]{12}/${id}/1.png$`));
  assert.match(second!, /\/2.png$/);
  assert.equal(readFileSync(first!, 'utf8'), 'png-bytes');
  assert.equal(statSync(first!).mode & 0o777, 0o600);
  assert.equal(statSync(join(first!, '..')).mode & 0o777, 0o700);
  writeFileSync(shot, 'changed');
  assert.throws(() => s.record({ ...rec, attachments: [shot] }), /already recorded today; attachments not added/);
  assert.equal(s.record(rec), id);
  assert.deepEqual(readdirSync(join(first!, '..')).sort(), ['1.png', '2.png']);
  assert.equal(readFileSync(first!, 'utf8'), 'png-bytes');
  s.close();
}));

test('attachment folders must be private, and a stale record folder is replaced', { skip: process.platform === 'win32' }, () => withDir(dir => {
  const shot = join(dir, 'a.png'); writeFileSync(shot, 'img');
  const s = new BrainStore(dir);
  const files = join(dir, 'files');
  mkdirSync(files, { mode: 0o755 }); chmodSync(files, 0o755);
  assert.throws(() => s.record({ ...run, key: 'p1', attachments: [shot] }), /private|unsafe/);
  assert.equal(s.history('/repo/a').length, 0);
  rmSync(files, { recursive: true });
  const elsewhere = join(dir, 'elsewhere'); mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, files);
  assert.throws(() => s.record({ ...run, key: 'p1', attachments: [shot] }), /unsafe/);
  assert.deepEqual(readdirSync(elsewhere), []);
  unlinkSync(files);
  const id = createHash('sha256').update(JSON.stringify([run.source, run.project, 'p2'])).digest('hex').slice(0, 16);
  const folder = join(files, createHash('sha256').update(run.project).digest('hex').slice(0, 12), id);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, '9.png'), 'left by a crash');
  assert.equal(s.record({ ...run, key: 'p2', attachments: [shot] }), id);
  assert.deepEqual(readdirSync(folder), ['1.png']);
  s.close();
}));
