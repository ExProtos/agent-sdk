# Codex backend

Drives `codex app-server` over JSON-RPC stdio. Codex owns the agent loop, system prompt assembly (its `developerInstructions` field appends to whatever Codex already builds), tool execution for built-ins, and credential reading from `~/.codex/auth.json` (or `OPENAI_API_KEY`).

We translate Codex's typed item stream to our canonical `AgentEvent` union and bridge user-supplied custom tools through a small MCP server that runs as a subprocess.

Implementation lives in five files:

```
src/backends/codex/
  index.ts        # CodexBackend, codex(), event translation
  client.ts       # JSON-RPC client over codex app-server stdio
  protocol.ts     # hand-written subset of Codex's JSON-RPC types
  mcp-bridge.ts   # parent-side socket server
  mcp-shim.ts     # subprocess MCP server Codex spawns
```

## Public API

```typescript
export interface CodexBackendOptions extends CodexClientOptions {
  tools?: Tool[];
  model?: string;
  developerInstructions?: string;
}

export class CodexBackend implements Backend {
  readonly customTools: Tool[];
  /* … */
}
export function codex(options?: CodexBackendOptions): CodexBackend;
```

`CodexClientOptions` (from `client.ts`): `{ command?, args?, env?, cwd? }` — defaults to spawning `codex app-server` on `PATH`.

## v0 scope

- **One AppServer subprocess per `CodexBackend` instance.** Lazy-spawned on first `query()`, killed on `close()`.
- **Native tools fire automatically.** Codex's built-ins (`commandExecution`, `fileChange`, `webSearch`, `plan`, etc.) run server-side. We don't register them — we pass through their items as events. `Tool.native.codex` is informational.
- **Custom tools route through the MCP bridge.** Tools with `execute` and **no** `native.codex` are exposed via a Unix socket + subprocess MCP shim. Closures stay in the parent.
- **Streaming text and reasoning.** `item/agentMessage/delta` and `item/reasoning/textDelta` map to `text_delta` / `thinking_delta`. `item/completed` events carry the full payload as `*_end`.
- **No `push()` mid-turn.** Codex doesn't allow concurrent turns on a thread. `push` errors with a message suggesting `end()` + `run()` with continuation.

## Flow

```
First query:
  ensureClient()    → spawn `codex app-server`, run `initialize`
  ensureBridge()    → if any custom tools, start McpBridge (returns socketPath + manifest)
  account/read      → verify auth (CodexAuthRequiredError on null)
  thread/start      → returns { thread: { id } }; emit session_start
  turn/start        → starts the model turn

  notification stream:
    item/agentMessage/delta   → text_delta
    item/reasoning/textDelta  → thinking_delta
    item/completed            → translateItem(item) → tool_call_end(+tool_result), text_end, …
    turn/completed            → session_end; queue.end()

Resume:
  thread/resume     → returns { thread: { id } }; emit session_start
  …same as above
```

## `query()`

The structure is async-but-eager: we kick off `start()` and return the AgentQuery handle immediately. Events flow through `EventQueue` (a push-based async iterable) — `start()` pushes lifecycle and translation results, the events generator drains.

Wrap all of `start()` in try/catch. Anything that throws (auth error, RPC error, network, …) becomes an `error` event followed by `queue.end()`. This is important — without it, a failed `account/read` would just silently hang the consumer.

