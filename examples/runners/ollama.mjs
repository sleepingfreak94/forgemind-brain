#!/usr/bin/env node
// Reflect runner: prompt on stdin -> local Ollama -> text on stdout. Model: OLLAMA_MODEL (default llama3.1).
// Use: brain reflect --runner cursor=/abs/path/to/examples/runners/ollama.mjs
import { stdin, stdout, env, exit } from 'node:process';

const MAX_OUT = 200000;
let prompt = '';
for await (const chunk of stdin) { prompt += chunk; if (prompt.length > 400000) { console.error('prompt too large'); exit(1); } }
try {
  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', signal: AbortSignal.timeout(300000), headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.OLLAMA_MODEL || 'llama3.1', prompt, stream: false }),
  });
  if (!res.ok) { console.error(`Ollama error ${res.status}`); exit(1); }
  const data = await res.json();
  stdout.write(String(data.response ?? '').slice(0, MAX_OUT));
} catch (error) { console.error(`request failed: ${error.message}`); exit(1); }
