import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBrainCli } from '../src/cli.js';
import { LABEL, schedule } from '../src/schedule.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-schedule-')));
after(() => rmSync(root, { recursive: true, force: true }));
const plist = join(root, 'agents', `${LABEL}.plist`);
const brain = join(root, 'brain');

test('every writes the plist and bootstraps; status and off use the fake launchctl', () => {
  const calls: string[][] = [];
  const deps = { plistDir: join(root, 'agents'), launchctl: (a: string[]) => { calls.push(a); }, platform: 'darwin', uid: 501 };
  assert.equal(schedule(brain, { every: '48h' }, deps).everySeconds, 172800);
  const xml = readFileSync(plist, 'utf8');
  assert.match(xml, /<key>StartInterval<\/key><integer>172800<\/integer>/);
  assert.match(xml, /<key>RunAtLoad<\/key><false\/>/);
  assert.ok(xml.includes(`<string>${join(brain, 'bin', 'cli.js')}</string><string>reflect</string>`));
  assert.ok(xml.includes(join(brain, 'reflect', 'launchd.log')));
  assert.deepEqual(calls.at(-1), ['bootstrap', 'gui/501', plist]);
  assert.deepEqual(schedule(brain, { status: true }, deps), { scheduled: true, everySeconds: 172800, loaded: true, plist });
  assert.equal(schedule(brain, { off: true }, deps).scheduled, false);
  assert.deepEqual(calls.at(-1), ['bootout', `gui/501/${LABEL}`]);
  assert.equal(existsSync(plist), false);
  assert.deepEqual(schedule(brain, { status: true }, deps), { scheduled: false });
});

test('refuses off macOS and bad intervals; cli requires exactly one mode', () => {
  assert.throws(() => schedule(brain, { every: '48h' }, { platform: 'linux' }), /macOS/);
  assert.throws(() => schedule(brain, { every: 'soon' }, { platform: 'darwin', plistDir: join(root, 'x'), launchctl: () => {} }), /--every/);
  let out = '';
  assert.equal(runBrainCli(['schedule', '--off', '--status', '--brain-dir', brain], { write: t => { out += t; } }), 2);
  assert.equal(runBrainCli(['schedule', '--status', '--brain-dir', brain], { write: t => { out += t; } },
    { schedule: { platform: 'darwin', plistDir: join(root, 'y'), launchctl: () => {} } }), 0);
});
