import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeBackend, MessageStream, claude, translateMessage } from '../../src/backends/claude.js';
import type { AgentEvent } from '../../src/types.js';
import type { Tool } from '../../src/tools/types.js';
import { z } from 'zod';

// ── translateMessage ──

function collect(message: SDKMessage): AgentEvent[] {
  return [...translateMessage(message)];
}

describe('translateMessage', () => {
  it('emits session_start on system/init', () => {
    const events = collect({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc',
    } as unknown as SDKMessage);

    expect(events).toEqual([{ type: 'session_start', continuation: 'sess-abc' }]);
  });

  it('emits text_end for assistant text blocks', () => {
    const events = collect({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello world' }],
      },
    } as unknown as SDKMessage);

    expect(events).toEqual([{ type: 'text_end', text: 'hello world' }]);
  });

  it('emits thinking_end for assistant thinking blocks', () => {
    const events = collect({
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'reasoning…' }],
      },
    } as unknown as SDKMessage);

    expect(events).toEqual([{ type: 'thinking_end', text: 'reasoning…' }]);
  });

  it('emits tool_call_end for assistant tool_use blocks', () => {
    const events = collect({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_123',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
    } as unknown as SDKMessage);

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: { id: 'tu_123', name: 'Bash', input: { command: 'ls' } },
      },
    ]);
  });

  it('emits multiple events for a single assistant message with mixed blocks', () => {
    const events = collect({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'I should run ls' },
          { type: 'text', text: 'Let me check the directory.' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    } as unknown as SDKMessage);

    expect(events.map((e) => e.type)).toEqual(['thinking_end', 'text_end', 'tool_call_end']);
  });

  it('emits tool_result from user messages with tool_result content blocks', () => {
    const events = collect({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'file1\nfile2\n',
            is_error: false,
          },
        ],
      },
    } as unknown as SDKMessage);

    expect(events).toEqual([
      {
        type: 'tool_result',
        result: { toolCallId: 'tu_1', output: 'file1\nfile2\n', isError: false },
      },
    ]);
  });

  it('marks tool_result as error when is_error is true', () => {
    const events = collect({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: 'permission denied',
            is_error: true,
          },
        ],
      },
    } as unknown as SDKMessage);

    expect(events[0]).toMatchObject({
      type: 'tool_result',
      result: { isError: true },
    });
  });

  it('emits session_end with usage on result/success', () => {
    const events = collect({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
      },
    } as unknown as SDKMessage);

    expect(events).toEqual([
      {
        type: 'session_end',
        stopReason: 'stop',
        usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100 },
      },
    ]);
  });

  it('emits session_end with stopReason=error on result error subtypes', () => {
    const events = collect({
      type: 'result',
      subtype: 'error_max_turns',
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as SDKMessage);

    expect(events[0]).toMatchObject({ type: 'session_end', stopReason: 'error' });
  });

  it('emits zero usage if SDK omits usage fields', () => {
    const events = collect({
      type: 'result',
      subtype: 'success',
    } as unknown as SDKMessage);

    expect(events[0]).toMatchObject({
      type: 'session_end',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('ignores unrelated message types', () => {
    const events = collect({ type: 'auth_status', isAuthenticating: false } as unknown as SDKMessage);
    expect(events).toEqual([]);
  });

  it('ignores non-tool_result blocks in user messages', () => {
    const events = collect({
      type: 'user',
      message: { content: [{ type: 'text', text: 'irrelevant' }] },
    } as unknown as SDKMessage);

    expect(events).toEqual([]);
  });
});

// ── MessageStream ──

describe('MessageStream', () => {
  it('yields a message pushed before iteration starts', async () => {
    const stream = new MessageStream();
    stream.push('hello');
    stream.end();

    const messages = [];
    for await (const msg of stream) messages.push(msg);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.content).toBe('hello');
    expect(messages[0]?.type).toBe('user');
  });

  it('yields multiple messages in order', async () => {
    const stream = new MessageStream();
    stream.push('one');
    stream.push('two');
    stream.push('three');
    stream.end();

    const texts: string[] = [];
    for await (const msg of stream) {
      const c = msg.message.content;
      texts.push(typeof c === 'string' ? c : '');
    }

    expect(texts).toEqual(['one', 'two', 'three']);
  });

  it('yields messages pushed mid-iteration (waiter wakes up)', async () => {
    const stream = new MessageStream();
    stream.push('first');

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const msg of stream) {
        const c = msg.message.content;
        collected.push(typeof c === 'string' ? c : '');
        if (collected.length === 2) stream.end();
      }
    })();

    // Push the second message after a tick so the consumer has to wait.
    await new Promise((r) => setTimeout(r, 5));
    stream.push('second');
    await consumer;

    expect(collected).toEqual(['first', 'second']);
  });

  it('returns immediately on end() with no pending messages', async () => {
    const stream = new MessageStream();
    stream.end();

    const messages = [];
    for await (const msg of stream) messages.push(msg);

    expect(messages).toEqual([]);
  });

  it('drains queued messages even after end() is called', async () => {
    const stream = new MessageStream();
    stream.push('a');
    stream.push('b');
    stream.end();

    const texts: string[] = [];
    for await (const msg of stream) {
      const c = msg.message.content;
      texts.push(typeof c === 'string' ? c : '');
    }

    expect(texts).toEqual(['a', 'b']);
  });
});

// ── ClaudeBackend basics ──

describe('ClaudeBackend', () => {
  it('exposes name "claude"', () => {
    const backend = claude();
    expect(backend.name).toBe('claude');
  });

  it('claude() factory returns a ClaudeBackend instance', () => {
    expect(claude()).toBeInstanceOf(ClaudeBackend);
  });

  it('detects stale-session error messages', () => {
    const backend = claude();
    expect(backend.isContinuationInvalid(new Error('No conversation found'))).toBe(true);
    expect(backend.isContinuationInvalid(new Error('ENOENT: foo.jsonl not found'))).toBe(true);
    expect(backend.isContinuationInvalid(new Error('Session not found'))).toBe(true);
    expect(backend.isContinuationInvalid(new Error('Network unreachable'))).toBe(false);
    expect(backend.isContinuationInvalid('No conversation found')).toBe(true);
  });

  it('accepts tools with native.claude mapping (silently drops others)', () => {
    const tools: Tool[] = [
      {
        name: 'bash',
        description: 'Run shell commands',
        schema: z.object({ command: z.string() }),
        native: { claude: 'Bash' },
      },
      {
        name: 'someCustomTool',
        description: 'Custom tool',
        schema: z.object({}),
        // No native.claude — should be silently dropped in v0
      },
    ];

    // Should construct without throwing.
    const backend = claude({ tools });
    expect(backend.name).toBe('claude');
  });
});
