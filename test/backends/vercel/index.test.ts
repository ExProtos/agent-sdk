import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { TextStreamPart, ToolSet } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

import { VercelBackend, runSubAgent, translatePart, vercel } from '../../../src/backends/vercel/index';
import { readUIMessages } from '../../../src/persistence';
import * as builtin from '../../../src/tools/builtin';
import type { AgentEvent } from '../../../src/types';
import type { Tool } from '../../../src/tools/types';

// ── translatePart ──

function collect(part: TextStreamPart<ToolSet>): AgentEvent[] {
  const textBuf = new Map<string, string>();
  const reasoningBuf = new Map<string, string>();
  return [...translatePart(part, textBuf, reasoningBuf)];
}

describe('translatePart', () => {
  it('emits text_start on text-start', () => {
    expect(collect({ type: 'text-start', id: 't1' })).toEqual([{ type: 'text_start' }]);
  });

  it('emits text_delta on text-delta', () => {
    expect(collect({ type: 'text-delta', id: 't1', text: 'hello' })).toEqual([
      { type: 'text_delta', delta: 'hello' },
    ]);
  });

  it('accumulates text deltas and emits text_end with full text', () => {
    const textBuf = new Map<string, string>();
    const reasoningBuf = new Map<string, string>();
    [...translatePart({ type: 'text-start', id: 't1' }, textBuf, reasoningBuf)];
    [...translatePart({ type: 'text-delta', id: 't1', text: 'hello ' }, textBuf, reasoningBuf)];
    [...translatePart({ type: 'text-delta', id: 't1', text: 'world' }, textBuf, reasoningBuf)];
    const ends = [...translatePart({ type: 'text-end', id: 't1' }, textBuf, reasoningBuf)];
    expect(ends).toEqual([{ type: 'text_end', text: 'hello world' }]);
    // Buffer cleaned up.
    expect(textBuf.has('t1')).toBe(false);
  });

  it('emits text_end with empty text when no deltas seen', () => {
    expect(collect({ type: 'text-end', id: 'unknown' })).toEqual([{ type: 'text_end', text: '' }]);
  });

  it('tracks multiple concurrent text streams by id', () => {
    const textBuf = new Map<string, string>();
    const reasoningBuf = new Map<string, string>();
    [...translatePart({ type: 'text-start', id: 'a' }, textBuf, reasoningBuf)];
    [...translatePart({ type: 'text-start', id: 'b' }, textBuf, reasoningBuf)];
    [...translatePart({ type: 'text-delta', id: 'a', text: 'A' }, textBuf, reasoningBuf)];
    [...translatePart({ type: 'text-delta', id: 'b', text: 'B' }, textBuf, reasoningBuf)];
    expect([...translatePart({ type: 'text-end', id: 'a' }, textBuf, reasoningBuf)]).toEqual([
      { type: 'text_end', text: 'A' },
    ]);
    expect([...translatePart({ type: 'text-end', id: 'b' }, textBuf, reasoningBuf)]).toEqual([
      { type: 'text_end', text: 'B' },
    ]);
  });

  it('maps reasoning-* to thinking_*', () => {
    const textBuf = new Map<string, string>();
    const reasoningBuf = new Map<string, string>();
    [...translatePart({ type: 'reasoning-start', id: 'r1' }, textBuf, reasoningBuf)];
    [...translatePart({ type: 'reasoning-delta', id: 'r1', text: 'because' }, textBuf, reasoningBuf)];
    expect([...translatePart({ type: 'reasoning-end', id: 'r1' }, textBuf, reasoningBuf)]).toEqual([
      { type: 'thinking_end', text: 'because' },
    ]);
  });

  it('emits tool_call_start on tool-input-start', () => {
    expect(
      collect({ type: 'tool-input-start', id: 'tc1', toolName: 'bash' }),
    ).toEqual([{ type: 'tool_call_start', id: 'tc1', name: 'bash' }]);
  });

  it('emits tool_call_input_delta on tool-input-delta', () => {
    expect(collect({ type: 'tool-input-delta', id: 'tc1', delta: '{"cmd":' })).toEqual([
      { type: 'tool_call_input_delta', id: 'tc1', deltaJson: '{"cmd":' },
    ]);
  });

  it('emits no event on tool-input-end', () => {
    expect(collect({ type: 'tool-input-end', id: 'tc1' })).toEqual([]);
  });

  it('emits tool_call_end on tool-call', () => {
    expect(
      collect({
        type: 'tool-call',
        toolCallId: 'tc1',
        toolName: 'bash',
        input: { command: 'ls' },
      } as TextStreamPart<ToolSet>),
    ).toEqual([
      {
        type: 'tool_call_end',
        toolCall: { id: 'tc1', name: 'bash', input: { command: 'ls' } },
      },
    ]);
  });

  it('emits tool_result on tool-result', () => {
    expect(
      collect({
        type: 'tool-result',
        toolCallId: 'tc1',
        toolName: 'bash',
        input: { command: 'ls' },
        output: 'file1\nfile2',
      } as TextStreamPart<ToolSet>),
    ).toEqual([
      { type: 'tool_result', result: { toolCallId: 'tc1', output: 'file1\nfile2', isError: false } },
    ]);
  });

  it('emits tool_result with isError on tool-error', () => {
    const events = collect({
      type: 'tool-error',
      toolCallId: 'tc1',
      toolName: 'bash',
      input: { command: 'bad' },
      error: new Error('boom'),
    } as TextStreamPart<ToolSet>);
    expect(events).toEqual([
      {
        type: 'tool_result',
        result: { toolCallId: 'tc1', output: { error: 'boom' }, isError: true },
      },
    ]);
  });

  it('emits error on stream error', () => {
    expect(collect({ type: 'error', error: new Error('network down') })).toEqual([
      { type: 'error', message: 'network down', retryable: false },
    ]);
  });

  it('ignores stream-lifecycle and unsupported parts', () => {
    expect(collect({ type: 'start' })).toEqual([]);
    expect(
      collect({ type: 'start-step' } as TextStreamPart<ToolSet>),
    ).toEqual([]);
    expect(collect({ type: 'finish-step' } as TextStreamPart<ToolSet>)).toEqual([]);
    expect(collect({ type: 'finish' } as TextStreamPart<ToolSet>)).toEqual([]);
    expect(collect({ type: 'abort' })).toEqual([]);
    expect(collect({ type: 'raw', rawValue: {} })).toEqual([]);
  });
});

