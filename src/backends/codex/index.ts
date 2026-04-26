/**
 * Codex backend — drives `codex app-server` over JSON-RPC.
 *
 * v0 scope:
 * - One AppServer subprocess per CodexBackend instance, lazily spawned on
 *   first query, shut down on close()
 * - Native tools only (Tool.native.codex → no-op; Codex's built-in
 *   command/exec, fs/readFile, fs/writeFile, apply_patch run server-side
 *   automatically — we don't register them, we just pass through their
 *   output as events)
 * - Custom tools (have execute(), no native.codex) are exposed to Codex
 *   via the MCP bridge — Codex spawns mcp-shim.ts as a subprocess MCP
 *   server, which proxies invocations back to the parent over a Unix
 *   socket so the user's closures run in the parent process
 * - Coarse event translation: full items at `item/completed`. Streaming
 *   deltas (`item/agentMessage/delta`, `item/reasoning/textDelta`) are
 *   surfaced as text_delta / thinking_delta events
 * - Auth: caller has run `codex login` (or has OPENAI_API_KEY set);
 *   query() errors with a clear message if not logged in
 */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { AgentEvent, AgentQuery, Backend, QueryInput } from '../../types';
import type { Tool } from '../../tools/types';
import * as builtin from '../../tools/builtin';
import { CodexClient, CodexRpcError, type CodexClientOptions } from './client';
import { McpBridge, type BridgeConfig } from './mcp-bridge';
import type {
  GetAccountResponse,
  ServerNotification,
  ThreadItem,
  ThreadStartResponse,
  ThreadResumeResponse,
  TurnStartResponse,
  UserInput,
} from './protocol';

export interface CodexBackendOptions extends CodexClientOptions {
  tools?: Tool[];
  /** Override Codex's model selection. */
  model?: string;
  /** Append to Codex's developer instructions (similar to systemPromptAppend). */
  developerInstructions?: string;
}

const STALE_THREAD_RE = /thread.*not found|no such thread|thread.*does not exist/i;

class CodexAuthRequiredError extends Error {
  constructor() {
    super(
      'codex is not logged in. Run `codex login` (for ChatGPT) or set OPENAI_API_KEY before using this backend.',
    );
    this.name = 'CodexAuthRequiredError';
  }
}

export class CodexBackend implements Backend {
  readonly name = 'codex';

  private readonly clientOptions: CodexClientOptions;
  private readonly model: string | undefined;
  private readonly developerInstructions: string | undefined;
  /**
   * Tools that will be routed through the MCP bridge — i.e. those with an
   * `execute()` and no `native.codex` mapping. Exposed for introspection.
   */
  readonly customTools: Tool[];
  private clientPromise: Promise<CodexClient> | null = null;
  private bridge: McpBridge | null = null;
  private bridgeConfig: BridgeConfig | null = null;

  constructor(options: CodexBackendOptions = {}) {
    const { tools, model, developerInstructions, ...client } = options;
    this.clientOptions = client;
    this.model = model;
    this.developerInstructions = developerInstructions;

    // Bridge-eligible: has execute() and no native.codex (Codex's built-in
    // tools always win when both are present, since they fire automatically
    // server-side without our involvement).
    this.customTools = (tools ?? []).filter(
      (t) => typeof t.execute === 'function' && !t.native?.codex,
    );
  }

  isContinuationInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  async close(): Promise<void> {
    if (this.clientPromise) {
      const client = await this.clientPromise.catch(() => null);
      this.clientPromise = null;
      if (client) await client.close();
    }
    if (this.bridge) {
      await this.bridge.stop();
      this.bridge = null;
      this.bridgeConfig = null;
    }
  }

  /**
   * Lazy-start the MCP bridge (only if there are custom tools to expose).
   * Returns the BridgeConfig the next thread/start should plumb into Codex's
   * mcp_servers config.
   */
  private async ensureBridge(): Promise<BridgeConfig | null> {
    if (this.customTools.length === 0) return null;
    if (this.bridgeConfig) return this.bridgeConfig;

    const bridge = new McpBridge();
    for (const tool of this.customTools) bridge.register(tool);
    this.bridge = bridge;
    this.bridgeConfig = await bridge.start();
    return this.bridgeConfig;
  }

