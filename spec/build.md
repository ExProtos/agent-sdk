# Build

Step-by-step instructions for regenerating `agent-sdk` from this spec. Read [architecture.md](architecture.md) first — it defines the contracts this document tells you to implement.

All paths in this document are relative to the package root.

## Before you start

This is a library, not an application — there's no first-run flow, no config files to write, no daemon to spawn. The build creates a TypeScript package that consumers install and import.

## Key packages

- `@anthropic-ai/claude-agent-sdk` — Anthropic's official Claude agent SDK. Provides `query()`, `Options`, `SDKMessage`, `SDKUserMessage`. Used directly by the Claude backend.
- `@modelcontextprotocol/sdk` — MCP TypeScript SDK. Used by the Codex backend's `mcp-shim.ts` to speak MCP-over-stdio to Codex.
- `ai` — Vercel AI SDK. Listed as a dependency in anticipation of the Vercel backend; not used by the current code.
- `zod` (4.x) — schema validation. Tool definitions use Zod types; the MCP bridge converts to JSON Schema via `z.toJSONSchema()`.
- `tsx` — TypeScript runner. **Runtime dependency**, not a devDependency: the Codex backend spawns `mcp-shim.ts` from source via `node --import tsx`, so consumers running our code via `tsx` need `tsx` resolvable from our package.
- `vitest` — test runner (devDependency). Two configs: `vitest.config.ts` for unit (excludes `test/e2e/**`) and `vitest.e2e.config.ts` for e2e (loads `.env.test`).
- `typescript` ≥ 5.7 (devDependency).

## Step-by-step

### 1. Initialize the package