// ── VercelBackend constructor ──

function makeTool(name: string, opts: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({}),
    ...opts,
  } as Tool;
}

const echoModel = () =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'msg-1' },
        { type: 'text-delta', id: 'msg-1', delta: 'hi' },
        { type: 'text-end', id: 'msg-1' },
        {
          type: 'finish',
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
            totalTokens: 7,
          },
          finishReason: { unified: 'stop', raw: 'stop' },
        },
      ]),
    }),
  });

function freshSessionsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-sessions-'));
}

describe('VercelBackend constructor', () => {
  it('skips tools without execute', () => {
    const backend = new VercelBackend({
      model: echoModel(),
      sessionsDir: freshSessionsDir(),
      tools: [
        makeTool('with_exec', { execute: async () => 'ok' }),
        makeTool('no_exec'),
      ],
    });
    expect(backend.name).toBe('vercel');
  });

  it('vercel() factory returns a VercelBackend', () => {
    expect(vercel({ model: echoModel(), sessionsDir: freshSessionsDir() })).toBeInstanceOf(
      VercelBackend,
    );
  });
});

// ── query() lifecycle ──

async function drainEvents(backend: VercelBackend, message: string): Promise<AgentEvent[]> {
  const q = backend.query({ message });
  const events: AgentEvent[] = [];
  for await (const e of q.events) events.push(e);
  return events;
}

async function drainEvents2(
  backend: VercelBackend,
  message: string,
  continuation: string,
): Promise<AgentEvent[]> {
  const q = backend.query({ message, continuation });
  const events: AgentEvent[] = [];
  for await (const e of q.events) events.push(e);
  return events;
}

