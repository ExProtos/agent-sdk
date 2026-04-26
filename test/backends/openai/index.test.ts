import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import {
  JsonlSession,
  OpenAIBackend,
  appendJsonlItems,
  buildOpenAIRunInput,
  combineSystem,
  findLatestTodoInput,
  formatTodos,
  openai,
  readJsonlItems,
  rewriteJsonl,
  translateStreamEvent,
  unwrapStoredArgs,
  wrapSchemaForOpenAI,
} from '../../../src/backends/openai/index';
import * as hostedTools from '../../../src/backends/openai/hosted';
import * as builtin from '../../../src/tools/builtin';
import type { Tool } from '../../../src/tools/types';
import type { AgentEvent, Attachment } from '../../../src/types';

// ── wrapSchemaForOpenAI ──

describe('wrapSchemaForOpenAI', () => {
  it('passes ZodObject through unchanged with identity unwrap', () => {
    const schema = z.object({ foo: z.string() });
    const { params, unwrap } = wrapSchemaForOpenAI(schema);
    expect(params).toBe(schema);
    expect(unwrap({ foo: 'hi' })).toEqual({ foo: 'hi' });
  });

  it('flattens unions into a top-level keyed object (option0/option1/…)', () => {
    const schema = z.union([
      z.object({ a: z.string() }),
      z.object({ b: z.number() }),
      z.object({ c: z.boolean() }),
    ]);
    const { params, unwrap } = wrapSchemaForOpenAI(schema);
    expect(params).toBeInstanceOf(z.ZodObject);
    // Both branches present, only one filled
    expect(unwrap({ option0: { a: 'hi' } })).toEqual({ a: 'hi' });
    expect(unwrap({ option1: { b: 42 } })).toEqual({ b: 42 });
    expect(unwrap({ option2: { c: true } })).toEqual({ c: true });
    // Nothing filled — pass through unchanged
    expect(unwrap({})).toEqual({});
  });

  it('wraps array schemas as { input: <schema> }', () => {
    const { params, unwrap } = wrapSchemaForOpenAI(z.array(z.string()));
    expect(params.parse({ input: ['a', 'b'] })).toEqual({ input: ['a', 'b'] });
    expect(unwrap({ input: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('wraps primitive schemas as { input: <schema> }', () => {
    const { params, unwrap } = wrapSchemaForOpenAI(z.string());
    expect(params.parse({ input: 'hello' })).toEqual({ input: 'hello' });
    expect(unwrap({ input: 'hello' })).toBe('hello');
  });

  it('union unwrap picks the first defined option key', () => {
    const schema = z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]);
    const { unwrap } = wrapSchemaForOpenAI(schema);
    // option0 wins when both happen to be set
    expect(unwrap({ option0: { a: 'hi' }, option1: { b: 1 } })).toEqual({ a: 'hi' });
    // null is treated as "not filled"
    expect(unwrap({ option0: null, option1: { b: 7 } })).toEqual({ b: 7 });
  });
});

// ── formatTodos ──

describe('formatTodos', () => {
  it('formats Claude-shape todos as a checklist', () => {
    const out = formatTodos({
      todos: [
        { content: 'do A', status: 'completed', activeForm: 'doing A' },
        { content: 'do B', status: 'in_progress', activeForm: 'doing B' },
        { content: 'do C', status: 'pending', activeForm: 'doing C' },
      ],
    });
    expect(out).toBe('[x] do A\n[~] do B\n[ ] do C');
  });

  it('formats Codex shape (text) verbatim', () => {
    expect(formatTodos({ text: 'plan stuff' })).toBe('plan stuff');
  });

  it('returns empty string for unrecognized shapes', () => {
    expect(formatTodos(undefined)).toBe('');
    expect(formatTodos(null)).toBe('');
    expect(formatTodos('hello')).toBe('');
    expect(formatTodos({ unrelated: 1 })).toBe('');
  });
});

// ── combineSystem ──

describe('combineSystem', () => {
  it('returns base when append undefined', () => {
    expect(combineSystem('base', undefined)).toBe('base');
  });
  it('returns append when base undefined', () => {
    expect(combineSystem(undefined, 'append')).toBe('append');
  });
  it('joins with double newline', () => {
    expect(combineSystem('base', 'append')).toBe('base\n\nappend');
  });
  it('returns undefined when both undefined', () => {
    expect(combineSystem(undefined, undefined)).toBeUndefined();
  });
});

// ── JsonlSession ──

function tempJsonlPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-openai-'));
  return path.join(dir, 'session.jsonl');
}

describe('JsonlSession', () => {
  it('round-trips items via addItems and getItems', async () => {
    const filePath = tempJsonlPath();
    const session = new JsonlSession({ sessionId: 'abc', filePath });
    expect(await session.getSessionId()).toBe('abc');
    expect(await session.getItems()).toEqual([]);
    await session.addItems([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any,
    ]);
    const items = await session.getItems();
    expect(items).toHaveLength(1);
    expect((items[0] as any).role).toBe('user');
  });

  it('appends to disk on addItems', async () => {
    const filePath = tempJsonlPath();
    const session = new JsonlSession({ sessionId: 'x', filePath });
    await session.addItems([{ type: 'message', role: 'user', content: [] } as any]);
    await session.addItems([{ type: 'message', role: 'assistant', content: [] } as any]);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).role).toBe('user');
    expect(JSON.parse(lines[1]!).role).toBe('assistant');
  });

  it('reloads items from disk lazily on getItems', async () => {
    const filePath = tempJsonlPath();
    appendJsonlItems(filePath, [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'pre' }] } as any,
    ]);
    const session = new JsonlSession({ sessionId: 'reload', filePath });
    const items = await session.getItems();
    expect(items).toHaveLength(1);
    expect((items[0] as any).content[0].text).toBe('pre');
  });

  it('respects the limit argument on getItems', async () => {
    const filePath = tempJsonlPath();
    const session = new JsonlSession({ sessionId: 'l', filePath });
    await session.addItems([
      { role: 'user' } as any,
      { role: 'assistant' } as any,
      { role: 'user' } as any,
    ]);
    const tail = await session.getItems(2);
    expect(tail).toHaveLength(2);
    expect((tail[0] as any).role).toBe('assistant');
    expect((tail[1] as any).role).toBe('user');
  });

  it('popItem removes and returns the most recent item', async () => {
    const filePath = tempJsonlPath();
    const session = new JsonlSession({ sessionId: 'p', filePath });
    await session.addItems([{ role: 'user' } as any, { role: 'assistant' } as any]);
    const popped = await session.popItem();
    expect((popped as any).role).toBe('assistant');
    const remaining = await session.getItems();
    expect(remaining).toHaveLength(1);
    // Disk reflects the rewrite
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('popItem returns undefined on empty session', async () => {
    const filePath = tempJsonlPath();
    const session = new JsonlSession({ sessionId: 'e', filePath });
    expect(await session.popItem()).toBeUndefined();
  });

  it('clearSession empties items and removes the file', async () => {
    const filePath = tempJsonlPath();
    const session = new JsonlSession({ sessionId: 'c', filePath });
    await session.addItems([{ role: 'user' } as any]);
    expect(fs.existsSync(filePath)).toBe(true);
    await session.clearSession();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(await session.getItems()).toEqual([]);
  });
});

