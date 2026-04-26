# OpenAI Agents backend

Wraps `@openai/agents` (npm) — OpenAI's official multi-agent framework. Separate from the Codex backend even though both target OpenAI models: this one is the API-key path with hosted tools (web_search, file_search, code_interpreter, computer_use, image_generation) and built-in tracing; Codex is the ChatGPT-subscription path with `codex app-server`.

Implementation: `src/backends/openai-agents/`. Two files:

```
src/backends/openai-agents/
  index.ts        # OpenAIAgentsBackend, openaiAgents(), event translation, JsonlSession
  hosted.ts       # hostedTools.* factories — wrap SDK's hosted-tool factories into our Tool shape
```

## Public API

```typescript
export interface OpenAIAgentsBackendOptions {
  /** Required. OpenAI model name. */
  model: string;
  /**
   * Tools to expose. Resolved per `Tool.native.openai` / `Tool.execute`
   * with special-cases for `task` and `todo`. Tools without any usable
   * path are silently skipped.
   */
  tools?: Tool[];
  /** System prompt. Mapped to Agent.instructions. */
  instructions?: string;
  /** Pass-through model settings (temperature, top_p, …). */
  modelSettings?: ModelSettings;
  /** Maximum agent turns. Defaults to 20 (matches Vercel's default). */
  maxTurns?: number;
  /**
   * Decide which tools a sub-agent (the `task` tool) gets when spawned.
   * Receives the model-supplied `subagent_type` hint (Claude convention;
   * empty string if absent). Default: every parent tool except `task`
   * itself — single-level delegation, no recursive spawning.
   */
  subagentTools?: (subagent_type: string) => Tool[];
  /**
   * If set, persist conversation history to `<sessionsDir>/<continuation>.jsonl`
   * and reload on cache-miss. If unset, conversations live in memory only and
   * are lost on process exit.
   */
  sessionsDir?: string;
  /**
   * If true, use OpenAI's hosted Conversations API for continuation. Mutually
   * exclusive with `sessionsDir`. Requires `@openai/agents-openai` (which is
   * a transitive dep of `@openai/agents`, so already on disk). Default false.
   */
  useConversations?: boolean;
  /**
   * If true, wrap the underlying session in `OpenAIResponsesCompactionSession`
   * to auto-compact when history grows. Cannot combine with `useConversations`
   * (compaction rewrites locally-stored items; Conversations stores them
   * server-side). Default `true` for non-Conversations sessions (parity with
   * Claude/Codex/Vercel which all auto-compact); silently disabled when
   * `useConversations: true`. Opt out explicitly with `autoCompact: false`.
   */
  autoCompact?: boolean;
}

export class OpenAIAgentsBackend implements Backend { /* … */ }
export function openaiAgents(options: OpenAIAgentsBackendOptions): OpenAIAgentsBackend;

export const hostedTools: {
  webSearch(options?: WebSearchToolOptions): Tool;
  fileSearch(options: FileSearchToolOptions): Tool;
  codeInterpreter(options?: CodeInterpreterToolOptions): Tool;
  computerUse(options: ComputerToolOptions): Tool;
  imageGeneration(options?: ImageGenerationToolOptions): Tool;
};
```

## Tool resolution

Dispatch order at construction time, per parent tool:

