import { closeSync, constants, lstatSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acceptAdr, adrLabel, getDocument, listDocuments, rejectAdr } from './documents.js';
import type { DocKind, DocStatus } from './documents.js';
import type { BrainStore } from './brain.js';

export const DOC_COMMANDS: Record<string, { required: string[]; optional: string[] }> = {
  'docs-list': { required: ['workspace'], optional: ['kind', 'status'] },
  'docs-show': { required: ['workspace', 'id'], optional: [] },
  'docs-accept': { required: ['workspace', 'id'], optional: [] },
  'docs-reject': { required: ['workspace', 'id'], optional: ['note'] },
  'docs-export': { required: ['workspace', 'to'], optional: [] }
};
export const DOC_STATUSES = ['proposed', 'accepted', 'rejected', 'superseded', 'recorded'];

const slug = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'adr';

/** `write` is injectable so tests can fail a write part-way. */
export function exportAdrs(store: BrainStore, workspace: string, to: string, write: typeof writeSync = writeSync): { files: string[] } {
  let dir: string;
  try { dir = realpathSync(resolve(to)); } catch { throw new Error('--to must be an existing directory'); }
  if (!statSync(dir).isDirectory()) throw new Error('--to must be an existing directory');
  const files = listDocuments(store, workspace, 'adr', 'accepted').map(d => ({ name: `${adrLabel(d.number!).slice(4)}-${slug(d.title)}.md`, id: d.id }));
  for (const file of files) {
    try { lstatSync(join(dir, file.name)); throw new Error(`refusing to overwrite ${file.name}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const written: string[] = [];
  try {
    for (const file of files) {
      const path = join(dir, file.name);
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
      written.push(path);
      try {
        const data = Buffer.from(getDocument(store, workspace, file.id).body);
        for (let done = 0; done < data.length;) done += write(fd, data, done);
      } finally { closeSync(fd); }
    }
  } catch (error) {
    for (const path of written) try { unlinkSync(path); } catch { /* best effort */ }
    throw error;
  }
  return { files: files.map(f => f.name) };
}

export function docsCommand(command: string, args: Record<string, string>, store: BrainStore, workspace: string): unknown {
  switch (command) {
    case 'docs-list': return { documents: listDocuments(store, workspace, args.kind as DocKind | undefined, args.status as DocStatus | undefined) };
    case 'docs-show': return { document: getDocument(store, workspace, args.id!) };
    case 'docs-accept': acceptAdr(store, workspace, args.id!); return { ok: true };
    case 'docs-reject': rejectAdr(store, workspace, args.id!, args.note); return { ok: true };
    default: return exportAdrs(store, workspace, args.to!);
  }
}
