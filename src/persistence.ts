/**
 * JSONL persistence helpers for UIMessage[].
 *
 * Format: one complete UIMessage per line, JSON-encoded. Append-only.
 * Used by the Vercel backend to persist conversation history across
 * process restarts (Vercel has no native session storage). Other
 * backends (Claude, Codex) use their own native session storage and
 * don't write through this module.
 *
 * Round-trip via the AI SDK:
 *   write side  — `result.toUIMessageStream()` → `readUIMessageStream()`
 *                 yields UIMessages → append via `appendUIMessage`
 *   reload side — `readUIMessages(path)` → `convertToModelMessages()`
 *                 → pass as `messages` to `streamText`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UIMessage } from 'ai';

/**
 * Append one UIMessage as a single JSONL line. Creates parent directories
 * as needed. Synchronous so callers can rely on ordering relative to
 * surrounding I/O.
 */
export function appendUIMessage(filePath: string, message: UIMessage): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(message) + '\n', 'utf8');
}

/**
 * Read a JSONL file of UIMessages. Returns an empty array if the file
 * does not exist (treats missing as "no prior history" for new sessions).
 * Throws on malformed JSON — corruption is a real bug, not a recoverable
 * empty state.
 */
export function readUIMessages(filePath: string): UIMessage[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const messages: UIMessage[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    messages.push(JSON.parse(line) as UIMessage);
  }
  return messages;
}