| Condition | Treatment |
|---|---|
| `t.native.openai` is an **object** | A user-customized SDK tool from `hostedTools.*` (e.g. `webSearchTool({userLocation})`, `fileSearchTool(['vs_id'])`, `computerTool({computer})`). Forwarded verbatim into `Agent.tools`. `execute` is not called. |
| `t.native.openai === 'task'` | Special-cased function tool: receives the canonical union schema (Claude one-shot or Codex multi-step) flattened by `wrapSchemaForOpenAI`. On execute, unwraps the chosen branch, rejects the Codex form with a clear error, builds a child `Agent` (same model + instructions, tools from `subagentTools(subagent_type)` minus `task` itself), and runs it via nested `run()`. Returns `result.finalOutput`. |
| `t.native.openai === 'todo'` | Special-cased function tool: receives the canonical union schema (Claude `{todos: [...]}` or Codex `{text: …}`). On execute, unwraps the chosen branch and writes to a per-continuation `Map<string, unknown>`. `callModelInputFilter` re-injects the latest todos into `instructions` before each model call. |
| `t.native.openai` is one of `'web_search'` / `'code_interpreter'` / `'image_generation'` | Lazy-construct the corresponding SDK hosted tool with default options (`webSearchTool()`, `codeInterpreterTool()`, `imageGenerationTool()`) and forward into `Agent.tools`. This is how the canonical `tools.webSearch` fires by default. |
| Has `execute`, none of the above | Wrapped via the SDK's `tool({name, description, parameters, execute})`. Closure runs in-process. Schema gets shape-promoted (see [Schema shape promotion](#schema-shape-promotion)). |
| Otherwise | Silently skipped (matches Vercel's posture). |
| Otherwise | Silently skipped (matches Vercel). |

`native.claude` / `native.codex` are ignored entirely. Same posture as Vercel.

### Hosted tool factories

`src/backends/openai-agents/hosted.ts` wraps the SDK's hosted-tool factories (`webSearchTool`, `fileSearchTool`, `codeInterpreterTool`, `computerTool`, `imageGenerationTool` — all from `@openai/agents-openai`, transitively available through `@openai/agents`) into our `Tool` shape. Use these when you need to customize options (web search location, vector store IDs, computer dimensions). For default-configured hosted tools, the canonical builtins (`tools.webSearch`) already declare a string `native.openai` marker and the backend lazy-constructs the SDK tool — no factory call needed.

```typescript
export const hostedTools = {
  webSearch: (options?: WebSearchToolOptions): Tool => ({
    name: 'webSearch',
    description: 'OpenAI hosted web search.',
    schema: z.object({}),
    native: { openai: webSearchTool(options) },
  }),
  // … same shape for fileSearch, codeInterpreter, computerUse, imageGeneration
};
```

The wrapper schema (`z.object({})`) is informational only — the model never sees it. Hosted tools are dispatched server-side; OpenAI knows their real schemas. We carry just enough to surface a canonical name in events.

### Schema shape promotion

The SDK's `tool()` helper requires `ToolInputParameters = ZodObjectLike` — unions and primitives are not allowed at the top level. `wrapSchemaForOpenAI` transforms the schema and provides a matching `unwrap` callback:

| Input shape | Wrapped shape | unwrap |
|---|---|---|
| `z.object({…})` | unchanged | identity |
| `z.union([A, B, C])` | `z.object({option0?: A, option1?: B, option2?: C})` | returns the value of the first defined option key |
| anything else (arrays, primitives) | `z.object({input: <schema>})` | returns `args.input` |

The model fills exactly one branch on a union — `option0` or `option1` etc. — and `unwrap` returns that branch's value to the caller's `execute`. From the consumer's perspective the wrapping is invisible: `t.execute({...})` receives the original Claude or Codex shape.

The reverse path (reading function-call args back from the JSONL store on cache-miss reload) uses `unwrapStoredArgs`, which detects the wrapping by structure (`{input: …}` single-key, or `{option0?, option1?, …}` keys) and returns the canonical shape. `findLatestTodoInput` uses this so reloaded todos go straight into `formatTodos` without the wrapper layer leaking through.

### Tool type extension

The OpenAI Agents backend uses `Tool.native.openai` polymorphically — string for canonical markers, object for SDK tool instances:

```typescript
// src/tools/types.ts
export interface Tool<TInput = unknown, TOutput = unknown> {
  // existing fields…
  native?: {
    claude?: string;
    codex?: string;
    vercel?: string;
    openai?: string | object;  // string marker, or SDK tool object
  };
}
```

Other backends ignore `native.openai`. A user who puts `hostedTools.codeInterpreter()` in `tools` and points at Claude or Codex: backend sees no `execute`, no `native.{claude,codex}` — silently skipped. Same fall-through as `native.codex='apply_patch'` for `edit` from Codex's perspective on the Claude backend.

## Construction

```typescript
constructor(options: OpenAIAgentsBackendOptions) {
  if (options.useConversations && options.sessionsDir) {
    throw new Error('useConversations and sessionsDir are mutually exclusive');
  }
  // Only throw when caller explicitly sets autoCompact: true alongside
  // useConversations. Default autoCompact is true (parity with other
  // backends), but it silently drops to false when useConversations is on.
  if (options.useConversations && options.autoCompact === true) {
    throw new Error('useConversations and autoCompact are mutually exclusive');
  }

  this.model = options.model;
  this.instructions = options.instructions;
  this.modelSettings = options.modelSettings;
  this.maxTurns = options.maxTurns ?? 20;
  this.sessionsDir = options.sessionsDir;
  this.useConversations = options.useConversations ?? false;
  this.autoCompact = options.autoCompact ?? !this.useConversations;

  const parentTools = options.tools ?? [];
  this.hasTodoTool = parentTools.some((t) => t.name === 'todo');
  this.canonicalByWireName = new Map();

  const sdkTools: SdkTool[] = [];
  for (const t of parentTools) {
    const n = t.native?.openai;
    if (typeof n === 'object' && n !== null) {
      // User-customized SDK hosted tool from hostedTools.* — forward verbatim
      sdkTools.push(n as SdkTool);
      const wireName = (n as { name?: string; type?: string }).name
        ?? (n as { type?: string }).type ?? t.name;
      this.canonicalByWireName.set(wireName, t.name);
      continue;
    }
    if (n === 'task') {
      sdkTools.push(this.buildTaskTool(t));
      this.canonicalByWireName.set(t.name, t.name);
      continue;
    }
    if (n === 'todo') {
      sdkTools.push(this.buildTodoTool(t));
      this.canonicalByWireName.set(t.name, t.name);
      continue;
    }
    if (typeof n === 'string') {
      // Default-configured hosted markers: 'web_search', 'code_interpreter',
      // 'image_generation'. Lazy-construct the SDK hosted tool here.
      const built = buildHostedFromMarker(n);
      if (built !== undefined) {
        sdkTools.push(built.sdkTool);
        this.canonicalByWireName.set(built.wireName, t.name);
        continue;
      }
    }
    if (!t.execute) continue;
    sdkTools.push(wrapPlainTool(t));
    this.canonicalByWireName.set(t.name, t.name);
  }

  this.agent = new Agent({
    name: 'agent-sdk',
    ...(this.instructions !== undefined && { instructions: this.instructions }),
    model: this.model,
    ...(this.modelSettings !== undefined && { modelSettings: this.modelSettings }),
    tools: sdkTools,
  });
}
```

## `query()`

Each query opens a single conversation turn. Persistence (when `sessionsDir` is set) happens automatically through the Session abstraction; we don't write JSONL directly.

```typescript
query(input: QueryInput): AgentQuery {
  const continuation = input.continuation ?? randomUUID();
  const session = this.sessionFor(continuation);
  // … events generator
}
```

### Session resolution

`sessionFor(continuation)` returns a `Session` per the option triple:

| Options | Returns |
|---|---|
| `useConversations: true` | `OpenAIConversationsSession({ conversationId: continuation })` cached per continuation |
| `sessionsDir` set | `JsonlSession({ filePath: <sessionsDir>/<continuation>.jsonl })` cached per continuation |
| neither | `MemorySession({ sessionId: continuation })` cached per continuation |
| `autoCompact: true` | wraps the above (when not Conversations) in `OpenAIResponsesCompactionSession` |

The cache lives on the backend instance (`Map<continuation, Session>`). On cache-miss, the appropriate Session is constructed; the JSONL variant reads existing items from disk on first `getItems()`.

### Events generator

```typescript
async function* events(): AsyncGenerator<AgentEvent> {
  yield { type: 'session_start', continuation };

  const stream = await run(this.agent, input.message ?? '', {
    stream: true,
    session,
    maxTurns: this.maxTurns,
    signal: abortController.signal,
    ...(this.hasTodoTool && {
      callModelInputFilter: ({ modelData }) => {
        const todos = this.todosByContinuation.get(continuation);
        if (todos === undefined) return modelData;
        const formatted = formatTodos(todos);
        if (formatted === '') return modelData;
        return {
          ...modelData,
          instructions: combineSystem(modelData.instructions, `Current todos:\n${formatted}`),
        };
      },
    }),
  });

  for await (const ev of stream) {
    if (aborted) break;
    yield { type: 'activity' };
    yield* translateStreamEvent(ev, this.canonicalByWireName, textBuf, reasoningBuf);
  }

  await stream.completed;
  const usage = mapUsage(stream.state.context.usage);
  yield { type: 'session_end', usage, stopReason: aborted ? 'aborted' : 'stop' };
}
```

`abort()` calls `abortController.abort()`. The SDK's `signal` option threads through to the underlying fetch; the `for await` returns when the stream cancels.

`push()` is unsupported — same posture as Codex. The SDK's `run()` is single-turn-shaped; concurrent turns aren't allowed. `push()` emits an error event suggesting `end()` + `run()` with continuation.

## Event translation

`translateStreamEvent(ev, canonicalByWireName, textBuf, reasoningBuf)` is a generator that yields zero or more `AgentEvent` for each SDK event. Three event classes:

### `RunRawModelStreamEvent`

The SDK's raw model events — typed via `ResponseStreamEvent` from the OpenAI client. Map to deltas:

| Raw event type | Yields |
|---|---|
| `response.output_text.delta` | `text_delta` (and `text_start` on first delta per id) |
| `response.reasoning.delta` | `thinking_delta` (and `thinking_start` on first) |
| `response.function_call_arguments.delta` | `tool_call_input_delta` |
| `response.created` / `response.completed` / others | nothing — wait for the matching `RunItemStreamEvent` |

Track text/reasoning ids in `textBuf` / `reasoningBuf` so we can emit `text_end` / `thinking_end` with the accumulated string when the corresponding `message_output_created` / `reasoning_item_created` item arrives.

### `RunItemStreamEvent`

Named events wrapping a finalized `RunItem`:

| `name` | Yields |
|---|---|
| `message_output_created` | `text_end` with text from accumulator (clear `textBuf` for that id) |
| `reasoning_item_created` | `thinking_end` with text from accumulator |
| `tool_called` | `tool_call_end` with `{id, name: canonicalByWireName.get(item.name) ?? item.name, input: item.arguments}` |
| `tool_output` | `tool_result` with `{toolCallId, output, isError: item.error !== undefined}` |
| `tool_search_called` / `tool_search_output_created` | passthrough as `tool_call_end` / `tool_result` with `name: 'toolSearch'` |
| `handoff_requested` / `handoff_occurred` | `text_end` with a synthetic line ("handoff to <agent>"); we don't currently emit a typed `handoff` event |
| `tool_approval_requested` | `error` (out of scope for v0; treated as an unexpected interrupt) |

### `RunAgentUpdatedStreamEvent`

Yields nothing user-visible — `activity` is already emitted on every translated event upstream.

## JsonlSession (our local Session impl)

Implements the SDK's `Session` interface backed by `<sessionsDir>/<continuation>.jsonl`. Trivial because `Session` is a clean 5-method interface and `AgentInputItem` is a typed discriminated union designed for serialization (it's literally what the SDK posts to the model).

