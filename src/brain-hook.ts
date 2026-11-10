import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrainStore, clientSources, containsSecret, defaultBrainDirectory, redactSecrets } from './brain.js';
import { contextText, resolveWorkspace } from './brain-mcp.js';
import { readTranscript } from './transcript.js';

export interface BrainHookOptions { brainDirectory?: string; now?: () => number; changedFiles?: (workspace: string) => string[] }

const MAX_INPUT = 1048576;
const MAX_PROMPT = 4000, MAX_PROMPTS = 50, MAX_PROMPT_TOTAL = 20000;
const TITLE_PROMPT_CAP = 160;
const MAX_FILES = 200;
const RECORD_LINE = 'Before you finish, call the forgemind-brain tools brain_record (what worked and what failed) and brain_recipe (plan, the exact prompts, dead ends, verification, outcome). Record significant decisions with brain_adr.';

const red = (value: string): string => containsSecret(value) ? '[redacted]' : value;
// Cutting redacted text can create a new match (e.g. a cut AKIA run), so re-redact until stable; give up rather than store a secret.
function cut(text: string, max: number): string {
  let out = redactSecrets(text).slice(0, max);
  for (let i = 0; i < 3 && containsSecret(out); i++) out = redactSecrets(out).slice(0, max);
  return containsSecret(out) ? '[redacted]' : out;
}
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

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
  if (argv.length !== 3 || argv[1] !== '--source') throw new Error('usage: session-start|session-end --source claude-code|cursor|codex');
  const event = argv[0], source = clientSources.find(s => s === argv[2]);
  if (event !== 'session-start' && event !== 'session-end') throw new Error('unknown event');
  if (!source) throw new Error('unknown source');
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
  if (event === 'session-start') {
    const store = new BrainStore(brainDirectory);
    try {
      const text = contextText(store, workspace) + '\n' + RECORD_LINE;
      return source === 'claude-code'
        ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
        : JSON.stringify({ additional_context: text });
    } finally { store.close(); }
  }
  const transcript = data.transcript_path;
  const capture = readTranscript(transcript);
  const real = capture?.prompts ?? [];
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
  if (real.length === 0 && files.length === 0) return '';
  const prompts: string[] = [];
  let total = 0;
  for (const p of real.slice(0, MAX_PROMPTS)) {
    const text = cut(p, MAX_PROMPT); // redact the whole text first, then cut
    if (total + text.length > MAX_PROMPT_TOTAL) break; // keep the earliest
    prompts.push(text); total += text.length;
  }
  const raw = capture?.signals;
  const n = (x: number): number => Math.min(Math.max(0, Math.trunc(x)), 1e9);
  const signals = raw && { prompts: n(raw.prompts), corrections: n(raw.corrections), correctionIndexes: raw.correctionIndexes.slice(0, MAX_PROMPTS).map(n),
    model: raw.model === null ? null : cut(raw.model, 100) || null, assistantTurns: n(raw.assistantTurns), toolErrors: n(raw.toolErrors),
    durationMs: raw.durationMs === null ? null : n(raw.durationMs) };
  const title = real.length > 0 ? cut(real[0]!.replace(/\s+/g, ' ').trim(), TITLE_PROMPT_CAP).trimEnd() : `Session: ${files.length} files changed`;
  const summary = `${real.length} prompts, ${signals?.corrections ?? 0} corrections, ${files.length} files changed` + (signals?.model ? `, model ${signals.model}` : '');
  let id = typeof sessionId === 'string' && sessionId !== '' ? sessionId
    : sha(JSON.stringify([typeof transcript === 'string' ? transcript : workspace, new Date(now).toISOString().slice(0, 10)]));
  if (id.length > 190) id = sha(id);
  const store = new BrainStore(brainDirectory);
  try {
    store.record({ project: workspace, source, key: red('session:' + id), title,
      summary: red(summary), files: files.map(red), outcome: red('session ended'), evidence: ['hook:' + source],
      prompts: real.length > 0 ? prompts : undefined, signals: real.length > 0 ? signals : undefined });
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
