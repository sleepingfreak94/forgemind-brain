import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultInstallDirectory(): string { return join(homedir(), '.forgemind', 'bin'); }

function isPreviousInstall(target: string): boolean {
  try { return (JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { name?: unknown }).name === 'forgemind-brain'; }
  catch { return false; }
}

/**
 * Copy the built files and package.json to `target`. Build in a temp sibling, then swap, so a failed copy never leaves a half install.
 * Refuses to replace a directory that is not a previous install. `rename` is a parameter for tests only.
 */
export function installLocal(builtSrc: string, packageJson: string, target: string, rename: typeof renameSync = renameSync): void {
  if (!isAbsolute(target)) throw new Error('install directory must be absolute');
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const exists = existsSync(target);
  if (exists && !isPreviousInstall(target)) throw new Error(`${target} exists and is not a forgemind-brain install; refusing to replace it`);
  const stamp = `${process.pid}-${Date.now()}`;
  const fresh = join(parent, `.bin-new-${stamp}`), old = join(parent, `.bin-old-${stamp}`);
  try {
    cpSync(builtSrc, join(fresh, '.'), { recursive: true });
    cpSync(packageJson, join(fresh, 'package.json'));
    // shortcut: two renames leave a moment with no bin/; fine for a single-user tool, use a symlink swap if that ever matters
    if (exists) rename(target, old);
    try { rename(fresh, target); }
    catch (error) { if (exists) renameSync(old, target); throw error; }
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const target = defaultInstallDirectory();
  try {
    installLocal(here, join(here, '..', '..', 'package.json'), target);
    process.stdout.write(`installed to ${target}\n`);
  } catch (error) {
    process.stderr.write(`install-local failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
