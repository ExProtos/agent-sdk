# Architecture

## Overview

`agent-sdk` is a thin TypeScript layer over multiple agent runtimes — Claude Agent SDK and Codex AppServer today, with Vercel AI SDK Agent and OpenAI Agents SDK planned. The wrapper does **not** reimplement an agent loop. It delegates to each backend's own runtime and only normalizes what each backend exposes.

It exists for two reasons:

1. **Provider portability with subscription auth.** Claude Agent SDK reads `CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max subscriptions); Codex AppServer reads `~/.codex/auth.json` from `codex login`. Building a portable assistant on subscription credentials means writing against both.
2. **Custom tools as closures, not subprocesses.** MCP servers normally need to be standalone executables. The Codex backend's MCP bridge lets a regular TS function with closure-captured state run as if it were a Codex tool — closures stay in the parent process; a small subprocess shim proxies calls back over a Unix socket.

Designed for general-purpose assistants (NanoClaw / OpenClaw / protos style), not specifically coding agents — though it works for those too. Target size: ~3k LOC.

## Goals and non-goals

**Goals.**

- One `Agent` API the consumer programs against, regardless of backend.
- A unified streaming-event union (`session_start`, `text_delta`, `tool_call_end`, `tool_result`, `session_end`, …) with `*_start`/`*_delta`/`*_end` variants and an `activity` heartbeat.
- A canonical tool catalog: same name (`bash`) regardless of which native tool fires (Claude `Bash`, Codex `command/exec`).
- Custom tools defined as closures with Zod schemas, surfaced natively where the backend allows or via the MCP bridge where it doesn't.
- Pass-through auth — credentials are whatever the underlying SDK reads from env or disk; the wrapper stores none.

**Non-goals.**

- We don't reimplement an agent loop, retry policy, or token-budget management — those are the underlying SDK's job.
- We don't manage credentials.
- We don't sandbox tool execution. Caller should run inside a container if isolation matters.
- We don't try to support every feature of every backend SDK. Backend-specific knobs are exposed via escape hatches in each `BackendOptions` interface.
- We don't bridge hosted tools across backends (e.g. OpenAI's Code Interpreter on Claude). Hosted tools are backend-specific declarations.

## Source layout

```
src/
  index.ts           # public exports: Agent, types, tools.*, claude(), codex()
  agent.ts           # Agent class — thin wrapper around Backend
  types.ts           # AgentEvent, Backend, AgentQuery, QueryInput, …
  tools/
    types.ts         # Tool<TInput,TOutput> interface
    builtin.ts       # canonical Tool catalog (bash, read, write, edit, …)
    implementations.ts  # in-process execute() for builtins that need one
  backends/
    claude/
      index.ts       # ClaudeBackend, claude()
    codex/
      index.ts       # CodexBackend, codex(), event translation
      client.ts      # JSON-RPC client over codex app-server stdio
      protocol.ts    # hand-written subset of Codex's JSON-RPC types
      mcp-bridge.ts  # Unix-socket server in parent process
      mcp-shim.ts    # MCP-over-stdio subprocess Codex spawns
```

Tests under `test/` mirror this layout (`test/backends/claude/`, `test/tools/`, etc.). E2E tests live in `test/e2e/`.

## The `Agent` API

The public surface is intentionally small. Everything in `src/index.ts`:

```typescript
import { Agent, claude, tools } from 'agent-sdk';

const agent = new Agent({
  backend: claude({ tools: tools.all, permissionMode: 'bypassPermissions' }),
});

