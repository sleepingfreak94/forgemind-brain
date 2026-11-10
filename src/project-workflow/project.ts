import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectProfile } from './contracts.js';
import { profile, relativePath } from './validation.js';

export const profilePath = 'config/forgemind-project.json';
function target(root: string, path: string): string {
  relativePath(path);
  if (realpathSync(root) !== root) throw new Error('workspace must be canonical');
  let current = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('linked project path');
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('project path parent is not a directory');
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return current;
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function readProject(root: string): Readonly<ProjectProfile> {
  const path = target(root, profilePath), stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error('invalid project profile file');
  return profile(JSON.parse(readFileSync(path, 'utf8')) as ProjectProfile);
}
/** Non-secret preferences/documents only. This file never carries grants or approval receipts. */
export function initializeProject(root: string, raw: ProjectProfile, scaffold = false): { profile: Readonly<ProjectProfile>; created: string[]; preserved: string[] } {
  const selected = profile(raw), destination = target(root, profilePath);
  if (exists(destination)) throw new Error('project already registered; load its preferences or edit them explicitly');
  const documents: Record<string, string> = scaffold ? {
    [selected.documents.prd]: '# Product requirements\n\nStatus: Draft — needs owner review\n\n## Problem and users\n\nTODO\n\n## Goals and non-goals\n\nTODO\n\n## Acceptance criteria\n\nTODO\n\n## Open questions\n\nRequirements have not been supplied or approved.\n',
    [selected.documents.srs]: '# Software requirements specification\n\nStatus: Draft — needs owner review\n\n## Functional requirements\n\nTODO: link to PRD and testable requirements.\n\n## Quality and security requirements\n\nTODO\n\n## Interfaces and constraints\n\nTODO\n\n## Validation and open questions\n\nNo implementation requirements are approved by this template.\n',
    [`${selected.documents.adrs}/ADR-template.md`]: '# ADR: Decision title\n\nStatus: Proposed\n\n## Context\n\nTODO\n\n## Decision and alternatives\n\nPending owner review.\n\n## Consequences and validation\n\nTODO\n\n## Sources and supersession\n\nTODO: source versions, dates and related decisions.\n'
  } : {};
  // Validate every destination before creating anything; never follow existing directory links.
  const paths = Object.keys(documents).map(path => ({ path, target: target(root, path) }));
  for (const item of paths) if (exists(item.target) && !lstatSync(item.target).isFile()) throw new Error('document destination is not a file');
  const created: string[] = [], preserved: string[] = [];
  for (const item of paths) {
    if (exists(item.target)) {
      preserved.push(item.path); continue;
    }
    mkdirSync(join(item.target, '..'), { recursive: true });
    writeFileSync(item.target, documents[item.path]!, { flag: 'wx', mode: 0o600 }); created.push(item.path);
  }
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(destination, JSON.stringify(selected, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); created.push(profilePath);
  return { profile: selected, created, preserved };
}
export function documentStatus(root: string, selected: ProjectProfile): { path: string; exists: boolean }[] {
  return Object.values(profile(selected).documents).map(path => ({ path, exists: exists(target(root, path)) }));
}
