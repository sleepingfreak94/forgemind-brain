import { createHash } from 'node:crypto';
import { ContextBoundaryError } from './contracts.js';
import type { ContextScope, OptimizationInput } from './contracts.js';

export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function bytes(value: string): number { return Buffer.byteLength(value); }
export function serialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some(key => !keys.includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(d => d.get || d.set)) {
    throw new ContextBoundaryError('invalid-input');
  }
}
export function string(value: unknown, max = 4096, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.length) || bytes(value) > max || value.includes('\0')) {
    throw new ContextBoundaryError('invalid-input');
  }
}
export function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new ContextBoundaryError('invalid-input');
}
export function validateScope(raw: unknown): ContextScope {
  const keys = ['tenantId', 'principalId', 'projectId', 'taskId', 'invocationId', 'sessionId', 'policyVersion', 'sourceSnapshot'];
  object(raw, keys);
  for (const key of keys) string(raw[key], 256);
  return Object.freeze(Object.fromEntries(keys.map(key => [key, raw[key]]))) as unknown as ContextScope;
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
/** Inspect descriptor values without invoking accessors, including array indices. */
function jsonData(value: unknown, stack = new Set<object>(), depth = 0): void {
  if (depth > 10) throw new ContextBoundaryError('invalid-input');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || stack.has(value) || Object.getOwnPropertySymbols(value).length) {
    throw new ContextBoundaryError('invalid-input');
  }
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new ContextBoundaryError('invalid-input');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (array && ((value as unknown[]).length > 2048 || Object.keys(value).length !== (value as unknown[]).length)) {
    throw new ContextBoundaryError('invalid-input');
  }
  stack.add(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === 'length') continue;
    if (descriptor.get || descriptor.set || !descriptor.enumerable || (array && !/^(0|[1-9][0-9]*)$/.test(key))) {
      throw new ContextBoundaryError('invalid-input');
    }
    jsonData(descriptor.value, stack, depth + 1);
  }
  stack.delete(value);
}
/** Descriptor-safe immutable copy for trusted host boundary payloads. */
export function dataSnapshot<T>(value: T): Readonly<T> {
  jsonData(value);
  const copy = structuredClone(value);
  if (bytes(JSON.stringify(copy)) > 1024 * 1024) throw new ContextBoundaryError('invalid-input');
  return freeze(copy);
}
export function snapshot(input: OptimizationInput): Readonly<OptimizationInput> {
  try {
    jsonData(input);
    const raw = structuredClone(input);
    object(raw, ['schemaVersion', 'scope', 'protected', 'evidence', 'budget', 'expiresAt']);
    if (raw.schemaVersion !== 1) throw new ContextBoundaryError('invalid-input');
    validateScope(raw.scope);
    object(raw.protected, ['objective', 'acceptanceCriteria', 'policy', 'permissions', 'checkpoint']);
    string(raw.protected.objective, 65536);
    string(raw.protected.policy, 65536, true);
    string(raw.protected.checkpoint, 65536, true);
    for (const field of ['acceptanceCriteria', 'permissions'] as const) {
      const list = raw.protected[field];
      if (!Array.isArray(list) || list.length > 256) throw new ContextBoundaryError('invalid-input');
      list.forEach(item => string(item, 4096));
    }
    object(raw.budget, ['maxBytes', 'maxTokens']);
    positive(raw.budget.maxBytes, 4 * 1024 * 1024);
    if (raw.budget.maxTokens !== undefined) positive(raw.budget.maxTokens, 1000000);
    positive(raw.expiresAt);
    if (!Array.isArray(raw.evidence) || raw.evidence.length > 128) throw new ContextBoundaryError('invalid-input');
    const ids = new Set<string>();
    for (const item of raw.evidence) {
      object(item, ['id', 'sourceUri', 'sourceVersion', 'contentDigest', 'content', 'compressible']);
      string(item.id, 256); string(item.sourceUri); string(item.sourceVersion, 256);
      string(item.contentDigest, 64); string(item.content, 1024 * 1024, true);
      if (ids.has(item.id) || typeof item.compressible !== 'boolean' || item.contentDigest !== digest(item.content)) {
        throw new ContextBoundaryError('invalid-input');
      }
      ids.add(item.id);
    }
    if (bytes(JSON.stringify(raw)) > 4 * 1024 * 1024) throw new ContextBoundaryError('invalid-input');
    return freeze(raw);
  } catch { throw new ContextBoundaryError('invalid-input'); }
}
