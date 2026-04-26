import { describe, expect, it } from 'vitest';
import {
  CodexBackend,
  EventQueue,
  attachmentToCodexInput,
  buildCodexConfig,
  codex,
  translateItem,
  translateNotification,
} from '../../../src/backends/codex/index';
import type { Attachment } from '../../../src/types';
import type { ThreadItem } from '../../../src/backends/codex/protocol';
import type { AgentEvent } from '../../../src/types';

// ── EventQueue ──

describe('EventQueue', () => {
  it('yields items pushed before iter() starts', async () => {
    const q = new EventQueue();
    q.push({ type: 'activity' });
    q.push({ type: 'text_end', text: 'hi' });
    q.end();

    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);

    expect(events).toEqual([{ type: 'activity' }, { type: 'text_end', text: 'hi' }]);
  });

  it('returns from iter() after end() with no items', async () => {
    const q = new EventQueue();
    q.end();

    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);

    expect(events).toEqual([]);
  });

  it('drains queue then exits when end() is called between pushes', async () => {
    const q = new EventQueue();
    q.push({ type: 'text_end', text: 'a' });
    q.push({ type: 'text_end', text: 'b' });
    q.end();
    q.push({ type: 'text_end', text: 'c' }); // dropped — already ended

    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);

    expect(events.map((e) => (e.type === 'text_end' ? e.text : ''))).toEqual(['a', 'b']);
  });

  it('wakes the consumer when push() arrives mid-iteration', async () => {
    const q = new EventQueue();
    const collected: AgentEvent[] = [];

    const consumer = (async () => {
      for await (const ev of q.iter()) {
        collected.push(ev);
        if (collected.length === 2) q.end();
      }
    })();

    q.push({ type: 'activity' });
    await new Promise((r) => setTimeout(r, 5));
    q.push({ type: 'text_end', text: 'mid' });
    await consumer;

    expect(collected).toEqual([{ type: 'activity' }, { type: 'text_end', text: 'mid' }]);
  });

  it('fires onEnd handlers when end() is called', () => {
    const q = new EventQueue();
    let called = 0;
    q.onEnd(() => {
      called++;
    });
    q.end();

    expect(called).toBe(1);
  });

  it('fires onEnd handlers immediately when registered after end()', () => {
    const q = new EventQueue();
    q.end();

    let called = 0;
    q.onEnd(() => {
      called++;
    });

    expect(called).toBe(1);
  });

  it('multiple end() calls are idempotent', () => {
    const q = new EventQueue();
    let called = 0;
    q.onEnd(() => {
      called++;
    });
    q.end();
    q.end();
    q.end();

    expect(called).toBe(1);
  });

  it('a throwing onEnd handler does not prevent others from running', () => {
    const q = new EventQueue();
    let secondRan = false;
    q.onEnd(() => {
      throw new Error('boom');
    });
    q.onEnd(() => {
      secondRan = true;
    });

    q.end();

    expect(secondRan).toBe(true);
  });
});

// ── translateItem ──