const query = agent.run({ message: 'Find every TODO in src/.' });
for await (const event of query.events) { /* … */ }
await agent.close();
```

`Agent` itself is ~25 LOC — just `run(input)` and `close()`. All work happens in the backend.

### Backend interface

```typescript
interface Backend {
  readonly name: string;
  query(input: QueryInput): AgentQuery;
  isContinuationInvalid?(err: unknown): boolean;
  close?(): Promise<void>;
}
```

Backends own:

- The agent loop (delegated to the underlying SDK).
- Translation from native SDK events → `AgentEvent`.
- Continuation-token semantics.
- Native tool registration where the SDK supports it.
- For Codex: spawning the MCP bridge subprocess for custom tools.

`isContinuationInvalid(err)` is consulted by callers that retain continuation tokens across restarts: when retry against the stored token errors with "session not found" / "thread not found", the caller clears the token and starts fresh. Each backend matches its SDK's specific error wording.

### Query handle

```typescript
interface AgentQuery {
  push(message: string): void;
  end(): void;
  abort(): void;
  events: AsyncIterable<AgentEvent>;
}
```

`push` enqueues a follow-up user message mid-conversation. (Codex doesn't permit this — its `push` emits an `error` event suggesting `end()` + `run()` with the continuation instead.) `end` closes the input stream so the underlying iterator can terminate. `abort` aborts the in-flight turn.

### `QueryInput`

```typescript
interface QueryInput {
  message?: string;
  continuation?: string;
  cwd?: string;
  systemPromptAppend?: string;
}
```

`message` is optional — omitting it opens a query against an existing continuation without sending anything (e.g. to inspect state, then push later). `continuation` is opaque: a Claude session ID, a Codex thread ID, or whatever a future backend stores. `systemPromptAppend` is a backend-aware hint; backends that have a system-prompt concept thread it through, others may ignore it.

## Event model

`AgentEvent` is a discriminated union. Every event has a `type` and is shaped to be cheap to pattern-match.

```typescript
type AgentEvent =
  // Lifecycle
  | { type: 'session_start'; continuation: string }
  | { type: 'session_end'; usage: TokenUsage; stopReason: StopReason }
  | { type: 'turn_end'; reason: StopReason }
  | { type: 'error'; message: string; retryable: boolean }

  // Streaming text (assistant message)
  | { type: 'text_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'text_end'; text: string }

  // Streaming reasoning / extended thinking
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end'; text: string }

  // Tool calls (model → tool)
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_input_delta'; id: string; deltaJson: string }
  | { type: 'tool_call_end'; toolCall: ToolCall }

  // Tool results (tool → model)
  | { type: 'tool_result'; result: ToolResult }

  // Liveness — emitted on every underlying SDK event
  | { type: 'activity' };
```

Pi-style `*_start` / `*_delta` / `*_end` lets consumers render incrementally or wait for the final state, whichever they prefer. Backends that don't expose deltas (current Claude backend) skip the delta variants and emit only `*_end` with the complete payload.

`activity` is emitted on every translated SDK event so liveness timers (heartbeats, "still thinking" UI) stay honest even when no other event is firing — useful for long-running tool calls.

`session_start.continuation` is the **opaque** token to pass back as `QueryInput.continuation`. The shape (Claude session UUID, Codex thread ID, …) is backend-defined; consumers store and forward it without parsing.

`stopReason` is one of `'stop' | 'tool_calls' | 'length' | 'aborted' | 'error'`.

`TokenUsage` has `input | output | cacheRead | cacheWrite`. Backends that don't surface a field set it to 0.

### Canonical tool names in events

When a backend emits a tool call, the `name` field on `tool_call_*` events is the **canonical name from our Tool catalog** (e.g. `bash`), not the backend's wire name (e.g. Claude `Bash`, Codex `command/exec`). Consumer code can switch on canonical names without knowing which backend served the call.

Translation works by `canonicalByWireName: Map<string,string>` built at backend construction:

- Claude: `t.native.claude → t.name` for every tool the consumer registered.
- Codex: hand-coded in `translateItem` because Codex's items are typed (e.g. `commandExecution.command`) — the backend rebuilds an input shape that matches our canonical tool's schema, then emits the canonical name.

Tools the consumer didn't register (custom MCP servers wired via Codex config, Claude built-ins not in `tools.all`) fall through to the wire name unchanged.

## Tool model

```typescript
interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;                                  // canonical name
  description: string;
  schema: z.ZodType<TInput>;                     // Zod 4
  native?: { claude?: string; codex?: string };  // backend wire names
  execute?(input: TInput): Promise<TOutput>;     // in-process implementation
}
```

A single Tool definition can fire as **either** the backend's native tool **or** an in-process closure, depending on what the backend supports.

- **Native path.** If the backend has `native[backendName]` set, the backend wires that tool name into its native allowlist (Claude `allowedTools`) or just lets the model call it (Codex's built-ins fire automatically) and the SDK runs the implementation server-side. `execute` is **not** called.
- **MCP-bridge path (Codex only).** If the tool has `execute` and **no** `native.codex`, the Codex backend exposes it through the MCP bridge — the user's closure runs in their process while Codex thinks it's calling an MCP tool. See [Codex backend](backends/codex.md) for the full bridge protocol.
- **In-process path (planned).** When a Vercel AI SDK Agent backend lands, every tool needs an `execute` (Vercel ships no native tools); tools without one are silently skipped.

The asymmetry is deliberate: backends that ship rich native tools (Claude, Codex) get them for free; the wrapper's job is to keep the canonical name in events and let custom user closures coexist.

`schema` is a Zod 4 type. On native paths it's informational (the SDK has its own internal schema). On the bridge path it's load-bearing — the bridge generates JSON Schema via `z.toJSONSchema(t.schema)` for the MCP manifest and validates inputs via `t.schema.safeParse` before invoking `execute`.

### Edit and todo: union schemas

Some tools collapse what would otherwise be two tools into a union:

- **`edit`** accepts either `{path, old_string, new_string}` (Claude's Edit) **or** `{patch}` (Codex's apply_patch). Same canonical name, single Tool. The model emits whichever shape its training prefers; the schema is informational on Claude/Codex (each uses its native).
- **`todo`** accepts either `{todos: [{content, status, activeForm}, …]}` (Claude TodoWrite) **or** `{text: string}` (Codex plan). Same canonical name.

This is the same pattern that lets `bash`, `glob`, `grep`, and `webSearch` map to backend-specific shapes without forcing two canonical tools.

### The `tools.all` toolbox

```typescript
import { tools } from 'agent-sdk';
codex({ tools: tools.all });
codex({ tools: [tools.bash, tools.read, tools.write] });
```

`tools.all` is the default coding-agent toolbox in declaration order: `bash, read, write, edit, glob, grep, webFetch, webSearch, todo`. Pick individuals when you want a narrower surface. Consumers can also define their own `Tool` and pass them mixed in with the catalog.

Per-tool details are in [tools.md](tools.md).

## Backend behavior summary

| | Claude (`@anthropic-ai/claude-agent-sdk`) | Codex (`codex app-server` JSON-RPC) |
|---|---|---|
| Agent loop | Delegated to SDK | Delegated to AppServer |
| Native tools | Selected by `allowedTools` (wire names from `Tool.native.claude`) | Built-ins fire automatically; `Tool.native.codex` is informational |
| Custom tools | Skipped in v0 (in-process MCP a future addition) | Routed through MCP bridge (subprocess shim + Unix socket) |
| Continuation | Session UUID from `system/init` message | Thread ID from `thread/start` response (`{thread:{id}}`) |
| Streaming | `text_end` / `thinking_end` / `tool_call_end` only (coarse) | `text_delta` / `thinking_delta` (streaming) + `*_end` |
| Auth | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (env, read by SDK) | `~/.codex/auth.json` (from `codex login`) or `OPENAI_API_KEY` (env) |
| `push()` mid-turn | Supported (SDK has a streaming user-message iterator) | Not supported — `push` errors; caller should `end()` + `run()` with continuation |
| Subprocess | None | One `codex app-server` per backend instance, lazily spawned, killed on `close()` |

Per-backend wire details are in [backends/claude.md](backends/claude.md) and [backends/codex.md](backends/codex.md).

## Custom tools and the MCP bridge

A user-defined Tool with `execute` and no `native.codex` is exposed to Codex through a small MCP server that runs as a subprocess. The bridge's job is to keep the **closure** (which has access to the user's env vars, in-memory state, network connections) in the parent process while Codex thinks it's calling a normal MCP tool.

```
parent (Node)                                            child (mcp-shim)
─────────────                                            ────────────────
McpBridge.start() opens Unix socket
  → returns { socketPath, manifest }
