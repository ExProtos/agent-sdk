# Learnings from Prior Art

Synthesis of architectural patterns from four projects, mapped to design decisions for our wrapper.

Sources skimmed:
- **NanoClaw** `/Users/justin/src/nanoclaw` — agent-runner provider abstraction + Claude Agent SDK usage
- **OpenClaw** `/Users/justin/src/openclaw` — Codex AppServer JSON-RPC client + Pi as agent core
- **Pi** [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono) — multi-provider event stream + OAuth
- **one-agent-sdk** [github.com/odysa/one-agent-sdk](https://github.com/odysa/one-agent-sdk) — drop-in `query()` with backend dispatch

## NanoClaw — clean minimal `AgentProvider`

`container/agent-runner/src/providers/types.ts` is the cleanest, smallest provider interface I've seen:

```typescript
interface AgentProvider {
  readonly supportsNativeSlashCommands: boolean;
  query(input: QueryInput): AgentQuery;
  isSessionInvalid(err: unknown): boolean;  // detect stale resume tokens
}

interface AgentQuery {
  push(message: string): void;     // mid-flight follow-up
  end(): void;                     // close input stream
  events: AsyncIterable<ProviderEvent>;
  abort(): void;
}

type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  | { type: 'activity' };  // liveness — yielded on every SDK event
```

**Borrow:**
- The `AgentQuery` shape with `push`/`end`/`events`/`abort` — push-based async iterator for input, pull-based for output. Models real-world agent interaction (mid-flight messages, abort).
- **Opaque `continuation` token.** Provider decides what it means (Claude session ID, Codex thread ID, replay-from-history, nothing). Caller never inspects.
- **`isSessionInvalid(err)`** — providers detect their own stale-resume errors via regex/code matching. Beats unifying error types we don't control.
- **Activity event for liveness.** Every SDK event triggers `{type: 'activity'}` so timers/UIs can detect a wedged agent. Cheap, universal.
- **Registry pattern** — `registerProvider('claude', factory)`. `providers/index.ts` is a barrel of self-registering imports.

**Specific Claude-backend lessons (`providers/claude.ts`):**
- `SDK_DISALLOWED_TOOLS` list at provider construction time — Claude Agent SDK ships tools that don't fit headless containers (`AskUserQuestion`, `EnterPlanMode`, scheduling). The provider knows; the caller doesn't.
- `TOOL_ALLOWLIST` is *also* defined at the provider — defense-in-depth pairing with `disallowedTools`.
- PreToolUse hook used for **logging + dynamic timeout extension** (Bash declares its own timeout, hook records it for the host-side stuck detector). Universal pattern: hooks = the wrapper's internal observability layer.
- PostToolUse + PostToolUseFailure both fire the same cleanup hook — important to set both, easy to miss.
- PreCompact hook used to archive transcripts. Useful: non-data-path lifecycle hooks for backup/audit.

**Avoid:**
- **`permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`** baked in. NanoClaw needs it (headless container, can't show prompts). Our wrapper should default to safer behavior and let callers opt in.

NanoClaw's narrow event vocabulary (`init | result | error | progress | activity`) is too coarse for our purposes — we want streaming text, tool calls, etc. surfaced. Extend, don't copy.

## OpenClaw — production Codex AppServer integration

`extensions/codex/src/app-server/` is the reference implementation for our Codex backend.

### Architecture

```
client.ts                    — JSON-RPC client (request/notify, pending map, handlers)
client-factory.ts            — factory abstraction (lets tests swap)
shared-client.ts             — singleton-per-config cache
transport-stdio.ts           — stdio spawning with Windows path resolution
transport-websocket.ts       — websocket transport (for remote codex)
config.ts                    — typed start options + key hashing
auth-bridge.ts               — separate auth profile application
protocol.ts                  — re-exports + manual typing
protocol-generated/          — auto-generated TS from upstream Codex schema
  typescript/                — ~80 generated files (AbsolutePathBuf, AuthMode, etc.)
protocol-validators.ts       — runtime validation of incoming messages
run-attempt.ts               — turn lifecycle wrapper
approval-bridge.ts           — pending approvals → human approver
user-input-bridge.ts         — pending questions → user reply
context-engine-projection.ts — transcript projection for compaction
trajectory.ts                — observability/replay
capabilities.ts              — feature detection
```

### Borrow

- **`CodexAppServerClient.start(options?)`** static factory. Private constructor. Accepts partial options merged with defaults from `resolveCodexAppServerRuntimeOptions()`. Selects transport (stdio vs websocket) based on options.
- **Generic typed `request<M>`** — overloaded so known method names are typed against generated protocol, fallback signature for unknown methods.
- **Notification + request handler sets** — server-initiated messages (approval requests, fuzzy file search) get routed via handler registries. `addNotificationHandler(fn)` / `addRequestHandler(fn)`.
- **Close handlers + cleanup propagation** — `closeWithError()` rejects all pending requests, fires close handlers. Critical for not leaving orphaned promises when Codex dies mid-stream.
- **Singleton-per-config cache** — `getSharedCodexAppServerClient({startOptions, authProfileId})` keyed by hash of start options. Multiple agents in the same Node process share one Codex daemon.
- **Auth bridge as separate module** — `applyCodexAppServerAuthProfile()` runs *after* `initialize()`. Auth concerns isolated from transport concerns.
- **Generated protocol types from upstream** — `scripts/sync-codex-app-server-protocol.ts` copies from a local clone of `openai/codex` into `protocol-generated/`, with selective JSON-schema pinning and import rewriting. **We should do the same.**
- **`assertSupportedCodexAppServerVersion(response)`** — explicit version compatibility check on `initialize` response. Future-proofs against breaking protocol changes.
- **stderr capture for debugging** — child stderr piped to a debug logger, not silent. Codex emits useful errors there.
- **EPIPE/`stdin.on('error')` guard** — async stdin write errors bypass `exit` event; explicit error handler prevents host crashes when child terminates abruptly.

### Specific OpenClaw decisions worth copying

- **Not using `@openai/codex-sdk`** — confirmed by the absence of any reference to it in `app-server/`. Going to JSON-RPC directly.
- **Transport types separated from protocol types** — `transport.ts` defines the `CodexAppServerTransport` interface (subprocess-or-websocket); `protocol.ts` defines wire types. We can extend transport later without touching protocol.

## Pi — the cleanest event stream and OAuth design

### `Api × Provider × compat` three-axis split

Pi separates:
- **`Api`** — wire protocol (~10): `anthropic-messages`, `openai-responses`, `openai-completions`, `google-generative-ai`, `bedrock-converse-stream`.
- **`Provider`** — model metadata (~25): `anthropic`, `openai`, `deepseek`, `groq`, `openrouter`, `xai`, `mistral`, …
- **`compat`** — per-Model quirks: `thinkingFormat`, `cacheControlFormat`, `maxTokensField`, `requiresAssistantAfterToolResult`, …

One `openai-completions` Api serves a long tail of OpenAI-shaped backends.

**Doesn't directly apply to our wrapper** — we have 4 distinct *agent SDKs*, not 25 model providers. Vercel AI SDK already does this for the model layer underneath us. **But:** the principle (separate transport quirks from semantic identity) is something to preserve when we expose backend-specific options.

### Normalized event stream — copy this directly

Pi's `AssistantMessageEvent` union is the cleanest streaming protocol I've seen:

```typescript
type AssistantMessageEvent =
  | { type: 'start' }
  | { type: 'text_start' | 'text_delta' | 'text_end'; ... }
  | { type: 'thinking_start' | 'thinking_delta' | 'thinking_end'; ... }
  | { type: 'toolcall_start' | 'toolcall_delta' | 'toolcall_end'; ... }
  | { type: 'done' | 'error'; ... };
```

**Each event carries a partial `AssistantMessage` snapshot** alongside the delta. Consumers can render from the snapshot (always-current full state) or from the delta (incremental). This is the killer feature — no need to choose between "easy to consume" and "efficient to stream."

### `AgentMessage` vs `Message` boundary

Agent loop holds `AgentMessage[]` extensible via TS declaration merging (`CustomAgentMessages`). Converts to provider-shaped `Message[]` only at the LLM boundary via user-supplied `convertToLlm`.

Lets apps stash UI-only messages (status, system events, partial agent actions) in the transcript without polluting the provider payload. **Strong pattern. Borrow.**

### Tool `Operations` injection

```typescript
interface BashOperations { exec(...): Promise<...> }
interface EditOperations { applyPatch(...): Promise<...> }
interface ReadOperations { readFile(...): Promise<...> }

const bashTool = defineTool({
  name: 'bash',
  parameters: ...,
  factory: (ops: BashOperations) => async ({command}) => ops.exec(command),
});
```

Same tool *definition*; swappable execution backend. Default `createLocalBashOperations` spawns locally; SSH/remote backends supply their own. **This is exactly what we want for the polyfill story** — `bash` tool definition is universal, `BashOperations` is what swaps between native (claude `Bash`) and polyfill (`child_process.exec`).

### OAuth — single interface, real diversity

```typescript
interface OAuthProviderInterface {
  id: string;
  name: string;
  login(callbacks): Promise<Credentials>;
  refreshToken(creds): Promise<Credentials>;
  getApiKey(creds): Promise<string>;
  modifyModels?(models, creds): Models;  // Copilot uses this to rewrite baseUrl from token claim
}
```

Five implementations, three flow shapes:
1. **PKCE + loopback callback server** — Anthropic, Codex, Gemini, Antigravity. Each uses a different fixed port (53692, 1455, 8085, …).
2. **Device-code polling** — GitHub Copilot. Two-step (GitHub OAuth → Copilot token via `/copilot_internal/v2/token`).
3. **Manual paste fallback** for headless environments.

**`getApiKey` resolved per-turn**, not once at start. Copilot tokens expire mid-tool-execution; per-turn refresh handles it. Borrow: our `Agent.run()` should consult auth-state before each turn, not cache.

**Key architectural note:** Pi stores tokens as plaintext `~/.pi/agent/auth.json`. We should NOT do this — defer to the caller's choice (env var, OneCLI, KMS, whatever). Our OAuth surface is the `login()` flow; storage is out of scope.

### Avoid from Pi

- Plaintext auth.json — caller's problem, not ours
- Hardcoded base64-obfuscated client IDs of other vendors' apps (works until revoked, fragile)
- No tool sandboxing — fine for CLI, wrong default for embedded use. Container at deployment.
- Five separately-implemented callback servers — factor out one helper if we end up doing this
- Tools live in `pi-coding-agent`, not `pi-agent-core` — every embedder reinvents `read`/`write`/`bash`. **We should ship a default tool layer.**

## one-agent-sdk — what NOT to do (mostly)

Closest existing wrapper. Useful as a what-not-to-do reference, with a few patterns worth borrowing.

### Borrow

- **Symbol-tagged mock MCP server** — `createSdkMcpServer()` returns a config object tagged with a symbol (`MOCK_MCP_SERVER`). The same tool object materializes into a real Anthropic in-process MCP server (claude path) or gets stripped to `ToolDef[]` (other backends). Clean polymorphism without forking the public API.
- **Tiny `StreamChunk` union** — 6 variants (`text | tool_call | tool_result | handoff | error | done`). Enough surface for an MVP. We'll want a richer union, but the principle (small union, not bloated) is right.
- **Dynamic import with install hint** — peer deps stay optional; error message tells user the exact `bun add @openai/codex-sdk` to run. UX for a wrapper-of-many-things.
- **Happy-path short-circuit** — when backend is Claude, dispatch straight to `@anthropic-ai/claude-agent-sdk` with no translation layer. Zero overhead on the most common path.

### Avoid

- **Force-fitting output into `SDKMessage` (Anthropic shape)** — every other backend's richness (thinking blocks, citations, hooks, permission events) gets dropped at the adapter boundary. **Don't pick one provider's wire format as canonical.** Use a richer union (Pi-style).
- **Hand-rolling streaming tool loops in `openai.ts`/`anthropic.ts`** — ~200 lines per provider that AI-SDK or the official agent SDKs already give you. We should *call* the SDKs, not reimplement them.
- **Module-scoped `messages[]` shared across calls** — `chat()` and `run()` interleave history when called concurrently. Keep state per-run.
- **Synthetic `handoff_to_X` tools mutating `currentAgent` mid-stream** — handoffs deserve a real orchestrator, not a tool-call hack.
- **`providerOptions: Record<string, unknown>`** as the per-backend escape hatch — typed nowhere, every adapter ad-hoc-casts. **Type per-backend options properly** (`claude: ClaudeOptions, openai: OpenAIOptions, …`).
- **Two parallel APIs in one package** (current `query()` + deprecated `run()`/sessions/middleware tree). Pick one; ship one.
- **Double-baked permission bypass** (`permissionMode: 'bypassPermissions' + allowDangerouslySkipPermissions: true`) by default. Wrong default for a general wrapper.

## Synthesized design decisions

### 1. UnifiedAgent interface — combine NanoClaw shape + Pi events

```typescript
interface AgentProvider {
  readonly capabilities: ProviderCapabilities;
  query(input: QueryInput): AgentQuery;
  isSessionInvalid?(err: unknown): boolean;
  close?(): Promise<void>;  // for subprocess backends (Codex)
}

interface AgentQuery {
  push(message: string): void;
  end(): void;
  events: AsyncIterable<AgentEvent>;
  abort(): void;
}

interface QueryInput {
  prompt: string;
  continuation?: string;  // opaque to caller; provider-defined
  cwd?: string;
  systemContext?: { instructions?: string };
}

type AgentEvent =
  // Lifecycle
  | { type: 'session_start'; sessionId: string }
  | { type: 'session_complete'; usage: TokenUsage }
  | { type: 'turn_complete'; reason: 'stop' | 'tool_calls' | 'length' | 'aborted' }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }

  // Streaming content (Pi-style: start/delta/end with snapshot)
  | { type: 'text_start' }
  | { type: 'text_delta'; delta: string; snapshot: string }
  | { type: 'text_end'; final: string }

  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string; snapshot: string }
  | { type: 'thinking_end'; final: string }

  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_input_delta'; id: string; partial: unknown }
  | { type: 'tool_call_end'; id: string; name: string; input: unknown }

  | { type: 'tool_result'; id: string; output: unknown; isError?: boolean }

  // Liveness (NanoClaw pattern)
  | { type: 'activity' }
  | { type: 'progress'; message: string };
```

### 2. Tool layer — Pi's Operations injection

```typescript
interface BashOperations { exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> }
interface ReadOperations { readFile(path: string): Promise<string> }
interface WriteOperations { writeFile(path: string, content: string): Promise<void> }
// ...

interface ToolDefinition<TParams, TResult, TOps> {
  name: string;
  description: string;
  schema: ZodSchema<TParams>;
  operations: TOps;  // dependency injection slot
  native?: { claude?: string; codex?: string; openai?: string };
  factory(ops: TOps): (params: TParams) => Promise<TResult>;
}
```

When backend is Claude and `native.claude` is set, route to native tool. Otherwise, instantiate via `factory(operations)` and register as in-process MCP. Operations can be swapped at construction time (e.g. for SSH/remote execution).

### 3. Backend dispatch — per-call AND per-instance, both supported

NanoClaw passes provider at construction time. one-agent-sdk passes per-call. We support both:

```typescript
const agent = new Agent({ backend: 'claude', ... });          // bound at construction
agent.run({ prompt, options: { backend: 'codex' } });          // override per-call (rare)
```

Per-construction is the main path. Per-call override is an escape hatch.

### 4. Codex backend — copy OpenClaw's architecture

- Generic typed JSON-RPC client (`request<M>`, `notify`, handler registries)
- Static factory `CodexClient.start(options?)` with private constructor
- Singleton-per-config shared client cache for in-process reuse
- Auth bridge as separate module, applied after `initialize()`
- Generated protocol types via `codex app-server generate-ts` from a pinned Codex version
- Notification + request handler sets for server-initiated messages
- EPIPE/stdin error guards
- Version compatibility check at handshake

### 5. OAuth — Pi's interface, no storage

```typescript
interface AuthProvider {
  id: string;
  login(callbacks): Promise<Credentials>;
  refreshToken(creds): Promise<Credentials>;
  getApiKey(creds): Promise<string>;
  modifyModels?(models, creds): Models;
}
```

The wrapper exposes the interface; the *caller* implements storage (env var, OneCLI vault, keychain, whatever). Five flow shapes (PKCE+loopback, device-code, manual paste, two-step exchange, per-token base-URL) all fit this interface.

`getApiKey` is called per-turn, not once. Handles short-lived tokens.

### 6. Public API shape

```typescript
import { Agent, tools } from 'agent-sdk';

const agent = new Agent({
  backend: 'claude',
  model: 'claude-sonnet-4-6',
  tools: [
    tools.read,
    tools.write,
    tools.bash.with(customBashOps),  // override Operations
    tools.webSearch({ provider: 'tavily' }),
  ],
  cwd: process.cwd(),
  // typed per-backend escape hatches
  claude: { permissionMode: 'default', /* ClaudeAgentSDKOptions */ },
  codex: { sandboxMode: 'workspace-write' },
  openai: { tracing: { ... } },
  vercel: { stopWhen: stepCountIs(20) },
});

const query = agent.run({ prompt: '...' });
for await (const event of query.events) {
  // ...
}
query.push('follow-up');
query.end();
```

Note `tools` are values that can be `.with(operations)` to swap execution backends. Per-backend options are **typed**, not `Record<string, unknown>`.

### 7. Build order (revised from earlier `wrapper-design.md`)

1. **Types layer** — define `AgentProvider`, `AgentQuery`, `AgentEvent`, `Tool*Operations`, `AuthProvider` as types only. No implementations. Make sure the public API in section 6 type-checks end-to-end with empty bodies.
2. **Vercel AI SDK Agent backend first** — forces tool polyfill layer to exist on day 1; unlocks local models; in-process so no subprocess complexity.
3. **Claude Agent SDK backend** — happy-path short-circuit + native tool routing. A/B against the polyfilled versions to tune semantics.
4. **Codex backend** — most architectural risk; subprocess + JSON-RPC + login flow. Crib heavily from OpenClaw.
5. **OpenAI Agents SDK backend** — last; mostly redundant with Vercel + `@ai-sdk/openai` for v1 unless we want hosted `code_interpreter`/`computer_use`.

## What this changes about wrapper-design.md

- `AgentEvent` union becomes much richer (Pi-style start/delta/end with snapshots) — update the doc.
- Tool catalog gains the `Operations` injection model — update the doc.
- Public API gains typed per-backend options instead of generic escape hatches — update the doc.
- Codex backend section gains the OpenClaw reference architecture (singleton cache, auth bridge separation, version check).
- Add an explicit `AuthProvider` section based on Pi's interface.

I'll do these updates next.
