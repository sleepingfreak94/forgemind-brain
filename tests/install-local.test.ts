import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'stale.js'), 'x');
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