CodexBackend passes manifest+socket to thread/start
  via mcp_servers config

Codex spawns shim:
  node --import tsx mcp-shim.ts   (env: AGENT_SDK_SOCKET, AGENT_SDK_MANIFEST)
                                                         shim connects to socketPath
                                                         shim speaks MCP-over-stdio to Codex
                                                         shim returns manifest on tools/list

Model calls tool                                         Codex sends CallToolRequest to shim
                                                         shim sends { id, tool, args } over socket
McpBridge handleLine():
  - validates args against zod schema
  - calls tool.execute(args)
  - sends back { id, result: { content: [{ type: 'text', text }] } }
                                                         shim returns { content: [...] } to Codex
                                                         Codex emits a mcpToolCall item
CodexBackend translateItem('mcpToolCall', …)
  emits tool_call_end + tool_result events
```

Wire format on the socket (newline-delimited JSON):

- `→ {"id":N,"tool":"name","args":{…}}`
- `← {"id":N,"result":{"content":[{"type":"text","text":"…"}],"isError":false}}`
- `← {"id":N,"error":{"message":"…"}}`

Bridge lifecycle:

- `start()` is called lazily on first query that has at least one custom tool. Returns the manifest+socket.
- `stop()` destroys all open shim connections (`server.close()` alone hangs waiting for them) and unlinks the socket file. Called from `CodexBackend.close()`.
- One bridge per `CodexBackend` instance; the same shim spawns once per Codex thread that uses custom tools.

The shim resolves its own path relative to `mcp-bridge.ts` so it works in both `tsx`-from-source (`.ts`) and post-build (`.js`) modes. When `.ts`, it spawns as `node --import tsx mcp-shim.ts` (tsx must be in `dependencies`, not `devDependencies` — see [build.md](build.md) → packaging).

## Continuation tokens

Each backend exposes its native session/thread ID as the continuation. Callers store it and pass it as `QueryInput.continuation` to resume.

When the stored token becomes invalid (session purged, transcript missing, daemon restarted with no record of the thread), the SDK throws. The caller catches, calls `backend.isContinuationInvalid(err)` — if `true`, the caller clears the stored token and runs again with no continuation (fresh thread). Each backend's regex matches its SDK's wording:

- Claude: `/no conversation found|ENOENT.*\.jsonl|session.*not found/i`
- Codex: `/thread.*not found|no such thread|thread.*does not exist/i`

## Auth

The wrapper passes through whatever the underlying SDK reads.

| Backend | Mechanism |
|---|---|
| Claude (Pro/Max) | `CLAUDE_CODE_OAUTH_TOKEN` env (run `claude setup-token` once) |
| Claude (API key) | `ANTHROPIC_API_KEY` env |
| Codex (subscription) | `~/.codex/auth.json` from `codex login` |
| Codex (API key) | `OPENAI_API_KEY` env |

Subscription OAuth is licensed for personal use; multi-user products should use API keys. The wrapper enforces nothing — it's the consumer's responsibility to read the licensing terms.

The Codex backend explicitly verifies auth on each `query()` by calling `account/read` first; if `account` is null, it emits an `error` event with `"codex is not logged in. Run \`codex login\` (for ChatGPT) or set OPENAI_API_KEY before using this backend."` and ends the query cleanly.

## Packaging

- `type: "module"` (ESM throughout).
- `engines.node`: ≥ 20.
- `tsconfig.json`: bundler resolution, target ES2022, no `.js` import suffixes (see [build.md](build.md)).
- Direct dependencies: `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `ai` (placeholder for Vercel backend), `zod` (4.x), `tsx` (runtime — needed to load `mcp-shim.ts` from source when consumers `tsx` our package).
- `peerDependencies` (planned for Vercel/OpenAI Agents): `ai`, `@ai-sdk/anthropic`/`@ai-sdk/openai`/`@openai/agents` — caller picks which providers to install.
- Codex AppServer is invoked as the `codex` CLI on `PATH` — not an npm dependency.

