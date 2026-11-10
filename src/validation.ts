import { lstatSync } from 'node:fs';

/** Owner-only check: a real file or directory (no symlink, one link) owned by this user with no group/other access. */
export function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('unsafe memory storage');
  if (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) throw new Error('memory storage must be private to the owner');
}
