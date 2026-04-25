/**
 * End-to-end tests against a real `codex app-server`.
 *
 * Required:
 *   - codex binary on PATH
 *   - logged in (`codex login`) OR OPENAI_API_KEY set
 *   - AGENT_SDK_CODEX_E2E=1 to opt in (since we can't auto-detect ChatGPT
 *     OAuth from env vars alone)
 *
 * These tests make real API calls and may be slow. Keep prompts short.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, codex, tools, type Tool } from '../../src/index';
import {
  assembledText,
  codexE2eEnabled,
  collectEvents,
  collectEventsVerbose,
  continuationFromEvents,
  toolCalls,
} from './helpers';

describe.skipIf(!codexE2eEnabled)('Codex end-to-end', () => {
  it('completes a trivial query', async () => {
    const agent = new Agent({ backend: codex({}) });
    try {
      const query = agent.run({
        message: 'Reply with exactly the word OK and nothing else.',
      });
      // Verbose collector dumps every event to stderr as it arrives.
      const events = await collectEventsVerbose(query, 'codex-trivial');

      expect(events.find((e) => e.type === 'session_start')).toBeDefined();
      expect(events.find((e) => e.type === 'session_end')).toBeDefined();
      expect(continuationFromEvents(events)).toBeTypeOf('string');

      const text = assembledText(events);
      expect(text.length).toBeGreaterThan(0);
      expect(text.toLowerCase()).toContain('ok');
    } finally {
      await agent.close();
    }
  }, 90_000);

  it('surfaces native commandExecution items as tool_call_end with name=bash', async () => {
    const agent = new Agent({ backend: codex({ tools: tools.all }) });
    try {
      const query = agent.run({
        message: 'Run exactly: echo hello-from-bash. Then reply with DONE.',
      });
      const events = await collectEvents(query);

      const calls = toolCalls(events);
      const bashCalls = calls.filter((c) => c.name === 'bash');
      expect(bashCalls.length).toBeGreaterThanOrEqual(1);

      // Should NOT see the raw wire name 'commandExecution' — canonical mapping applies.
      expect(calls.find((c) => c.name === 'commandExecution')).toBeUndefined();
    } finally {
      await agent.close();
    }
  }, 120_000);

  it('routes a custom tool through the MCP shim bridge', async () => {
    let invocations = 0;
    let lastTimezone: string | undefined;

    const currentTime: Tool = {
      name: 'currentTime',
      description: 'Get the current date and time. Optional IANA timezone.',
      schema: z.object({
        timezone: z.string().optional(),
      }),
      // No native.codex — must route through the bridge
      execute: async ({ timezone }: { timezone?: string }): Promise<string> => {
        invocations++;
        lastTimezone = timezone;
        // Return a sentinel string the test can verify the model received
        return `SENTINEL-TIME-VALUE for tz=${timezone ?? 'UTC'}`;
      },
    };

    const agent = new Agent({
      backend: codex({ tools: [currentTime] }),
    });
    try {
      const query = agent.run({
        message:
          'Call the currentTime tool with timezone "Asia/Tokyo". Then echo back exactly the value the tool returned.',
      });
      const events = await collectEventsVerbose(query, 'codex-bridge');

      // The closure ran in OUR process — verify side effects
      expect(invocations).toBeGreaterThanOrEqual(1);
      expect(lastTimezone).toBe('Asia/Tokyo');

      // The tool call shows up in the event stream with our canonical name
      const calls = toolCalls(events);
      const timeCalls = calls.filter((c) => c.name === 'currentTime');
      expect(timeCalls.length).toBeGreaterThanOrEqual(1);

      // Sentinel value flowed back — the model saw what we returned
      const text = assembledText(events);
      expect(text).toContain('SENTINEL-TIME-VALUE');
    } finally {
      await agent.close();
    }
  }, 120_000);

  it('resumes a thread across two queries via continuation', async () => {
    const agent = new Agent({ backend: codex({}) });
    try {
      const q1 = agent.run({
        message: 'Remember the magic number is 11. Reply with OK.',
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
      expect(text).toContain('11');
    } finally {
      await agent.close();
    }
  }, 180_000);
});
