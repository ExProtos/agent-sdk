/**
 * End-to-end tests against the OpenAI Agents backend (`@openai/agents`).
 *
 * Required env: OPENAI_API_KEY. Tests skip when missing.
 *
 * These tests make real API calls. Keep prompts short to minimize cost.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Agent, openai, hostedTools, tools, type Tool } from '../../src/index';
import {
  assembledText,
  collectEvents,
  continuationFromEvents,
  hasOpenAIApiKey,
  toolCalls,
} from './helpers';
import { readJsonlItems } from '../../src/backends/openai/index';

const MODEL = 'gpt-5-mini';

function freshSessionsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openai-e2e-'));
}

describe.skipIf(!hasOpenAIApiKey)('OpenAI Agents end-to-end', () => {
  it('completes a trivial query and emits a coherent event sequence', async () => {
    const agent = new Agent({
      backend: openai({ model: MODEL }),
    });
    try {
      const query = agent.run({
        message: 'Reply with exactly the word OK and nothing else.',
      });
      const events = await collectEvents(query);

      expect(events.find((e) => e.type === 'session_start')).toBeDefined();
      expect(events.find((e) => e.type === 'session_end')).toBeDefined();
      expect(continuationFromEvents(events)).toBeTypeOf('string');

      const text = assembledText(events);
      expect(text.length).toBeGreaterThan(0);
      expect(text.toLowerCase()).toContain('ok');
    } finally {
      await agent.close();
    }
  }, 60_000);

  it('routes a custom function tool through tool() with closure-captured side effects', async () => {
    let invocations = 0;
    let lastTimezone: string | undefined;

    const currentTime: Tool = {
      name: 'currentTime',
      description: 'Get the current date and time. Optional IANA timezone.',
      schema: z.object({
        timezone: z.string().optional(),
      }),
      execute: async ({ timezone }: { timezone?: string }): Promise<string> => {
        invocations++;
        lastTimezone = timezone;
        return `SENTINEL-TIME-VALUE for tz=${timezone ?? 'UTC'}`;
      },
    };

    const agent = new Agent({
      backend: openai({ model: MODEL, tools: [currentTime] }),
    });
    try {
      const query = agent.run({
        message:
          'Call the currentTime tool with timezone "Asia/Tokyo". Then echo back exactly the value the tool returned.',
      });
      const events = await collectEvents(query);

      expect(invocations).toBeGreaterThanOrEqual(1);
      expect(lastTimezone).toBe('Asia/Tokyo');

      const calls = toolCalls(events);
      const timeCalls = calls.filter((c) => c.name === 'currentTime');
      expect(timeCalls.length).toBeGreaterThanOrEqual(1);

      const text = assembledText(events);
      expect(text).toContain('SENTINEL-TIME-VALUE');
    } finally {
      await agent.close();
    }
  }, 120_000);

  it('persists conversation to JSONL and reloads across backend instances', async () => {
    const sessionsDir = freshSessionsDir();

    const agentA = new Agent({
      backend: openai({ model: MODEL, sessionsDir }),
    });
    let continuation: string | undefined;
    try {
      const q = agentA.run({
        message: 'Remember the magic number is 41. Reply with OK.',
      });
      const events = await collectEvents(q);
      continuation = continuationFromEvents(events);
      expect(continuation).toBeTypeOf('string');

      const jsonlPath = path.join(sessionsDir, `${continuation}.jsonl`);
      expect(fs.existsSync(jsonlPath)).toBe(true);
      const stored = readJsonlItems(jsonlPath);
      expect(stored.length).toBeGreaterThanOrEqual(2);
    } finally {
      await agentA.close();
    }

    const agentB = new Agent({
      backend: openai({ model: MODEL, sessionsDir }),
    });
    try {
      const q = agentB.run({
        message: 'What was the magic number? Reply with just the number.',
        ...(continuation !== undefined && { continuation }),
      });
      const events = await collectEvents(q);
      const text = assembledText(events);
      expect(text).toContain('41');
    } finally {
      await agentB.close();
    }
  }, 180_000);

  it('runs a hosted webSearch tool when included via hostedTools.webSearch()', async () => {
    const agent = new Agent({
      backend: openai({
        model: MODEL,
        tools: [hostedTools.webSearch()],
      }),
    });
    try {
      const query = agent.run({
        message:
          'Use web search to find any single recent news headline. Then briefly summarize what you found in under 30 words.',
      });
      const events = await collectEvents(query);

      // The hosted webSearch tool should have fired at least once and produced
      // a tool_call_end event with our canonical name.
      const calls = toolCalls(events);
      const searchCalls = calls.filter((c) => c.name === 'webSearch');
      expect(searchCalls.length).toBeGreaterThanOrEqual(1);

      const text = assembledText(events);
      expect(text.length).toBeGreaterThan(0);
    } finally {
      await agent.close();
    }
  }, 120_000);
});
