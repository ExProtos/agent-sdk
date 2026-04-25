import type { AgentEvent, AgentQuery } from '../../src/types';

/** True if env has any usable Anthropic credential (OAuth or API key). */
export const hasAnthropicAuth =
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

/**
 * Codex auth is checked at runtime via account/read — we can't pre-detect
 * via env vars alone (ChatGPT OAuth tokens live in ~/.codex/auth.json).
 * Tests that need Codex set AGENT_SDK_CODEX_E2E=1 to opt in explicitly,
 * acknowledging they have `codex login` done or OPENAI_API_KEY set.
 */
export const codexE2eEnabled = process.env.AGENT_SDK_CODEX_E2E === '1';

/** Drain an AgentQuery's events into an array. */
export async function collectEvents(query: AgentQuery): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of query.events) events.push(ev);
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
