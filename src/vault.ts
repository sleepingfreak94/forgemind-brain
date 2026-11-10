import { chmodSync, closeSync, existsSync, openSync, statSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { buildNotes, defaultCaps } from './vault-notes.js';
import type { Caps, Counts, VaultOptions } from './vault-notes.js';

export const MARKER = '.forgemind-vault';
/** Everything else at the top level (.obsidian, code, user notes, templates, .trash) is the user's and survives regeneration. */
const GENERATED = new Set(['Projects', 'Sessions', 'ADRs', 'Recipes', 'Lessons', 'Global.md', 'index.md', MARKER]);
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

function withVaultLock<T>(brainDir: string, work: () => T): T {
  const lock = join(brainDir, 'vault.lock');
  mkdirSync(brainDir, { recursive: true, mode: 0o700 });
  try {
    const before = statSync(lock);
    if (Date.now() - before.mtimeMs > 1800000) {
      const again = statSync(lock); // re-check, as reflect does, so a fresh lock is never removed
      if (again.ino === before.ino && again.mtimeMs === before.mtimeMs) rmSync(lock);
    }
  } catch { /* none */ }
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('another vault export is in progress'); throw error; }
  try { return work(); } finally { closeSync(fd); rmSync(lock, { force: true }); }
}
/** Siblings left by an interrupted swap (exactly the names this exporter creates, and only if they carry the marker): restore the old vault if `to` is gone, drop stale temp dirs, flag leftovers (they may hold user files). */
function recover(to: string): string[] {
  const warnings: string[] = [], parent = dirname(to), base = basename(to);
  const mine = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(tmp|old)-\\d+-\\d+$`);
  let names: string[] = [];
  try { names = readdirSync(parent).filter(n => mine.test(n) && existsSync(join(parent, n, MARKER))); } catch { return warnings; }
  for (const n of names.filter(n => n.includes('.tmp-'))) rmSync(join(parent, n), { recursive: true, force: true });
  for (const n of names.filter(n => n.includes('.old-'))) {
    const old = join(parent, n);
    if (!existsSync(to)) { renameSync(old, to); warnings.push(`restored the vault from an interrupted export (${n})`); }
    else warnings.push(`leftover ${old} from an interrupted export; it may hold your files`);
  }
  return warnings;
}

/** Write a one-way, disposable Obsidian view of the brain. Nothing in the brain changes. */
export function exportVault(brainDir: string, options: ExportOptions): Record<string, unknown> {
  return withVaultLock(brainDir, () => doExport(brainDir, options));
}
function doExport(brainDir: string, options: ExportOptions): Record<string, unknown> {
  const requested = options.to ?? defaultVault(brainDir);
  if (!isAbsolute(requested)) throw new Error('--to must be an absolute path');
  const to = resolveReal(requested);
  if (!options.allowRepo && insideRepo(to)) throw new Error('refusing to write the vault inside a git repository (use --allow-repo to override)');
  if (existsSync(to)) {
    if (!lstatSync(to).isDirectory()) throw new Error('vault path is not a directory');
    if (readdirSync(to).length > 0 && !existsSync(join(to, MARKER))) throw new Error(`refusing to overwrite a directory that is not a ForgeMind vault (no ${MARKER})`);
  }
  const warnings = recover(to);
  const exists = existsSync(to);
  const now = options.now ?? new Date();
  const built = buildNotes(brainDir, options, options.caps ?? defaultCaps, now);
  if (['Mobile Documents', 'CloudStorage'].some(d => to.startsWith(join(homedir(), 'Library', d))) || /Dropbox|OneDrive|Google Drive/.test(to))
    warnings.push('the vault is in a cloud-synced folder; its notes may contain your exact prompts');
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const tmp = `${to}.tmp-${process.pid}-${Date.now()}`, trash = `${to}.old-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(tmp, { mode: 0o700 }); chmodSync(tmp, 0o700);
    writeFileSync(join(tmp, MARKER), 'ForgeMind brain vault: generated, read-only, safe to delete. Regenerate with `brain export --obsidian`.\n', { mode: 0o600 });
    writeNotes(tmp, built.notes);
    if (exists) renameSync(to, trash);
    try { renameSync(tmp, to); } catch (error) { if (exists) renameSync(trash, to); throw error; }
    // Move (not copy) the user's entries over: after a crash they are in `to` or in the trash sibling, never lost.
    if (exists) {
      const generated = new Set([...GENERATED].map(g => g.toLowerCase())), have = new Set(readdirSync(to).map(k => k.toLowerCase())), skipped: string[] = [];
      for (const k of readdirSync(trash)) {
        if (generated.has(k.toLowerCase())) { if (!GENERATED.has(k)) skipped.push(k); continue; } // user entry that collides with a generated name (APFS is case-insensitive)
        if (have.has(k.toLowerCase())) { skipped.push(k); continue; }
        renameSync(join(trash, k), join(to, k));
      }
      if (skipped.length) warnings.push(`kept ${skipped.join(', ')} in ${trash} because the names collide with generated notes`);
      else rmSync(trash, { recursive: true, force: true });
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const truncated = built.omitted > 0;
  const config: Config = { to, prompts: options.prompts, includeProposed: options.includeProposed, projects: options.projects, allowRepo: options.allowRepo,
    last: { at: now.toISOString(), counts: built.counts, truncated, omitted: built.omitted } };
  writeFileSync(configPath(brainDir), JSON.stringify(config), { mode: 0o600 }); chmodSync(configPath(brainDir), 0o600);
  return { vault: to, counts: built.counts, truncated, omitted: built.omitted, hidden: built.hidden, warnings };
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
