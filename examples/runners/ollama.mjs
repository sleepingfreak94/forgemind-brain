#!/usr/bin/env node
// Reflect runner: prompt on stdin -> local Ollama -> text on stdout. Model: OLLAMA_MODEL (default llama3.1).
// Use: brain reflect --runner cursor=/abs/path/to/examples/runners/ollama.mjs
import { stdin, stdout, env, exit } from 'node:process';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_OUT = 200000;
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
let fileModel = '';
if (!env.OLLAMA_MODEL) { try { fileModel = readPrivate(join(homedir(), '.forgemind', 'reflect', 'ollama-model')) ?? ''; } catch { /* optional; an unsafe file is ignored */ } }
let prompt = '';
for await (const chunk of stdin) { prompt += chunk; if (prompt.length > 400000) { console.error('prompt too large'); exit(1); } }
try {
  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', signal: AbortSignal.timeout(300000), headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.OLLAMA_MODEL || fileModel || 'llama3.1', prompt, stream: false }),
  });
  if (!res.ok) { console.error(`Ollama error ${res.status}`); exit(1); }
  const data = await res.json();
  stdout.write(String(data.response ?? '').slice(0, MAX_OUT));
} catch (error) { console.error(`request failed: ${error.message}`); exit(1); }