```typescript
class JsonlSession implements Session {
  private items: AgentInputItem[] | undefined;
  constructor(private readonly opts: { sessionId: string; filePath: string }) {}

  async getSessionId(): Promise<string> { return this.opts.sessionId; }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (this.items === undefined) {
      this.items = readJsonlItems(this.opts.filePath);
    }
    return limit !== undefined ? this.items.slice(-limit) : [...this.items];
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (this.items === undefined) this.items = readJsonlItems(this.opts.filePath);
    this.items.push(...items);
    appendJsonlItems(this.opts.filePath, items);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    if (this.items === undefined) this.items = readJsonlItems(this.opts.filePath);
    const popped = this.items.pop();
    if (popped !== undefined) rewriteJsonl(this.opts.filePath, this.items);
    return popped;
  }

  async clearSession(): Promise<void> {
    this.items = [];
    fs.rmSync(this.opts.filePath, { force: true });
  }
}
```

`readJsonlItems` / `appendJsonlItems` / `rewriteJsonl` are the obvious file helpers. `popItem` requires a full rewrite (rare path; OK to be slow). All sync I/O — Session's interface is async but the disk work is small per turn and this matches how `MemorySession` operates.

### Format

One `AgentInputItem` per line, JSON-encoded. We don't invent a schema — `AgentInputItem` is the SDK's typed union (`UserMessageItem | AssistantMessageItem | SystemMessageItem | FunctionCallItem | FunctionCallResultItem | ReasoningItem | HostedToolCallItem | …` — 17 variants) and is what gets sent to the model verbatim. Reusing it gives us lossless round-trip for free, including reasoning items and hosted-tool calls.

