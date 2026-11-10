import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import type { BrainSpace } from './brain.js';
import { privatePath } from './database.js';

type SpaceMap = Record<string, BrainSpace>;

function canonicalWorkspace(workspace: unknown): string {
  if (typeof workspace !== 'string' || workspace === '') throw new Error('workspace must be an existing directory');
  let real: string;
  try {
    real = realpathSync(resolve(workspace));
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch { throw new Error('workspace must be an existing directory'); }
  return real;
}

function checkDirectory(directory: unknown): string {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('brain storage must be absolute');
  return directory;
}
function checkCanonical(directory: string): void {
  if (realpathSync(directory) !== directory) throw new Error('brain storage must be canonical');
}

function readMap(path: string): SpaceMap {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as SpaceMap;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536
    || (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)))
    throw new Error('Brain space map must be an owner-only regular file');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Invalid brain space map'); }
  const value = raw as { schemaVersion?: unknown; projects?: unknown };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join() !== 'projects,schemaVersion' || value.schemaVersion !== 1
    || !value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects)) throw new Error('Invalid brain space map');
  const entries = Object.entries(value.projects as Record<string, unknown>);
  if (entries.length > 1024) throw new Error('Invalid brain space map');
  const out = Object.create(null) as SpaceMap;
  for (const [key, space] of entries) {
    if (!isAbsolute(key) || (space !== 'personal' && space !== 'company')) throw new Error('Invalid brain space map');
    let real: string;
    try { real = realpathSync(key); } catch { throw new Error('Invalid brain space map'); }
    if (real !== key) throw new Error('Invalid brain space map');
    out[key] = space;
  }
  return out;
}

export function brainSpaceFor(workspace: string, brainDirectory: string): BrainSpace {
  const project = canonicalWorkspace(workspace);
  const dir = checkDirectory(brainDirectory);
  try { lstatSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'personal';
    throw error;
  }
  checkCanonical(dir);
  const space = readMap(join(dir, 'spaces.json'))[project];
  // Unmapped projects share the default (personal) space by owner decision (2026-10-26).
  return space ?? 'personal';
}

export function mapBrainSpace(workspace: string, space: BrainSpace, brainDirectory: string): void {
  if (space !== 'personal' && space !== 'company') throw new Error('invalid brain space');
  const project = canonicalWorkspace(workspace);
  const dir = checkDirectory(brainDirectory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkCanonical(dir);
  privatePath(dir, true);
  const path = join(dir, 'spaces.json');
  const projects = readMap(path);
  const existing = projects[project];
  if (existing === space) return;
  if (existing) throw new Error(`Project is already mapped to the ${existing} brain space`);
  projects[project] = space;
  const plain: Record<string, string> = {};
  for (const [key, value] of Object.entries(projects)) plain[key] = value;
  const tmp = join(dir, `.spaces.json.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({ schemaVersion: 1, projects: plain })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
  readMap(path);
}
