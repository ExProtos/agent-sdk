import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeBackend,
  MessageStream,
  buildInitialContentParts,
  claude,
  translateMessage,
} from '../../../src/backends/claude/index';
import type { AgentEvent, Attachment } from '../../../src/types';
import type { Tool } from '../../../src/tools/types';
import { z } from 'zod';

// ── translateMessage ──

function collect(message: SDKMessage, nameMap?: Map<string, string>): AgentEvent[] {
  return [...translateMessage(message, nameMap)];
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

  it('emits tool_call_end with wire name when no map provided', () => {
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

  it('emits tool_call_end with canonical name when map maps it', () => {
    const nameMap = new Map([
      ['Bash', 'bash'],
      ['Read', 'read'],
    ]);
    const events = collect(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_123', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      } as unknown as SDKMessage,
      nameMap,
    );

    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: { id: 'tu_123', name: 'bash', input: { command: 'ls' } },
      },
    ]);
  });

  it('falls through to wire name for tools not in the map', () => {
    const nameMap = new Map([['Bash', 'bash']]);
    const events = collect(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_x', name: 'mcp__custom__doThing', input: {} },
          ],
        },
      } as unknown as SDKMessage,
      nameMap,
    );

    expect(events[0]).toMatchObject({
      type: 'tool_call_end',
      toolCall: { name: 'mcp__custom__doThing' },
    });
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

// `push(text)` wraps as content-parts now; this helper digs the first text part out.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const part = content.find((p): p is { type: 'text'; text: string } =>
      typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text',
    );
    return part?.text ?? '';
  }
  return '';
}

describe('MessageStream', () => {
  it('yields a message pushed before iteration starts', async () => {
    const stream = new MessageStream();
    stream.push('hello');
    stream.end();

    const messages = [];
    for await (const msg of stream) messages.push(msg);

    expect(messages).toHaveLength(1);
    expect(textOf(messages[0]?.message.content)).toBe('hello');
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
      texts.push(textOf(msg.message.content));
    }

    expect(texts).toEqual(['one', 'two', 'three']);
  });

  it('yields messages pushed mid-iteration (waiter wakes up)', async () => {
    const stream = new MessageStream();
    stream.push('first');

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const msg of stream) {
        collected.push(textOf(msg.message.content));
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
      texts.push(textOf(msg.message.content));
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

  it('accepts tools with native.claude mapping (silently drops execute-less customs)', () => {
    const tools: Tool[] = [
      {
        name: 'bash',
        description: 'Run shell commands',
        schema: z.object({ command: z.string() }),
        native: { claude: 'Bash' },
      },
      {
        name: 'someCustomToolNoExec',
        description: 'Custom tool with no execute',
        schema: z.object({}),
        // No native.claude AND no execute — silently dropped.
      },
    ];

    const backend = claude({ tools });
    expect(backend.name).toBe('claude');
  });

  it('registers custom tools (with execute, no native.claude) as in-process MCP tools', () => {
    const customExecute = async ({ tz }: { tz: string }) => `time in ${tz}`;
    const tools: Tool[] = [
      {
        name: 'currentTime',
        description: 'Return the current time',
        schema: z.object({ tz: z.string() }),
        execute: customExecute,
      },
    ];

    // Constructing should wire the tool through createSdkMcpServer with the
    // wire name `mcp__agent-sdk-tools__currentTime` and add it to allowedTools.
    const backend = claude({ tools });
    expect(backend.name).toBe('claude');
    // No way to introspect sdkOptions directly; the e2e test exercises the
    // round trip end-to-end. Construction not throwing is the smoke check.
  });

  it('promotes non-object schemas (unions, arrays) to {input: schema} wrappers', () => {
    // Should NOT warn and NOT skip — the tool is registered with a wrapped
    // shape, transparent to both the consumer and the user's execute.
    const errs: string[] = [];
    const origError = console.error;
    console.error = (msg: unknown) => {
      errs.push(String(msg));
    };
    try {
      const tools: Tool[] = [
        {
          name: 'unionTool',
          description: 'Has a union schema',
          schema: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
          execute: async () => 'unused',
        },
      ];
      const backend = claude({ tools });
      expect(backend.name).toBe('claude');
      expect(errs.length).toBe(0);
    } finally {
      console.error = origError;
    }
  });
});

describe('translateMessage with wrapped tools', () => {
  it('unwraps `.input` for tools registered with a promoted schema', () => {
    const nameMap = new Map([['mcp__agent-sdk-tools__unionTool', 'unionTool']]);
    const wrapped = new Set(['unionTool']);
    const events = [
      ...translateMessage(
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu_99',
                name: 'mcp__agent-sdk-tools__unionTool',
                input: { input: { a: 'hello' } },
              },
            ],
          },
        } as unknown as SDKMessage,
        nameMap,
        wrapped,
      ),
    ];
    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: { id: 'tu_99', name: 'unionTool', input: { a: 'hello' } },
      },
    ]);
  });

  it('leaves input untouched when tool is not in wrapped set', () => {
    const nameMap = new Map([['Bash', 'bash']]);
    const events = [
      ...translateMessage(
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          },
        } as unknown as SDKMessage,
        nameMap,
        new Set(),
      ),
    ];
    expect(events).toEqual([
      {
        type: 'tool_call_end',
        toolCall: { id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      },
    ]);
  });
});

// ── buildInitialContentParts ──

describe('buildInitialContentParts', () => {
  it('returns null when there is no message and no attachments (resume-only)', () => {
    expect(buildInitialContentParts({})).toBeNull();
  });

  it('emits a single text part for plain message + no attachments', async () => {
    const parts = await buildInitialContentParts({ message: 'hello' })!;
    expect(parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('orders attachments before text', async () => {
    const att: Attachment = { type: 'image', source: { kind: 'url', url: 'https://x/y.png' } };
    const parts = await buildInitialContentParts({ message: 'caption', attachments: [att] })!;
    expect(parts).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
      { type: 'text', text: 'caption' },
    ]);
  });

  it('passes through base64 attachments verbatim with media_type', async () => {
    const att: Attachment = {
      type: 'image',
      source: { kind: 'base64', data: 'ZGF0YQ==', mimeType: 'image/png' },
    };
    const parts = await buildInitialContentParts({ attachments: [att] })!;
    expect(parts).toEqual([
      {
        type: 'image',
        source: { type: 'base64', data: 'ZGF0YQ==', media_type: 'image/png' },
      },
    ]);
  });

  it('reads path attachments from disk and infers media_type from extension', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-att-'));
    const filePath = path.join(dir, 'tiny.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(filePath, bytes);
    const att: Attachment = { type: 'image', source: { kind: 'path', path: filePath } };
    const parts = await buildInitialContentParts({ attachments: [att] })!;
    expect(parts).toEqual([
      {
        type: 'image',
        source: { type: 'base64', data: bytes.toString('base64'), media_type: 'image/png' },
      },
    ]);
  });

  it('rejects unsupported media types with a clear error', async () => {
    const att: Attachment = {
      type: 'image',
      source: { kind: 'base64', data: 'ZA==', mimeType: 'image/svg+xml' },
    };
    await expect(buildInitialContentParts({ attachments: [att] })).rejects.toThrow(
      /unsupported image media type/,
    );
  });
});