The cost: format is tied to `@openai/agents` versions. Major SDK bumps may break the file format. Acceptable — same trade Vercel makes with `UIMessage`.

### Path

`<sessionsDir>/<continuation>.jsonl`. `sessionsDir` is required to opt in; no default. (Vercel auto-defaults to `<cwd>/.agent-sdk/sessions/`; we don't here because users opting into this backend may also be opting into Conversations, and a silent "well, we made some files" surprise is worse than an explicit one-line config.)

## Todo round-trip

The `todo` tool is contextual: its execute writes to a per-continuation map, and `callModelInputFilter` re-injects the latest todos into `instructions` before each model call. Same wiring shape as Vercel's `prepareStep`.

```typescript
callModelInputFilter: ({ modelData }) => {
  const todos = todosByContinuation.get(continuation);
  if (todos === undefined) return modelData;
  const formatted = formatTodos(todos);
  if (formatted === '') return modelData;
  return { ...modelData, instructions: combineSystem(modelData.instructions, `Current todos:\n${formatted}`) };
}
```

`formatTodos()` and `combineSystem()` are the same helpers Vercel uses — extracted to `src/backends/shared.ts` since both backends need identical behavior.

### Reload from JSONL

On cache-miss with `sessionsDir` set, the session loads items from disk. Walk the loaded `AgentInputItem[]` backward looking for the most recent `FunctionCallItem` with `name === 'todo'`; parse its arguments and seed `todosByContinuation` from it. Single source of truth (the JSONL); no sidecar file. Same pattern as Vercel's `findLatestTodoInput`.

## Sub-agent (`task` tool)

Use `Agent.asTool()` directly — the SDK's documented one-shot delegation primitive:

> *"In handoffs, the new agent receives the conversation history. In this tool, the new agent receives generated input. … In handoffs, the new agent takes over the conversation. In this tool, the new agent is called as a tool, and the conversation is continued by the original agent."*

That's exactly our `task` semantics. The child Agent is built at construction time with the parent's tools minus `task` (or whatever `subagentTools(subagent_type)` returns). The SDK handles the entire nested run lifecycle; we only see one `tool_called` and one `tool_output` for `task` in the parent stream — sub-agent events stay opaque, matching Vercel's behavior.

The Codex multi-step form (`{tool, prompt?, model?, receiverThreadIds?}`) is rejected at execution time with: *"Codex multi-step form is not supported on OpenAI Agents; pass {description, prompt, subagent_type}."*

## Continuation

`session_start.continuation` is:

- A UUID we mint when `sessionsDir` is set or memory-only. Matches Vercel's pattern.
- The OpenAI conversation ID when `useConversations: true`.

To resume, pass it back as `QueryInput.continuation`.

```typescript
const STALE_SESSION_RE = /conversation.*not found|session.*not found|no such (conversation|session)/i;
isContinuationInvalid(err: unknown): boolean {
  return STALE_SESSION_RE.test(err.message ?? String(err));
}
```

The local Session paths (memory, JSONL) treat missing JSONL as "no prior history" rather than invalidation, same as Vercel — `isContinuationInvalid` matters only for `useConversations`.

## Auth

`OPENAI_API_KEY` env (read by the SDK's default OpenAI client). We don't validate; we let the SDK fail. Documented explicitly: *"Use Codex backend if you want ChatGPT subscription auth (`codex login`); use this backend if you have an API key and want hosted tools, tracing, or programmatic agent orchestration."*

## Compaction

On by default for non-Conversations sessions. `autoCompact: true` wraps the underlying Session in `OpenAIResponsesCompactionSession` (from `@openai/agents-openai`), which calls OpenAI's `responses.compact` API after each completed turn when history grows beyond the SDK's internal threshold. The decorator implements `OpenAIResponsesCompactionAwareSession`, so the runner automatically supplies the latest `responseId` and invokes compaction at the right boundary. We don't write any compaction logic ourselves — purely a wrapper.

How it works under the hood (per the SDK source):
- Items live in your local Session (MemorySession or our JsonlSession). The SDK doesn't store them remotely.
- After each completed turn, the runner asks the decorated session to compact.
- The decorator calls `responses.compact` — sending the locally-stored items, getting back a compacted version.
- The decorator clears the underlying Session and writes the compacted items back. Same destructive semantics as Vercel's compaction — when paired with `JsonlSession`, the file is rewritten in place.

**Mutually exclusive with `useConversations`** because the compaction decorator requires local storage to clear and rewrite; Conversations sessions are server-managed. Default behavior handles this transparently — when you pass `useConversations: true`, `autoCompact` silently drops to `false`. We only throw when you explicitly set both to `true`.

## What we don't do

- **No Handoff plumbing.** The SDK supports `Handoff` natively; we surface `handoff_requested` / `handoff_occurred` as synthetic text events in v0. Real handoff support needs an `AgentEvent` variant (`handoff_to`) and is a separate design pass.
- **No Computer Use sandbox management.** `hostedTools.computerUse({display_width, display_height})` produces the SDK tool factory's output; the consumer must provide a `Computer` implementation that performs the screenshot/click protocol. Same posture the SDK itself takes.
- **No tracing dashboard wiring.** The SDK auto-traces to OpenAI's tracing dashboard when this backend is in use. We don't expose anything additional — just document where traces appear.
- **No `tool_approval_requested` flow.** Currently surfaced as an `error` event. Adding a typed approval event is on the backlog if anyone uses tool approval guardrails.
- **No `previousResponseId` mode.** The SDK supports it as an alternative to Session for continuation, but it's strictly server-bound (response chain) without the durability of Conversations or the locality of JSONL. Skip until someone asks.
- **No mid-turn `push()`.** Same as Codex — `run()` is single-turn-shaped. `push()` emits an error suggesting `end()` + `run()` with continuation.