  query(input: QueryInput): AgentQuery {
    const queue = new EventQueue();
    let aborted = false;
    let activeThreadId: string | undefined = input.continuation;

    const start = async () => {
      let detach: (() => void) | null = null;
      try {
        const client = await this.ensureClient();
        const bridgeConfig = await this.ensureBridge();

        // Verify auth before doing anything else.
        const account = await client.request<GetAccountResponse>('account/read', {});
        if (!account.account) {
          queue.push({
            type: 'error',
            message: new CodexAuthRequiredError().message,
            retryable: false,
          });
          queue.end();
          return;
        }

        // Wire notifications → events for this turn.
        detach = client.onNotification((notif) =>
          translateNotification(notif, activeThreadId, queue),
        );

        const codexConfig = buildCodexConfig(bridgeConfig);

        // Start or resume thread.
        if (input.continuation) {
          const resp = await client.request<ThreadResumeResponse>('thread/resume', {
            threadId: input.continuation,
            ...(input.cwd !== undefined && { cwd: input.cwd }),
            ...(this.developerInstructions !== undefined && {
              developerInstructions: this.developerInstructions,
            }),
            ...(codexConfig !== null && { config: codexConfig }),
          });
          activeThreadId = resp.thread.id;
        } else {
          const resp = await client.request<ThreadStartResponse>('thread/start', {
            ...(input.cwd !== undefined && { cwd: input.cwd }),
            ...(this.model !== undefined && { model: this.model }),
            ...(this.developerInstructions !== undefined && {
              developerInstructions: this.developerInstructions,
            }),
            ...(codexConfig !== null && { config: codexConfig }),
            experimentalRawEvents: false,
            persistExtendedHistory: false,
          });
          activeThreadId = resp.thread.id;
        }

        queue.push({ type: 'session_start', continuation: activeThreadId });

        // If no message, we just resumed for inspection — nothing to send.
        if (input.message === undefined) {
          queue.push({ type: 'session_end', usage: zeroUsage(), stopReason: 'stop' });
          return;
        }

        const userInput: UserInput[] = [{ type: 'text', text: input.message, text_elements: [] }];

        await client.request<TurnStartResponse>('turn/start', {
          threadId: activeThreadId,
          input: userInput,
          ...(input.cwd !== undefined && { cwd: input.cwd }),
        });

        // Wait for turn/completed — translateNotification ends the queue.
      } catch (err) {
        const message =
          err instanceof CodexRpcError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        queue.push({ type: 'error', message, retryable: false });
        queue.end();
      } finally {
        // Detach notification handler whenever the queue eventually ends
        // (model finished, error, or abort). If we never attached, no-op.
        if (detach) queue.onEnd(detach);
      }
    };

    void start();

    async function* events(): AsyncGenerator<AgentEvent> {
      try {
        for await (const ev of queue.iter()) {
          if (aborted) return;
          yield ev;
          if (ev.type === 'session_end' || ev.type === 'error') return;
        }
      } finally {
        queue.end();
      }
    }

    return {
      push: (msg: string) => {
        // Mid-flight follow-ups: enqueue another turn/start. v0 doesn't
        // support this — Codex doesn't allow concurrent turns on a thread.
        // Caller should end() and run() again with continuation instead.
        queue.push({
          type: 'error',
          message: 'push() not supported on Codex backend; end() and run() with continuation instead',
          retryable: false,
        });
        void msg;
      },
      end: () => queue.end(),
      abort: () => {
        aborted = true;
        if (activeThreadId) {
          this.ensureClient()
            .then((c) => c.notify('turn/interrupt', { threadId: activeThreadId }))
            .catch(() => {
              /* best-effort */
            });
        }
        queue.end();
      },
      events: events(),
    };
  }

  private ensureClient(): Promise<CodexClient> {
    if (!this.clientPromise) {
      this.clientPromise = CodexClient.start(this.clientOptions);
    }
    return this.clientPromise;
  }
}

export function codex(options?: CodexBackendOptions): CodexBackend {
  return new CodexBackend(options);
}

// ── Event translation ──

