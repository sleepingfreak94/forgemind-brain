import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Measured session signals; the shape is the schema v5 history.signals contract. */
export interface SessionSignals {
  prompts: number; corrections: number; correctionIndexes: number[]; model: string | null;
  assistantTurns: number; toolErrors: number; durationMs: number | null;
}
export interface ParsedTranscript { prompts: string[]; signals: SessionSignals }

const MAX_INDEXED_PROMPTS = 50;
export const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;

/** A prompt that starts like one of these is a correction of the previous answer. Conservative: leading words only. */
export const CORRECTION_STARTS: readonly RegExp[] = [
  /^(no|nope|nah|wrong)\b/, /^that'?s (not|wrong|incorrect)\b/, /^that is (not|wrong|incorrect)\b/, /^not (what|quite|right|that|working)\b/,
  /^undo\b/, /^you (didn'?t|did not|forgot|missed|broke|misunderstood)\b/, /^i (said|told you)\b/, /^why did you\b/,
  /^(that )?(doesn'?t|does not|didn'?t|did not) (work|help)\b/, /^(this|that) (is )?(still )?(broken|wrong)\b/, /^actually,? (no|don'?t|that)\b/,
  /^still (broken|fails|failing|not working)\b/, /^it still\b/, /^wait\b.{0,80}\bnot\b/
];
/** Starts that look like corrections but are not ("no rush", "nope that works"). */
export const CORRECTION_EXCLUDES: readonly RegExp[] = [/^(no|nope|nah)\b[\s,.!-]*(rush|problem|worries|need|thanks|thank)\b/, /^(no|nope|nah)\b[\s,.!-]*(that|it|this)\b.{0,15}\b(works|worked|is fine|looks good|is good)\b/];
export const isCorrection = (prompt: string): boolean => {
  const text = prompt.trim().toLowerCase().replace(/^[\s"'`*_-]+/, '');
  return !CORRECTION_EXCLUDES.some(pattern => pattern.test(text)) && CORRECTION_STARTS.some(pattern => pattern.test(text));
};

// Wrapper tags Claude Code and Cursor put in user-role messages that the human never typed.
const NOT_TYPED = /^\s*<(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|system-reminder|task-notification|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr|ide_[a-z_]+|attached_files|open_tabs)\b/i;
const INTERRUPTED = /^\s*\[Request interrupted by user/i;

function typedPrompt(content: unknown): string | undefined {
  const parts: string[] = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const p of content) {
      if (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string') parts.push((p as { text: string }).text);
    }
  } else return undefined;
  const kept = parts.map(text => {
    const query = /<user_query\b[^>]*>([\s\S]*?)<\/user_query>/i.exec(text); // Cursor wraps the typed text
    return query ? (query[1] ?? '') : text;
  }).filter(text => text.trim() !== '' && !NOT_TYPED.test(text) && !INTERRUPTED.test(text) && !/^\s*Caveat: The messages below/i.test(text));
  const joined = kept.join('\n').trim();
  return joined === '' ? undefined : joined;
}

/** Parse transcript text (Claude Code JSONL or Cursor agent-transcript JSONL). Never throws; skips bad lines. */
export function parseTranscript(text: string): ParsedTranscript {
  const prompts: string[] = [];
  const turns = new Set<string>();
  let anonymousTurns = 0, toolErrors = 0, model: string | null = null;
  let first = Infinity, last = -Infinity;
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const e = o as Record<string, unknown>;
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(ts)) { first = Math.min(first, ts); last = Math.max(last, ts); }
    const message = e.message && typeof e.message === 'object' ? e.message as Record<string, unknown> : undefined;
    const role = e.type === 'user' || e.type === 'assistant' ? e.type : e.role;
    if (e.isSidechain === true || e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true) continue;
    if (role === 'assistant') {
      const id = message?.id;
      if (typeof id === 'string') turns.add(id); else anonymousTurns++;
      if (typeof message?.model === 'string' && message.model !== '' && message.model !== '<synthetic>') model = message.model;
    } else if (role === 'user' && e.isMeta !== true) {
      const content = message?.content ?? e.content;
      if (Array.isArray(content) && content.some(p => p && typeof p === 'object' && (p as { type?: unknown }).type === 'tool_result')) {
        for (const p of content) if (p && typeof p === 'object' && (p as { type?: unknown; is_error?: unknown }).type === 'tool_result' && (p as { is_error?: unknown }).is_error === true) toolErrors++;
        continue;
      }
      if (e.toolUseResult !== undefined) continue;
      const prompt = typedPrompt(content);
      if (prompt !== undefined) prompts.push(prompt);
    }
  }
  const all = prompts.flatMap((p, i) => i > 0 && isCorrection(p) ? [i] : []);
  const correctionIndexes = all.filter(i => i < MAX_INDEXED_PROMPTS); // the store keeps at most 50 indexes
  return { prompts, signals: { prompts: prompts.length, corrections: all.length, correctionIndexes, model,
    assistantTurns: turns.size + anonymousTurns, toolErrors, durationMs: Number.isFinite(first) && last >= first ? last - first : null } };
}

/** Read at most the last 20 MB of a transcript file. Returns undefined for anything unreadable. */
export function readTranscript(path: unknown): ParsedTranscript | undefined {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const start = Math.max(0, stat.size - MAX_TRANSCRIPT_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    let got = 0;
    while (got < buffer.length) {
      const n = readSync(fd, buffer, got, buffer.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let text = buffer.subarray(0, got).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // the first line is cut mid-way
    return parseTranscript(text);
  } catch { return undefined; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}
