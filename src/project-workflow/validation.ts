import { isAbsolute } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { dataSnapshot, object, positive, string } from '../context-engine/validation.js';
import type { ImplementationPlan, ProjectProfile, TaskPreferences, WorkflowPreferences, WorkflowScope } from './contracts.js';

export function relativePath(value: unknown): asserts value is string {
  string(value, 4096);
  if (/[\\:*?<>"|\x00-\x1f\u202a-\u202e\u2066-\u2069]/.test(value) || value.startsWith('/') || value.split('/').some(part =>
    !part || ['.', '..', '.git'].includes(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('invalid relative path');
}
function label(value: unknown): asserts value is string {
  string(value, 256); if (/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/.test(value)) throw new Error('invalid label');
}
function paragraph(value: unknown): asserts value is string {
  string(value, 8192); if (/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)) throw new Error('unsafe display text');
}
export function taskPreferences(raw: TaskPreferences): Readonly<TaskPreferences> {
  const value = dataSnapshot(raw); object(value, ['draftPr', 'evidence', 'planReview']);
  if (value.draftPr !== undefined && typeof value.draftPr !== 'boolean' ||
      value.evidence !== undefined && !['text', 'video', 'both'].includes(value.evidence) ||
      value.planReview !== undefined && !['approve', 'show', 'auto'].includes(value.planReview)) throw new Error('invalid preferences');
  return value;
}
export function preferences(raw: WorkflowPreferences): Readonly<WorkflowPreferences> {
  const value = dataSnapshot(raw); object(value, ['askAt', 'draftPr', 'evidence', 'planReview']);
  if (!['project', 'task'].includes(value.askAt)) throw new Error('invalid prompt frequency');
  const { askAt: _askAt, ...options } = value; taskPreferences(options); return value;
}
export function profile(raw: ProjectProfile): Readonly<ProjectProfile> {
  const value = dataSnapshot(raw); object(value, ['schemaVersion', 'projectId', 'name', 'documents', 'preferences']);
  if (value.schemaVersion !== 1) throw new Error('unsupported project profile');
  label(value.projectId); label(value.name); preferences(value.preferences);
  object(value.documents, ['prd', 'srs', 'adrs']);
  for (const key of ['prd', 'srs', 'adrs'] as const) {
    relativePath(value.documents[key]); if (!value.documents[key].startsWith('docs/')) throw new Error('documents must be under docs');
  }
  if (new Set(Object.values(value.documents)).size !== 3) throw new Error('duplicate document paths');
  const paths = Object.values(value.documents);
  if (paths.some(path => paths.some(other => path !== other && other.startsWith(`${path}/`)))) throw new Error('overlapping document paths');
  return value;
}
export function plan(raw: ImplementationPlan): Readonly<ImplementationPlan> {
  const value = dataSnapshot(raw); object(value, ['schemaVersion', 'objective', 'changedPaths', 'steps', 'acceptanceCriteria', 'checks', 'risks', 'rollback']);
  if (value.schemaVersion !== 1) throw new Error('unsupported plan');
  paragraph(value.objective); paragraph(value.rollback);
  for (const key of ['changedPaths', 'steps', 'acceptanceCriteria', 'checks', 'risks'] as const) {
    const list = value[key];
    if (!Array.isArray(list) || list.length > 64 || key !== 'risks' && !list.length) throw new Error('incomplete plan');
    list.forEach(item => key === 'changedPaths' ? relativePath(item) : paragraph(item));
  }
  if (new Set(value.changedPaths).size !== value.changedPaths.length) throw new Error('duplicate planned paths');
  return value;
}
export function scope(raw: WorkflowScope): Readonly<WorkflowScope> {
  const value = dataSnapshot(raw); object(value, ['projectId', 'taskId', 'principalId', 'workspaceRoot', 'sourceSnapshot', 'expiresAt']);
  for (const key of ['projectId', 'taskId', 'principalId'] as const) label(value[key]);
  string(value.workspaceRoot); string(value.sourceSnapshot); positive(value.expiresAt);
  if (!isAbsolute(value.workspaceRoot) || realpathSync(value.workspaceRoot) !== value.workspaceRoot || !statSync(value.workspaceRoot).isDirectory() || !/^[a-f0-9]{64}$/.test(value.sourceSnapshot)) throw new Error('invalid workflow scope');
  return value;
}
