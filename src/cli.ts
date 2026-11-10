import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrainStore, defaultBrainDirectory } from './brain.js';
import type { BrainEntry, BrainKind, BrainStatus } from './brain.js';
import { MigrationRefused, migrateLegacy } from './migrate.js';
import { learnFromGit, learnFromGitHub } from './brain-learn.js';
import type { BrainProposal } from './brain-learn.js';
import { defaultSources, lastReport, reflect } from './reflect.js';
import type { ModelRunner, Spawn } from './reflect-runners.js';
import { parseCustom } from './reflect-runners.js';
import { schedule } from './schedule.js';
import type { ScheduleDeps } from './schedule.js';
import { DOC_COMMANDS, DOC_STATUSES, docsCommand } from './documents-cli.js';

class UsageError extends Error {}

export type CliRunner = (tool: 'git' | 'gh', args: string[], cwd: string) => string;

const defaultRunner: CliRunner = (tool, args, cwd) => {
  const options = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
  return tool === 'git' ? execFileSync('/usr/bin/git', ['-C', cwd, ...args], options) : execFileSync('gh', args, { ...options, cwd });
};

const commands: Record<string, { required: string[]; optional: string[]; bool?: string[] }> = {
  migrate: { required: [], optional: [] },
  list: { required: ['workspace'], optional: ['status'] },
  add: { required: ['workspace', 'kind', 'text', 'reason'], optional: ['evidence', 'scope'] },
  show: { required: ['workspace', 'id'], optional: [] },
  approve: { required: ['workspace'], optional: ['id', 'ids'] },
  retire: { required: ['workspace'], optional: ['id', 'ids'] },
  reject: { required: ['workspace'], optional: ['id', 'ids', 'note'] },
  reflect: { required: [], optional: ['days', 'sources', 'projects', 'runner'], bool: ['dry-run', 'last'] },
  schedule: { required: [], optional: ['every', 'sources', 'projects', 'runner'], bool: ['off', 'status'] },
  learn: { required: ['workspace'], optional: ['source', 'limit'] },
  history: { required: ['workspace'], optional: ['limit'] },
  ...DOC_COMMANDS
};
// Usage: history --workspace PATH [--limit 1-200]

function parse(argv: string[]): { command: string; args: Record<string, string> } {
  if (!Array.isArray(argv) || argv.length === 0) throw new UsageError('missing command');
  // `docs <sub>` is the command `docs-<sub>`.
  if (argv[0] === 'docs') argv = [`docs-${String(argv[1])}`, ...argv.slice(2)];
  const command = String(argv[0]);
  const spec = Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (!spec) throw new UsageError('unknown command');
  const allowed = [...spec.required, ...spec.optional, ...(spec.bool ?? []), 'brain-dir'];
  const args: Record<string, string> = Object.create(null) as Record<string, string>;
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--')) throw new UsageError('invalid arguments');
    const key = flag.slice(2);
    if (!allowed.includes(key)) throw new UsageError('unknown option');
    if (key === 'runner' && key in args) { args[key] += '\n' + String(value); continue; }
    if (key in args) throw new UsageError('repeated option');
    if (spec.bool?.includes(key)) { args[key] = 'true'; i -= 1; continue; }
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) throw new UsageError('missing option value');
    args[key] = value;
  }
  for (const key of spec.required) if (!(key in args)) throw new UsageError(`missing --${key}`);
  if ('scope' in args && args.scope !== 'project' && args.scope !== 'global') throw new UsageError('invalid --scope');
  const docs = command.startsWith('docs-');
  if ('status' in args && command !== 'schedule' && !(docs ? DOC_STATUSES : ['proposed', 'approved', 'rejected', 'retired']).includes(args.status!)) throw new UsageError('invalid --status');
  if ('kind' in args && !(docs ? ['adr', 'recipe'] : ['convention', 'lesson', 'decision', 'pattern']).includes(args.kind!)) throw new UsageError('invalid --kind');
  if ('source' in args && !['git', 'github', 'all'].includes(args.source!)) throw new UsageError('invalid --source');
  if ('limit' in args && (!/^\d+$/.test(args.limit!) || Number(args.limit) < 1 || Number(args.limit) > 1000)) throw new UsageError('invalid --limit');
  if (['approve', 'retire', 'reject'].includes(command) && ('id' in args) === ('ids' in args)) throw new UsageError('give exactly one of --id or --ids');
  if ('ids' in args && !/^[0-9a-f]{16}(,[0-9a-f]{16})*$/.test(args.ids!)) throw new UsageError('invalid --ids');
  if ('days' in args && (!/^\d+$/.test(args.days!) || Number(args.days) < 1 || Number(args.days) > 30)) throw new UsageError('invalid --days');
  if ('sources' in args && !args.sources!.split(',').every(x => ['claude-code', 'cursor', 'codex'].includes(x))) throw new UsageError('invalid --sources');
  if ('projects' in args && !args.projects!.split(',').every(x => isAbsolute(x))) throw new UsageError('invalid --projects');
  if (command === 'schedule' && ['every', 'off', 'status'].filter(k => k in args).length !== 1) throw new UsageError('give exactly one of --every, --off or --status');
  if (command === 'history' && 'limit' in args && Number(args.limit) > 200) throw new UsageError('invalid --limit');
  return { command, args };
}

