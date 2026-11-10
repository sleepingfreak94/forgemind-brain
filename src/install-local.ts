import { cpSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultInstallDirectory(): string { return join(homedir(), '.forgemind', 'bin'); }

/** Copy the built files and package.json to `target`. Build in a temp sibling, then swap, so a failed copy never leaves a half install. */
export function installLocal(builtSrc: string, packageJson: string, target: string): void {
  if (!isAbsolute(target)) throw new Error('install directory must be absolute');
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stamp = `${process.pid}-${Date.now()}`;
  const fresh = join(parent, `.bin-new-${stamp}`), old = join(parent, `.bin-old-${stamp}`);
  try {
    cpSync(builtSrc, join(fresh, '.'), { recursive: true });
    cpSync(packageJson, join(fresh, 'package.json'));
    // shortcut: two renames leave a moment with no bin/; fine for a single-user tool, use a symlink swap if that ever matters
    try { renameSync(target, old); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    renameSync(fresh, target);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const target = process.argv[2] ?? defaultInstallDirectory();
  try {
    installLocal(here, join(here, '..', '..', 'package.json'), target);
    process.stdout.write(`installed to ${target}\n`);
  } catch (error) {
    process.stderr.write(`install-local failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