## Status and roadmap

- ✅ Claude Agent SDK backend — native tools only; `*_end`-only events
- ✅ Codex AppServer backend — with MCP bridge for custom tools, streaming deltas, native browsing → canonical `webSearch`/`webFetch` events
- 🚧 Vercel AI SDK Agent backend — see [docs/vercel-ai-sdk-agent.md](../docs/vercel-ai-sdk-agent.md). Unlocks local models (Ollama / vLLM / LM Studio / llama.cpp) and provider-agnostic model selection.
- 🚧 OpenAI Agents SDK backend — see [docs/openai-agents.md](../docs/openai-agents.md). Separate from Codex; adds OpenAI's hosted tools (Code Interpreter, Computer Use, file_search) and built-in tracing for API-key users.

The roadmap docs under `docs/` capture integration shape, what needs building, and open questions per planned backend. They live outside `spec/` because they're forward-looking design notes, not contracts the build must produce.

## Guidelines

- **Don't reimplement what the SDK already does.** No retry policies, no token-budget logic, no agent loops. If the SDK exposes it badly, expose it through; don't paper over.
- **Canonical names everywhere.** Events that flow to consumers carry catalog names; wire names are an implementation detail of the translator.
- **Backends are isolated.** No backend imports another backend's code. Shared types live in `src/types.ts` and `src/tools/`.
- **Subprocess hygiene.** Anything spawned (Codex, MCP shim) must clean up on `close()`. Pre-emptively destroy sockets — `server.close()` waits for connections to drain, which can hang.
- **Pass-through escape hatches.** Each backend's options interface accepts the underlying SDK's options where reasonable (`permissionMode`, `additionalDirectories`, `env`, `developerInstructions`) so consumers don't need to fork the wrapper to access provider-specific knobs.

## Security considerations

- **No sandboxing.** Tools run with the consumer's process permissions. Run the wrapper inside a container if you need isolation.
- **Auth is not stored.** All credentials are read from env or the underlying SDK's on-disk state. Don't log credentials.
- **Closure capture.** Custom tools' `execute` bodies run in the parent process and have access to whatever's in scope. This is the *point* of the bridge — but it means a misbehaving tool can do anything the consumer can.
- **MCP shim stderr leaks.** The shim writes startup/connection log lines to stderr, which Codex forwards to the parent's `[codex]` channel. Don't put secrets in tool descriptions or the manifest.
