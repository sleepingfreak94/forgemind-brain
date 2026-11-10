import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function reflectDirectory(brainDir: string): string {
  const dir = join(brainDir, 'reflect');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
const lastFile = (brainDir: string, source: string) => join(reflectDirectory(brainDir), `last-${source}.json`);

/** Record that `source` was reflected at `now` (0700 dir, 0600 file). */
export function markReflected(brainDir: string, source: string, now: number): void {
  const path = lastFile(brainDir, source);
  writeFileSync(path, JSON.stringify({ at: now }), { mode: 0o600 });
  chmodSync(path, 0o600);
}
/** Time of the last run for `source`, or undefined when there never was one or the file is unreadable. */
export function lastReflected(brainDir: string, source: string): number | undefined {
  try {
    const at = (JSON.parse(readFileSync(lastFile(brainDir, source), 'utf8')) as { at?: unknown }).at;
    return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
}