```typescript
const start = async () => {
  let detach: (() => void) | null = null;
  try {
    const client = await this.ensureClient();
    const bridgeConfig = await this.ensureBridge();
    const account = await client.request('account/read', {});
    if (!account.account) {
      queue.push({ type: 'error', message: new CodexAuthRequiredError().message, retryable: false });
      queue.end();
      return;
    }
    detach = client.onNotification((n) => translateNotification(n, activeThreadId, queue));
    const codexConfig = buildCodexConfig(bridgeConfig);

    if (input.continuation) {
      const resp = await client.request<ThreadResumeResponse>('thread/resume', { threadId: input.continuation, …codexConfig });
      activeThreadId = resp.thread.id;
    } else {
      const resp = await client.request<ThreadStartResponse>('thread/start', {
        cwd: input.cwd, model, developerInstructions, config: codexConfig,
        experimentalRawEvents: false, persistExtendedHistory: false,
      });
      activeThreadId = resp.thread.id;
    }

    queue.push({ type: 'session_start', continuation: activeThreadId });
    if (input.message === undefined) {
      queue.push({ type: 'session_end', usage: zeroUsage(), stopReason: 'stop' });
      return;
    }
    await client.request('turn/start', {
      threadId: activeThreadId,
      input: [{ type: 'text', text: input.message, text_elements: [] }],
    });
    // turn/completed via translateNotification ends the queue
  } catch (err) {
    queue.push({ type: 'error', message: err.message ?? String(err), retryable: false });
    queue.end();
  } finally {
    if (detach) queue.onEnd(detach);  // detach when queue ends, however it ended
  }
};
```

**Critical**: `resp.thread.id`, not `resp.threadId`. Codex's `ThreadStart` response shape is `{ thread: { id } }`. Reading the wrong field returns `undefined` and breaks every subsequent call that includes `threadId`.

`buildCodexConfig(bridge)` returns `null` when there are no custom tools, otherwise:

```typescript
{
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
}
```

## Event translation

### `translateNotification(notif, expectedThreadId, queue)`

First filter by `expectedThreadId` (Codex daemons may serve multiple threads in the future). Push `activity` on every translated notification for liveness. Then dispatch by method:

| `notif.method` | Action |
|---|---|
| `turn/started` | no-op (session_start was emitted on thread/start response) |
| `item/agentMessage/delta` | push `{type:'text_delta', delta}` |
| `item/reasoning/textDelta` | push `{type:'thinking_delta', delta}` |
| `item/completed` | dispatch to `translateItem(params.item)` |
| `turn/completed` | push `error` if `turn.error`, then `session_end` with `stopReason` from `turn.status`, then `queue.end()` |
| `error` | push `{type:'error', message, retryable:false}` |

`stopReason` mapping for `turn/completed`:
- `'completed'` → `'stop'`
- `'interrupted'` → `'aborted'`
- anything else → `'error'`

### `translateItem(item, queue)`

Maps Codex's typed items to canonical events. Tool names reference `builtin.<tool>.name` so renaming a tool in `builtin.ts` propagates.

| `item.type` | Yields |
|---|---|
| `agentMessage` | `text_end` with `item.text` |
| `reasoning` | `thinking_end` with `summary.join('\n') + '\n' + content.join('\n')` |
| `commandExecution` | `tool_call_end` named `bash` with `{command}` + `tool_result` (`output: aggregatedOutput ?? ''`, `isError: exitCode !== null && exitCode !== 0`) |
| `fileChange` | `tool_call_end` named `edit` with `{changes}` + `tool_result` only when status is `completed`/`failed`/`declined` (skip `inProgress`) |
| `plan` | `tool_call_end` named `todo` with `{text}` |
| `collabAgentToolCall` | `tool_call_end` named `task` with `{tool, receiverThreadIds, prompt?, model?}` + `tool_result` only when status is `completed`/`failed` (skip `inProgress`). `tool_result.output` is `{status, agentsStates}` where `agentsStates` is a map of receiver thread id → `{status, message}` — the sub-agent's response text lives in `message`. Note: upstream's status enum has no `declined` variant (unlike `fileChange`); collab spawn isn't human-gated. |
| `webSearch` (action `openPage`) | `tool_call_end` named `webFetch` with `{url}` |
| `webSearch` (action `search`) | `tool_call_end` named `webSearch` with `{query}` and/or `{queries}` |
| `webSearch` (action `findInPage`) | `tool_call_end` named `webSearch` with `{url, pattern}` |
| `webSearch` (other / fallback) | `tool_call_end` named `webSearch` with the item-level `query` |
| `mcpToolCall` | `tool_call_end` with the wire `tool` name + `tool_result` if `result` or `error` is set |
| `dynamicToolCall` | same as `mcpToolCall` |
| (unknown) | drop silently |

