import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { readProject } from '../project-workflow/project.js';
import { relativePath } from '../project-workflow/validation.js';
import type { DocumentSource } from './contracts.js';

export function canonicalWorkspace(root: string): string {
  if (!isAbsolute(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('canonical workspace required');
  return root;
}
export function safePath(root: string, relative: string): string {
  relativePath(relative); canonicalWorkspace(root);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || i < parts.length - 1 && !stat.isDirectory()) throw new Error('unsafe source path');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return current;
}
export function displayText(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '\ufffd');
}
function document(root: string, path: string): DocumentSource | undefined {
  const target = safePath(root, path);
  let fd: number;
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw new Error('invalid document file');
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 262144) throw new Error('invalid document file');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length > 262144 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('document changed while reading');
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes), text = displayText(raw);
    const status = /^\s*(?:-\s*)?(?:\*\*)?Status(?:\*\*)?\s*:\s*(.+)$/im.exec(text)?.[1]?.trim().slice(0, 256) ?? 'Unspecified';
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim().slice(0, 256) ?? path;
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), status, title, text };
  } finally { closeSync(fd); }
}
/** Registered files only; no Git/network traversal, extraction or automatic trust promotion. */
export function scanDocuments(root: string, projectId: string): DocumentSource[] {
  const profile = readProject(canonicalWorkspace(root));
  if (profile.projectId !== projectId) throw new Error('project identity changed');
  const paths = [profile.documents.prd, profile.documents.srs];
  let visited = 0;
  const walk = (relative: string, depth: number) => {
    if (depth > 8) throw new Error('ADR tree too deep');
    const path = safePath(root, relative);
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (entries.length > 512) throw new Error('ADR tree too large');
    visited += entries.length;
    if (visited > 1024) throw new Error('ADR tree traversal budget exceeded');
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.isSymbolicLink()) throw new Error('linked ADR entry');
      if (entry.isDirectory()) walk(`${relative}/${entry.name}`, depth + 1);
      else if (/\.md$/i.test(entry.name)) paths.push(`${relative}/${entry.name}`);
      if (paths.length > 256) throw new Error('too many registered documents');
    }
  };
  walk(profile.documents.adrs, 0);
  const result = paths.sort().map(path => document(root, path)).filter((item): item is DocumentSource => item !== undefined);
  if (result.reduce((n, doc) => n + doc.text.length, 0) > 4194304) throw new Error('document corpus too large');
  return result;
}