export interface CliOptions { run?: CliRunner; model?: ModelRunner; schedule?: ScheduleDeps; reflect?: { spawn?: Spawn; has?: (command: string) => boolean } }

function parseRunners(value: string | undefined): Record<string, string> {
  try { return parseCustom(value); } catch (error) { throw new UsageError((error as Error).message); }
}

function execute(command: string, args: Record<string, string>, run: CliRunner, options: CliOptions = {}): unknown {
  const dir = resolve(args['brain-dir'] ?? defaultBrainDirectory());
  if (command === 'migrate') {
    try { return { ok: true, ...migrateLegacy(dir) }; }
    catch (error) { throw error instanceof MigrationRefused ? new UsageError(error.message) : error; }
  }
  if (command === 'schedule') return { ok: true, ...schedule(dir, { every: args.every, sources: args.sources, projects: args.projects, runners: parseRunners(args.runner) && args.runner?.split('\n'), off: 'off' in args, status: 'status' in args }, options.schedule) };
  if (command === 'reflect') {
    if ('last' in args) return { ok: true, ...lastReport(dir) };
    return { ok: true, ...reflect(dir, { days: args.days ? Number(args.days) : 2, dryRun: 'dry-run' in args, run: options.model, custom: parseRunners(args.runner), spawn: options.reflect?.spawn, has: options.reflect?.has,
      filter: { sources: args.sources ? args.sources.split(',') : [...new Set([...defaultSources, ...Object.keys(parseRunners(args.runner))])], projects: args.projects?.split(',') } }) };
  }
  let workspace: string;
  try { workspace = realpathSync(resolve(args.workspace!)); } catch { throw new Error('workspace must be an existing directory'); }
  const store = new BrainStore(dir);
  try {
    const visible = (id: string): BrainEntry => {
      const entry = store.list().find(e => e.id === id && (e.project === null || e.project === workspace));
      if (!entry) throw new Error('unknown brain entry');
      return entry;
    };
    if (command.startsWith('docs-')) return docsCommand(command, args, store, workspace);
    switch (command) {
      case 'list': {
        const entries = store.list(args.status ? { status: args.status as BrainStatus } : {})
          .filter(e => e.project === null || e.project === workspace);
        return { entries };
      }
      case 'add':
        return { id: store.propose({ kind: args.kind as BrainKind, text: args.text!, reason: args.reason!,
          evidence: args.evidence ? [args.evidence] : [], project: args.scope === 'global' ? null : workspace }) };
      case 'history': return { history: store.history(workspace, args.limit ? Number(args.limit) : 20) };
      case 'show': return { entry: visible(args.id!) };
      case 'approve': case 'retire': case 'reject': {
        const to = command === 'approve' ? 'approved' : command === 'retire' ? 'retired' : 'rejected';
        if (args.ids === undefined) {
          visible(args.id!);
          if (command === 'approve') store.approve(args.id!); else if (command === 'retire') store.retire(args.id!); else store.reject(args.id!, args.note);
          return { ok: true };
        }
        const ids = args.ids.split(',');
        ids.forEach(visible);
        store.changeMany(ids, to, args.note);
        return { ok: true, changed: new Set(ids).size };
      }
      case 'learn': {
        const source = args.source ?? 'all';
        const limit = args.limit ? Number(args.limit) : 100;
        const proposed: string[] = [], skipped: string[] = [];
        const sources: [string, () => BrainProposal[]][] = [];
        if (source === 'git' || source === 'all') sources.push(['git', () => learnFromGit({ run: a => run('git', a, workspace), limit })]);
        if (source === 'github' || source === 'all') sources.push(['github', () => learnFromGitHub({ run: a => run('gh', a, workspace), limit })]);
        for (const [name, learn] of sources) {
          let found: BrainProposal[];
          try { found = learn(); } catch { skipped.push(name); continue; }
          for (const p of found) {
            try {
              const id = store.propose({ ...p, project: workspace });
              if (!proposed.includes(id)) proposed.push(id);
            } catch { /* rejected proposals are dropped */ }
          }
        }
        return { proposed, skipped };
      }
      default: throw new UsageError('unknown command');
    }
  } finally { store.close(); }
}

export function runBrainCli(argv: string[], output: { write(text: string): void }, options: CliOptions = {}): number {
  let code = 0;
  let body: unknown;
  try {
    const { command, args } = parse(argv);
    body = execute(command, args, options.run ?? defaultRunner, options);
  } catch (error) {
    code = error instanceof UsageError ? 2 : 1;
    body = { error: error instanceof Error ? error.message : 'brain command failed' };
  }
  try { output.write(JSON.stringify(body) + '\n'); } catch { return 1; }
  return code;
}

try {
  const evaluated = process.execArgv.some(a => a === '-e' || a === '--eval' || a === '-p' || a === '--print');
  if (!evaluated && process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    process.exitCode = runBrainCli(process.argv.slice(2), process.stdout);
} catch { /* guard must never throw on import */ }
