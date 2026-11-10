import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrainStore, defaultBrainDirectory } from '../memory/brain.js';
import type { BrainEntry, BrainKind, BrainSpace, BrainStatus } from '../memory/brain.js';
import { brainSpaceFor, mapBrainSpace } from '../memory/brain-spaces.js';
import { learnFromGit, learnFromGitHub } from '../memory/brain-learn.js';
import type { BrainProposal } from '../memory/brain-learn.js';

class UsageError extends Error {}

export type CliRunner = (tool: 'git' | 'gh', args: string[], cwd: string) => string;

const defaultRunner: CliRunner = (tool, args, cwd) => {
  const options = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
  return tool === 'git' ? execFileSync('/usr/bin/git', ['-C', cwd, ...args], options) : execFileSync('gh', args, { ...options, cwd });
};

const commands: Record<string, { required: string[]; optional: string[] }> = {
  map: { required: ['workspace', 'space'], optional: [] },
  list: { required: ['workspace'], optional: ['status'] },
  add: { required: ['workspace', 'kind', 'text', 'reason'], optional: ['evidence', 'scope'] },
  show: { required: ['workspace', 'id'], optional: [] },
  approve: { required: ['workspace', 'id'], optional: [] },
  retire: { required: ['workspace', 'id'], optional: [] },
  reject: { required: ['workspace', 'id'], optional: ['note'] },
  learn: { required: ['workspace'], optional: ['source', 'limit'] },
  history: { required: ['workspace'], optional: ['limit'] }
};
// Usage: history --workspace PATH [--limit 1-200]

function parse(argv: string[]): { command: string; args: Record<string, string> } {
  if (!Array.isArray(argv) || argv.length === 0) throw new UsageError('missing command');
  const command = String(argv[0]);
  const spec = Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (!spec) throw new UsageError('unknown command');
  const allowed = [...spec.required, ...spec.optional, 'brain-dir'];
  const args: Record<string, string> = Object.create(null) as Record<string, string>;
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--')) throw new UsageError('invalid arguments');
    const key = flag.slice(2);
    if (!allowed.includes(key)) throw new UsageError('unknown option');
    if (key in args) throw new UsageError('repeated option');
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) throw new UsageError('missing option value');
    args[key] = value;
  }
  for (const key of spec.required) if (!(key in args)) throw new UsageError(`missing --${key}`);
  if ('space' in args && args.space !== 'personal' && args.space !== 'company') throw new UsageError('invalid --space');
  if ('scope' in args && args.scope !== 'project' && args.scope !== 'space') throw new UsageError('invalid --scope');
  if ('status' in args && !['proposed', 'approved', 'rejected', 'retired'].includes(args.status!)) throw new UsageError('invalid --status');
  if ('kind' in args && !['convention', 'lesson', 'decision', 'pattern'].includes(args.kind!)) throw new UsageError('invalid --kind');
  if ('source' in args && !['git', 'github', 'all'].includes(args.source!)) throw new UsageError('invalid --source');
  if ('limit' in args && (!/^\d+$/.test(args.limit!) || Number(args.limit) < 1 || Number(args.limit) > 1000)) throw new UsageError('invalid --limit');
  if (command === 'history' && 'limit' in args && Number(args.limit) > 200) throw new UsageError('invalid --limit');
  return { command, args };
}

function execute(command: string, args: Record<string, string>, run: CliRunner): unknown {
  const dir = resolve(args['brain-dir'] ?? defaultBrainDirectory());
  let workspace: string;
  try { workspace = realpathSync(resolve(args.workspace!)); } catch { throw new Error('workspace must be an existing directory'); }
  if (command === 'map') { mapBrainSpace(workspace, args.space as BrainSpace, dir); return { ok: true }; }
  const space = brainSpaceFor(workspace, dir);
  const store = new BrainStore(dir, space);
  try {
    const visible = (id: string): BrainEntry => {
      const entry = store.list().find(e => e.id === id && (e.project === null || e.project === workspace));
      if (!entry) throw new Error('unknown brain entry');
      return entry;
    };
    switch (command) {
      case 'list': {
        const entries = store.list(args.status ? { status: args.status as BrainStatus } : {})
          .filter(e => e.project === null || e.project === workspace);
        return { space, entries };
      }
      case 'add':
        return { id: store.propose({ kind: args.kind as BrainKind, text: args.text!, reason: args.reason!,
          evidence: args.evidence ? [args.evidence] : [], project: args.scope === 'space' ? null : workspace }) };
      case 'history': return { space, history: store.history(workspace, args.limit ? Number(args.limit) : 20) };
      case 'show': return { entry: visible(args.id!) };
      case 'approve': visible(args.id!); store.approve(args.id!); return { ok: true };
      case 'retire': visible(args.id!); store.retire(args.id!); return { ok: true };
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
      default: visible(args.id!); store.reject(args.id!, args.note); return { ok: true };
    }
  } finally { store.close(); }
}

export function runBrainCli(argv: string[], output: { write(text: string): void }, options: { run?: CliRunner } = {}): number {
  let code = 0;
  let body: unknown;
  try {
    const { command, args } = parse(argv);
    body = execute(command, args, options.run ?? defaultRunner);
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
