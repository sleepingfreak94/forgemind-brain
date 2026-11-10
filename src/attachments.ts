import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, constants, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';

export const MAX_ATTACHMENTS = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'];

/** Check every path (absolute, regular file, no symlink, allowed type, size) before anything is copied. */
export function validateAttachments(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) throw new Error(`attachments must be an array of at most ${MAX_ATTACHMENTS} paths`);
  return (raw as unknown[]).map(item => {
    if (typeof item !== 'string' || !isAbsolute(item)) throw new Error('attachment must be an absolute path');
    if (!EXTENSIONS.includes(extname(item).toLowerCase())) throw new Error(`attachment type not allowed: ${basename(item)}`);
    let stat;
    try { stat = lstatSync(item); } catch { throw new Error(`attachment not found: ${basename(item)}`); }
    if (!stat.isFile()) throw new Error(`attachment must be a regular file (no symlink or directory): ${basename(item)}`);
    if (stat.size > MAX_BYTES) throw new Error(`attachment larger than 10 MB: ${basename(item)}`);
    return item;
  });
}

const safeName = (path: string): string => basename(path).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(-80);

/** Copy into <brainDir>/files/<project hash>/<record id>/<n>-<name> (dirs 0700, files 0600); a failure removes the partial copy. */
export function copyAttachments(brainDirectory: string, project: string, recordId: string, sources: string[]): string[] {
  if (sources.length === 0) return [];
  const projectId = createHash('sha256').update(project).digest('hex').slice(0, 12);
  const folder = join(brainDirectory, 'files', projectId, recordId);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    return sources.map((source, index) => {
      const target = join(folder, `${index + 1}-${safeName(source)}`);
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      chmodSync(target, 0o600);
      return target;
    });
  } catch (error) { removeAttachments(folder); throw error; }
}

export function removeAttachments(folder: string): void { rmSync(folder, { recursive: true, force: true }); }
