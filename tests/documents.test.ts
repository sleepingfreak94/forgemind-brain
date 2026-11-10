import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrainStore } from '../src/brain.js';
import { acceptAdr, createAdr, createRecipe, getDocument, listDocuments, redact, rejectAdr, searchDocuments } from '../src/documents.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-docs-')));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function fresh() {
  const base = join(root, `case${counter++}`);
  const project = join(base, 'ws');
  mkdirSync(project, { recursive: true });
  return { dir: join(base, 'brain'), project };
}
const adr = (title: string, extra: object = {}) => ({ title, context: 'ctx', decision: 'dec', alternatives: 'alt', consequences: 'con', ...extra });
const recipe = (extra: object = {}) => ({ goal: 'Fix it', plan: 'p', prompts: ['do x'], deadEnds: ['d'], verification: 'v', outcome: 'o', files: ['a.ts'], ...extra });
function open<T>(dir: string, work: (store: BrainStore) => T): T {
  const store = new BrainStore(dir);
  try { return work(store); } finally { store.close(); }
}

test('ADRs are numbered per project and rendered as markdown', () => {
  const { dir, project } = fresh();
  open(dir, store => {
    const a = createAdr(store, project, 'claude-code', null, adr('Use SQLite'));
    const b = createAdr(store, project, 'cursor', 's1', adr('Use Node'));
    const other = createAdr(store, join(project, 'other'), 'cli', null, adr('Elsewhere'));
    assert.deepEqual([a.number, b.number, other.number], [1, 2, 1]);
    assert.equal(a.status, 'proposed');
    assert.match(a.body, /^# ADR-0001: Use SQLite\n\nStatus: proposed\nDate: \d{4}-\d\d-\d\d\n/);
    for (const h of ['## Context', '## Decision', '## Alternatives considered', '## Consequences', '## Supersedes\nNone']) assert.ok(a.body.includes(h), h);
    assert.equal(getDocument(store, project, 'ADR-2').id, b.id);
    assert.equal(getDocument(store, project, 'adr-0002').id, b.id);
    assert.equal(getDocument(store, project, b.id).title, 'Use Node');
    assert.throws(() => getDocument(store, project, 'ADR-9'), /unknown document/);
    assert.deepEqual(store.audit().map(r => r.action), ['doc-create', 'doc-create', 'doc-create']);
  });
});

test('concurrent creates on two connections and in two processes get distinct numbers', async () => {
  const { dir, project } = fresh();
  const one = new BrainStore(dir), two = new BrainStore(dir);
  try {
    const numbers = [createAdr(one, project, 'cli', null, adr('A')).number, createAdr(two, project, 'cli', null, adr('B')).number,
      createAdr(one, project, 'cli', null, adr('C')).number];
    assert.deepEqual(numbers, [1, 2, 3]);
  } finally { one.close(); two.close(); }
  const module = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'documents.js');
  const brain = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'brain.js');
  const script = `const {BrainStore}=await import(${JSON.stringify(brain)});const {createAdr}=await import(${JSON.stringify(module)});`
    + `const s=new BrainStore(${JSON.stringify(dir)});for(let i=0;i<5;i++)createAdr(s,${JSON.stringify(project)},'cli',null,{title:'t'+process.pid+i,context:'c',decision:'d',alternatives:'a',consequences:'q'});s.close();`;
  const go = () => new Promise<number>(done => { spawn('node', ['--input-type=module', '-e', script], { stdio: 'inherit' }).on('close', code => done(code ?? -1)); });
  assert.deepEqual(await Promise.all([go(), go()]), [0, 0]);
  open(dir, store => assert.deepEqual(listDocuments(store, project, 'adr').map(d => d.number), Array.from({ length: 13 }, (_, i) => i + 1)));
});

test('validation, size caps and secret refusal for ADRs', () => {
  const { dir, project } = fresh();
  open(dir, store => {
    assert.throws(() => createAdr(store, project, 'cli', null, adr('x'.repeat(201))), /invalid title/);
    assert.throws(() => createAdr(store, project, 'cli', null, adr('t', { context: 'x'.repeat(8001) })), /invalid context/);
    assert.throws(() => createAdr(store, project, 'cli', null, adr('t', { decision: '' })), /invalid decision/);
    assert.ok(createAdr(store, project, 'cli', null, adr('ok', { context: 'x'.repeat(8000) })));
    assert.throws(() => createAdr(store, project, 'cli', null, adr('t', { decision: 'password: hunter2' })), /secret/);
    assert.throws(() => createAdr(store, project, 'cli', null, adr('ghp_' + 'a'.repeat(30))), /secret/);
    assert.throws(() => createAdr(store, 'relative', 'cli', null, adr('t')), /absolute/);
    assert.throws(() => createAdr(store, project, 'bogus' as never, null, adr('t')), /invalid source/);
    assert.throws(() => createAdr(store, project, 'cli', null, adr('t', { supersedes: 'ADR-7' })), /unknown document/);
    assert.equal(listDocuments(store, project).length, 1);
  });
});

