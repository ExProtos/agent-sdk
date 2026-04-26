import type { AgentEvent, AgentQuery } from '../../src/types';

/** True if env has any usable Anthropic credential (OAuth or API key). */
export const hasAnthropicAuth =
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

/**
 * True only if env has a real ANTHROPIC_API_KEY. Distinct from
 * `hasAnthropicAuth` because `@ai-sdk/anthropic` does not understand
 * Claude Code's OAuth token format — it only accepts an API key.
 */
export const hasAnthropicApiKey = !!process.env.ANTHROPIC_API_KEY;

/**
 * Env override for the Claude backend that prefers `CLAUDE_CODE_OAUTH_TOKEN`
 * when both it and `ANTHROPIC_API_KEY` are set. Returns an env dict with
 * `ANTHROPIC_API_KEY` stripped so the SDK only sees the OAuth credential
 * (which routes through the user's Pro/Max subscription instead of metered
 * API billing).
 *
 * Returns `undefined` when there's nothing to override — caller can spread
 * the result conditionally without juggling defaults.
 */
export function claudeOAuthPreferredEnv(): Record<string, string | undefined> | undefined {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN || !process.env.ANTHROPIC_API_KEY) {
    return undefined;
  }
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/**
 * Codex auth is checked at runtime via account/read — we can't pre-detect
 * via env vars alone (ChatGPT OAuth tokens live in ~/.codex/auth.json).
 * Tests that need Codex set AGENT_SDK_CODEX_E2E=1 to opt in explicitly,
 * acknowledging they have `codex login` done or OPENAI_API_KEY set.
 */
export const codexE2eEnabled = process.env.AGENT_SDK_CODEX_E2E === '1';

/** True if env has OPENAI_API_KEY (required for the @openai/agents SDK). */
export const hasOpenAIApiKey = !!process.env.OPENAI_API_KEY;

/** Drain an AgentQuery's events into an array. */
export async function collectEvents(query: AgentQuery): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of query.events) events.push(ev);
  return events;
}

/**
 * Like collectEvents, but also prints every event to stderr as it arrives.
 * Useful when a test is failing mysteriously and you want to see the full
 * sequence (errors, partial events, etc.).
 */
export async function collectEventsVerbose(
  query: AgentQuery,
  label = 'events',
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of query.events) {
    events.push(ev);
    const summary = JSON.stringify(ev).slice(0, 300);
    process.stderr.write(`[${label}] ${summary}\n`);
  }
  return events;
}

/** Find all tool_call_end events. */
export function toolCalls(events: AgentEvent[]): Array<{ name: string; input: unknown }> {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'tool_call_end' }> => e.type === 'tool_call_end')
    .map((e) => ({ name: e.toolCall.name, input: e.toolCall.input }));
}

/** Concatenate all text_end content. */
export function assembledText(events: AgentEvent[]): string {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'text_end' }> => e.type === 'text_end')
    .map((e) => e.text)
    .join('\n');
}

/** Find the session_start event's continuation token, if present. */
export function continuationFromEvents(events: AgentEvent[]): string | undefined {
  const start = events.find(
    (e): e is Extract<AgentEvent, { type: 'session_start' }> => e.type === 'session_start',
  );
  return start?.continuation;
}
