import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainStore } from '../src/brain.js';
import { handleBrainMessage, contextText } from '../src/brain-mcp.js';
import { runBrainCli } from '../src/cli.js';
import { acceptAdr, createAdr, createRecipe } from '../src/documents.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-docs-mcp-')));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function fresh() {
  const base = join(root, `case${counter++}`);
  const workspace = join(base, 'ws');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  return { brainDirectory: join(base, 'brain'), workspace, base };
}
type Ctx = ReturnType<typeof fresh>;
const full = { title: 'Use SQLite', context: 'c', decision: 'We use SQLite', alternatives: 'a', consequences: 'q' };
function call(c: Ctx, name: string, args: object = {}): { text: string; isError: boolean } {
  const reply = handleBrainMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { brainDirectory: c.brainDirectory, workspace: c.workspace, source: 'claude-code' }) as { result: { content: { text: string }[]; isError: boolean } };
  return { text: reply.result.content[0]!.text, isError: reply.result.isError };
}
function withStore<T>(c: Ctx, work: (s: BrainStore) => T): T { const s = new BrainStore(c.brainDirectory); try { return work(s); } finally { s.close(); } }

test('initialize instructions stay short and tell agents about ADRs and recipes', () => {
  const c = fresh();
  const reply = handleBrainMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { brainDirectory: c.brainDirectory, workspace: c.workspace, source: 'cursor' }) as { result: { instructions: string } };
  const text = reply.result.instructions;
  assert.ok(text.length < 1000, String(text.length));
  for (const word of ['brain_context first', 'brain_adr', 'ADR-0001', 'brain_recipe', 'exact', 'dead ends', 'brain_record', 'brain_propose', 'attachments']) assert.ok(text.includes(word), word);
});

test('tool schemas require the fields', () => {
  const c = fresh();
  const reply = handleBrainMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { brainDirectory: c.brainDirectory, workspace: c.workspace, source: 'cursor' }) as { result: { tools: { name: string; inputSchema: { required: string[] } }[] } };
  const req = (n: string) => reply.result.tools.find(t => t.name === n)!.inputSchema.required;
  assert.deepEqual(req('brain_adr'), ['title', 'context', 'decision', 'alternatives', 'consequences']);
  assert.deepEqual(req('brain_recipe'), ['goal', 'plan', 'prompts', 'deadEnds', 'verification', 'outcome']);
  assert.deepEqual(req('brain_doc'), ['id']);
});

test('brain_adr, brain_recipe and brain_doc', () => {
  const c = fresh();
  assert.equal(call(c, 'brain_adr', full).text, 'ADR-0001 proposed; the owner must accept it');
  assert.equal(call(c, 'brain_adr', { ...full, title: 'Second', supersedes: 'ADR-1' }).text, 'ADR-0002 proposed; the owner must accept it');
  assert.equal(call(c, 'brain_adr', { ...full, context: 'token: abc' }).isError, true);
  assert.equal(call(c, 'brain_adr', { title: 'x' }).isError, true);
  assert.ok(call(c, 'brain_doc', { id: 'ADR-1' }).text.startsWith('# ADR-0001: Use SQLite'));
  assert.equal(call(c, 'brain_doc', { id: 'ADR-9' }).isError, true);
  const r = call(c, 'brain_recipe', { goal: 'g', plan: 'p', prompts: ['hello', 'password: x'], deadEnds: [], verification: 'v', outcome: 'o' });
  assert.match(r.text, /^recipe [0-9a-f]{16} saved$/);
  assert.equal(call(c, 'brain_recipe', { goal: 'g', plan: 'p', prompts: ['hello'], deadEnds: [], verification: 'v', outcome: 'o' }).text, r.text);
  const body = call(c, 'brain_doc', { id: r.text.split(' ')[1]! }).text;
  assert.ok(body.includes('hello') && body.includes('[redacted]') && !body.includes('password'));
  withStore(c, s => createAdr(s, c.workspace, 'cli', null, { ...full, title: 'Big', context: 'x'.repeat(8000), decision: 'x'.repeat(8000), alternatives: 'x'.repeat(8000), consequences: 'x'.repeat(8000) }));
  assert.ok(call(c, 'brain_doc', { id: 'ADR-3' }).text.length <= 12000);
});

test('brain_search finds documents within the caps', () => {
  const c = fresh();
  withStore(c, s => {
    for (let i = 0; i < 8; i++) createAdr(s, c.workspace, 'cli', null, { ...full, title: `Database choice ${i}`, decision: 'Pick the database engine. ' + 'x'.repeat(600) });
  });
  const out = call(c, 'brain_search', { query: 'database engine' }).text;
  assert.ok(out.includes('[adr] ADR-'));
  const lines = out.split('\n');
  assert.ok(lines.length <= 5 && lines.every(l => l.length <= 400) && out.length <= 2000);
});

