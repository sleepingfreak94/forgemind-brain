import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCorrection, parseTranscript, readTranscript } from '../src/transcript.js';

const jl = (lines: object[]): string => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
const user = (content: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });

test('corrections: positives and negatives', () => {
  for (const p of ['No, use tabs', 'nope', 'Wrong file', "that's not what I meant", "that's not what I asked", 'Not what I asked', 'undo that',
    "You didn't run the tests", 'Actually, no', 'why did you delete it', 'I told you to use X', 'I said tabs', 'it still fails', 'still broken',
    'not working', 'wait, that is not right'])
    assert.ok(isCorrection(p), p);
  for (const p of ['now add tests', 'note that the file is big', 'nothing else to add', 'Add a stop button', 'Can you undo the rename?', 'notes for later', 'looks good',
    'No rush, also add tests', 'Stop the dev server and restart', "Don't forget to update the docs", 'Revert the version bump then release',
    'Instead of npm use pnpm?', 'Nope that works, thanks', 'Do not touch the lockfile'])
    assert.ok(!isCorrection(p), p);
});

test('parser keeps typed prompts only and measures signals', () => {
  const text = jl([
    { type: 'permission-mode', mode: 'default' },
    user('<local-command-caveat>Caveat: ignore</local-command-caveat>', { timestamp: '2026-01-01T00:00:00Z' }),
    user('<command-name>/model</command-name>'),
    user('<local-command-stdout>done</local-command-stdout>'),
    user('<system-reminder>hook context</system-reminder>', { isMeta: true }),
    user('Build the parser', { timestamp: '2026-01-01T00:00:10Z' }),
    { type: 'assistant', timestamp: '2026-01-01T00:00:20Z', message: { id: 'a1', role: 'assistant', model: 'claude-test-1', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'assistant', message: { id: 'a1', role: 'assistant', model: 'claude-test-1', content: [{ type: 'tool_use' }] } },
    user([{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }, { type: 'tool_result', tool_use_id: 'u', content: 'fine' }], { toolUseResult: 'x' }),
    { type: 'assistant', message: { id: 'a2', role: 'assistant', model: '<synthetic>', content: [] } },
    user([{ type: 'text', text: '[Request interrupted by user]' }]),
    user([{ type: 'text', text: 'No, use tabs' }], { timestamp: '2026-01-01T00:01:40Z' }),
    user('now add tests'),
    user('side chat', { isSidechain: true })
  ]) + 'not json at all\n';
  const r = parseTranscript(text);
  assert.deepEqual(r.prompts, ['Build the parser', 'No, use tabs', 'now add tests']);
  assert.deepEqual(r.signals, { prompts: 3, corrections: 1, correctionIndexes: [1], model: 'claude-test-1', assistantTurns: 2, toolErrors: 1, durationMs: 100000 });
});

test('the first prompt is never a correction; empty and garbage input do not throw', () => {
  assert.equal(parseTranscript(jl([user('No thanks')])).signals.corrections, 0);
  const empty = parseTranscript('');
  assert.deepEqual(empty.prompts, []);
  assert.equal(empty.signals.durationMs, null);
  assert.equal(empty.signals.model, null);
  assert.deepEqual(parseTranscript('{"a":\n[1]\nnull\n"x"\n{"type":"user","message":5}').prompts, []);
});

test('cursor format: user_query wrapper is unwrapped, no model or timestamps', () => {
  const r = parseTranscript(jl([{ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nAdd a flag\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }, { type: 'status', status: 'done' }]));
  assert.deepEqual(r.prompts, ['Add a flag']);
  assert.equal(r.signals.model, null);
  assert.equal(r.signals.assistantTurns, 1);
  assert.equal(r.signals.durationMs, null);
});

test('readTranscript reads only the tail of a huge file and refuses relative or missing paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const file = join(dir, 'big.jsonl');
    const old = JSON.stringify(user('old prompt')) + '\n';
    const pad = JSON.stringify({ type: 'x', pad: 'z'.repeat(1000) }) + '\n';
    writeFileSync(file, old + pad.repeat(21000) + JSON.stringify(user('late prompt')) + '\n');
    assert.deepEqual(readTranscript(file)?.prompts, ['late prompt']);
    assert.equal(readTranscript('rel.jsonl'), undefined);
    assert.equal(readTranscript(join(dir, 'missing')), undefined);
    assert.equal(readTranscript(dir), undefined);
    assert.equal(readTranscript(null), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('more than 50 corrections: indexes are bounded, the count is not', () => {
  const lines = [user('start'), ...Array.from({ length: 60 }, () => user('no, redo'))];
  const r = parseTranscript(jl(lines));
  assert.equal(r.signals.corrections, 60);
  assert.equal(r.signals.correctionIndexes.length, 49);
});
