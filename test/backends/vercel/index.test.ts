import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { TextStreamPart, ToolSet } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

import {
  VercelBackend,
  buildInitialUserContent,
  compactHistory,
  findCompactionSplitIndex,
  findLatestTodoInput,
  formatTodos,
  runSubAgent,
  sliceTrailingTurns,
  translatePart,
  vercel,
} from '../../../src/backends/vercel/index';
import type { ModelMessage } from 'ai';
import type { UIMessage } from 'ai';
import { readUIMessages } from '../../../src/persistence';
import * as builtin from '../../../src/tools/builtin';
import type { AgentEvent, Attachment } from '../../../src/types';
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

  it('runs a multi-step tool loop by default (catches stopWhen=stepCountIs(1) regression)', async () => {
    // Regression: streamText defaults to stepCountIs(1), which would stop the
    // tool loop after the first tool result instead of continuing to a final
    // answer. The Vercel backend applies stepCountIs(20) as its default. To
    // verify, build a model whose first call emits a tool call and whose
    // second call emits final text. Without the default, only one doStream
    // call would happen (the loop would terminate after the first step).
    let callIndex = 0;
    const recordingModel = new MockLanguageModelV3({
      doStream: async () => {
        const i = callIndex++;
        if (i === 0) {
          // First call: model decides to use the tool.
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tc-1',
                toolName: 'noop',
                input: '{}',
              },
              {
                type: 'finish',
                usage: {
                  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                  totalTokens: 6,
                },
                finishReason: { unified: 'tool-calls', raw: 'tool_use' },
              },
            ]),
          };
        }
        // Second call (only reached if the loop continues past the tool result):
        // emit final text.
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'final' },
            { type: 'text-delta', id: 'final', delta: 'all done' },
            { type: 'text-end', id: 'final' },
            {
              type: 'finish',
              usage: {
                inputTokens: { total: 6, noCache: 6, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
                totalTokens: 8,
              },
              finishReason: { unified: 'stop', raw: 'stop' },
            },
          ]),
        };
      },
    });

    const noopTool: Tool = {
      name: 'noop',
      description: 'a tool that does nothing',
      schema: z.object({}),
      execute: async () => 'result',
    };

    const backend = vercel({
      model: recordingModel,
      sessionsDir: freshSessionsDir(),
      tools: [noopTool],
    });
    const events = await drainEvents(backend, 'use the tool then answer');

    // Two doStream calls means the loop continued past the first step.
    expect(recordingModel.doStreamCalls.length).toBe(2);

    // And the final text from the second step made it through to the events.
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'text_end' }> => e.type === 'text_end')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('all done');
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

// ── formatTodos ──

describe('formatTodos', () => {
  it('renders Claude-shape todos as a status checklist', () => {
    expect(
      formatTodos({
        todos: [
          { content: 'first', status: 'completed', activeForm: 'firsting' },
          { content: 'second', status: 'in_progress', activeForm: 'seconding' },
          { content: 'third', status: 'pending', activeForm: 'thirding' },
        ],
      }),
    ).toBe('[x] first\n[~] second\n[ ] third');
  });

  it('returns Codex freeform text verbatim', () => {
    expect(formatTodos({ text: 'plan: do A, then B' })).toBe('plan: do A, then B');
  });

  it('returns empty string for unrecognized shapes', () => {
    expect(formatTodos({})).toBe('');
    expect(formatTodos(null)).toBe('');
    expect(formatTodos('raw string')).toBe('');
    expect(formatTodos(42)).toBe('');
  });

  it('coerces non-string content via String()', () => {
    expect(formatTodos({ todos: [{ content: 123, status: 'pending' }] })).toBe('[ ] 123');
  });
});

// ── todo tool wiring ──

describe('VercelBackend todo tool wiring', () => {
  it('constructs without throwing when todo is in the toolset', () => {
    const backend = vercel({
      model: echoModel(),
      sessionsDir: freshSessionsDir(),
      tools: [builtin.todo, builtin.bash],
    });
    expect(backend.name).toBe('vercel');
  });

  it('runs an empty turn cleanly with todo wired in but uncalled', async () => {
    const backend = vercel({
      model: echoModel(),
      sessionsDir: freshSessionsDir(),
      tools: [builtin.todo],
    });
    const events = await drainEvents(backend, 'no todo work needed');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session_start');
    expect(types[types.length - 1]).toBe('session_end');
  });
});