The `webSearch` case is a single Codex item that can mean any of three different things; mapping back to our two canonical names (`webFetch` vs. `webSearch`) is what gives consumers a single name to switch on.

`fileChange` skipping `inProgress`: emitting a `tool_result` while the patch is still mid-application would orphan the tool_call once the final state arrives. Wait until the patch settles.

### Duplicate `tool_call_end` is possible by design

`translateItem` runs once per `item/completed` notification. For long-lived items (`fileChange`, `collabAgentToolCall`) Codex can emit `item/completed` multiple times for the same item id as the underlying state evolves — so consumers may see two `tool_call_end` events with the same `toolCall.id` and one `tool_result` (the final settle). This is intentional: the wrapper passes through what Codex emits rather than tracking item lifecycle.

**Consumer rule:** if you're persisting a tool-call log, dedupe by `toolCall.id` and treat the latest `tool_call_end` for an id as authoritative. The matching `tool_result` (if any) always carries the final state. If you don't dedupe, you'll see two entries per long-lived call — annoying but not load-bearing for correctness.

## MCP bridge

The bridge translates Codex's "MCP-server-as-subprocess" model into in-process closures.

### Bridge eligibility

```typescript
this.customTools = (tools ?? []).filter(
  (t) => typeof t.execute === 'function' && !t.native?.codex,
);
```

A tool is bridge-eligible iff:

