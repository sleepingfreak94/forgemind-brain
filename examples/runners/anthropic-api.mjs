#!/usr/bin/env node
// Reflect runner: prompt on stdin -> Anthropic Messages API (no tools) -> text on stdout.
// Use: brain reflect --runner cursor=/abs/path/to/examples/runners/anthropic-api.mjs
import { stdin, stdout, env, exit } from 'node:process';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_OUT = 200000;
// Scheduled (launchd) runs have no shell env, so fall back to a private key file.
function readPrivate(file) {
  // O_NOFOLLOW refuses symlinks; O_NONBLOCK stops a FIFO from hanging the open (the fstat check then refuses it).
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error(`cannot open ${file} (symlinks are refused): ${error.code}`); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error(`${file} must be a regular file you own with mode 0600 or stricter`);
    return readFileSync(fd, 'utf8').trim();
  } finally { closeSync(fd); }
}
function readKey() {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  const file = env.ANTHROPIC_API_KEY_FILE || join(homedir(), '.forgemind', 'reflect', 'anthropic-api-key');
  let key;
  try { key = readPrivate(file); } catch (error) { console.error(error.message); exit(1); }
  if (key === undefined) { console.error(`ANTHROPIC_API_KEY is not set and no key file at ${file}`); exit(1); }
  if (!key) { console.error(`key file ${file} is empty`); exit(1); }
  return key;
}
const key = readKey();
let prompt = '';
for await (const chunk of stdin) { prompt += chunk; if (prompt.length > 400000) { console.error('prompt too large'); exit(1); } }
try {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) { console.error(`Anthropic API error ${res.status}`); exit(1); }
  const data = await res.json();
  if (data.stop_reason === 'max_tokens') console.error('warning: answer cut off at max_tokens');
  stdout.write((data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('').slice(0, MAX_OUT));
} catch (error) { console.error(`request failed: ${error.message}`); exit(1); }
