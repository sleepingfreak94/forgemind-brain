import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LABEL = 'com.forgemind.brain.reflect';
export type Launchctl = (args: string[]) => void;
export interface ScheduleDeps { plistDir?: string; launchctl?: Launchctl; platform?: string; uid?: number }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const defaultLaunchctl: Launchctl = args => { execFileSync('launchctl', args, { stdio: 'ignore', timeout: 30000 }); };

export function plistContent(brainDir: string, seconds: number, extra: string[] = []): string {
  const path = [dirname(process.execPath), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  const args = [process.execPath, join(brainDir, 'bin', 'cli.js'), 'reflect', '--brain-dir', brainDir, '--days', String(Math.min(30, Math.ceil(seconds / 86400))), ...extra];
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

/** The installed reflect plist's arguments, interval and mtime, or undefined when none is installed or it is unreadable. No launchctl call, so it is fast. */
export function scheduledInfo(deps: ScheduleDeps = {}): { args: string[]; everySeconds: number; mtimeMs: number } | undefined {
  try {
    const path = join(deps.plistDir ?? join(homedir(), 'Library', 'LaunchAgents'), `${LABEL}.plist`);
    const text = readFileSync(path, 'utf8');
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '';
    return { args: [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')),
      everySeconds: Number(/<key>StartInterval<\/key><integer>(\d+)</.exec(text)?.[1]) || 0, mtimeMs: statSync(path).mtimeMs };
  } catch { return undefined; }
}

/** Install (`every` like "48h"), remove (`off`) or report on the reflect LaunchAgent. */
export function schedule(brainDir: string, opts: { every?: string | undefined; off?: boolean; status?: boolean; sources?: string | undefined; projects?: string | undefined; runners?: string[] | undefined }, deps: ScheduleDeps = {}): Record<string, unknown> {
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
  const cli = join(brainDir, 'bin', 'cli.js');
  if (!existsSync(cli)) throw new Error(`${cli} not found; run install-local first`);
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(join(brainDir, 'reflect'), { recursive: true, mode: 0o700 });
  quietly(['bootout', `${domain}/${LABEL}`]);
  writeFileSync(plist, plistContent(brainDir, hours * 3600, [...(opts.sources ? ['--sources', opts.sources] : []), ...(opts.projects ? ['--projects', opts.projects] : []), ...(opts.runners ?? []).flatMap(r => ['--runner', r])]), { mode: 0o644 });
  try { launchctl(['bootstrap', domain, plist]); } catch (error) { rmSync(plist, { force: true }); throw error; }
  return { scheduled: true, everySeconds: hours * 3600, plist };
}