describe('translateItem', () => {
  function collect(item: ThreadItem): AgentEvent[] {
    const q = new EventQueue();
    translateItem(item, q);
    q.end();
    const events: AgentEvent[] = [];
    // Synchronously drain the internal items via the iter()'s eager phase.
    // Since end() was called and items are already there, this completes immediately.
    return (async () => {
      for await (const ev of q.iter()) events.push(ev);
      return events;
    })() as unknown as AgentEvent[]; // hack: see below
  }

  // Helper that actually awaits the queue.
  async function collectAsync(item: ThreadItem): Promise<AgentEvent[]> {
    const q = new EventQueue();
    translateItem(item, q);
    q.end();
    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);
    return events;
  }

  it('emits text_end for agentMessage items', async () => {
    const events = await collectAsync({ type: 'agentMessage', id: 'i1', text: 'hello' });
    expect(events).toEqual([{ type: 'text_end', text: 'hello' }]);
    void collect;
  });

  it('emits thinking_end with summary + content joined for reasoning items', async () => {
    const events = await collectAsync({
      type: 'reasoning',
      id: 'r1',
      summary: ['First, I will…'],
      content: ['Detailed reasoning here.'],
    });

    expect(events).toEqual([
      { type: 'thinking_end', text: 'First, I will…\nDetailed reasoning here.' },
    ]);
  });

  it('emits tool_call_end + tool_result for commandExecution', async () => {
    const events = await collectAsync({
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'ls -la',
      aggregatedOutput: 'file1\nfile2',
      exitCode: 0,
    });

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: { id: 'cmd-1', name: 'bash', input: { command: 'ls -la' } },
      },
      {
        type: 'tool_result',
        result: { toolCallId: 'cmd-1', output: 'file1\nfile2', isError: false },
      },
    ]);
  });

  it('marks commandExecution with non-zero exitCode as error', async () => {
    const events = await collectAsync({
      type: 'commandExecution',
      id: 'cmd-2',
      command: 'false',
      aggregatedOutput: '',
      exitCode: 1,
    });

    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ result: { isError: true } });
  });

  it('preserves null aggregatedOutput as empty string', async () => {
    const events = await collectAsync({
      type: 'commandExecution',
      id: 'cmd-3',
      command: 'pending',
      aggregatedOutput: null,
      exitCode: null,
    });

    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ result: { output: '' } });
  });

  it('emits tool_call_end + tool_result for completed fileChange items', async () => {
    const changes = [{ path: 'src/x.ts', kind: 'modify', diff: '@@ -1 +1 @@\n-a\n+b\n' }];
    const events = await collectAsync({
      type: 'fileChange',
      id: 'fc-1',
      changes,
      status: 'completed',
    });

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: { id: 'fc-1', name: 'edit', input: { changes } },
      },
      {
        type: 'tool_result',
        result: { toolCallId: 'fc-1', output: { status: 'completed', changes }, isError: false },
      },
    ]);
  });

  it('marks fileChange tool_result as error when status is failed', async () => {
    const events = await collectAsync({
      type: 'fileChange',
      id: 'fc-2',
      changes: [],
      status: 'failed',
    });

    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      result: { isError: true },
    });
  });

  it('marks fileChange tool_result as error when status is declined', async () => {
    const events = await collectAsync({
      type: 'fileChange',
      id: 'fc-3',
      changes: [],
      status: 'declined',
    });

    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      result: { isError: true },
    });
  });

  it('emits only tool_call_end for in-progress fileChange items', async () => {
    const events = await collectAsync({
      type: 'fileChange',
      id: 'fc-4',
      changes: [{ path: 'a.ts', kind: 'modify', diff: '...' }],
      status: 'inProgress',
    });

    expect(events.map((e) => e.type)).toEqual(['tool_call_end']);
  });

  it('emits tool_call_end + tool_result for mcpToolCall', async () => {
    const events = await collectAsync({
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'srv',
      tool: 'fetch',
      arguments: { url: 'https://example.com' },
      result: { ok: true },
      error: null,
    });

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: { id: 'mcp-1', name: 'fetch', input: { url: 'https://example.com' } },
      },
      {
        type: 'tool_result',
        result: { toolCallId: 'mcp-1', output: { ok: true }, isError: false },
      },
    ]);
  });

  it('emits tool_call_end only when mcpToolCall has neither result nor error', async () => {
    const events = await collectAsync({
      type: 'mcpToolCall',
      id: 'mcp-2',
      server: 'srv',
      tool: 'fetch',
      arguments: {},
      result: undefined,
      error: undefined,
    } as unknown as ThreadItem);

    expect(events.map((e) => e.type)).toEqual(['tool_call_end']);
  });

  it('marks mcpToolCall with error as isError=true', async () => {
    const events = await collectAsync({
      type: 'mcpToolCall',
      id: 'mcp-3',
      server: 'srv',
      tool: 'fetch',
      arguments: {},
      result: null,
      error: { message: 'failed' },
    });

    expect(events[1]).toMatchObject({ type: 'tool_result', result: { isError: true } });
  });

  it('emits tool_call_end + tool_result for completed collabAgentToolCall', async () => {
    const events = await collectAsync({
      type: 'collabAgentToolCall',
      id: 'collab-1',
      tool: 'spawnAgent',
      prompt: 'Investigate this',
      model: 'gpt-5',
      reasoningEffort: null,
      receiverThreadIds: ['child-thread-1'],
      senderThreadId: 'parent-thread-0',
      status: 'completed',
      agentsStates: { 'child-thread-1': { status: 'completed', message: 'done' } },
    });

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: {
          id: 'collab-1',
          name: 'task',
          input: {
            tool: 'spawnAgent',
            receiverThreadIds: ['child-thread-1'],
            prompt: 'Investigate this',
            model: 'gpt-5',
          },
        },
      },
      {
        type: 'tool_result',
        result: {
          toolCallId: 'collab-1',
          output: {
            status: 'completed',
            agentsStates: { 'child-thread-1': { status: 'completed', message: 'done' } },
          },
          isError: false,
        },
      },
    ]);
  });

  it('omits prompt and model from input when null', async () => {
    const events = await collectAsync({
      type: 'collabAgentToolCall',
      id: 'collab-2',
      tool: 'wait',
      prompt: null,
      model: null,
      reasoningEffort: null,
      receiverThreadIds: ['child'],
      senderThreadId: 'parent',
      status: 'inProgress',
      agentsStates: {},
    });

    const call = events[0] as { toolCall: { input: Record<string, unknown> } };
    expect(call.toolCall.input).toEqual({ tool: 'wait', receiverThreadIds: ['child'] });
  });

  it('marks collabAgentToolCall tool_result as error when status=failed', async () => {
    const events = await collectAsync({
      type: 'collabAgentToolCall',
      id: 'collab-3',
      tool: 'spawnAgent',
      prompt: null,
      model: null,
      reasoningEffort: null,
      receiverThreadIds: [],
      senderThreadId: 'parent',
      status: 'failed',
      agentsStates: {},
    });

    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ result: { isError: true } });
  });

  it('emits only tool_call_end for in-progress collabAgentToolCall', async () => {
    const events = await collectAsync({
      type: 'collabAgentToolCall',
      id: 'collab-4',
      tool: 'sendInput',
      prompt: 'more context',
      model: null,
      reasoningEffort: null,
      receiverThreadIds: ['child'],
      senderThreadId: 'parent',
      status: 'inProgress',
      agentsStates: {},
    });

    expect(events.map((e) => e.type)).toEqual(['tool_call_end']);
  });

  it('handles dynamicToolCall like mcpToolCall', async () => {
    const events = await collectAsync({
      type: 'dynamicToolCall',
      id: 'dyn-1',
      tool: 'myTool',
      arguments: { x: 1 },
      success: true,
    });

    expect(events.map((e) => e.type)).toEqual(['tool_call_end']);
  });

  it('ignores unknown item types silently', async () => {
    const events = await collectAsync({ type: 'imageView', id: 'img-1' });
    expect(events).toEqual([]);
  });

  it('emits tool_call_end for plan items as canonical todo', async () => {
    const events = await collectAsync({
      type: 'plan',
      id: 'plan-1',
      text: '1. read\n2. think\n3. edit',
    });

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: { id: 'plan-1', name: 'todo', input: { text: '1. read\n2. think\n3. edit' } },
      },
    ]);
  });

  it('emits webSearch tool_call for action.type=search', async () => {
    const events = await collectAsync({
      type: 'webSearch',
      id: 'ws-1',
      query: 'rust async runtimes',
      action: { type: 'search', query: 'rust async runtimes', queries: ['rust async runtimes'] },
    } as unknown as ThreadItem);

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: {
          id: 'ws-1',
          name: 'webSearch',
          input: { query: 'rust async runtimes', queries: ['rust async runtimes'] },
        },
      },
    ]);
  });

  it('maps action.type=openPage to a webFetch tool_call', async () => {
    const events = await collectAsync({
      type: 'webSearch',
      id: 'ws-2',
      query: '',
      action: { type: 'openPage', url: 'https://example.com' },
    } as unknown as ThreadItem);

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: {
          id: 'ws-2',
          name: 'webFetch',
          input: { url: 'https://example.com' },
        },
      },
    ]);
  });

  it('emits webSearch with url+pattern for action.type=findInPage', async () => {
    const events = await collectAsync({
      type: 'webSearch',
      id: 'ws-3',
      query: 'fallback query',
      action: { type: 'findInPage', url: 'https://example.com', pattern: 'kubernetes' },
    } as unknown as ThreadItem);

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: {
          id: 'ws-3',
          name: 'webSearch',
          input: { url: 'https://example.com', pattern: 'kubernetes', query: 'fallback query' },
        },
      },
    ]);
  });

  it('falls back to item-level query when action is null or unknown', async () => {
    const events = await collectAsync({
      type: 'webSearch',
      id: 'ws-4',
      query: 'just a string',
      action: null,
    } as unknown as ThreadItem);

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: {
          id: 'ws-4',
          name: 'webSearch',
          input: { query: 'just a string' },
        },
      },
    ]);
  });

  it("treats action.type='other' as plain webSearch", async () => {
    const events = await collectAsync({
      type: 'webSearch',
      id: 'ws-5',
      query: 'something',
      action: { type: 'other' },
    } as unknown as ThreadItem);

    expect(events.map((e) => e.type)).toEqual(['tool_call_end']);
    const ev = events[0] as { toolCall: { name: string } };
    expect(ev.toolCall.name).toBe('webSearch');
  });
});