export function translateNotification(
  notif: ServerNotification,
  expectedThreadId: string | undefined,
  queue: EventQueue,
): void {
  // Filter to our thread (Codex daemon may serve others if shared in future).
  const params = notif.params as { threadId?: string } | undefined;
  if (
    expectedThreadId &&
    params &&
    typeof params === 'object' &&
    'threadId' in params &&
    params.threadId !== expectedThreadId
  ) {
    return;
  }

  queue.push({ type: 'activity' });

  switch (notif.method) {
    case 'turn/started':
      // No-op — session_start was emitted on thread/start response.
      return;

    case 'item/agentMessage/delta': {
      const p = notif.params as { delta: string };
      queue.push({ type: 'text_delta', delta: p.delta });
      return;
    }

    case 'item/reasoning/textDelta': {
      const p = notif.params as { delta: string };
      queue.push({ type: 'thinking_delta', delta: p.delta });
      return;
    }

    case 'item/completed': {
      const p = notif.params as { item: ThreadItem };
      translateItem(p.item, queue);
      return;
    }

    case 'turn/completed': {
      const p = notif.params as { turn: { status: string; error: { message: string } | null } };
      const stopReason =
        p.turn.status === 'completed'
          ? 'stop'
          : p.turn.status === 'interrupted'
            ? 'aborted'
            : 'error';
      if (p.turn.error) {
        queue.push({ type: 'error', message: p.turn.error.message, retryable: false });
      }
      queue.push({ type: 'session_end', stopReason: stopReason as 'stop' | 'aborted' | 'error', usage: zeroUsage() });
      queue.end();
      return;
    }

    case 'error': {
      const p = notif.params as { message: string };
      queue.push({ type: 'error', message: p.message, retryable: false });
      return;
    }
  }
}

export function translateItem(item: ThreadItem, queue: EventQueue): void {
  switch (item.type) {
    case 'agentMessage':
      if ('text' in item) queue.push({ type: 'text_end', text: item.text });
      return;

    case 'reasoning':
      if ('summary' in item || 'content' in item) {
        const text = [...((item as { summary?: string[] }).summary ?? []), ...((item as { content?: string[] }).content ?? [])].join(
          '\n',
        );
        queue.push({ type: 'thinking_end', text });
      }
      return;

    case 'commandExecution': {
      const i = item as { id: string; command: string; aggregatedOutput: string | null; exitCode: number | null };
      queue.push({
        type: 'tool_call_end',
        toolCall: { id: i.id, name: builtin.bash.name, input: { command: i.command } },
      });
      queue.push({
        type: 'tool_result',
        result: {
          toolCallId: i.id,
          output: i.aggregatedOutput ?? '',
          isError: i.exitCode !== null && i.exitCode !== 0,
        },
      });
      return;
    }

    case 'fileChange': {
      const i = item as {
        id: string;
        changes: Array<{ path: string; kind: string; diff: string }>;
        status: 'inProgress' | 'completed' | 'failed' | 'declined';
      };
      queue.push({
        type: 'tool_call_end',
        toolCall: { id: i.id, name: builtin.edit.name, input: { changes: i.changes } },
      });
      // Only surface a tool_result once the patch is settled.
      if (i.status === 'completed' || i.status === 'failed' || i.status === 'declined') {
        queue.push({
          type: 'tool_result',
          result: {
            toolCallId: i.id,
            output: { status: i.status, changes: i.changes },
            isError: i.status !== 'completed',
          },
        });
      }
      return;
    }

    case 'plan': {
      const i = item as { id: string; text: string };
      queue.push({
        type: 'tool_call_end',
        toolCall: { id: i.id, name: builtin.todo.name, input: { text: i.text } },
      });
      return;
    }

    case 'webSearch': {
      const i = item as {
        id: string;
        query: string;
        action: {
          type: 'search' | 'openPage' | 'findInPage' | 'other';
          query?: string | null;
          queries?: string[] | null;
          url?: string | null;
          pattern?: string | null;
        } | null;
      };
      // Map action variants back to our canonical tool names. openPage is
      // browsing → webFetch; everything else falls under webSearch.
      if (i.action?.type === 'openPage' && typeof i.action.url === 'string') {
        queue.push({
          type: 'tool_call_end',
          toolCall: {
            id: i.id,
            name: builtin.webFetch.name,
            input: { url: i.action.url },
          },
        });
      } else {
        const input: Record<string, unknown> = {};
        if (i.action?.type === 'search') {
          if (i.action.query) input.query = i.action.query;
          if (i.action.queries) input.queries = i.action.queries;
        } else if (i.action?.type === 'findInPage') {
          if (i.action.url) input.url = i.action.url;
          if (i.action.pattern) input.pattern = i.action.pattern;
        }
        // Fallback to the item-level query if action didn't supply one.
        if (!('query' in input) && i.query) input.query = i.query;
        queue.push({
          type: 'tool_call_end',
          toolCall: { id: i.id, name: builtin.webSearch.name, input },
        });
      }
      return;
    }

    case 'collabAgentToolCall': {
      const i = item as {
        id: string;
        tool: string;
        prompt: string | null;
        model: string | null;
        receiverThreadIds: string[];
        senderThreadId: string;
        status: 'inProgress' | 'completed' | 'failed';
        agentsStates: Record<string, { status: string; message: string | null }>;
      };
      const input: Record<string, unknown> = { tool: i.tool, receiverThreadIds: i.receiverThreadIds };
      if (i.prompt !== null) input.prompt = i.prompt;
      if (i.model !== null) input.model = i.model;
      queue.push({
        type: 'tool_call_end',
        toolCall: { id: i.id, name: builtin.task.name, input },
      });
      // Skip in-progress — same rule as fileChange. Wait for the sub-agent
      // to settle before emitting a tool_result.
      if (i.status === 'completed' || i.status === 'failed') {
        queue.push({
          type: 'tool_result',
          result: {
            toolCallId: i.id,
            output: { status: i.status, agentsStates: i.agentsStates },
            isError: i.status === 'failed',
          },
        });
      }
      return;
    }

    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const i = item as { id: string; tool: string; arguments: unknown; result?: unknown; error?: unknown };
      queue.push({
        type: 'tool_call_end',
        toolCall: { id: i.id, name: i.tool, input: i.arguments },
      });
      if (i.result !== undefined || i.error !== undefined) {
        queue.push({
          type: 'tool_result',
          result: { toolCallId: i.id, output: i.result ?? i.error, isError: !!i.error },
        });
      }
      return;
    }
  }
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Path to the MCP shim script. Resolved relative to this file so it works
 * whether running tsx-from-source (.ts) or after a tsc build (.js).
 */