test('accept, reject and supersede atomically', () => {
  const { dir, project } = fresh();
  open(dir, store => {
    const a = createAdr(store, project, 'cli', null, adr('Old'));
    acceptAdr(store, project, 'ADR-1');
    assert.match(getDocument(store, project, a.id).body, /Status: accepted/);
    assert.throws(() => acceptAdr(store, project, a.id), /invalid transition from accepted to accepted/);
    const b = createAdr(store, project, 'cli', null, adr('New', { supersedes: 'ADR-1' }));
    assert.match(b.body, /## Supersedes\nADR-0001/);
    assert.equal(getDocument(store, project, a.id).status, 'accepted');
    acceptAdr(store, project, 'ADR-2');
    const old = getDocument(store, project, 'ADR-1');
    assert.equal(old.status, 'superseded'); assert.equal(old.supersededBy, b.id); assert.match(old.body, /Status: superseded/);
    assert.equal(getDocument(store, project, 'ADR-2').status, 'accepted');
    const c = createAdr(store, project, 'cli', null, adr('Nope'));
    rejectAdr(store, project, c.id, 'not now');
    const rejected = getDocument(store, project, c.id);
    assert.equal(rejected.status, 'rejected'); assert.equal(rejected.fields.reviewNote, 'not now');
    assert.throws(() => rejectAdr(store, project, c.id), /invalid transition/);
    // a failing supersede (target already superseded) leaves both ADRs untouched
    const d = createAdr(store, project, 'cli', null, adr('Again', { supersedes: 'ADR-1' }));
    assert.throws(() => acceptAdr(store, project, d.id), /cannot supersede/);
    assert.equal(getDocument(store, project, d.id).status, 'proposed');
    assert.equal(getDocument(store, project, 'ADR-1').supersededBy, b.id);
    assert.deepEqual(store.audit().map(r => r.action).filter(a => a !== 'doc-create'), ['doc-accept', 'doc-accept', 'doc-supersede', 'doc-reject']);
  });
});

test('recipes redact prompts, enforce caps and are idempotent', () => {
  const { dir, project } = fresh();
  open(dir, store => {
    const r = createRecipe(store, project, 'claude-code', 's1', recipe({ prompts: ['use token: abc123 here', 'plain', 'key=ghp_' + 'z'.repeat(30) + ' ok'] }));
    assert.equal(r.status, 'recorded'); assert.equal(r.number, null);
    const prompts = r.fields.prompts as string[];
    assert.equal(prompts[1], 'plain');
    assert.ok(prompts[0]!.includes('[redacted]') && !prompts[0]!.includes('abc123') && prompts[0]!.startsWith('use '));
    assert.ok(!r.body.includes('abc123') && !r.body.includes('zzzz'));
    assert.equal(createRecipe(store, project, 'claude-code', 's1', recipe({ plan: 'different' })).id, r.id);
    assert.notEqual(createRecipe(store, project, 'claude-code', 's2', recipe()).id, r.id);
    assert.equal(listDocuments(store, project, 'recipe').length, 2);
    assert.throws(() => createRecipe(store, project, 'cli', null, recipe({ prompts: Array(51).fill('a') })), /invalid prompts/);
    assert.throws(() => createRecipe(store, project, 'cli', null, recipe({ prompts: ['a'.repeat(4001)] })), /invalid prompts/);
    assert.throws(() => createRecipe(store, project, 'cli', null, recipe({ prompts: Array(6).fill('a'.repeat(4000)) })), /invalid prompts/);
    assert.throws(() => createRecipe(store, project, 'cli', null, recipe({ outcome: 'secret = x' })), /secret/);
    assert.ok(createRecipe(store, project, 'cli', null, recipe({ goal: 'five', prompts: Array(5).fill('a'.repeat(4000)) })));
    assert.equal(redact('clean text'), 'clean text');
    assert.ok(!containsAny(redact('password = hunter2\nnext line')));
  });
});
const containsAny = (v: string): boolean => /hunter2/.test(v);

test('list filters and search return short snippets', () => {
  const { dir, project } = fresh();
  open(dir, store => {
    createAdr(store, project, 'cli', null, adr('Pick a database', { decision: 'We chose SQLite for storage' }));
    acceptAdr(store, project, 'ADR-1');
    createAdr(store, project, 'cli', null, adr('Pick a queue'));
    createRecipe(store, project, 'cli', 's', recipe({ goal: 'Add storage layer' }));
    assert.equal(listDocuments(store, project).length, 3);
    assert.equal(listDocuments(store, project, 'adr', 'accepted').length, 1);
    assert.equal(listDocuments(store, project, 'recipe').length, 1);
    assert.throws(() => listDocuments(store, project, 'x' as never), /invalid kind/);
    const hits = searchDocuments(store, project, 'SQLite');
    assert.equal(hits.length, 1); assert.equal(hits[0]!.label, 'ADR-0001');
    assert.ok(hits[0]!.snippet.includes('SQLite') && hits[0]!.snippet.length <= 170);
    assert.equal(searchDocuments(store, project, 'storage').length, 2);
    assert.equal(searchDocuments(store, project, '100%').length, 0);
    assert.equal(searchDocuments(store, join(project, 'x'), 'SQLite').length, 0);
  });
});
