/**
 * Claude backend — delegates the agent loop to @anthropic-ai/claude-agent-sdk.
 *
 * v0 scope:
 * - Native tools only (Tool.native.claude → allowedTools)
 * - Tools without `native.claude` are silently skipped (polyfill via in-process
 *   MCP comes when we add the Vercel backend)
 * - Coarse event translation: complete content blocks (text/thinking/tool_use)
 *   surface as text_end / thinking_end / tool_call_end events; no streaming
 *   deltas yet
 * - Auth: caller's responsibility (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 *   in the environment)
 */

import {
  query as sdkQuery,
  type Options as SDKOptions,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { AgentEvent, AgentQuery, Backend, QueryInput } from '../../types';
import type { Tool } from '../../tools/types';

export interface ClaudeBackendOptions {
  /**
   * Tools to expose. Only tools with `native.claude` set take effect in v0;
   * others are silently dropped. (In-process MCP polyfill is added when the
   * Vercel backend lands.)
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
  private readonly sdkOptions: Pick<
    SDKOptions,
    'permissionMode' | 'systemPrompt' | 'additionalDirectories' | 'env' | 'allowedTools'
  >;

  constructor(options: ClaudeBackendOptions = {}) {
    this.tools = options.tools ?? [];

    const allowedTools: string[] = [];
    this.canonicalByWireName = new Map();
    for (const t of this.tools) {
      if (t.native?.claude) {
        allowedTools.push(t.native.claude);
        this.canonicalByWireName.set(t.native.claude, t.name);
      }
    }

    this.sdkOptions = {
      ...(options.permissionMode !== undefined && { permissionMode: options.permissionMode }),
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
      ...(options.additionalDirectories !== undefined && {
        additionalDirectories: options.additionalDirectories,
      }),
      ...(options.env !== undefined && { env: options.env }),
      ...(allowedTools.length > 0 && { allowedTools }),
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

    async function* events(): AsyncGenerator<AgentEvent> {
      try {
        for await (const message of sdkResult) {
          if (aborted) return;
          yield { type: 'activity' };
          yield* translateMessage(message, nameMap);
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
 */
export function* translateMessage(
  message: SDKMessage,
  canonicalByWireName?: Map<string, string>,
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
        yield {
          type: 'tool_call_end',
          toolCall: { id: block.id, name, input: block.input },
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
