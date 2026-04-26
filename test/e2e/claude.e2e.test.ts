/**
 * End-to-end tests against the real Anthropic API via Claude Agent SDK.
 *
 * Required env (one of):
 *   - CLAUDE_CODE_OAUTH_TOKEN
 *   - ANTHROPIC_API_KEY
 *
 * Tests are skipped cleanly when neither is set, so this file is safe to
 * run in CI without secrets — it just no-ops.
 *
 * These tests make real API calls and consume tokens. Keep prompts short
 * and turn caps tight.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, claude, tools, type Tool } from '../../src/index';
import {
  assembledText,
  claudeOAuthPreferredToken,
  collectEvents,
  continuationFromEvents,
  hasAnthropicAuth,
  toolCalls,
} from './helpers';

// When both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set, prefer
// OAuth so tests run against the user's Pro/Max subscription instead of
// metered API billing. Returns undefined when only one is set, in which
// case the SDK uses whatever's there.
const oauthToken = claudeOAuthPreferredToken();
const claudeOpts = oauthToken !== undefined ? { oauthToken } : {};

describe.skipIf(!hasAnthropicAuth)('Claude end-to-end', () => {
  it('completes a trivial query and emits a coherent event sequence', async () => {
    const agent = new Agent({ backend: claude(claudeOpts) });
    try {
      const query = agent.run({
        message: 'Reply with exactly the word OK and nothing else.',
      });
      const events = await collectEvents(query);

      // Minimal contract:
      expect(events.find((e) => e.type === 'session_start')).toBeDefined();
      expect(events.find((e) => e.type === 'session_end')).toBeDefined();
      expect(continuationFromEvents(events)).toBeTypeOf('string');

      const text = assembledText(events);
      expect(text.length).toBeGreaterThan(0);
      // Tolerant — model may say "OK" or "OK." or similar
      expect(text.toLowerCase()).toContain('ok');
    } finally {
      await agent.close();
    }
  }, 60_000);

  it('fires tool_call_end with the canonical name when the model uses a native tool', async () => {
    const agent = new Agent({
      backend: claude({
        ...claudeOpts,
        tools: [tools.bash],
        permissionMode: 'bypassPermissions',
      }),
    });
    try {
      const query = agent.run({
        message:
          'Use the bash tool to run exactly: echo hello-from-bash. Then reply with exactly DONE.',
      });
      const events = await collectEvents(query);

      const calls = toolCalls(events);
      // Must have called bash at least once.
      const bashCalls = calls.filter((c) => c.name === 'bash');
      expect(bashCalls.length).toBeGreaterThanOrEqual(1);

      // Should NOT see the wire name 'Bash' — canonical lookup converts it.
      expect(calls.find((c) => c.name === 'Bash')).toBeUndefined();

      // tool_result should appear for the bash call.
      const result = events.find((e) => e.type === 'tool_result');
      expect(result).toBeDefined();
    } finally {
      await agent.close();
    }
  }, 90_000);

  it('routes a custom tool through the in-process SDK MCP server', async () => {
    let invocations = 0;
    let lastTimezone: string | undefined;

    const currentTime: Tool = {
      name: 'currentTime',
      description: 'Get the current date and time. Optional IANA timezone.',
      schema: z.object({
        timezone: z.string().optional(),
      }),
      // No native.claude — must register as an SDK MCP tool
      execute: async ({ timezone }: { timezone?: string }): Promise<string> => {
        invocations++;
        lastTimezone = timezone;
        return `SENTINEL-TIME-VALUE for tz=${timezone ?? 'UTC'}`;
      },
    };

    const agent = new Agent({
      backend: claude({
        ...claudeOpts,
        tools: [currentTime],
        permissionMode: 'bypassPermissions',
      }),
    });
    try {
      const query = agent.run({
        message:
          'Call the currentTime tool with timezone "Asia/Tokyo". Then echo back exactly the value the tool returned.',
      });
      const events = await collectEvents(query);

      // The closure ran in OUR process — verify side effects
      expect(invocations).toBeGreaterThanOrEqual(1);
      expect(lastTimezone).toBe('Asia/Tokyo');

      // The tool call appears in the event stream with the canonical name,
      // not the wire name (mcp__agent-sdk-tools__currentTime).
      const calls = toolCalls(events);
      const timeCalls = calls.filter((c) => c.name === 'currentTime');
      expect(timeCalls.length).toBeGreaterThanOrEqual(1);
      expect(calls.find((c) => c.name.startsWith('mcp__'))).toBeUndefined();

      // The model received the sentinel and echoed it back.
      const text = assembledText(events);
      expect(text).toContain('SENTINEL-TIME-VALUE');
    } finally {
      await agent.close();
    }
  }, 120_000);

  it('resumes a thread across two queries via continuation', async () => {
    const agent = new Agent({ backend: claude(claudeOpts) });
    try {
      const q1 = agent.run({
        message: 'Remember the magic number is 7. Reply with OK.',
      });
      const events1 = await collectEvents(q1);
      const continuation = continuationFromEvents(events1);
      expect(continuation).toBeTypeOf('string');

      const q2 = agent.run({
        message: 'What was the magic number? Reply with just the number.',
        ...(continuation !== undefined && { continuation }),
      });
      const events2 = await collectEvents(q2);
      const text = assembledText(events2);
      expect(text).toContain('7');
    } finally {
      await agent.close();
    }
  }, 120_000);
});
