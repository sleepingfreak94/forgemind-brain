import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { privatePath } from './validation.js';

export const MAX_ATTACHMENTS = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'];

/** An opened, checked source file. Hold it until the copy is done, then call closeAttachments. */
export interface OpenAttachment { fd: number; ext: string }

export function closeAttachments(files: OpenAttachment[]): void { for (const file of files) { try { closeSync(file.fd); } catch { /* closed */ } } }

/**
 * Open every path (absolute, allowed type, no symlink, regular file, size) before anything is copied.
 * O_NOFOLLOW refuses a symlink at open time and O_NONBLOCK keeps a FIFO from blocking; the checks run on the descriptor, so a swap afterwards cannot matter.
 */
export function openAttachments(raw: unknown): OpenAttachment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) throw new Error(`attachments must be an array of at most ${MAX_ATTACHMENTS} paths`);
  const opened: OpenAttachment[] = [];
  try {
    for (const item of raw as unknown[]) {
      if (typeof item !== 'string' || !isAbsolute(item)) throw new Error('attachment must be an absolute path');
      const ext = extname(item).toLowerCase();
      if (!EXTENSIONS.includes(ext)) throw new Error(`attachment type not allowed: ${basename(item)}`);
      let fd: number;
      try { fd = openSync(item, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`attachment not found: ${basename(item)}`);
        throw new Error(`attachment must be a regular file (no symlink or directory): ${basename(item)}`);
      }
      opened.push({ fd, ext });
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error(`attachment must be a regular file (no symlink or directory): ${basename(item)}`);
      if (stat.size > MAX_BYTES) throw new Error(`attachment larger than 10 MB: ${basename(item)}`);
    }
  } catch (error) { closeAttachments(opened); throw error; }
  return opened;
}

function privateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  privatePath(path, true); // refuses a symlink, a foreign owner or group/other access
}

function copyFd(fd: number, target: string): void {
  const out = openSync(target, 'wx', 0o600);
  try {
    const buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_BYTES) throw new Error('attachment larger than 10 MB');
      writeSync(out, buffer, 0, n);
    }
  } finally { closeSync(out); }
  chmodSync(target, 0o600);
}

/** Copy into <brainDir>/files/<project hash>/<record id>/<n><ext> (dirs 0700, files 0600); a failure removes the partial copy. */
export function copyAttachments(brainDirectory: string, project: string, recordId: string, sources: OpenAttachment[]): string[] {
  if (sources.length === 0) return [];
  const root = join(brainDirectory, 'files');
  const projectFolder = join(root, createHash('sha256').update(project).digest('hex').slice(0, 12));
  const folder = join(projectFolder, recordId);
  privateDirectory(root); privateDirectory(projectFolder);
  rmSync(folder, { recursive: true, force: true }); // left by a crash before the row was committed
  try {
    privateDirectory(folder);
    return sources.map((source, index) => {
      const target = join(folder, `${index + 1}${source.ext}`);
      copyFd(source.fd, target);
      return target;
    });
  } catch (error) { removeAttachments(folder); throw error; }
}

export function removeAttachments(folder: string): void { rmSync(folder, { recursive: true, force: true }); }
