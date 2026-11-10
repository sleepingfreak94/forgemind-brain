import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLocal } from '../src/install-local.js';

const built = dirname(fileURLToPath(import.meta.url)).replace(/tests$/, 'src');
const pkg = join(built, '..', '..', 'package.json');

test('installs a self-contained copy that runs without the checkout, and replaces it cleanly', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-install-')));
  try {
    const target = join(root, 'home', 'bin');
    installLocal(built, pkg, target);
    writeFileSync(join(target, 'stale.js'), 'x');
    installLocal(built, pkg, target);
    assert.equal(existsSync(join(target, 'stale.js')), false);
    for (const f of ['brain-mcp.js', 'brain-hook.js', 'package.json']) assert.equal(existsSync(join(target, f)), true);
    assert.deepEqual(readdirSync(join(root, 'home')), ['bin']);
    installLocal(built, pkg, target);
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n';
    const run = spawnSync('node', [join(target, 'brain-mcp.js'), '--source', 'codex', '--brain-dir', join(root, 'b')], { input: ping, encoding: 'utf8' });
    assert.equal(JSON.parse(run.stdout).id, 1);
    assert.throws(() => installLocal(built, pkg, 'relative/bin'), /absolute/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses to replace a directory that is not a previous install', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-install-')));
  try {
    const target = join(root, 'bin');
    mkdirSync(target); writeFileSync(join(target, 'mine.txt'), 'keep');
    assert.throws(() => installLocal(built, pkg, target), /not a forgemind-brain install/);
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'other' }));
    assert.throws(() => installLocal(built, pkg, target), /not a forgemind-brain install/);
    assert.equal(readFileSync(join(target, 'mine.txt'), 'utf8'), 'keep');
    assert.deepEqual(readdirSync(root), ['bin']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('puts the old install back when the second rename fails', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-install-')));
  try {
    const target = join(root, 'bin');
    installLocal(built, pkg, target);
    writeFileSync(join(target, 'marker.js'), 'old');
    let calls = 0;
    const flaky: typeof renameSync = (from, to) => { if (++calls === 2) throw new Error('disk says no'); renameSync(from, to); };
    assert.throws(() => installLocal(built, pkg, target, flaky), /disk says no/);
    assert.equal(readFileSync(join(target, 'marker.js'), 'utf8'), 'old');
    assert.deepEqual(readdirSync(root), ['bin']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('keeps the old install and reports its path when the restore also fails', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-install-')));
  try {
    const target = join(root, 'bin');
    installLocal(built, pkg, target);
    writeFileSync(join(target, 'marker.js'), 'old');
    let calls = 0;
    const broken: typeof renameSync = (from, to) => { if (++calls >= 2) throw new Error('disk says no'); renameSync(from, to); };
    assert.throws(() => installLocal(built, pkg, target, broken), /previous install is kept at/);
    const old = readdirSync(root).filter(n => n.startsWith('.bin-old-'));
    assert.equal(old.length, 1);
    assert.equal(readFileSync(join(root, old[0]!, 'marker.js'), 'utf8'), 'old');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