describe('VercelBackend.query', () => {
  it('emits session_start, text events, turn_end, session_end', async () => {
    const backend = vercel({ model: echoModel(), sessionsDir: freshSessionsDir() });
    const events = await drainEvents(backend, 'say hi');

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session_start');
    expect(types).toContain('text_start');
    expect(types).toContain('text_delta');
    expect(types).toContain('text_end');
    expect(types).toContain('turn_end');
    expect(types[types.length - 1]).toBe('session_end');

    // session_start should mint a continuation token.
    const start = events[0] as Extract<AgentEvent, { type: 'session_start' }>;
    expect(start.continuation).toMatch(/^[0-9a-f-]{36}$/);

    // session_end should carry usage from the finish part.
    const end = events[events.length - 1] as Extract<AgentEvent, { type: 'session_end' }>;
    expect(end.usage.input).toBe(5);
    expect(end.usage.output).toBe(2);
    expect(end.stopReason).toBe('stop');
  });

  it('reuses continuation across queries to grow message history', async () => {
    const backend = vercel({ model: echoModel(), sessionsDir: freshSessionsDir() });

    const first = await drainEvents(backend, 'first turn');
    const continuation = (first[0] as Extract<AgentEvent, { type: 'session_start' }>)
      .continuation;

    const second: AgentEvent[] = [];
    for await (const e of backend.query({ message: 'second turn', continuation }).events) {
      second.push(e);
    }
    const secondStart = second[0] as Extract<AgentEvent, { type: 'session_start' }>;
    expect(secondStart.continuation).toBe(continuation);
  });

  it('writes a JSONL file under sessionsDir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-jsonl-'));
    const backend = vercel({ model: echoModel(), sessionsDir: dir });

    const events = await drainEvents(backend, 'hi there');
    const continuation = (events[0] as Extract<AgentEvent, { type: 'session_start' }>)
      .continuation;

    const messages = readUIMessages(path.join(dir, `${continuation}.jsonl`));
    // First line is the user message; subsequent lines are assistant message(s).
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.parts).toEqual([{ type: 'text', text: 'hi there' }]);
    expect(messages[1]!.role).toBe('assistant');
  });

  it('reloads history from disk on cache-miss', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-reload-'));

    // First "process": run a query, capture continuation, JSONL gets written.
    const backendA = vercel({ model: echoModel(), sessionsDir: dir });
    const eventsA = await drainEvents(backendA, 'first turn');
    const continuation = (eventsA[0] as Extract<AgentEvent, { type: 'session_start' }>)
      .continuation;
    const filePath = path.join(dir, `${continuation}.jsonl`);
    const fileSizeBefore = fs.statSync(filePath).size;

    // Second "process": new backend instance (empty in-memory cache),
    // resume against the same continuation. Reload happens via JSONL.
    const backendB = vercel({ model: echoModel(), sessionsDir: dir });
    await drainEvents2(backendB, 'second turn', continuation);

    const fileSizeAfter = fs.statSync(filePath).size;
    expect(fileSizeAfter).toBeGreaterThan(fileSizeBefore);

    const all = readUIMessages(filePath);
    const userTexts = all
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text'))
      .map((p) => p.text);
    expect(userTexts).toEqual(['first turn', 'second turn']);
  });

  it('aborts cleanly and reports stopReason=aborted', async () => {
    // Use a model that emits one part then hangs on the next, so abort lands
    // mid-stream.
    const hangingModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'm' });
            controller.enqueue({ type: 'text-delta', id: 'm', delta: 'partial' });
            // Never close — let abort interrupt.
            await new Promise(() => {});
          },
        }),
      }),
    });
    const backend = vercel({ model: hangingModel, sessionsDir: freshSessionsDir() });
    const q = backend.query({ message: 'go' });

    const events: AgentEvent[] = [];
    const iter = q.events[Symbol.asyncIterator]();
    // Read the first few events to ensure the stream is running.
    for (let i = 0; i < 3; i++) {
      const { value, done } = await iter.next();
      if (done) break;
      events.push(value);
    }
    q.abort();
    // Drain remaining.
    while (true) {
      const { value, done } = await iter.next();
      if (done) break;
      events.push(value);
    }

    const last = events[events.length - 1] as Extract<AgentEvent, { type: 'session_end' }>;
    expect(last.type).toBe('session_end');
    expect(last.stopReason).toBe('aborted');
  });
});