// ── translateNotification ──

describe('translateNotification', () => {
  async function drainQueue(q: EventQueue, max: number): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const it = q.iter();
    for (let i = 0; i < max; i++) {
      const next = await it.next();
      if (next.done) break;
      events.push(next.value);
    }
    return events;
  }

  it('emits text_delta on item/agentMessage/delta', async () => {
    const q = new EventQueue();
    translateNotification(
      {
        method: 'item/agentMessage/delta',
        params: { itemId: 'i1', delta: 'hello', threadId: 't1', turnId: 'tu1' },
      },
      't1',
      q,
    );
    q.end();

    const events = await drainQueue(q, 5);
    // First event is `activity`, second is the delta
    expect(events).toEqual([
      { type: 'activity' },
      { type: 'text_delta', delta: 'hello' },
    ]);
  });

  it('emits thinking_delta on item/reasoning/textDelta', async () => {
    const q = new EventQueue();
    translateNotification(
      {
        method: 'item/reasoning/textDelta',
        params: { itemId: 'r1', delta: 'thinking…', threadId: 't1', turnId: 'tu1' },
      },
      't1',
      q,
    );
    q.end();

    const events = await drainQueue(q, 5);
    expect(events).toEqual([
      { type: 'activity' },
      { type: 'thinking_delta', delta: 'thinking…' },
    ]);
  });

  it('translates item/completed → translateItem output', async () => {
    const q = new EventQueue();
    translateNotification(
      {
        method: 'item/completed',
        params: {
          item: { type: 'agentMessage', id: 'm1', text: 'final' },
          threadId: 't1',
          turnId: 'tu1',
        },
      },
      't1',
      q,
    );
    q.end();

    const events = await drainQueue(q, 5);
    expect(events).toEqual([{ type: 'activity' }, { type: 'text_end', text: 'final' }]);
  });

  it('emits session_end on turn/completed (status=completed → stop)', async () => {
    const q = new EventQueue();
    translateNotification(
      {
        method: 'turn/completed',
        params: { threadId: 't1', turn: { id: 'tu1', status: 'completed', error: null } },
      },
      't1',
      q,
    );

    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);

    expect(events).toEqual([
      { type: 'activity' },
      {
        type: 'session_end',
        stopReason: 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it('emits session_end with stopReason=aborted on turn interrupted', async () => {
    const q = new EventQueue();
    translateNotification(
      {
        method: 'turn/completed',
        params: { threadId: 't1', turn: { id: 'tu1', status: 'interrupted', error: null } },
      },
      't1',
      q,
    );
    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);

    expect(events.find((e) => e.type === 'session_end')).toMatchObject({ stopReason: 'aborted' });
  });

  it('emits error event before session_end when turn failed', async () => {
    const q = new EventQueue();
    translateNotification(
      {
        method: 'turn/completed',
        params: {
          threadId: 't1',
          turn: { id: 'tu1', status: 'failed', error: { message: 'boom' } },
        },
      },
      't1',
      q,
    );
    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);

    expect(events.map((e) => e.type)).toContain('error');
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'boom' });
    expect(events.find((e) => e.type === 'session_end')).toMatchObject({ stopReason: 'error' });
  });

  it('drops notifications for a different threadId', async () => {
    const q = new EventQueue();
    translateNotification(
      {
        method: 'item/agentMessage/delta',
        params: { itemId: 'i1', delta: 'leak', threadId: 'other', turnId: 'tu1' },
      },
      't1',
      q,
    );
    q.end();

    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);

    expect(events).toEqual([]);
  });

  it('does not filter on threadId when expectedThreadId is undefined', async () => {
    const q = new EventQueue();
    translateNotification(
      {
        method: 'item/agentMessage/delta',
        params: { itemId: 'i1', delta: 'pre-thread', threadId: 'unknown', turnId: 'tu1' },
      },
      undefined,
      q,
    );
    q.end();

    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);

    expect(events.map((e) => e.type)).toEqual(['activity', 'text_delta']);
  });

  it('emits error event followed by terminal session_end on error notification', async () => {
    // Regression: previously a standalone `error` notification queued only the
    // error event and left the queue open. Combined with the events generator
    // returning on `error`, that dropped the spec-promised terminal session_end
    // — and worse, callers waiting on the iterator could hang. Now error
    // notifications also queue session_end and end the queue.
    const q = new EventQueue();
    translateNotification(
      { method: 'error', params: { message: 'something exploded' } },
      undefined,
      q,
    );
    // NOTE: no q.end() here — translateNotification should end the queue
    // itself for terminal notifications. If it didn't, this for-await would
    // block forever (and the test would time out).

    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);

    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'something exploded' });
    const sessionEnd = events.find((e) => e.type === 'session_end');
    expect(sessionEnd).toMatchObject({ stopReason: 'error' });
    // Order: error must precede session_end.
    const errorIdx = events.findIndex((e) => e.type === 'error');
    const sessionEndIdx = events.findIndex((e) => e.type === 'session_end');
    expect(errorIdx).toBeLessThan(sessionEndIdx);
  });

  it('emits only activity for unhandled notification methods', async () => {
    const q = new EventQueue();
    translateNotification(
      { method: 'app/list/updated', params: {} },
      undefined,
      q,
    );
    q.end();

    const events: AgentEvent[] = [];
    for await (const ev of q.iter()) events.push(ev);

    expect(events).toEqual([{ type: 'activity' }]);
  });
});