describe('readJsonlItems', () => {
  it('returns [] for missing file', () => {
    expect(readJsonlItems('/nonexistent/path/foo.jsonl')).toEqual([]);
  });

  it('skips blank lines', () => {
    const filePath = tempJsonlPath();
    fs.writeFileSync(filePath, '{"a":1}\n\n{"a":2}\n');
    expect(readJsonlItems(filePath)).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('rewriteJsonl', () => {
  it('overwrites the file with the given items', () => {
    const filePath = tempJsonlPath();
    appendJsonlItems(filePath, [{ a: 1 } as any, { a: 2 } as any, { a: 3 } as any]);
    rewriteJsonl(filePath, [{ a: 99 } as any]);
    expect(readJsonlItems(filePath)).toEqual([{ a: 99 }]);
  });
});

// ── findLatestTodoInput ──

describe('findLatestTodoInput', () => {
  it('returns undefined when no todo function_call is present', () => {
    expect(findLatestTodoInput([])).toBeUndefined();
    expect(findLatestTodoInput([{ type: 'message', role: 'user', content: [] } as any])).toBeUndefined();
  });

  it('finds the most recent todo function_call (string arguments)', () => {
    const items = [
      { type: 'function_call', name: 'todo', arguments: JSON.stringify({ todos: [{ content: 'old' }] }) },
      { type: 'function_call', name: 'bash', arguments: '{"command":"ls"}' },
      { type: 'function_call', name: 'todo', arguments: JSON.stringify({ todos: [{ content: 'new' }] }) },
    ] as any[];
    expect(findLatestTodoInput(items)).toEqual({ todos: [{ content: 'new' }] });
  });

  it('handles already-parsed arguments objects', () => {
    const items = [
      { type: 'function_call', name: 'todo', arguments: { todos: [{ content: 'parsed' }] } },
    ] as any[];
    expect(findLatestTodoInput(items)).toEqual({ todos: [{ content: 'parsed' }] });
  });

  it('returns undefined for malformed string arguments', () => {
    const items = [{ type: 'function_call', name: 'todo', arguments: 'not json' }] as any[];
    expect(findLatestTodoInput(items)).toBeUndefined();
  });

  it('unwraps option0/option1 wrapping on read (model emitted the wrapped union shape)', () => {
    const items = [
      {
        type: 'function_call',
        name: 'todo',
        arguments: JSON.stringify({ option0: { todos: [{ content: 'do it' }] } }),
      },
    ] as any[];
    expect(findLatestTodoInput(items)).toEqual({ todos: [{ content: 'do it' }] });
  });

  it('unwraps the Codex branch (option1) when that was the one filled', () => {
    const items = [
      {
        type: 'function_call',
        name: 'todo',
        arguments: JSON.stringify({ option1: { text: 'freeform plan' } }),
      },
    ] as any[];
    expect(findLatestTodoInput(items)).toEqual({ text: 'freeform plan' });
  });
});

// ── unwrapStoredArgs ──

describe('unwrapStoredArgs', () => {
  it('unwraps single { input: ... } shape', () => {
    expect(unwrapStoredArgs({ input: 'hello' })).toBe('hello');
    expect(unwrapStoredArgs({ input: [1, 2] })).toEqual([1, 2]);
  });

  it('does NOT unwrap when there are sibling keys alongside `input`', () => {
    expect(unwrapStoredArgs({ input: 'hi', other: 1 })).toEqual({ input: 'hi', other: 1 });
  });

  it('unwraps option0/option1/... and returns the first defined branch', () => {
    expect(unwrapStoredArgs({ option0: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapStoredArgs({ option0: null, option1: { b: 2 } })).toEqual({ b: 2 });
  });

  it('returns input unchanged when no wrapping pattern matches', () => {
    expect(unwrapStoredArgs({ todos: [] })).toEqual({ todos: [] });
    expect(unwrapStoredArgs({ command: 'ls' })).toEqual({ command: 'ls' });
  });

  it('returns input unchanged for non-objects', () => {
    expect(unwrapStoredArgs(undefined)).toBeUndefined();
    expect(unwrapStoredArgs(null)).toBeNull();
    expect(unwrapStoredArgs('hi')).toBe('hi');
  });
});

// ── translateStreamEvent ──

function collect(ev: any): AgentEvent[] {
  const textBuf = new Map<string, string>();
  const reasoningBuf = new Map<string, string>();
  const canonicalByWireName = new Map<string, string>();
  return [...translateStreamEvent(ev, canonicalByWireName, textBuf, reasoningBuf)];
}

describe('translateStreamEvent', () => {
  it('translates raw text deltas with text_start on first delta', () => {
    const textBuf = new Map<string, string>();
    const reasoningBuf = new Map<string, string>();
    const canonicalByWireName = new Map<string, string>();
    const first = [
      ...translateStreamEvent(
        {
          type: 'raw_model_stream_event',
          data: { type: 'response.output_text.delta', item_id: 't1', delta: 'hi' },
        } as any,
        canonicalByWireName,
        textBuf,
        reasoningBuf,
      ),
    ];
    expect(first).toEqual([{ type: 'text_start' }, { type: 'text_delta', delta: 'hi' }]);
    const second = [
      ...translateStreamEvent(
        {
          type: 'raw_model_stream_event',
          data: { type: 'response.output_text.delta', item_id: 't1', delta: ' there' },
        } as any,
        canonicalByWireName,
        textBuf,
        reasoningBuf,
      ),
    ];
    expect(second).toEqual([{ type: 'text_delta', delta: ' there' }]);
    expect(textBuf.get('t1')).toBe('hi there');
  });

  it('translates reasoning deltas with thinking_start/delta', () => {
    const textBuf = new Map<string, string>();
    const reasoningBuf = new Map<string, string>();
    const canonicalByWireName = new Map<string, string>();
    const out = [
      ...translateStreamEvent(
        {
          type: 'raw_model_stream_event',
          data: { type: 'response.reasoning.delta', item_id: 'r1', delta: 'thinking…' },
        } as any,
        canonicalByWireName,
        textBuf,
        reasoningBuf,
      ),
    ];
    expect(out).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', delta: 'thinking…' },
    ]);
  });

  it('translates function call argument deltas', () => {
    const out = collect({
      type: 'raw_model_stream_event',
      data: { type: 'response.function_call_arguments.delta', item_id: 'c1', delta: '{"a":' },
    });
    expect(out).toEqual([{ type: 'tool_call_input_delta', id: 'c1', deltaJson: '{"a":' }]);
  });

  it('translates message_output_created → text_end with accumulated text', () => {
    const textBuf = new Map<string, string>();
    const reasoningBuf = new Map<string, string>();
    const canonicalByWireName = new Map<string, string>();
    [
      ...translateStreamEvent(
        {
          type: 'raw_model_stream_event',
          data: { type: 'response.output_text.delta', item_id: 'm1', delta: 'hello world' },
        } as any,
        canonicalByWireName,
        textBuf,
        reasoningBuf,
      ),
    ];
    const out = [
      ...translateStreamEvent(
        {
          type: 'run_item_stream_event',
          name: 'message_output_created',
          item: { rawItem: { id: 'm1', content: [] } },
        } as any,
        canonicalByWireName,
        textBuf,
        reasoningBuf,
      ),
    ];
    expect(out).toEqual([{ type: 'text_end', text: 'hello world' }]);
    // Buffer cleaned up
    expect(textBuf.has('m1')).toBe(false);
  });

  it('falls back to extracting text from rawItem.content when buffer empty', () => {
    const out = collect({
      type: 'run_item_stream_event',
      name: 'message_output_created',
      item: {
        rawItem: {
          content: [
            { type: 'output_text', text: 'piece A ' },
            { type: 'output_text', text: 'piece B' },
            { type: 'refusal', refusal: 'ignored' },
          ],
        },
      },
    });
    expect(out).toEqual([{ type: 'text_end', text: 'piece A piece B' }]);
  });

  it('translates tool_called → tool_call_end with canonical name lookup', () => {
    const textBuf = new Map<string, string>();
    const reasoningBuf = new Map<string, string>();
    const canonicalByWireName = new Map<string, string>([['my_tool_wire', 'myTool']]);
    const out = [
      ...translateStreamEvent(
        {
          type: 'run_item_stream_event',
          name: 'tool_called',
          item: {
            rawItem: { callId: 'call_1', name: 'my_tool_wire', arguments: '{"x":1}' },
          },
        } as any,
        canonicalByWireName,
        textBuf,
        reasoningBuf,
      ),
    ];
    expect(out).toEqual([
      { type: 'tool_call_end', toolCall: { id: 'call_1', name: 'myTool', input: { x: 1 } } },
    ]);
  });

  it('falls through with wire name when no canonical mapping', () => {
    const out = collect({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: { rawItem: { callId: 'c2', name: 'unknown_tool', arguments: '{}' } },
    });
    expect(out).toEqual([
      { type: 'tool_call_end', toolCall: { id: 'c2', name: 'unknown_tool', input: {} } },
    ]);
  });

  it('translates tool_output → tool_result', () => {
    const out = collect({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: { rawItem: { callId: 'c3', output: 'result text' } },
    });
    expect(out).toEqual([
      { type: 'tool_result', result: { toolCallId: 'c3', output: 'result text', isError: false } },
    ]);
  });

  it('flags tool_output with error as isError', () => {
    const out = collect({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: { rawItem: { callId: 'c4', error: { message: 'boom' } } },
    });
    expect(out).toEqual([
      { type: 'tool_result', result: { toolCallId: 'c4', output: '', isError: true } },
    ]);
  });

  it('translates handoff_requested as a synthetic text_end note', () => {
    const out = collect({
      type: 'run_item_stream_event',
      name: 'handoff_requested',
      item: { rawItem: { name: 'researcher' } },
    });
    expect(out).toEqual([{ type: 'text_end', text: '(handoff requested: researcher)' }]);
  });

  it('translates tool_approval_requested as an error event', () => {
    const out = collect({
      type: 'run_item_stream_event',
      name: 'tool_approval_requested',
      item: { rawItem: {} },
    });
    expect(out).toEqual([
      { type: 'error', message: 'tool approval requested but not supported by this backend', retryable: false },
    ]);
  });

  it('returns nothing for agent_updated_stream_event', () => {
    expect(collect({ type: 'agent_updated_stream_event', agent: {} })).toEqual([]);
  });
});

// ── Construction guards ──

describe('OpenAIBackend construction', () => {
  it('rejects useConversations + sessionsDir together', () => {
    expect(() =>
      openai({
        model: 'gpt-5',
        useConversations: true,
        sessionsDir: '/tmp/s',
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects useConversations + autoCompact together', () => {
    expect(() =>
      openai({
        model: 'gpt-5',
        useConversations: true,
        autoCompact: true,
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('accepts a model and no tools', () => {
    const backend = openai({ model: 'gpt-5' });
    expect(backend.name).toBe('openai');
  });
});

// ── Tool resolution ──

describe('tool resolution', () => {
  it('builds a hosted tool from hostedTools.webSearch()', () => {
    const t = hostedTools.webSearch();
    expect(t.name).toBe('webSearch');
    // Stashed as the SDK tool object under native.openai
    expect(typeof t.native?.openai).toBe('object');
    // Construction succeeds with a hosted tool
    expect(() => openai({ model: 'gpt-5', tools: [t] })).not.toThrow();
  });

  it('accepts builtin.webSearch via the string marker (lazy-constructs the SDK hosted tool)', () => {
    expect(() => openai({ model: 'gpt-5', tools: [builtin.webSearch] })).not.toThrow();
  });

  it('skips tools that have no execute and no native/hosted mapping', () => {
    const ghost: Tool = {
      name: 'ghost',
      description: 'ghost',
      schema: z.object({}),
    };
    expect(() => openai({ model: 'gpt-5', tools: [ghost] })).not.toThrow();
  });

  it('wires builtin.bash via execute', () => {
    expect(() => openai({ model: 'gpt-5', tools: [builtin.bash] })).not.toThrow();
  });

  it('special-cases the task tool', () => {
    expect(() => openai({ model: 'gpt-5', tools: [builtin.task] })).not.toThrow();
  });

  it('special-cases the todo tool', () => {
    expect(() => openai({ model: 'gpt-5', tools: [builtin.todo] })).not.toThrow();
  });

  it('accepts a mixed catalog (hosted + execute + special)', () => {
    expect(() =>
      openai({
        model: 'gpt-5',
        tools: [
          builtin.bash,
          builtin.read,
          builtin.todo,
          builtin.task,
          hostedTools.webSearch(),
          hostedTools.codeInterpreter(),
        ],
      }),
    ).not.toThrow();
  });
});

// ── buildOpenAIRunInput ──

describe('buildOpenAIRunInput', () => {
  it('returns a plain string when there are no attachments', async () => {
    expect(await buildOpenAIRunInput('hello', [])).toBe('hello');
    expect(await buildOpenAIRunInput(undefined, [])).toBe('');
  });

  it('builds a single user message with input_image + input_text parts', async () => {
    const att: Attachment = { type: 'image', source: { kind: 'url', url: 'https://x/y.png' } };
    const out = await buildOpenAIRunInput('caption', [att]);
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_image', image: 'https://x/y.png' },
          { type: 'input_text', text: 'caption' },
        ],
      },
    ]);
  });

  it('inlines base64 attachments as data URLs on the image field', async () => {
    const att: Attachment = {
      type: 'image',
      source: { kind: 'base64', data: 'AAAA', mimeType: 'image/png' },
    };
    const out = await buildOpenAIRunInput(undefined, [att]);
    expect(out).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_image', image: 'data:image/png;base64,AAAA' }],
      },
    ]);
  });

  it('reads path attachments from disk and infers media type', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-att-'));
    const filePath = path.join(dir, 'tiny.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(filePath, bytes);
    const att: Attachment = { type: 'image', source: { kind: 'path', path: filePath } };
    const out = await buildOpenAIRunInput('look', [att]);
    const expectedDataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_image', image: expectedDataUrl },
          { type: 'input_text', text: 'look' },
        ],
      },
    ]);
  });
});