test('contextText lists accepted ADRs, proposed count and recent recipes within the cap', () => {
  const c = fresh();
  assert.ok(!contextText(new BrainStore(c.brainDirectory), c.workspace).includes('ADR'));
  withStore(c, s => {
    createAdr(s, c.workspace, 'cli', null, { ...full, title: 'Stack choice' }); acceptAdr(s, c.workspace, 'ADR-1');
    createAdr(s, c.workspace, 'cli', null, { ...full, title: 'Pending one' });
    createAdr(s, c.workspace, 'cli', null, { ...full, title: 'Pending two' });
    for (const g of ['r1', 'r2', 'r3', 'r4']) createRecipe(s, c.workspace, 'cli', g, { goal: g, plan: 'p', prompts: [], deadEnds: [], verification: 'v', outcome: 'o', files: [] });
    const text = contextText(s, c.workspace);
    assert.ok(text.includes('ADR-0001 Stack choice'));
    assert.ok(!text.includes('Pending one') && text.includes('(2 proposed ADRs waiting for the owner)'));
    assert.match(text, /Recent recipes: r\d; r\d; r\d$/);
    assert.ok(text.length <= 3200);
  });
});

test('the ADR section yields to existing items and the cap holds', () => {
  const c = fresh();
  withStore(c, s => {
    for (let i = 0; i < 40; i++) { const id = s.propose({ kind: 'convention', project: c.workspace, text: `Convention ${i} ` + 'w'.repeat(150), evidence: [], reason: 'r' }); s.approve(id); }
    for (let i = 0; i < 30; i++) { createAdr(s, c.workspace, 'cli', null, { ...full, title: `Decision number ${i} ` + 'y'.repeat(60) }); acceptAdr(s, c.workspace, `ADR-${i + 1}`); }
    const text = contextText(s, c.workspace);
    assert.ok(text.length <= 3200, String(text.length));
    assert.ok(text.includes('[convention]'));
  });
});

function cli(c: Ctx, args: string[]) {
  let out = '';
  const code = runBrainCli([...args, '--brain-dir', c.brainDirectory], { write: t => { out += t; } });
  return { code, json: JSON.parse(out) as Record<string, any> };
}

test('docs CLI: list, show, accept, reject', () => {
  const c = fresh();
  const ws = c.workspace;
  const [a, b] = withStore(c, s => [createAdr(s, ws, 'cli', null, full), createAdr(s, ws, 'cli', null, { ...full, title: 'Other' })]) as [any, any];
  assert.equal(cli(c, ['docs', 'list', '--workspace', ws]).json.documents.length, 2);
  assert.equal(cli(c, ['docs', 'list', '--workspace', ws, '--kind', 'adr', '--status', 'proposed']).json.documents.length, 2);
  assert.equal(cli(c, ['docs', 'list', '--workspace', ws, '--kind', 'recipe']).json.documents.length, 0);
  assert.equal(cli(c, ['docs', 'list', '--workspace', ws, '--kind', 'lesson']).code, 2);
  assert.equal(cli(c, ['docs', 'nope', '--workspace', ws]).code, 2);
  assert.equal(cli(c, ['docs']).code, 2);
  assert.equal(cli(c, ['docs', 'show', '--workspace', ws, '--id', 'ADR-1']).json.document.id, a.id);
  assert.equal(cli(c, ['docs', 'show', '--workspace', ws, '--id', 'ADR-9']).code, 1);
  assert.deepEqual(cli(c, ['docs', 'accept', '--workspace', ws, '--id', 'ADR-1']).json, { ok: true });
  assert.equal(cli(c, ['docs', 'accept', '--workspace', ws, '--id', 'ADR-1']).code, 1);
  assert.deepEqual(cli(c, ['docs', 'reject', '--workspace', ws, '--id', b.id, '--note', 'no']).json, { ok: true });
  assert.equal(cli(c, ['docs', 'list', '--workspace', ws, '--status', 'accepted']).json.documents.length, 1);
  assert.equal(cli(c, ['list', '--workspace', ws, '--status', 'proposed']).code, 0);
});

test('docs export writes accepted ADRs and refuses to overwrite', () => {
  const c = fresh();
  const ws = c.workspace, out = join(c.base, 'out');
  mkdirSync(out);
  withStore(c, s => {
    createAdr(s, ws, 'cli', null, { ...full, title: 'Use SQLite, always!' }); acceptAdr(s, ws, 'ADR-1');
    createAdr(s, ws, 'cli', null, { ...full, title: 'Draft' });
  });
  const done = cli(c, ['docs', 'export', '--workspace', ws, '--to', out]);
  assert.deepEqual(done.json, { files: ['0001-use-sqlite-always.md'] });
  assert.equal(readdirSync(out).length, 1);
  assert.ok(readFileSync(join(out, '0001-use-sqlite-always.md'), 'utf8').startsWith('# ADR-0001: Use SQLite, always!'));
  const again = cli(c, ['docs', 'export', '--workspace', ws, '--to', out]);
  assert.equal(again.code, 1); assert.match(again.json.error, /refusing to overwrite/);
  assert.equal(cli(c, ['docs', 'export', '--workspace', ws, '--to', join(c.base, 'missing')]).code, 1);
  writeFileSync(join(c.base, 'file'), 'x');
  assert.equal(cli(c, ['docs', 'export', '--workspace', ws, '--to', join(c.base, 'file')]).code, 1);
  assert.equal(cli(c, ['docs', 'export', '--workspace', ws]).code, 2);
  assert.ok(!existsSync(join(c.base, 'missing')));
});