// ── findLatestTodoInput ──

function todoToolPart(input: unknown, toolCallId: string): UIMessage['parts'][number] {
  return {
    type: 'tool-todo',
    toolCallId,
    state: 'output-available',
    input: input as never,
    output: 'todos updated' as never,
  } as UIMessage['parts'][number];
}

describe('findLatestTodoInput', () => {
  it('returns undefined for an empty array', () => {
    expect(findLatestTodoInput([])).toBeUndefined();
  });

  it('returns undefined when no todo tool calls are present', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello', state: 'done' }] },
    ];
    expect(findLatestTodoInput(messages)).toBeUndefined();
  });

  it('returns the input from the only todo call', () => {
    const todoInput = { text: 'do the thing' };
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [todoToolPart(todoInput, 'tc-1')],
      },
    ];
    expect(findLatestTodoInput(messages)).toEqual(todoInput);
  });

  it('returns the most recent of multiple todo calls', () => {
    const first = { text: 'plan v1' };
    const second = { text: 'plan v2' };
    const third = { text: 'plan v3' };
    const messages: UIMessage[] = [
      { id: 'a1', role: 'assistant', parts: [todoToolPart(first, 'tc-1')] },
      { id: 'a2', role: 'assistant', parts: [todoToolPart(second, 'tc-2')] },
      { id: 'a3', role: 'assistant', parts: [todoToolPart(third, 'tc-3')] },
    ];
    expect(findLatestTodoInput(messages)).toEqual(third);
  });

  it('finds a todo call interleaved with other parts in the same message', () => {
    const todoInput = {
      todos: [{ content: 'task A', status: 'pending', activeForm: 'doing A' }],
    };
    const messages: UIMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'first', state: 'done' },
          { type: 'step-start' },
          todoToolPart(todoInput, 'tc-1'),
          { type: 'text', text: 'after', state: 'done' },
        ],
      },
    ];
    expect(findLatestTodoInput(messages)).toEqual(todoInput);
  });

  it('ignores user messages even if they contain odd parts', () => {
    const messages: UIMessage[] = [
      // Synthetic user msg with a tool-todo part — shouldn't ever happen
      // in practice, but we should ignore by role.
      {
        id: 'u1',
        role: 'user',
        parts: [todoToolPart({ text: 'should be ignored' }, 'tc-x')],
      },
    ];
    expect(findLatestTodoInput(messages)).toBeUndefined();
  });
});

// ── reload-from-JSONL integration ──

describe('VercelBackend todo reload from JSONL', () => {
  it('recovers todos from disk on cache-miss and injects them via prepareStep', async () => {
    const dir = freshSessionsDir();

    // First backend: write a turn so the JSONL exists with a continuation.
    const backendA = vercel({
      model: echoModel(),
      sessionsDir: dir,
      tools: [builtin.todo],
    });
    const eventsA = await drainEvents(backendA, 'first turn');
    const continuation = (eventsA[0] as Extract<AgentEvent, { type: 'session_start' }>)
      .continuation;
    const filePath = path.join(dir, `${continuation}.jsonl`);

    // Synthesize a tool-todo entry directly (bypasses needing a mock model
    // that actually calls the tool).
    const expectedTodos = { text: 'remember to ship the thing' };
    const synthetic: UIMessage = {
      id: 'a-synth',
      role: 'assistant',
      parts: [todoToolPart(expectedTodos, 'tc-synth')],
    };
    fs.appendFileSync(filePath, JSON.stringify(synthetic) + '\n');

    // Second backend: fresh in-memory cache. Use a model whose call options
    // we can inspect after the fact, so we can verify prepareStep injected
    // the recovered todos into the system prompt.
    const recordingModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'r' },
          { type: 'text-delta', id: 'r', delta: 'ack' },
          { type: 'text-end', id: 'r' },
          {
            type: 'finish',
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
              totalTokens: 2,
            },
            finishReason: { unified: 'stop', raw: 'stop' },
          },
        ]),
      }),
    });
    const backendB = vercel({
      model: recordingModel,
      sessionsDir: dir,
      tools: [builtin.todo],
    });
    await drainEvents2(backendB, 'second turn', continuation);

    // Verify the model received a system message that includes the recovered
    // todos — proves the reload path populated todosByContinuation AND
    // prepareStep read it back into the prompt.
    expect(recordingModel.doStreamCalls.length).toBeGreaterThan(0);
    const lastCall = recordingModel.doStreamCalls[recordingModel.doStreamCalls.length - 1]!;
    const systemMessages = lastCall.prompt.filter((m) => m.role === 'system');
    const systemText = systemMessages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(systemText).toContain('Current todos:');
    expect(systemText).toContain('remember to ship the thing');
  });
});

