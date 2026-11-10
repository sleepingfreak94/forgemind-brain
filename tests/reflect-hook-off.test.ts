import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawnSync } from 'node:child_process';
import { runBrainHookDetailed } from '../src/brain-hook.js';
import { makeRunner } from '../src/reflect.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-hookoff-')));
after(() => rmSync(root, { recursive: true, force: true }));

test('FORGEMIND_BRAIN_HOOK=off makes both hook events empty and writes nothing', async () => {
  const brain = join(root, 'brain');
  process.env.FORGEMIND_BRAIN_HOOK = 'off';
  try {
    for (const event of ['session-start', 'session-end'])
      assert.deepEqual(await runBrainHookDetailed([event, '--source', 'claude-code', '--brain-dir', brain], JSON.stringify({ session_id: 'x', cwd: root })), { stdout: '' });
  } finally { delete process.env.FORGEMIND_BRAIN_HOOK; }
  assert.equal(existsSync(brain), false);
});

test('the default runner spawns claude with the hooks switched off and the existing env', () => {
  let seen: { env?: Record<string, string>; input?: string } = {};
  const fake = ((_cmd: string, _args: string[], options: typeof seen) => {
    seen = options;
    return { status: 0, stdout: JSON.stringify({ result: 'hi' }), stderr: '' };
  }) as unknown as typeof spawnSync;
  assert.equal(makeRunner(fake)('p'), 'hi');
  assert.equal(seen.env!.FORGEMIND_BRAIN_HOOK, 'off');
  assert.equal(seen.env!.PATH, process.env.PATH);
  assert.equal(seen.input, 'p');
});
