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
import { Agent, claude, tools } from '../../src/index';
import {
  assembledText,
  claudeOAuthPreferredEnv,
  collectEvents,
  continuationFromEvents,
  hasAnthropicAuth,
  toolCalls,
} from './helpers';

// When both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set, prefer
// OAuth so tests run against the user's Pro/Max subscription instead of
// metered API billing. Returns undefined when only one is set, in which
// case the SDK uses whatever's there.
const oauthEnv = claudeOAuthPreferredEnv();
const claudeOpts = oauthEnv !== undefined ? { env: oauthEnv } : {};

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
