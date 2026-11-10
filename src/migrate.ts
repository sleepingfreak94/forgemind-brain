import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { privatePath, strayMigrationFiles } from './validation.js';

export class MigrationRefused extends Error {}

function count(path: string, table: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0); }
  catch { return 0; } // very old files may lack the history table
  finally { db.close(); }
}

/** Copy <dir>/brain/personal/brain.sqlite to <dir>/brain.sqlite. Only a hot journal on the legacy file may be rolled back (normal SQLite recovery), its data is not changed; company/ is never read. */
export function migrateLegacy(directory: string): { entries: number; history: number } {
  if (!isAbsolute(directory)) throw new Error('brain storage must be absolute');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new Error('brain storage must be canonical');
  privatePath(directory, true);
  // Remove leftovers of a crashed migrate, but never a live one (the pid is in the name).
  for (const name of strayMigrationFiles(directory)) {
    const pidOf = Number(/^\.brain\.migrating-(\d+)-/.exec(name)?.[1]);
    if (Number.isInteger(pidOf)) {
      try { process.kill(pidOf, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') continue; /* alive, another user's */ }
    }
    try { unlinkSync(join(directory, name)); } catch { /* already gone */ }
  }
  const target = join(directory, 'brain.sqlite');
  const legacy = join(directory, 'brain', 'personal', 'brain.sqlite');
  if (existsSync(target)) throw new MigrationRefused('brain.sqlite already exists; nothing to migrate');
  if (!existsSync(legacy)) throw new MigrationRefused('no legacy brain at brain/personal/brain.sqlite');
  privatePath(legacy, false);
  const tmp = join(directory, `.brain.migrating-${process.pid}-${randomBytes(6).toString('hex')}`);
  // Opening rolls back a hot journal and VACUUM INTO reads under a lock, so the copy is a consistent snapshot.
  const source = new DatabaseSync(legacy, { timeout: 5000 });
  try { source.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`); } finally { source.close(); }
  try {
    const check = new DatabaseSync(tmp, { readOnly: true });
    try { if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('integrity check failed on the copy'); }
    finally { check.close(); }
    chmodSync(tmp, 0o600);
    try { linkSync(tmp, target); } // atomic and refuses to replace
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new MigrationRefused('brain.sqlite already exists; nothing to migrate');
      throw error;
    }
    return { entries: count(target, 'entries'), history: count(target, 'history') };
  } finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
}