- Has `execute` (we have something to call), AND
- Has no `native.codex` (Codex's built-in would otherwise win — they fire automatically server-side without our involvement).

Tools with `native.codex` set but no `execute` are passed through as a no-op — Codex runs them; we just translate items.

### `McpBridge` (parent process)

```typescript
class McpBridge {
  private server: Server | null;
  private socketPath: string | null;
  private readonly tools = new Map<string, Tool>();
  private readonly connections = new Set<Socket>();

  register(tool: Tool): void;
  start(): Promise<{ socketPath, manifest }>;
  stop(): Promise<void>;
}
```

- `register(tool)` adds to the registry; throws if `!tool.execute`.
- `start()` opens a Unix socket (or named pipe on Windows), builds the manifest, returns both. Manifest entries: `{ name, description, inputSchema: z.toJSONSchema(t.schema) }`.
- `stop()` **destroys all connections explicitly**, then closes the server, then unlinks the socket file. The destroy step is critical — `server.close()` waits for active connections to drain, which can hang indefinitely if the shim subprocess hasn't exited yet.

Connection handler: per-connection `readline` parses newline-delimited JSON. For each `{id, tool, args}`:

1. Look up `tools.get(req.tool)`. If missing → write `{id, error: {message: 'unknown tool: …'}}`.
2. `tool.schema.safeParse(args)`. If invalid → write `{id, error: {message: 'invalid args: …'}}`.
3. `await tool.execute(parsed.data)`. Stringify result if not already a string.
4. Write `{id, result: {content: [{type:'text', text}]}}`.
5. On throw → write `{id, error: {message}}`.

Socket path: `os.tmpdir()/agent-sdk-{pid}-{Date.now()}-{random}.sock`. Windows: `\\.\pipe\agent-sdk-…`.

### `mcp-shim.ts` (subprocess)

Spawned by Codex as a normal MCP server. Reads `AGENT_SDK_SOCKET` and `AGENT_SDK_MANIFEST` from env. Connects to the parent's socket. Speaks MCP-over-stdio to Codex. For every tool call:

1. Receive `CallToolRequest` from Codex.
2. Send `{id, tool: req.params.name, args: req.params.arguments ?? {}}` over the socket.
3. Wait for `{id, result}` or `{id, error}`.
4. Return `{content: result.content}` (or `{content: [{type:'text', text: error.message}], isError: true}`).

`tools/list` returns the manifest verbatim.

The shim's MCP server name is `agent-sdk-bridge` (visible to Codex in any debug output). Don't put secrets in tool descriptions or names — Codex's logs include them.

### Shim path resolution

The shim runs as either `.ts` (when our consumer is using `tsx`) or `.js` (post-build). The Codex backend resolves the right path and command at spawn time:

```typescript
const here = fileURLToPath(import.meta.url);   // .../codex/index.{ts,js}
const ext = path.extname(here);
const shim = path.join(path.dirname(here), `mcp-shim${ext}`);
return ext === '.ts'
  ? { command: 'node', args: ['--import', 'tsx', shim] }
  : { command: 'node', args: [shim] };
```

The `.ts` case requires `tsx` to be resolvable from the shim's directory — which is why `tsx` must be in the package's `dependencies`, not `devDependencies`.

## `EventQueue`

Simple push-based async iterable. Owned by `query()`, drained by the events generator.

```typescript
class EventQueue {
  push(ev: AgentEvent): void;        // no-op after end()
  end(): void;                        // signals iterator completion; runs onEnd handlers
  onEnd(handler: () => void): void;  // for cleanup (e.g. detach notification handler)
  iter(): AsyncGenerator<AgentEvent>;
}
```

The events generator wraps `iter()` and ensures `queue.end()` runs in `finally` even when the consumer breaks out of the loop.

## `push()` and `abort()`

- `push(msg)`: emit `error` with `"push() not supported on Codex backend; end() and run() with continuation instead"`. Codex doesn't permit concurrent turns.
- `abort()`: set a local `aborted` flag, call `client.notify('turn/interrupt', {threadId})` (best-effort), then `queue.end()`. The events generator's `aborted` check stops yielding.

## Continuation

`session_start.continuation` is the thread ID. To resume, pass it back as `QueryInput.continuation`.

```typescript
const STALE_THREAD_RE = /thread.*not found|no such thread|thread.*does not exist/i;
isContinuationInvalid(err: unknown): boolean {
  return STALE_THREAD_RE.test(err.message ?? String(err));
}
```

Note: Codex doesn't pin the model on resume — `model` is only valid on `thread/start`. The backend reflects this in the `thread/resume` request shape (no `model` field).

## Lifecycle

- `ensureClient()`: lazy-creates `clientPromise`. Single shared client for all queries.
- `ensureBridge()`: lazy-starts the bridge if `customTools.length > 0`. Single shared bridge.
- `close()`: awaits client, kills it, then stops the bridge. Idempotent.

## Auth verification

Before doing anything else, `query()` calls `account/read`. If `account` is null, push:

```typescript
new CodexAuthRequiredError(
  'codex is not logged in. Run `codex login` (for ChatGPT) or set OPENAI_API_KEY before using this backend.',
)
```

…then `queue.end()`. This is the friendliest place to catch missing auth — letting it through to `thread/start` produces an opaque RPC error.

## What we don't do

- **Approval flows.** Codex sends `item/commandExecution/requestApproval` etc. when in approval-required mode. The client decides them via `defaultServerRequestResponse` (decline by default) — there's no consumer-facing hook yet. Future work: surface as an `AgentEvent` variant (`approval_request`) the consumer can answer.
- **Non-text user input.** `image` and `localImage` UserInput variants are typed but not exposed in `QueryInput`. Adding them is straightforward; deferred until needed.
- **Token usage.** Codex's protocol doesn't expose token counts in a stable place; `session_end.usage` is `zeroUsage()` everywhere. Mapping is on the backlog.
- **Wiring user-supplied MCP servers.** Codex's TOML config supports arbitrary MCP servers; we only register our own bridge. Adding caller-controlled MCP server configs is a future option (see [architecture.md](../architecture.md) → Custom tools and the MCP bridge for the elicitation auto-accept caveat that becomes load-bearing if we do).