// ── runSubAgent ──

const subAgentReplyModel = (replyText: string) =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sub-1' },
        { type: 'text-delta', id: 'sub-1', delta: replyText },
        { type: 'text-end', id: 'sub-1' },
        {
          type: 'finish',
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 4, text: 4, reasoning: 0 },
            totalTokens: 7,
          },
          finishReason: { unified: 'stop', raw: 'stop' },
        },
      ]),
    }),
  });

describe('runSubAgent', () => {
  it('runs a single-turn nested generation and returns the final text', async () => {
    const text = await runSubAgent(
      { description: 'echo', prompt: 'say sub', subagent_type: 'general-purpose' },
      subAgentReplyModel('sub answer'),
      () => [],
      {},
    );
    expect(text).toBe('sub answer');
  });

  it('rejects the Codex multi-step form with a clear error', async () => {
    await expect(
      runSubAgent(
        { tool: 'spawnAgent', prompt: 'x' },
        subAgentReplyModel('unused'),
        () => [],
        {},
      ),
    ).rejects.toThrow(/Codex multi-step form is not supported/);
  });

  it('rejects input missing a prompt string', async () => {
    await expect(
      runSubAgent({ description: 'no prompt' }, subAgentReplyModel('unused'), () => [], {}),
    ).rejects.toThrow();
  });

  it('passes subagent_type to the tool-selector callback', async () => {
    const seen: string[] = [];
    await runSubAgent(
      { description: 'd', prompt: 'p', subagent_type: 'researcher' },
      subAgentReplyModel('ok'),
      (st) => {
        seen.push(st);
        return [];
      },
      {},
    );
    expect(seen).toEqual(['researcher']);
  });

  it('skips Tool[] entries lacking execute()', async () => {
    const calledWith: string[] = [];
    const noExec: Tool = {
      name: 'no_exec',
      description: 'n',
      schema: z.object({}),
    };
    const withExec: Tool = {
      name: 'with_exec',
      description: 'w',
      schema: z.object({}),
      execute: async () => {
        calledWith.push('called');
        return 'ok';
      },
    };
    await runSubAgent(
      { description: 'd', prompt: 'p' },
      subAgentReplyModel('done'),
      () => [noExec, withExec],
      {},
    );
    // Both tools were available to construct the ToolSet, but the model
    // didn't call them in this test. The point is constructor doesn't crash
    // on the no-exec tool.
    expect(calledWith).toEqual([]);
  });
});

// ── Backend wiring of the task tool ──

describe('VercelBackend task tool wiring', () => {
  it('strips task from default sub-agent toolset', () => {
    const dir = freshSessionsDir();
    // Construction with task in the catalog should not throw.
    const backend = vercel({
      model: subAgentReplyModel('ok'),
      sessionsDir: dir,
      tools: [builtin.task, builtin.bash, builtin.read],
    });
    expect(backend.name).toBe('vercel');
  });

  it('honors a caller-supplied subagentTools callback', () => {
    const dir = freshSessionsDir();
    const calls: string[] = [];
    const backend = vercel({
      model: subAgentReplyModel('ok'),
      sessionsDir: dir,
      tools: [builtin.task, builtin.bash, builtin.read, builtin.glob],
      subagentTools: (st) => {
        calls.push(st);
        return [builtin.read];
      },
    });
    // Construction-time wiring registers the callback; it isn't called
    // until task is invoked at runtime. Just verify backend constructs.
    expect(backend.name).toBe('vercel');
    expect(calls).toEqual([]);
  });
});
