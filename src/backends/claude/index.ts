/**
 * Claude backend — delegates the agent loop to @anthropic-ai/claude-agent-sdk.
 *
 * Tool resolution:
 *   - Tools with `native.claude` set → registered via `allowedTools`. The SDK
 *     uses its built-in implementation; our `execute` is not called.
 *   - Tools with `execute` and no `native.claude` → bundled into an in-process
 *     SDK MCP server (`createSdkMcpServer`). The closure runs in the parent
 *     process; the wire name on Claude's side is `mcp__agent-sdk-tools__<name>`
 *     and we map it back to the canonical name in event translation.
 *     Object-schema tools register their `.shape` directly; non-object schemas
 *     (unions, arrays) are wrapped as `{input: <schema>}` — the handler and
 *     event translator unwrap so consumers never see the wrapper level.
 *   - Tools that lack both `native.claude` and an `execute` are silently
 *     skipped — nothing to register.
 *
 * Event translation: complete content blocks (text/thinking/tool_use)
 * surface as text_end / thinking_end / tool_call_end events; no streaming
 * deltas yet.
 *
 * Auth: caller's responsibility (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * in the environment).
 */

import {
  createSdkMcpServer,
  query as sdkQuery,
  tool as claudeTool,
  type Options as SDKOptions,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ZodObject, ZodRawShape } from 'zod';

import type { AgentEvent, AgentQuery, Backend, QueryInput } from '../../types';
import type { Tool } from '../../tools/types';

const MCP_SERVER_NAME = 'agent-sdk-tools';

export interface ClaudeBackendOptions {
  /**
   * Tools to expose. Tools with `native.claude` use the SDK's built-in
   * implementation; tools with `execute` (and no `native.claude`) are
   * registered as in-process MCP tools. Tools that satisfy neither
   * condition are silently skipped.
   */
  tools?: Tool[];
  /**
   * Permission mode. SDK default is to prompt; we don't bake in
   * `bypassPermissions`. Callers running unattended must opt in explicitly.
   */
  permissionMode?: SDKOptions['permissionMode'];
  /**
   * Optional system-prompt configuration. If unset, the SDK uses Claude Code's
   * default preset.
   */
  systemPrompt?: SDKOptions['systemPrompt'];
  /** Pass-through to the SDK. */
  additionalDirectories?: string[];
  /** Pass-through to the SDK. */
  env?: Record<string, string | undefined>;
}

const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

/**
 * Push-based async iterable for streaming user messages into the SDK.
 */
export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiter: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiter?.();
  }

  end(): void {
    this.done = true;
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiter = r;
      });
      this.waiter = null;
    }
  }
}

export class ClaudeBackend implements Backend {
  readonly name = 'claude';

  private readonly tools: Tool[];
  private readonly canonicalByWireName: Map<string, string>;
  // Canonical names of tools registered with a wrapped `{input: …}` shape
  // because their schema isn't an object literal. The handler unwraps
  // `args.input` before calling the user's execute, and event translation
  // unwraps `block.input.input` so consumers see the canonical shape.
  private readonly wrappedToolNames: Set<string>;
  private readonly sdkOptions: Pick<
    SDKOptions,
    | 'permissionMode'
    | 'systemPrompt'
    | 'additionalDirectories'
    | 'env'
    | 'allowedTools'
    | 'mcpServers'
  >;

  constructor(options: ClaudeBackendOptions = {}) {
    this.tools = options.tools ?? [];

    const allowedTools: string[] = [];
    this.canonicalByWireName = new Map();
    this.wrappedToolNames = new Set();
    const customSdkTools: ReturnType<typeof claudeTool>[] = [];

    for (const t of this.tools) {
      if (t.native?.claude) {
        allowedTools.push(t.native.claude);
        this.canonicalByWireName.set(t.native.claude, t.name);
        continue;
      }
      if (t.execute === undefined) continue; // nothing to register
      const { shape, wrapped } = extractToolShape(t);
      if (wrapped) this.wrappedToolNames.add(t.name);
      const exec = t.execute;
      customSdkTools.push(
        claudeTool(t.name, t.description, shape, async (args, _extra) => {
          // For wrapped schemas the model emits `{input: <actualArgs>}`;
          // unwrap before handing to the user's execute.
          const actualArgs = wrapped ? (args as unknown as { input: unknown }).input : args;
          const result = await exec(actualArgs);
          return {
            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
          };
        }),
      );
      const wire = `mcp__${MCP_SERVER_NAME}__${t.name}`;
      allowedTools.push(wire);
      this.canonicalByWireName.set(wire, t.name);
    }

    const mcpServers =
      customSdkTools.length > 0
        ? { [MCP_SERVER_NAME]: createSdkMcpServer({ name: MCP_SERVER_NAME, tools: customSdkTools }) }
        : undefined;

    this.sdkOptions = {
      ...(options.permissionMode !== undefined && { permissionMode: options.permissionMode }),
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
      ...(options.additionalDirectories !== undefined && {
        additionalDirectories: options.additionalDirectories,
      }),
      ...(options.env !== undefined && { env: options.env }),
      ...(allowedTools.length > 0 && { allowedTools }),
      ...(mcpServers !== undefined && { mcpServers }),
    };
  }

  isContinuationInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    if (input.message !== undefined) stream.push(input.message);

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        ...this.sdkOptions,
        ...(input.cwd !== undefined && { cwd: input.cwd }),
        ...(input.continuation !== undefined && { resume: input.continuation }),
        ...(input.systemPromptAppend !== undefined && {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemPromptAppend },
        }),
      },
    });

    let aborted = false;
    const nameMap = this.canonicalByWireName;
    const wrapped = this.wrappedToolNames;

    async function* events(): AsyncGenerator<AgentEvent> {
      try {
        for await (const message of sdkResult) {
          if (aborted) return;
          yield { type: 'activity' };
          yield* translateMessage(message, nameMap, wrapped);
          // SDK keeps its async iterator alive as long as the input stream
          // is open (so callers can push() more messages mid-conversation).
          // For our turn-scoped query model, the 'result' message means
          // the model is done — close the input so the SDK iterator
          // terminates cleanly.
          if (message.type === 'result') {
            stream.end();
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: msg, retryable: false };
      }
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      abort: () => {
        aborted = true;
        stream.end();
      },
      events: events(),
    };
  }
}

export function claude(options?: ClaudeBackendOptions): ClaudeBackend {
  return new ClaudeBackend(options);
}

// ── Event translation ──

/**
 * Translate an SDK message into AgentEvents.
 *
 * `canonicalByWireName` maps Claude SDK wire names (e.g. 'Bash') to canonical
 * names from our Tool catalog (e.g. 'bash'). When the model uses a tool whose
 * wire name is in the map, we emit the canonical name. Unknown tools (custom
 * MCP, or built-ins not in the user's tools list) fall through to the wire
 * name unchanged.
 *
 * `wrappedToolNames` is the set of canonical names whose schemas were promoted
 * to `{input: <schema>}` at registration time (because they weren't object
 * literals — unions, arrays, etc.). For these, the model emits arguments
 * wrapped in `.input`; we unwrap so consumers see the canonical shape.
 */
export function* translateMessage(
  message: SDKMessage,
  canonicalByWireName?: Map<string, string>,
  wrappedToolNames?: Set<string>,
): Generator<AgentEvent> {
  if (message.type === 'system' && message.subtype === 'init') {
    yield { type: 'session_start', continuation: message.session_id };
    return;
  }

  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') {
        yield { type: 'text_end', text: block.text };
      } else if (block.type === 'thinking') {
        yield { type: 'thinking_end', text: block.thinking };
      } else if (block.type === 'tool_use') {
        const name = canonicalByWireName?.get(block.name) ?? block.name;
        const input =
          wrappedToolNames?.has(name) &&
          typeof block.input === 'object' &&
          block.input !== null &&
          'input' in block.input
            ? (block.input as { input: unknown }).input
            : block.input;
        yield {
          type: 'tool_call_end',
          toolCall: { id: block.id, name, input },
        };
      }
    }
    return;
  }

  if (message.type === 'user') {
    // Tool-result echoes from the SDK come back as user messages with tool_result blocks.
    const content = message.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
          const tr = block as { tool_use_id: string; content: unknown; is_error?: boolean };
          yield {
            type: 'tool_result',
            result: {
              toolCallId: tr.tool_use_id,
              output: tr.content,
              isError: tr.is_error ?? false,
            },
          };
        }
      }
    }
    return;
  }

  if (message.type === 'result') {
    const usage = message.usage;
    yield {
      type: 'session_end',
      stopReason: message.subtype === 'success' ? 'stop' : 'error',
      usage: {
        input: usage?.input_tokens ?? 0,
        output: usage?.output_tokens ?? 0,
        cacheRead: usage?.cache_read_input_tokens ?? 0,
        cacheWrite: usage?.cache_creation_input_tokens ?? 0,
      },
    };
    return;
  }
}

/**
 * Determine the raw shape to register with the Claude SDK's `tool()` helper,
 * which requires `Record<string, ZodType>` (the inner shape of `z.object()`).
 *
 * - Object schemas pass through directly: `{shape: t.schema.shape, wrapped: false}`.
 * - Non-object schemas (unions, arrays, primitives) are promoted to
 *   `{input: t.schema}` and marked `wrapped: true`. The model then emits
 *   `{input: <actualArgs>}`, which we unwrap on the handler side and in
 *   event translation so the consumer sees the canonical shape unchanged.
 */
function extractToolShape(t: Tool): { shape: ZodRawShape; wrapped: boolean } {
  const schema = t.schema as unknown as Partial<ZodObject<ZodRawShape>>;
  if (schema && typeof schema === 'object' && 'shape' in schema && typeof schema.shape === 'object') {
    return { shape: schema.shape as ZodRawShape, wrapped: false };
  }
  return { shape: { input: t.schema } as unknown as ZodRawShape, wrapped: true };
}