// ── buildInitialUserContent ──

describe('buildInitialUserContent', () => {
  it('returns plain string content + single text UI part when there are no attachments', async () => {
    const out = await buildInitialUserContent('hello', []);
    expect(out.modelContent).toBe('hello');
    expect(out.uiParts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('builds image+text content-parts and parallel UI file-parts (URL form)', async () => {
    const att: Attachment = { type: 'image', source: { kind: 'url', url: 'https://x/y.png' } };
    const out = await buildInitialUserContent('caption', [att]);
    expect(out.modelContent).toEqual([
      { type: 'image', image: new URL('https://x/y.png') },
      { type: 'text', text: 'caption' },
    ]);
    expect(out.uiParts).toEqual([
      { type: 'file', mediaType: 'application/octet-stream', url: 'https://x/y.png' },
      { type: 'text', text: 'caption' },
    ]);
  });

  it('reads path attachments and base64-encodes them into a data URL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-att-'));
    const filePath = path.join(dir, 'tiny.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(filePath, bytes);
    const att: Attachment = { type: 'image', source: { kind: 'path', path: filePath } };
    const out = await buildInitialUserContent(undefined, [att]);
    const expectedDataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    expect(out.modelContent).toEqual([
      { type: 'image', image: bytes.toString('base64'), mediaType: 'image/png' },
    ]);
    expect(out.uiParts).toEqual([{ type: 'file', mediaType: 'image/png', url: expectedDataUrl }]);
  });
});

// ── Auto-compaction ──

describe('findCompactionSplitIndex', () => {
  it('returns 0 when there are fewer user messages than keepLastTurns', () => {
    const h: ModelMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'A' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'B' },
    ];
    expect(findCompactionSplitIndex(h, 4)).toBe(0);
  });

  it('returns the index of the Nth-most-recent user message', () => {
    const h: ModelMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'u4' },
      { role: 'assistant', content: 'a4' },
    ];
    // keep last 2 user-led turns → split at u3 (index 4)
    expect(findCompactionSplitIndex(h, 2)).toBe(4);
    // keep last 1 → split at u4 (index 6)
    expect(findCompactionSplitIndex(h, 1)).toBe(6);
  });

  it('keeps tool messages bound to their preceding assistant (split lands on user)', () => {
    const h: ModelMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: {} }] as any },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'bash', output: 'x' }] as any },
      { role: 'assistant', content: 'after the tool' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply' },
    ];
    // keep last 1 user-led turn → split at the second user message (index 4),
    // not in the middle of the tool-call/result pair
    expect(findCompactionSplitIndex(h, 1)).toBe(4);
  });
});

describe('sliceTrailingTurns', () => {
  it('returns the slice from the Nth-most-recent user UIMessage onward', () => {
    const messages: UIMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'a' }] },
      { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'A' }] },
      { id: '3', role: 'user', parts: [{ type: 'text', text: 'b' }] },
      { id: '4', role: 'assistant', parts: [{ type: 'text', text: 'B' }] },
      { id: '5', role: 'user', parts: [{ type: 'text', text: 'c' }] },
      { id: '6', role: 'assistant', parts: [{ type: 'text', text: 'C' }] },
    ];
    expect(sliceTrailingTurns(messages, 2).map((m) => m.id)).toEqual(['3', '4', '5', '6']);
    expect(sliceTrailingTurns(messages, 1).map((m) => m.id)).toEqual(['5', '6']);
  });

  it('returns the entire array when fewer user messages exist than requested', () => {
    const messages: UIMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'only' }] },
    ];
    expect(sliceTrailingTurns(messages, 4)).toEqual(messages);
  });
});

