import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrainStore, containsSecret, defaultBrainDirectory } from './brain.js';
import { brainSpaceFor } from './brain-spaces.js';
import { contextText, resolveWorkspace } from './brain-mcp.js';

export interface BrainHookOptions { brainDirectory?: string; now?: () => number; changedFiles?: (workspace: string) => string[] }

const MAX_INPUT = 1048576;
const MAX_TRANSCRIPT = 20971520;
const TITLE_PROMPT_CAP = 160;
const MAX_FILES = 200;
const RECORD_LINE = 'Before you finish, call the forgemind-brain tool brain_record with a short title, summary, files changed and outcome.';

const red = (value: string): string => containsSecret(value) ? '[redacted]' : value;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

function userText(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  let content: unknown;
  if (o.type === 'user' && o.message && typeof o.message === 'object' && (o.message as Record<string, unknown>).role === 'user') {
    content = (o.message as Record<string, unknown>).content;
  } else if (o.role === 'user') {
    content = o.content ?? (o.message && typeof o.message === 'object' ? (o.message as Record<string, unknown>).content : undefined);
  } else return undefined;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.filter((p): p is { type: string; text: string } => !!p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text).join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

export function cleanPrompt(text: string): string {
  let t = String(text).replace(/<timestamp\b[^>]*>[\s\S]*?<\/timestamp>/gi, ' ');
  const q = /<user_query\b[^>]*>([\s\S]*?)<\/user_query>/i.exec(t);
  if (q) t = q[1] ?? '';
  const tag = /^\s*<\/?[A-Za-z][\w:.-]*(?:\s[^>]*)?\/?>/;
  while (tag.test(t)) t = t.replace(tag, '');
  return t.replace(/\s+/g, ' ').trim();
}

function readFirstPrompt(path: unknown): string | undefined {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT) return undefined;
    const chunk = Buffer.alloc(65536);
    let pending = '', position = 0;
    while (position < stat.size) {
      const n = readSync(fd, chunk, 0, chunk.length, position);
      if (n <= 0) break;
      position += n;
      pending += chunk.subarray(0, n).toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const text = parseLine(line);
        if (text !== undefined) return text;
      }
    }
    return parseLine(pending);
  } catch { return undefined; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}

function parseLine(line: string): string | undefined {
  if (line.trim() === '') return undefined;
  try { return userText(JSON.parse(line)); } catch { return undefined; }
}

function defaultChangedFiles(workspace: string): string[] {
  try {
    const out = execFileSync('/usr/bin/git', ['-C', workspace, 'status', '--porcelain', '-z'],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin' }, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
    const records = out.toString('utf8').split('\0');
    const files: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      if (record.length < 4) continue;
      files.push(record.slice(3));
      if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') i++;
    }
    return files.filter(f => f !== '');
  } catch { return []; }
}

async function runBrainHookCore(argv: string[], input: string, options: BrainHookOptions): Promise<string> {
  if (argv.length !== 3 || argv[1] !== '--source') throw new Error('usage: session-start|session-end --source claude-code|cursor');
  const event = argv[0], source = argv[2];
  if (event !== 'session-start' && event !== 'session-end') throw new Error('unknown event');
  if (source !== 'claude-code' && source !== 'cursor') throw new Error('unknown source');
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT) throw new Error('input too large');
  const parsed: unknown = JSON.parse(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('input must be an object');
  const data = parsed as Record<string, unknown>;
  let candidate: unknown;
  let sessionId: unknown;
  if (source === 'claude-code') { candidate = data.cwd; sessionId = data.session_id; }
  else {
    const roots = data.workspace_roots;
    candidate = Array.isArray(roots) ? roots[0] : undefined;
    sessionId = data.conversation_id ?? data.session_id;
  }
  if (typeof candidate !== 'string' || candidate === '') throw new Error('missing workspace');
  const brainDirectory = options.brainDirectory ?? defaultBrainDirectory();
  const workspace = resolveWorkspace(candidate);
  const space = brainSpaceFor(workspace, brainDirectory);
  if (event === 'session-start') {
    const store = new BrainStore(brainDirectory, space);
    try {
      const text = contextText(store, space, workspace) + '\n' + RECORD_LINE;
      return source === 'claude-code'
        ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
        : JSON.stringify({ additional_context: text });
    } finally { store.close(); }
  }
  const transcript = data.transcript_path;
  const prompt = readFirstPrompt(transcript);
  const cleaned = prompt === undefined ? '' : cleanPrompt(prompt);
  if (cleaned === '') return '';
  const rawFiles = (options.changedFiles ?? defaultChangedFiles)(workspace);
  const seen = new Set<string>();
  for (const f of rawFiles) {
    if (typeof f !== 'string' || f.length < 1 || f.length > 1024) continue;
    const rel = relative(workspace, resolve(workspace, f));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    seen.add(rel.split(sep).join('/'));
  }
  const files = [...seen].slice(0, MAX_FILES);
  const now = (options.now ?? Date.now)();
  const title = 'Session (auto): ' + cleaned.slice(0, TITLE_PROMPT_CAP).trimEnd();
  let id = typeof sessionId === 'string' && sessionId !== '' ? sessionId
    : sha(JSON.stringify([typeof transcript === 'string' ? transcript : workspace, new Date(now).toISOString().slice(0, 10)]));
  if (id.length > 190) id = sha(id);
  const store = new BrainStore(brainDirectory, space);
  try {
    store.record({ project: workspace, source, key: red('session:' + id), title: red(title),
      summary: red(`Auto-captured at session end. Files changed: ${files.length}.`), files: files.map(red),
      outcome: red('session ended'), evidence: ['hook:' + source] });
  } finally { store.close(); }
  return '';
}

export async function runBrainHookDetailed(argv: string[], input: string, options: BrainHookOptions = {}): Promise<{ stdout: string; error?: string }> {
  try { return { stdout: await runBrainHookCore(argv, input, options) }; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: '', error: message.replace(/[\r\n]+/g, ' ').slice(0, 300) };
  }
}

export async function runBrainHook(argv: string[], input: string, options?: { brainDirectory?: string; now?: () => number; changedFiles?: (workspace: string) => string[] }): Promise<string> {
  return (await runBrainHookDetailed(argv, input, options)).stdout;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
    chunks.push(buf); size += buf.length;
    if (size > MAX_INPUT + 1) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = 0;
  readStdin().then(text => runBrainHookDetailed(process.argv.slice(2), text)).then(result => {
    if (result.stdout !== '') process.stdout.write(result.stdout + '\n');
    if (result.error) process.stderr.write(`forgemind brain hook: ${result.error}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`forgemind brain hook: ${error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ') : 'failed'}\n`);
  }).finally(() => { process.exitCode = 0; });
}
