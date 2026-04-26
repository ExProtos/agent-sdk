/**
 * End-to-end tests against the Vercel AI SDK backend, wired to Anthropic
 * via @ai-sdk/anthropic. Reuses the same auth detection as the Claude
 * backend e2e (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY) so the
 * skip semantics are uniform.
 *
 * The backend itself is provider-agnostic — the choice of @ai-sdk/anthropic
 * here is purely so we can reuse existing CI credentials. Other providers
 * (@ai-sdk/openai, @ai-sdk/openai-compatible at an Ollama endpoint) work
 * identically; not exercised here only to keep CI requirements minimal.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { anthropic } from '@ai-sdk/anthropic';

import { Agent, vercel, tools, readUIMessages } from '../../src/index';
import {
  assembledText,
  collectEvents,
  continuationFromEvents,
  hasAnthropicApiKey,
  toolCalls,
} from './helpers';

const MODEL = 'claude-haiku-4-5';

function freshSessionsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-e2e-'));
}

describe.skipIf(!hasAnthropicApiKey)('Vercel end-to-end (via @ai-sdk/anthropic)', () => {
  it('completes a trivial query and emits a coherent event sequence', async () => {
    const agent = new Agent({
      backend: vercel({
        model: anthropic(MODEL),
        sessionsDir: freshSessionsDir(),
      }),
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

  it('fires tool_call_end with canonical name when the model uses bash', async () => {
    const agent = new Agent({
      backend: vercel({
        model: anthropic(MODEL),
        sessionsDir: freshSessionsDir(),
        tools: [tools.bash],
      }),
    });
    try {
      const query = agent.run({
        message:
          'Use the bash tool to run exactly: echo hello-from-bash. Then reply with exactly DONE.',
      });
      const events = await collectEvents(query);

      const calls = toolCalls(events);
      const bashCalls = calls.filter((c) => c.name === 'bash');
      expect(bashCalls.length).toBeGreaterThanOrEqual(1);

      // The in-process bash impl ran; tool_result must be present.
      const result = events.find((e) => e.type === 'tool_result');
      expect(result).toBeDefined();
    } finally {
      await agent.close();
    }
  }, 90_000);

  it('resumes a thread across two queries via continuation (in-memory cache)', async () => {
    const agent = new Agent({
      backend: vercel({
        model: anthropic(MODEL),
        sessionsDir: freshSessionsDir(),
      }),
    });
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
  }, 120_000);

  it('reloads history from JSONL on a fresh backend instance (cross-restart resume)', async () => {
    const sessionsDir = freshSessionsDir();

    // First "process": run a query, capture continuation, JSONL gets written.
    const agentA = new Agent({
      backend: vercel({ model: anthropic(MODEL), sessionsDir }),
    });
    let continuation: string | undefined;
    try {
      const q = agentA.run({
        message: 'Remember the magic number is 23. Reply with OK.',
      });
      const events = await collectEvents(q);
      continuation = continuationFromEvents(events);
      expect(continuation).toBeTypeOf('string');

      // Verify the JSONL exists and has at least the user + assistant messages.
      const jsonlPath = path.join(sessionsDir, `${continuation}.jsonl`);
      const stored = readUIMessages(jsonlPath);
      expect(stored.length).toBeGreaterThanOrEqual(2);
      expect(stored[0]!.role).toBe('user');
    } finally {
      await agentA.close();
    }

    // Second "process": fresh Agent + fresh VercelBackend (empty in-memory
    // cache). Resume against the same continuation. Reload happens via JSONL.
    const agentB = new Agent({
      backend: vercel({ model: anthropic(MODEL), sessionsDir }),
    });
    try {
      const q = agentB.run({
        message: 'What was the magic number? Reply with just the number.',
        ...(continuation !== undefined && { continuation }),
      });
      const events = await collectEvents(q);
      const text = assembledText(events);
      expect(text).toContain('23');
    } finally {
      await agentB.close();
    }
  }, 180_000);
});