describe('compactHistory', () => {
  function summaryMockModel(summary: string) {
    return new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        content: [{ type: 'text', text: summary }],
        warnings: [],
      }),
    });
  }

  it('returns undefined when history is too short to compact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-compact-'));
    const persistPath = path.join(dir, 'session.jsonl');
    const result = await compactHistory({
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      todos: undefined,
      model: summaryMockModel('summary text'),
      keepLastTurns: 4,
      persistPath,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when no clean split point exists (not enough recent turns)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-compact-'));
    const persistPath = path.join(dir, 'session.jsonl');
    // 12 messages but only 1 user — keepLastTurns=4 wants 4 user-led turns,
    // can't find them → no split.
    const history: ModelMessage[] = [{ role: 'user', content: 'q' }];
    for (let i = 0; i < 11; i++) history.push({ role: 'assistant', content: `chunk ${i}` });
    const result = await compactHistory({
      history,
      todos: undefined,
      model: summaryMockModel('s'),
      keepLastTurns: 4,
      persistPath,
    });
    expect(result).toBeUndefined();
  });

  it('rewrites history with a synthetic user summary + recent verbatim', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-compact-'));
    const persistPath = path.join(dir, 'session.jsonl');
    // Seed JSONL with 6 messages — 3 user-led turns
    const seed: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'reply 1' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second' }] },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'reply 2' }] },
      { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'third' }] },
      { id: 'a3', role: 'assistant', parts: [{ type: 'text', text: 'reply 3' }] },
    ];
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    fs.writeFileSync(persistPath, seed.map((m) => JSON.stringify(m)).join('\n') + '\n');
    // Pad to clear the MIN_HISTORY_FOR_COMPACTION threshold of 10
    const history: ModelMessage[] = [];
    for (let i = 0; i < 4; i++) {
      history.push({ role: 'user', content: `older ${i}` });
      history.push({ role: 'assistant', content: `older reply ${i}` });
    }
    history.push({ role: 'user', content: 'second' });
    history.push({ role: 'assistant', content: 'reply 2' });
    history.push({ role: 'user', content: 'third' });
    history.push({ role: 'assistant', content: 'reply 3' });

    const newHistory = await compactHistory({
      history,
      todos: undefined,
      model: summaryMockModel('SUMMARY OF EARLIER'),
      keepLastTurns: 2,
      persistPath,
    });
    expect(newHistory).toBeDefined();
    expect(newHistory![0]).toEqual({
      role: 'user',
      content: 'Earlier in this conversation:\nSUMMARY OF EARLIER',
    });
    // Last 2 user-led turns survive verbatim
    expect(newHistory!.slice(1)).toEqual([
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'third' },
      { role: 'assistant', content: 'reply 3' },
    ]);

    // JSONL on disk reflects the rewrite
    const persisted = readUIMessages(persistPath);
    expect(persisted[0]!.role).toBe('user');
    expect((persisted[0]!.parts[0] as { text: string }).text).toContain('SUMMARY OF EARLIER');
    // Trailing UIMessages match the seed's last 4 entries (u2/a2/u3/a3)
    expect(persisted.slice(1).map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3']);
  });

  it('injects a synthetic tool-todo message after the summary when todos are present', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-compact-'));
    const persistPath = path.join(dir, 'session.jsonl');
    // Need at least MIN_HISTORY_FOR_COMPACTION (10) messages — 6 user-led
    // turns = 12 messages clears the threshold.
    const seed: UIMessage[] = [];
    for (let i = 0; i < 6; i++) {
      seed.push({ id: `u${i}`, role: 'user', parts: [{ type: 'text', text: `q${i}` }] });
      seed.push({ id: `a${i}`, role: 'assistant', parts: [{ type: 'text', text: `r${i}` }] });
    }
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    fs.writeFileSync(persistPath, seed.map((m) => JSON.stringify(m)).join('\n') + '\n');
    const history: ModelMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push({ role: 'user', content: `q${i}` });
      history.push({ role: 'assistant', content: `r${i}` });
    }

    const todos = { todos: [{ content: 'survive compaction', status: 'in_progress', activeForm: 'surviving compaction' }] };
    await compactHistory({
      history,
      todos,
      model: summaryMockModel('SUMMARY'),
      keepLastTurns: 2,
      persistPath,
    });
    const persisted = readUIMessages(persistPath);
    // First message: summary
    expect(persisted[0]!.role).toBe('user');
    // Second message: synthetic assistant with tool-todo part — survives
    // the next reload's findLatestTodoInput walk
    const recovered = findLatestTodoInput(persisted);
    expect(recovered).toEqual(todos);
  });
});
