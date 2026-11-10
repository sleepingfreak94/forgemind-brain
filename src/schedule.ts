import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LABEL = 'com.forgemind.brain.reflect';
export type Launchctl = (args: string[]) => void;
export interface ScheduleDeps { plistDir?: string; launchctl?: Launchctl; platform?: string; uid?: number }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const defaultLaunchctl: Launchctl = args => { execFileSync('launchctl', args, { stdio: 'ignore', timeout: 30000 }); };

export function plistContent(brainDir: string, seconds: number): string {
  const path = [dirname(process.execPath), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  const args = [process.execPath, join(brainDir, 'bin', 'cli.js'), 'reflect', '--brain-dir', brainDir];
  const log = join(brainDir, 'reflect', 'launchd.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
  <key>StartInterval</key><integer>${seconds}</integer>
  <key>RunAtLoad</key><false/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Install (`every` like "48h"), remove (`off`) or report on the reflect LaunchAgent. */
export function schedule(brainDir: string, opts: { every?: string | undefined; off?: boolean; status?: boolean }, deps: ScheduleDeps = {}): Record<string, unknown> {
  if ((deps.platform ?? process.platform) !== 'darwin') throw new Error('schedule needs macOS (launchd)');
  const plist = join(deps.plistDir ?? join(homedir(), 'Library', 'LaunchAgents'), `${LABEL}.plist`);
  const launchctl = deps.launchctl ?? defaultLaunchctl;
  const domain = `gui/${deps.uid ?? process.getuid?.() ?? 0}`;
  const quietly = (args: string[]) => { try { launchctl(args); return true; } catch { return false; } };
  if (opts.status) {
    if (!existsSync(plist)) return { scheduled: false };
    const seconds = Number(/<key>StartInterval<\/key><integer>(\d+)</.exec(readFileSync(plist, 'utf8'))?.[1]);
    return { scheduled: true, everySeconds: seconds, loaded: quietly(['print', `${domain}/${LABEL}`]), plist };
  }
  if (opts.off) {
    quietly(['bootout', `${domain}/${LABEL}`]);
    rmSync(plist, { force: true });
    return { scheduled: false };
  }
  const match = /^(\d+)h$/.exec(opts.every ?? '');
  const hours = match ? Number(match[1]) : 0;
  if (hours < 1 || hours > 720) throw new Error('--every must look like 48h (1 to 720 hours)');
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(join(brainDir, 'reflect'), { recursive: true, mode: 0o700 });
  quietly(['bootout', `${domain}/${LABEL}`]);
  writeFileSync(plist, plistContent(brainDir, hours * 3600), { mode: 0o644 });
  launchctl(['bootstrap', domain, plist]);
  return { scheduled: true, everySeconds: hours * 3600, plist };
}
