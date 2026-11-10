import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainStore } from '../../src/memory/brain.js';
import { mapBrainSpace } from '../../src/memory/brain-spaces.js';
import { cleanPrompt, runBrainHook } from '../../src/memory/brain-hook.js';

const LINE = 'Before you finish, call the forgemind-brain tool brain_record with a short title, summary, files changed and outcome.';
const NOW = Date.parse('2026-10-24T10:00:00Z');
let root: string, brain: string, ws: string, sub: string, other: string, tdir: string;
const seq = { n: 0 };

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-hook-')));
  brain = join(root, 'brain'); ws = join(root, 'ws'); sub = join(ws, 'sub'); other = join(root, 'other'); tdir = join(root, 't');
  mkdirSync(brain, { mode: 0o700 });
  for (const d of [join(ws, '.git'), sub, join(other, '.git'), tdir]) mkdirSync(d, { recursive: true });
  mapBrainSpace(ws, 'personal', brain);
  const store = new BrainStore(brain, 'personal');
  store.approve(store.propose({ kind: 'convention', project: ws, text: 'Use tabs never', reason: 'owner', evidence: [] }));
  store.close();
});
after(() => { rmSync(root, { recursive: true, force: true }); });

const history = (project = ws) => { const s = new BrainStore(brain, 'personal'); try { return s.history(project); } finally { s.close(); } };
const opts = (files: string[] = []) => ({ brainDirectory: brain, now: () => NOW, changedFiles: () => files });
const transcript = (lines: object[]) => { const p = join(tdir, `t${seq.n++}.jsonl`); writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n'); return p; };
const sid = () => `s${seq.n++}`;

test('claude session-start shape', async () => {
  const out = await runBrainHook(['session-start', '--source', 'claude-code'], JSON.stringify({ session_id: 'a', cwd: sub, hook_event_name: 'SessionStart' }), opts());
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  const text: string = parsed.hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith('ForgeMind brain (personal space)'));
  assert.ok(text.includes('Use tabs never'));
  assert.ok(text.endsWith(LINE));
  assert.ok(text.length <= 3200 + 1 + LINE.length);
});

test('cursor session-start shape', async () => {
  const out = await runBrainHook(['session-start', '--source', 'cursor'], JSON.stringify({ conversation_id: 'c', workspace_roots: [ws], hook_event_name: 'sessionStart', transcript_path: null }), opts());
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed), ['additional_context']);
  assert.ok(parsed.additional_context.startsWith('ForgeMind brain (personal space)'));
  assert.ok(parsed.additional_context.includes('Use tabs never'));
  assert.ok(parsed.additional_context.endsWith(LINE));
});

test('unmapped workspace works in the personal space', async () => {
  const start = await runBrainHook(['session-start', '--source', 'claude-code'], JSON.stringify({ session_id: 'u', cwd: other }), opts());
  const text: string = JSON.parse(start).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith('ForgeMind brain (personal space)'));
  assert.ok(text.endsWith(LINE));
  assert.ok(!text.includes('Use tabs never'));
  const t = transcript([{ type: 'user', message: { role: 'user', content: 'Unmapped prompt' } }]);
  await runBrainHook(['session-end', '--source', 'claude-code'], JSON.stringify({ session_id: sid(), cwd: other, transcript_path: t }), opts(['a.ts']));
  assert.ok(history(other).some(x => x.title === 'Session (auto): Unmapped prompt'));
  assert.ok(!history(ws).some(x => x.title === 'Session (auto): Unmapped prompt'));
});

test('claude session-end records from transcript', async () => {
  const long = 'x'.repeat(300);
  const t = transcript([{ type: 'summary', summary: 's' }, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] } },
    { type: 'user', message: { role: 'user', content: 'later prompt' } }]);
  const id = sid();
  assert.equal(await runBrainHook(['session-end', '--source', 'claude-code'], JSON.stringify({ session_id: id, cwd: ws, transcript_path: t }), opts(['a.ts', 'b/c.ts'])), '');
  const h = history().find(x => x.title === 'Session (auto): Fix the bug')!;
  assert.ok(h);
  assert.equal(h.summary, 'Auto-captured at session end. Files changed: 2.');
  assert.deepEqual(h.files, ['a.ts', 'b/c.ts']);
  assert.equal(h.outcome, 'session ended');
  assert.equal(h.source, 'claude-code');
  const t2 = transcript([{ type: 'user', message: { role: 'user', content: long } }]);
  await runBrainHook(['session-end', '--source', 'claude-code'], JSON.stringify({ session_id: sid(), cwd: ws, transcript_path: t2 }), opts());
  const l = history().find(x => x.title.startsWith('Session (auto): xxx'))!;
  assert.ok(l.title.length - 'Session (auto): '.length <= 160);
});