function shimSpawn(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here); // '.ts' in dev, '.js' after build
  const shim = path.join(path.dirname(here), `mcp-shim${ext}`);
  if (ext === '.ts') {
    // Need tsx to load TS source. node --import tsx walks node_modules from
    // the shim's directory, so tsx must be installed in our package.
    return { command: 'node', args: ['--import', 'tsx', shim] };
  }
  return { command: 'node', args: [shim] };
}

/**
 * Build the Codex config blob to pass to thread/start. Currently only
 * registers the MCP bridge server; returns null when there are no custom
 * tools (so thread/start gets no config override at all).
 */
function buildCodexConfig(bridge: BridgeConfig | null): Record<string, unknown> | null {
  if (!bridge) return null;
  const spawn = shimSpawn();
  return {
    mcp_servers: {
      'agent-sdk': {
        command: spawn.command,
        args: spawn.args,
        env: {
          AGENT_SDK_SOCKET: bridge.socketPath,
          AGENT_SDK_MANIFEST: JSON.stringify(bridge.manifest),
        },
      },
    },
  };
}

// ── Push-based event queue ──

export class EventQueue {
  private items: AgentEvent[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  private endHandlers: (() => void)[] = [];

  push(ev: AgentEvent): void {
    if (this.done) return;
    this.items.push(ev);
    this.waiter?.();
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    this.waiter?.();
    for (const h of this.endHandlers) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
    this.endHandlers = [];
  }

  onEnd(handler: () => void): void {
    if (this.done) {
      handler();
      return;
    }
    this.endHandlers.push(handler);
  }

  async *iter(): AsyncGenerator<AgentEvent> {
    while (true) {
      while (this.items.length > 0) {
        yield this.items.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiter = r;
      });
      this.waiter = null;
    }
  }
}

export type { CodexClientOptions };