- `package.json`:
  - `"type": "module"`
  - `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`
  - Scripts: `build` (`tsc -p tsconfig.json`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:watch`, `test:e2e` (`vitest run --config vitest.e2e.config.ts`), `test:all` (run unit then e2e).
  - `engines.node`: `>=20.0.0`.
  - Direct deps and devDeps per the package list above.
- `tsconfig.json`:
  - `target: "ES2022"`, `module: "ESNext"`, `moduleResolution: "bundler"`.
  - `bundler` resolution is deliberate — it lets us write `import './foo'` without `.js` suffixes, which `NodeNext` would require. Consumers with their own bundler (or running via `tsx`) handle resolution.
  - `strict: true`, `declaration: true`, `outDir: "./dist"`, `rootDir: "./src"`.
  - Include `src/**/*`. Exclude `dist`, `node_modules`, `test`, `examples`.
- Source goes in `src/` per the [Source layout](architecture.md#source-layout). Tests go in `test/`.

### 2. Define core types

Implement `src/types.ts`. Contracts in [architecture.md](architecture.md) → Event model and The `Agent` API. Export:

- `StopReason`: `'stop' | 'tool_calls' | 'length' | 'aborted' | 'error'`
- `TokenUsage`: `{ input, output, cacheRead, cacheWrite }`
- `ToolCall`: `{ id, name, input }`
- `ToolResult`: `{ toolCallId, output, isError }`
- `AgentEvent`: full discriminated union per the architecture doc.
- `QueryInput`: `{ message?, continuation?, cwd?, systemPromptAppend? }`
- `AgentQuery`: `{ push, end, abort, events }`
- `Backend`: `{ name, query, isContinuationInvalid?, close? }`

This file is types-only — no runtime code. Backends and the Agent class import from it.

### 3. Define the Tool model

Implement `src/tools/types.ts`. ~30 LOC. Exports:

- `Tool<TInput, TOutput>`:

  ```typescript
  interface Tool<TInput = unknown, TOutput = unknown> {
    name: string;
    description: string;
    schema: z.ZodType<TInput>;
    native?: { claude?: string; codex?: string };
    execute?(input: TInput): Promise<TOutput>;
  }
  ```
- `ToolResultContent`: `{ type: 'text'; text } | { type: 'image'; data; mimeType }`.

### 4. Build the canonical tool catalog

Implement `src/tools/builtin.ts` per [tools.md](tools.md). Each tool is a single `export const` of type `Tool` with `name`, `description`, `schema`, and `native` filled in. Most tools have **no** `execute` — Claude and Codex both have natives so neither bridge nor in-process execution is needed today.

- Implement `src/tools/implementations.ts` for tools that *do* have an `execute`. Today only `webFetch` (used as a placeholder for the planned Vercel backend; Codex's `webSearch` covers it natively, so the bridge path is never used in v0).
- Export the catalog from `builtin.ts`:

  ```typescript
  export const all: Tool[] = [bash, read, write, edit, glob, grep, webFetch, webSearch, todo];
  ```
- The full set is re-exported from `src/index.ts` as `tools`:

  ```typescript
  export * as tools from './tools/builtin';
  ```
  so consumers write `tools.all`, `tools.bash`, etc.

### 5. Build the `Agent` class

Implement `src/agent.ts`. ~25 LOC. Just:

```typescript
class Agent {
  readonly backend: Backend;
  constructor(config: { backend: Backend }) { this.backend = config.backend; }
  run(input: QueryInput): AgentQuery { return this.backend.query(input); }
  async close() { await this.backend.close?.(); }
}
```

Re-export the public types alongside.

### 6. Build the Claude backend

Implement `src/backends/claude/index.ts` per [backends/claude.md](backends/claude.md). Single file. Exports `ClaudeBackend`, `claude(options)`, `ClaudeBackendOptions`.

Key implementation points (full contract in the backend spec):

- Build `canonicalByWireName` Map from `Tool.native.claude → Tool.name` at construction time.
- `allowedTools` is the array of wire names from registered tools that have `native.claude` set.
- `query()` opens a `MessageStream` (push-based async iterable yielding `SDKUserMessage`), passes it as `prompt` to the SDK's `query()`, and async-iterates the SDK's responses.
- **End the stream when the SDK emits a `result` message.** Without this the SDK iterator stays alive waiting for more user messages — turn-scoped queries hang forever.
- `translateMessage(message, canonicalByWireName)` is a generator function — the events generator awaits SDK messages and yields `activity` then `yield* translateMessage(…)`.
- Errors from the SDK iterator are caught and yielded as `{ type: 'error', message, retryable: false }`.

### 7. Build the Codex backend

Implement `src/backends/codex/{index,client,protocol,mcp-bridge,mcp-shim}.ts` per [backends/codex.md](backends/codex.md).

#### 7a. JSON-RPC protocol types (`protocol.ts`)

Hand-written subset of [Codex's JSON-RPC schema](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema). Only the types the backend uses. **Don't try to be exhaustive** — Codex's full surface is 50+ notifications and ~30 request methods. Generate from upstream (`codex app-server generate-ts`) if/when broader coverage is needed.

Required:

- Request params/responses: `InitializeParams`, `ThreadStartParams`/`Response`, `ThreadResumeParams`/`Response`, `TurnStartParams`/`Response`, `TurnInterruptParams`, `LoginAccountParams`/`Response`, `GetAccountResponse`.
- `UserInput`: `{ type: 'text'; text; text_elements: [] } | { type: 'image'; url } | { type: 'localImage'; path }`.
- `ThreadItem` discriminated union: `agentMessage`, `reasoning`, `plan`, `commandExecution`, `fileChange`, `webSearch`, `collabAgentToolCall`, `mcpToolCall`, `dynamicToolCall`. Include the bare `{ type: string; id: string }` fallback variant — Codex's protocol grows; unknown items shouldn't crash the type checker.
- `ServerNotification` union: `thread/started`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/textDelta`, `error`, plus a `{ method: string; params: unknown }` fallback.

**Critical correctness fix:** `ThreadStartResponse` is `{ thread: { id: string } }`, **not** `{ threadId }`. Reading the wrong field hands back `undefined` and breaks subsequent `turn/start` calls.

#### 7b. Stdio JSON-RPC client (`client.ts`)

`CodexClient` spawns `codex app-server` as a subprocess (overridable via `command`/`args`/`env`/`cwd` options). Speaks newline-delimited JSON on stdin/stdout — **note Codex omits the `"jsonrpc": "2.0"` header**, per its README, so emit and accept without it.

- `static start(options)` spawns the child, runs the `initialize` request, sends the `initialized` notification, returns a ready client.
- `request<T>(method, params)` returns a Promise that resolves on the matching response or rejects with `CodexRpcError`.
- `notify(method, params)` is fire-and-forget.
- `onNotification(handler)` registers a notification listener; returns an unsubscribe function.
- `close()` SIGTERMs the child, waits up to 1s, then SIGKILL.
- Stdin EPIPE / write-after-close is handled — `child.stdin.on('error')` fires async without an exit event.
- Stderr from the child is forwarded with `[codex]` prefix to our stderr.

**`defaultServerRequestResponse(method)`** — Codex makes server-initiated requests too (asks the client to approve a command, accept a tool call, etc.). Sending the wrong shape stalls the conversation with deserialization errors. The defaults:

| Method | Default response |
|---|---|
| `item/commandExecution/requestApproval` | `{ decision: 'decline' }` |
| `item/fileChange/requestApproval` | `{ decision: 'decline' }` |
| `applyPatchApproval` | `{ decision: 'decline' }` |
| `execCommandApproval` | `{ decision: 'decline' }` |
| `item/permissions/requestApproval` | `{ permissions: {}, scope: 'turn' }` |
| `mcpServer/elicitation/request` | `{ action: 'accept', content: {}, _meta: null }` |
| `item/tool/call` | `{ contentItems: [{ type: 'inputText', text: 'No handler registered…' }], success: false }` |
| `item/tool/requestUserInput` | `{ action: 'decline' }` |
| (default) | `{}` |

The `mcpServer/elicitation/request` auto-accept is correct because the user explicitly opted into the MCP-served tool by passing it to `codex({ tools: [...] })`. (If we ever expose Codex's TOML config so users can wire in additional MCP servers we don't know about, this auto-accept would need tightening.)

#### 7c. Backend (`index.ts`)

`CodexBackend` exposes `query()` per the standard Backend contract and owns the JSON-RPC client lifecycle.

- One `CodexClient` per backend instance, lazy-spawned on first query (`ensureClient()`), killed on `close()`.
- One `McpBridge` per backend instance, lazy-started on first query that has at least one custom tool (`ensureBridge()`).
- `customTools` is the subset of registered tools that have `execute` and **no** `native.codex`. Codex's built-ins always win when `native.codex` is set — they fire automatically server-side, no registration needed.
- `query()` is wrapped in try/catch that yields a final `error` event for any failure (including the `CodexAuthRequiredError` thrown when `account/read` returns null).
- For new threads, send `thread/start` with `model`, `developerInstructions`, optional `cwd`, `experimentalRawEvents: false`, `persistExtendedHistory: false`, and the `mcp_servers` config when the bridge is active.
- For continuations, send `thread/resume` with the same fields except `model` (it's pinned at thread creation).
- Read `resp.thread.id` (not `threadId`) and emit `session_start` with it.
- Then send `turn/start` with `{ threadId, input: [{ type: 'text', text: message, text_elements: [] }] }`. (`text_elements: []` is required by the protocol.)
- The notification handler translates `item/agentMessage/delta` → `text_delta`, `item/reasoning/textDelta` → `thinking_delta`, `item/completed` → `translateItem(item)`, `turn/completed` → `session_end`, `error` → `error`.
- `push()` is not supported — emit `error` with `"push() not supported on Codex backend; end() and run() with continuation instead"`. Codex doesn't permit concurrent turns on a thread.
- `abort()` calls `notify('turn/interrupt', { threadId })` (best-effort) and ends the queue.

`translateItem` maps Codex's typed items to canonical events:

- `commandExecution` → `tool_call_end` named `bash` with `{command}` input + a `tool_result` carrying `aggregatedOutput` and `exitCode !== 0` for `isError`.
- `fileChange` → `tool_call_end` named `edit` with `{changes}` input. Only emit a `tool_result` when status is `completed | failed | declined` (skip `inProgress` — interim updates would orphan the call).
- `plan` → `tool_call_end` named `todo` with `{text}` input.
- `webSearch.action.type === 'openPage'` → `tool_call_end` named `webFetch` with `{url}`. All other actions → `webSearch` with `{query}` (or `{queries}` / `{url, pattern}` for variants).
- `mcpToolCall` / `dynamicToolCall` → `tool_call_end` with the tool's wire name unchanged + a `tool_result` if `result` or `error` is present.

The tool name on `commandExecution`/`fileChange`/`plan`/`webSearch` maps via the `builtin.<tool>.name` constant, not a hard-coded string — so renaming a builtin only touches `builtin.ts`.

#### 7d. MCP bridge (`mcp-bridge.ts`)

`McpBridge` is the in-process side of the bridge.

- `register(tool)` adds a tool to the registry. Throws if no `execute`.
- `start()` opens a Unix socket (or Windows named pipe) at a unique path under `os.tmpdir()`, returns `{ socketPath, manifest }`. Manifest is `[{ name, description, inputSchema: z.toJSONSchema(t.schema) }]`.
- `stop()` **destroys all open shim connections explicitly** — `server.close()` alone waits for them to drain and can hang indefinitely. Track sockets in `Set<Socket>`, destroy them all, then close the server, then unlink the socket file.
- Connection handler reads newline-delimited JSON. For each `{id, tool, args}`:
  - Look up the tool. If unknown → write back `{id, error: { message: 'unknown tool: …' }}`.
  - `tool.schema.safeParse(args)`. If invalid → write back error.
  - `await tool.execute(parsed.data)`. Stringify result if not already a string. Write back `{id, result: { content: [{ type: 'text', text }] }}`.
  - On throw → write back error.

Socket path generator: `agent-sdk-${pid}-${Date.now()}-${random}`. On POSIX, joined with `os.tmpdir()` and `.sock`. On Windows, the `\\.\pipe\…` form.

#### 7e. MCP shim (`mcp-shim.ts`)

The subprocess Codex spawns. Reads `AGENT_SDK_SOCKET` and `AGENT_SDK_MANIFEST` from env on startup; if either is missing, exit 1 with a stderr message.

- Parse `AGENT_SDK_MANIFEST` as JSON.
- Connect to `AGENT_SDK_SOCKET`. Print connection status to stderr (Codex forwards it to the parent's `[codex]` channel — useful for debugging).
- Construct an MCP `Server` named `agent-sdk-bridge` with `capabilities: { tools: {} }`.
- Handle `ListToolsRequestSchema` → return the manifest.
- Handle `CallToolRequestSchema` → assign next ID, send `{id, tool, args}` over the socket, wait for response, return `{ content }` (or `{ content: [{type:'text', text: error.message}], isError: true }` on error).
- Connect the server with `StdioServerTransport()` so Codex talks to it on stdin/stdout.

The shim's path resolves dynamically in the parent so `tsx`-from-source and post-build both work:

```typescript
const here = fileURLToPath(import.meta.url);
const ext = path.extname(here); // '.ts' or '.js'
const shim = path.join(path.dirname(here), `mcp-shim${ext}`);
const spawn = ext === '.ts'
  ? { command: 'node', args: ['--import', 'tsx', shim] }
  : { command: 'node', args: [shim] };
```

When spawned with `tsx`, `tsx` resolves through node_modules from the shim's directory — which is why `tsx` must be a dependency of our package, not just a devDependency.

### 8. Wire up the public surface

`src/index.ts` re-exports:

```typescript
export { Agent, type AgentConfig } from './agent';
export type { AgentEvent, AgentQuery, Backend, QueryInput,
              StopReason, TokenUsage, ToolCall, ToolResult } from './types';
export type { Tool, ToolResultContent } from './tools/types';
export * as tools from './tools/builtin';
export { claude, ClaudeBackend, type ClaudeBackendOptions } from './backends/claude/index';
export { codex,  CodexBackend,  type CodexBackendOptions  } from './backends/codex/index';
```

Note `tools` is a namespace re-export — consumers write `tools.all`, `tools.bash`, etc.

### 9. Examples

Under `examples/`:

- `chat.ts` — interactive Claude chat loop using readline.
- `codex-chat.ts` — interactive Codex chat loop.
- `codex-custom-tool.ts` — a custom `currentTime` Tool wired through the MCP bridge, demonstrating closure capture (env var read at definition time, not call time).
- `claude-hello.ts` — simplest possible Claude usage.

Examples are run via `pnpm exec tsx examples/<name>.ts`.

## Tests

See [test.md](test.md). Build with the test layout in place from the start — adding tests after the fact tends to surface incidental coupling that the test harness has to work around.

## Before you're done

- `pnpm typecheck` passes (`tsc --noEmit`)
- `pnpm test` (unit) passes — should be fast, ~1s, no network
- `pnpm test:e2e` passes when `.env.test` is configured; tests that depend on missing credentials skip cleanly
- `pnpm build` produces `dist/` with `.js` and `.d.ts` files for every `src/` module
- The 9-tool catalog roundtrips: a Codex e2e test that registers a custom tool and verifies the closure ran in the parent process (sentinel value flows shim → socket → parent → `execute` → return → MCP → model)
- No backend imports another backend's code — `grep -r "backends/codex" src/backends/claude` and vice versa return nothing
