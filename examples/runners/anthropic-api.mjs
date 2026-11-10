#!/usr/bin/env node
// Reflect runner: prompt on stdin -> Anthropic Messages API (no tools) -> text on stdout.
// Use: brain reflect --runner cursor=/abs/path/to/examples/runners/anthropic-api.mjs
import { stdin, stdout, env, exit } from 'node:process';

const MAX_OUT = 200000;
const key = env.ANTHROPIC_API_KEY;
if (!key) { console.error('ANTHROPIC_API_KEY is not set'); exit(1); }
let prompt = '';
for await (const chunk of stdin) { prompt += chunk; if (prompt.length > 400000) { console.error('prompt too large'); exit(1); } }
try {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) { console.error(`Anthropic API error ${res.status}`); exit(1); }
  const data = await res.json();
  stdout.write((data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('').slice(0, MAX_OUT));
} catch (error) { console.error(`request failed: ${error.message}`); exit(1); }
