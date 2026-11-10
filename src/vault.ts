import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { buildNotes, defaultCaps } from './vault-notes.js';
import type { Caps, Counts, VaultOptions } from './vault-notes.js';

export const MARKER = '.forgemind-vault';
/** User-owned folders kept across regeneration: Obsidian's config and graphify's code graph. */
const KEEP = ['.obsidian', 'code'];
export interface ExportOptions extends VaultOptions { to?: string | undefined; allowRepo?: boolean | undefined; caps?: Caps | undefined; now?: Date | undefined }
interface Config { to: string; prompts: boolean; includeProposed: boolean; projects?: string[] | undefined; allowRepo?: boolean | undefined;
  last?: { at: string; counts: Counts; truncated: boolean; omitted: number } }
const configPath = (brainDir: string): string => join(brainDir, 'vault-config.json');
export const defaultVault = (brainDir: string): string => join(brainDir, 'vault');

function readConfig(brainDir: string): Config | undefined {
  try { const c = JSON.parse(readFileSync(configPath(brainDir), 'utf8')) as Config; return typeof c.to === 'string' && isAbsolute(c.to) ? c : undefined; } catch { return undefined; }
}
/** realpath that also works for a directory that does not exist yet (resolves the deepest existing ancestor). */
function resolveReal(path: string): string {
  try { return realpathSync(path); } catch { const parent = dirname(path); return parent === path ? path : join(resolveReal(parent), path.slice(parent.length).replace(/^[\\/]+/, '')); }
}
function insideRepo(path: string): boolean {
  for (let d = path; ; d = dirname(d)) { if (existsSync(join(d, '.git'))) return true; if (dirname(d) === d) return false; }
}
function writeNotes(dir: string, notes: Map<string, string>): void {
  const dirs = new Set<string>();
  for (const [name, text] of notes) {
    const file = join(dir, `${name}.md`);
    for (let d = dirname(file); d !== dir && !dirs.has(d); d = dirname(d)) dirs.add(d);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, text, { mode: 0o600 });
  }
  for (const d of dirs) chmodSync(d, 0o700);
}

/** Write a one-way, disposable Obsidian view of the brain. Nothing in the brain changes. */
export function exportVault(brainDir: string, options: ExportOptions): Record<string, unknown> {
  const requested = options.to ?? defaultVault(brainDir);
  if (!isAbsolute(requested)) throw new Error('--to must be an absolute path');
  const to = resolveReal(requested);
  if (!options.allowRepo && insideRepo(to)) throw new Error('refusing to write the vault inside a git repository (use --allow-repo to override)');
  const exists = existsSync(to);
  if (exists) {
    if (!lstatSync(to).isDirectory()) throw new Error('vault path is not a directory');
    if (readdirSync(to).length > 0 && !existsSync(join(to, MARKER))) throw new Error(`refusing to overwrite a directory that is not a ForgeMind vault (no ${MARKER})`);
  }
  const now = options.now ?? new Date();
  const built = buildNotes(brainDir, options, options.caps ?? defaultCaps, now);
  const warnings: string[] = [];
  if (to.startsWith(join(homedir(), 'Library', 'Mobile Documents')) || /Dropbox|OneDrive|Google Drive/.test(to))
    warnings.push('the vault is in a cloud-synced folder; its notes may contain your exact prompts');
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const tmp = `${to}.tmp-${process.pid}-${Date.now()}`, trash = `${to}.old-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(tmp, { mode: 0o700 }); chmodSync(tmp, 0o700);
    writeNotes(tmp, built.notes);
    writeFileSync(join(tmp, MARKER), 'ForgeMind brain vault: generated, read-only, safe to delete. Regenerate with `brain export --obsidian`.\n', { mode: 0o600 });
    if (exists) for (const keep of KEEP) if (existsSync(join(to, keep))) cpSync(join(to, keep), join(tmp, keep), { recursive: true });
    if (exists) renameSync(to, trash);
    try { renameSync(tmp, to); } catch (error) { if (exists) renameSync(trash, to); throw error; }
    if (exists) rmSync(trash, { recursive: true, force: true });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const truncated = built.omitted > 0;
  const config: Config = { to, prompts: options.prompts, includeProposed: options.includeProposed, projects: options.projects, allowRepo: options.allowRepo,
    last: { at: now.toISOString(), counts: built.counts, truncated, omitted: built.omitted } };
  writeFileSync(configPath(brainDir), JSON.stringify(config), { mode: 0o600 }); chmodSync(configPath(brainDir), 0o600);
  return { vault: to, counts: built.counts, truncated, omitted: built.omitted, warnings };
}

export function vaultStatus(brainDir: string): Record<string, unknown> {
  const c = readConfig(brainDir);
  const to = c?.to ?? defaultVault(brainDir);
  return { vault: to, exists: existsSync(join(to, MARKER)), last: c?.last ?? null };
}

/** After a reflect run: regenerate the vault if one exists, with the options of the last export. Never throws. */
export function refreshVault(brainDir: string): Record<string, unknown> | undefined {
  try {
    const c = readConfig(brainDir);
    const to = c?.to ?? defaultVault(brainDir);
    if (!existsSync(join(to, MARKER))) return undefined;
    return { refreshed: true, ...exportVault(brainDir, { to, prompts: c?.prompts ?? true, includeProposed: c?.includeProposed ?? false, projects: c?.projects, allowRepo: c?.allowRepo }) };
  } catch (error) { return { refreshed: false, error: (error as Error).message }; }
}
