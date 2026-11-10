import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Takes the prompt and a working directory, returns the model's answer text. Injected in tests. */
export type ModelRunner = (prompt: string, cwd: string) => string;
export type Spawn = typeof spawnSync;
export const clientSources = ['claude-code', 'cursor', 'codex'] as const;

// --safe-mode drops CLAUDE.md, skills, plugins, hooks, MCP and agents (auth still works); the rest are extra layers.
export const claudeArgs = ['-p', '--output-format', 'json', '--model', 'sonnet', '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
// Print mode cannot turn tools off, so ask mode (read-only), the sandbox and an empty cwd are the isolation; --trust only trusts that empty cwd.
export const cursorArgs = ['-p', '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled', '--trust'];
// UNTESTED (codex is not installed where this was written): flags are from codex's public docs.
export const codexArgs = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'];

const OPTIONS = { encoding: 'utf8' as const, timeout: 600000, maxBuffer: 4 * 1024 * 1024 };
// FORGEMIND_BRAIN_HOOK=off keeps the user's brain hooks from recording this session (--bare would break OAuth login).
const env = () => ({ ...process.env, FORGEMIND_BRAIN_HOOK: 'off' });
function finish(r: ReturnType<Spawn>): string {
  if (r.error || r.status !== 0) throw new Error(`model run failed: ${r.error?.message ?? String(r.stderr).slice(0, 200)}`);
  return String(r.stdout);
}
/** The `.result` text of a JSON envelope; lenient: last JSON line with a string `.result`, else the raw text. */
export function resultText(stdout: string): string {
  const lines = [stdout.trim(), ...stdout.trim().split('\n').reverse()];
  for (const l of lines) {
    try { const v = JSON.parse(l) as { result?: unknown; is_error?: unknown }; if (v && typeof v.result === 'string') { if (v.is_error) throw new Error('model run failed: error result'); return v.result; } }
    catch (error) { if ((error as Error).message.startsWith('model run failed')) throw error; }
  }
  return stdout;
}

export const makeRunner = (spawn: Spawn = spawnSync): ModelRunner => (prompt, cwd) => {
  const out = finish(spawn('claude', claudeArgs, { cwd, env: env(), input: prompt, ...OPTIONS }));
  const body = JSON.parse(out) as { result?: unknown; is_error?: unknown };
  if (body.is_error || typeof body.result !== 'string') throw new Error('model run failed: bad envelope');
  return body.result;
};
export const makeCursorRunner = (spawn: Spawn = spawnSync): ModelRunner => (prompt, cwd) => {
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return resultText(finish(spawn('cursor-agent', [...cursorArgs, prompt], { cwd, env: env(), ...OPTIONS })));
};
export const makeCodexRunner = (spawn: Spawn = spawnSync): ModelRunner => (prompt, cwd) => {
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const last = join(cwd, 'last-message.txt');
  try {
    const out = finish(spawn('codex', [...codexArgs, '--output-last-message', last, '-'], { cwd, env: env(), input: prompt, ...OPTIONS }));
    try { return readFileSync(last, 'utf8'); } catch { return out; }
  } finally { rmSync(last, { force: true }); }
};
/** A user-supplied executable: reads the prompt on stdin, prints the answer. No shell involved. */
export const makeCustomRunner = (path: string, spawn: Spawn = spawnSync): ModelRunner => (prompt, cwd) => {
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return finish(spawn(path, [], { cwd, env: env(), input: prompt, ...OPTIONS }));
};

export function onPath(command: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some(dir => {
    try { accessSync(join(dir, command), constants.X_OK); return statSync(join(dir, command)).isFile(); } catch { return false; }
  });
}
/** `--runner source=/abs/path` entries (newline-joined by the CLI): validated, never run through a shell. */
export function parseCustom(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of value ? value.split('\n') : []) {
    const at = item.indexOf('=');
    const source = item.slice(0, at), path = item.slice(at + 1);
    if (at < 1 || !(clientSources as readonly string[]).includes(source)) throw new Error('invalid --runner: expected source=/absolute/path with source claude-code, cursor or codex');
    if (source in out) throw new Error(`invalid --runner: ${source} given twice`);
    if (!isAbsolute(path)) throw new Error('invalid --runner: path must be absolute');
    try { accessSync(path, constants.X_OK); if (!statSync(path).isFile()) throw new Error('x'); } catch { throw new Error('invalid --runner: not an executable file'); }
    out[source] = path;
  }
  return out;
}

export interface Plan { source: string; label: string; run?: ModelRunner; skip?: string; untested?: boolean }
const defaults: Record<string, { cmd: string; make: (spawn: Spawn) => ModelRunner; label: string; untested?: boolean }> = {
  'claude-code': { cmd: 'claude', make: makeRunner, label: `claude ${claudeArgs.join(' ')}` },
  cursor: { cmd: 'cursor-agent', make: makeCursorRunner, label: `cursor-agent ${cursorArgs.join(' ')} (weaker isolation than claude)` },
  codex: { cmd: 'codex', make: makeCodexRunner, label: `codex ${codexArgs.join(' ')} -o <file> - (untested)`, untested: true }
};
/** The runner for one source: a custom path, the tool's own CLI, or a skip reason when the CLI is not on PATH. */
export function planFor(source: string, custom: Record<string, string>, spawn: Spawn = spawnSync, has: (c: string) => boolean = onPath): Plan {
  const path = custom[source];
  if (path) return { source, label: `custom runner ${path}`, run: makeCustomRunner(path, spawn) };
  const d = defaults[source];
  if (!d) return { source, label: 'none', skip: 'no runner for this source' };
  if (!has(d.cmd)) return { source, label: d.label, skip: `\`${d.cmd}\` not found on PATH` };
  return { source, label: d.label, run: d.make(spawn), ...(d.untested ? { untested: true } : {}) };
}