// ── CodexBackend basics ──

describe('CodexBackend', () => {
  it('exposes name "codex"', () => {
    const backend = codex();
    expect(backend.name).toBe('codex');
  });

  it('codex() factory returns a CodexBackend instance', () => {
    expect(codex()).toBeInstanceOf(CodexBackend);
  });

  it('detects stale-thread error messages', () => {
    const backend = codex();
    expect(backend.isContinuationInvalid(new Error('thread not found'))).toBe(true);
    expect(backend.isContinuationInvalid(new Error('No such thread: abc'))).toBe(true);
    expect(backend.isContinuationInvalid(new Error('thread does not exist'))).toBe(true);
    expect(backend.isContinuationInvalid(new Error('rate limited'))).toBe(false);
  });

  it('close() is a no-op when no client was started', async () => {
    const backend = codex();
    await expect(backend.close()).resolves.toBeUndefined();
  });

  describe('custom-tool filtering', () => {
    it('marks a tool with execute() and no native.codex as bridged', () => {
      const t = {
        name: 't',
        description: 'd',
        schema: { safeParse: () => ({ success: true, data: {} }) },
        execute: async () => 'ok',
      } as unknown as import('../../../src/tools/types').Tool;
      const backend = codex({ tools: [t] });
      expect(backend.customTools).toEqual([t]);
    });

    it('skips bridge for tools that have native.codex', () => {
      const t = {
        name: 't',
        description: 'd',
        schema: { safeParse: () => ({ success: true, data: {} }) },
        execute: async () => 'ok',
        native: { codex: 'someNativeName' },
      } as unknown as import('../../../src/tools/types').Tool;
      const backend = codex({ tools: [t] });
      expect(backend.customTools).toEqual([]);
    });

    it('skips bridge for tools without execute()', () => {
      const t = {
        name: 't',
        description: 'd',
        schema: { safeParse: () => ({ success: true, data: {} }) },
      } as unknown as import('../../../src/tools/types').Tool;
      const backend = codex({ tools: [t] });
      expect(backend.customTools).toEqual([]);
    });

    it('webFetch is NOT bridged on Codex (has native.codex via webSearch)', async () => {
      const builtin = await import('../../../src/tools/builtin');
      const backend = codex({ tools: [builtin.webFetch] });
      expect(backend.customTools).toEqual([]);
    });
  });

  describe('codexHome passthrough', () => {
    it('accepts codexHome and constructs without throwing', () => {
      expect(() => codex({ codexHome: '/tmp/some-codex-home' })).not.toThrow();
    });

    it('accepts no codexHome (falls back to ambient ~/.codex/)', () => {
      expect(() => codex({})).not.toThrow();
    });
  });

  describe('approval/sandbox policy', () => {
    it('accepts askForApproval', () => {
      expect(() => codex({ askForApproval: 'never' })).not.toThrow();
      expect(() => codex({ askForApproval: 'untrusted' })).not.toThrow();
      expect(() => codex({ askForApproval: 'on-request' })).not.toThrow();
    });

    it('accepts sandboxMode', () => {
      expect(() => codex({ sandboxMode: 'read-only' })).not.toThrow();
      expect(() => codex({ sandboxMode: 'workspace-write' })).not.toThrow();
      expect(() => codex({ sandboxMode: 'danger-full-access' })).not.toThrow();
    });

    it('accepts onApprovalRequest handler', () => {
      const handler = async () => ({ decision: 'accept' as const });
      expect(() => codex({ onApprovalRequest: handler })).not.toThrow();
    });

    it('accepts the unattended trio together', () => {
      expect(() =>
        codex({
          askForApproval: 'never',
          sandboxMode: 'workspace-write',
          onApprovalRequest: async () => ({ decision: 'decline' }),
        }),
      ).not.toThrow();
    });
  });
});