const WRAPPED = '<timestamp>Saturday, Oct 24, 2026, 11:11 PM (UTC+5:30)</timestamp>\n<user_query>\nAnswer in 4 short lines...\n</user_query>';

test('cleanPrompt', () => {
  assert.equal(cleanPrompt(WRAPPED), 'Answer in 4 short lines...');
  assert.equal(cleanPrompt('  Fix   the\nbug '), 'Fix the bug');
  assert.equal(cleanPrompt('<timestamp>x</timestamp>'), '');
  assert.equal(cleanPrompt('<context>hi'), 'hi');
});

test('cursor session-end with null transcript records nothing; wrapped prompt dedups', async () => {
  const before = history().length;
  await runBrainHook(['session-end', '--source', 'cursor'], JSON.stringify({ conversation_id: 'nul', workspace_roots: [ws], transcript_path: null }), opts(['z.ts']));
  assert.equal(history().length, before);
  const t = transcript([{ role: 'user', content: [{ type: 'text', text: WRAPPED }] }]);
  const input = JSON.stringify({ conversation_id: 'dup', workspace_roots: [ws], transcript_path: t });
  await runBrainHook(['session-end', '--source', 'cursor'], input, opts(['z.ts']));
  await runBrainHook(['session-end', '--source', 'cursor'], input, opts(['z.ts']));
  const h = history();
  assert.equal(h.length, before + 1);
  const e = h.find(x => x.source === 'cursor')!;
  assert.equal(e.title, 'Session (auto): Answer in 4 short lines...');
});

test('claude session without a user prompt records nothing even with files', async () => {
  const before = history().length;
  const t = transcript([{ type: 'summary', summary: 's' }]);
  assert.equal(await runBrainHook(['session-end', '--source', 'claude-code'], JSON.stringify({ session_id: sid(), cwd: ws, transcript_path: t }), opts(['a.ts'])), '');
  assert.equal(history().length, before);
});

test('secrets become [redacted]', async () => {
  for (const secret of ['password: hunter2', 'ghp_' + 'a'.repeat(24)]) {
    const t = transcript([{ type: 'user', message: { role: 'user', content: secret } }]);
    await runBrainHook(['session-end', '--source', 'claude-code'], JSON.stringify({ session_id: sid(), cwd: ws, transcript_path: t }), opts());
  }
  const h = history();
  assert.equal(h.filter(x => x.title === '[redacted]').length, 2);
  assert.ok(!JSON.stringify(h).includes('hunter2'));
  assert.ok(!JSON.stringify(h).includes('ghp_'));
});

test('nothing recorded without prompt and files; non-regular transcript ignored', async () => {
  const before = history().length;
  assert.equal(await runBrainHook(['session-end', '--source', 'cursor'], JSON.stringify({ conversation_id: 'none', workspace_roots: [ws] }), opts()), '');
  assert.equal(await runBrainHook(['session-end', '--source', 'claude-code'], JSON.stringify({ session_id: 'dir', cwd: ws, transcript_path: tdir }), opts()), '');
  const link = join(tdir, 'link'); symlinkSync(tdir, link);
  assert.equal(await runBrainHook(['session-end', '--source', 'claude-code'], JSON.stringify({ session_id: 'lnk', cwd: ws, transcript_path: link }), opts()), '');
  assert.equal(history().length, before);
});

test('garbage input returns empty string', async () => {
  const argv = ['session-end', '--source', 'claude-code'];
  for (const input of ['not json', '[]', '{}', '{"cwd":"' + 'a'.repeat(1048577) + '"}']) assert.equal(await runBrainHook(argv, input, opts()), '');
  assert.equal(await runBrainHook(['session-middle', '--source', 'x'], '{}', opts()), '');
});