describe('buildCodexConfig', () => {
  it('returns null when nothing is set', () => {
    expect(buildCodexConfig(null, undefined, undefined, undefined)).toBeNull();
  });

  it('emits approval_policy with the kebab-case wire value', () => {
    expect(buildCodexConfig(null, undefined, 'never', undefined)).toEqual({
      approval_policy: 'never',
    });
    expect(buildCodexConfig(null, undefined, 'on-request', undefined)).toEqual({
      approval_policy: 'on-request',
    });
  });

  it('emits sandbox_mode with the kebab-case wire value', () => {
    expect(buildCodexConfig(null, undefined, undefined, 'workspace-write')).toEqual({
      sandbox_mode: 'workspace-write',
    });
  });

  it('combines effort, approval_policy, and sandbox_mode', () => {
    const cfg = buildCodexConfig(null, 'high', 'never', 'workspace-write');
    expect(cfg).toEqual({
      model_reasoning_effort: 'high',
      approval_policy: 'never',
      sandbox_mode: 'workspace-write',
    });
  });
});

// ── Attachment mapping ──

describe('attachmentToCodexInput', () => {
  it('maps url → image', () => {
    const att: Attachment = { type: 'image', source: { kind: 'url', url: 'https://example.com/cat.png' } };
    expect(attachmentToCodexInput(att)).toEqual({ type: 'image', url: 'https://example.com/cat.png' });
  });

  it('maps path → localImage', () => {
    const att: Attachment = { type: 'image', source: { kind: 'path', path: '/tmp/cat.png' } };
    expect(attachmentToCodexInput(att)).toEqual({ type: 'localImage', path: '/tmp/cat.png' });
  });

  it('maps base64 → data URL on image', () => {
    const att: Attachment = {
      type: 'image',
      source: { kind: 'base64', data: 'AAAA', mimeType: 'image/png' },
    };
    expect(attachmentToCodexInput(att)).toEqual({
      type: 'image',
      url: 'data:image/png;base64,AAAA',
    });
  });
});
