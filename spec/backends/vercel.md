# Vercel backend

Wraps the AI SDK's `streamText` (the same primitive `Agent.stream` calls underneath). Unlike Claude and Codex, this backend ships **no native tools** — every tool the model can invoke must have an in-process `execute()`. The unique unlock is **provider portability**: any AI SDK `LanguageModel` works, including `@ai-sdk/openai-compatible` pointed at Ollama, vLLM, LM Studio, or llama.cpp.

Implementation: `src/backends/vercel/index.ts`. Single file, ~640 LOC (heaviest of the three backends — owns persistence, sub-agent execution, and todo state in addition to the agent loop).

## Public API

```typescript
export interface VercelBackendOptions {
  model: LanguageModel;                              // required
  tools?: Tool[];
  instructions?: string;                             // streamText `system`
  stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  sessionsDir?: string;                              // override JSONL location
  subagentTools?: (subagent_type: string) => Tool[]; // task tool's toolset
}

export class VercelBackend implements Backend { /* … */ }
export function vercel(options: VercelBackendOptions): VercelBackend;
```

`model` is the only required field. Everything else has sensible defaults.

## Tool resolution

The backend doesn't have native tools — it owns nothing the SDK provides server-side. Every tool gets one of three treatments at construction time:

| Condition | Treatment |
|---|---|
| `t.name === 'task'` | Special-cased: `execute` is a closure-bound sub-agent runner (model + parent toolset minus task) |
| `t.name === 'todo'` | Special-cased: `execute` writes to a per-continuation map; `prepareStep` re-injects todos into the system prompt before each step |
| Otherwise, has `execute` | Wrapped via the AI SDK's `tool()` helper: `vercelTool({description, inputSchema, execute})` |
| Otherwise (no `execute`) | Silently skipped — model can't call it |

`native.claude` / `native.codex` are ignored entirely. A tool that's native on Claude/Codex but lacks an `execute` is dropped (no in-process implementation to wrap). This is why `webSearch` doesn't fire by default on Vercel — caller must plug a provider via `withImpls`.

## Construction

```typescript
constructor(options: VercelBackendOptions) {
  this.model = options.model;
  this.sessionsDir = options.sessionsDir
    ?? path.join(process.cwd(), '.agent-sdk', 'sessions');

  const parentTools = options.tools ?? [];
  this.hasTodoTool = parentTools.some(t => t.name === 'todo');
  const set: ToolSet = {};
  for (const t of parentTools) {
    if (t.name === 'task') set[t.name] = buildTaskTool(t, this.model, options, parentTools);
    else if (t.name === 'todo') set[t.name] = buildTodoTool(t, this.todosByContinuation);
    else if (t.execute) set[t.name] = wrapPlainTool(t);
    // else: silently skipped
  }
  this.toolSet = set;
}
```

## `query()`

Each query opens a single conversation turn (or chain of turns if the caller `push()`es follow-ups mid-stream). Persistence happens automatically — no opt-in needed.

```typescript
query(input: QueryInput): AgentQuery {
  const continuation = input.continuation ?? randomUUID();
  const filePath = path.join(this.sessionsDir, `${continuation}.jsonl`);
  // ... events generator below
}
```

### Events generator

Per turn:

1. **Load history** on cache-miss: `readUIMessages(persistPath)` → `convertToModelMessages` → in-memory `Map<continuation, ModelMessage[]>`. Reconstruct todos from the loaded UIMessages too (see [Todo round-trip](#todo-round-trip)).
2. **Append the inbound user message** to history and persist as a `UIMessage` line via `appendUIMessage`.
3. **Call `streamText`** with the current history, tools, optional `prepareStep` (only when `todo` is in the toolset).
4. **Consume two streams concurrently**:
   - `result.fullStream` for AgentEvent translation (the consumer-facing event stream)
   - `result.toUIMessageStream() → readUIMessageStream` for JSONL persistence
   - The SDK tee's the underlying source, so both consumers are independent.
5. **Persist all step messages** onto history after the stream drains (`steps[].response.messages`).
6. **Loop on `push()`** — if there's a queued user message, run another turn against the updated history. If not, single-shot semantics: emit `session_end` and finish.

`abort()` sets a flag, calls `abortController.abort()`, and wakes any waiting promise. The fullStream loop exits, `persistPromise` settles, the generator emits `session_end` with `stopReason: 'aborted'`.

## Event translation

`translatePart(part, textBuf, reasoningBuf)` is a generator that yields zero or more `AgentEvent` for each `TextStreamPart` from `result.fullStream`:

| TextStreamPart | Yields |
|---|---|
| `text-start` | `text_start`; init `textBuf[id] = ''` |
| `text-delta` | `text_delta`; append delta to `textBuf[id]` |
| `text-end` | `text_end` with accumulated text from `textBuf[id]`; clear |
| `reasoning-start` / `-delta` / `-end` | `thinking_start` / `thinking_delta` / `thinking_end` (same accumulation logic via `reasoningBuf`) |
| `tool-input-start` | `tool_call_start` |
| `tool-input-delta` | `tool_call_input_delta` |
| `tool-input-end` | (nothing — `tool-call` next will carry the full input) |
| `tool-call` | `tool_call_end` with `{id, name, input}` |
| `tool-result` | `tool_result` with `{toolCallId, output, isError: false}` |
| `tool-error` | `tool_result` with `{toolCallId, output: {error: msg}, isError: true}` |
| `error` | `error` |
| Lifecycle (`start`, `start-step`, `finish-step`, `finish`, `abort`) | (nothing — caller reads `finish-step.usage`/`finishReason` and `finish.totalUsage` directly) |

`textBuf`/`reasoningBuf` are required because the SDK's `text-end` / `reasoning-end` parts don't carry the accumulated text — only the deltas do. We synthesize the `_end.text` field by accumulating ourselves.

## Persistence

The Vercel backend is the only one that writes its own JSONL. Claude and Codex have native session storage (`~/.claude/projects/...` and `~/.codex/sessions/...` + sqlite); Vercel has none. So we own the file format here.

### Format

One complete `UIMessage` per line, JSON-encoded. UIMessage is the AI SDK's documented persistence shape:

```typescript
interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: UIMessagePart[];          // text | reasoning | tool-* | source-* | file | data-* | step-start
  metadata?: unknown;
}
```

We don't invent a schema — UIMessage is the SDK's contract for client-side persistence (every Next.js app using `useChat` round-trips this shape via `convertToModelMessages`). Reusing it gives us the reload pipeline for free.

### Path

Computed per query as `path.join(this.sessionsDir, `${continuation}.jsonl`)`. Default `sessionsDir` is `<process.cwd()>/.agent-sdk/sessions/`. The `sessionsDir` constructor option exists primarily so tests can isolate to a temp directory without juggling `process.chdir`.

### Write side

Two channels:

1. **User messages** are persisted immediately at `run()` / `push()` time as a synthetic UIMessage with one TextUIPart.
2. **Assistant messages** flow from `result.toUIMessageStream() → readUIMessageStream`, which yields complete UIMessages as they finalize. We append each via `appendUIMessage`.

`appendUIMessage(filePath, msg)` mkdir-p's the parent dir then `fs.appendFileSync`s `JSON.stringify(msg) + '\n'`. Synchronous so callers can rely on ordering relative to surrounding I/O.

### Read side

`readUIMessages(filePath)` reads the file, splits on newlines, JSON.parses each non-empty line. Returns `[]` for missing files (treats absent as "no prior history" — supports new-session creation). Throws on malformed JSON because corruption is a real bug, not a recoverable empty state.

### Reload on cache-miss

`query()` checks the in-memory `histories: Map<continuation, ModelMessage[]>` first. On miss, it reads the JSONL and converts:

```typescript
const stored = readUIMessages(persistPath);
history = stored.length > 0 ? await convertToModelMessages(stored) : [];
```

`convertToModelMessages` is the SDK's own `UIMessage[] → ModelMessage[]` adapter. We then pass the converted history to `streamText` exactly as we would for any other turn — no special "resume" path needed.

## Sub-agent (`task` tool)

The `task` tool can't ship a stateless `execute()` — it needs the parent's model and a derived tool subset. Vercel intercepts the canonical `task` tool at construction time and substitutes a closure-bound replacement that calls `runSubAgent`.

```typescript
runSubAgent(input, model, subagentToolsFor, callOptions): Promise<string>
```

Accepts only the **Claude one-shot form**: `{description, prompt, subagent_type}`. The Codex multi-step form (`{tool, prompt?, model?, receiverThreadIds?}`) throws with a clear error pointing at the Claude form — multi-step sub-agents need long-lived sub-thread management that doesn't map to a single in-process invocation, and a model that wasn't trained on Codex's collaboration protocol won't drive it well anyway.

Defaults: same model as parent, parent's toolset minus `task` (single-level delegation, no recursive spawning). Override the toolset via `subagentTools: (subagent_type) => Tool[]` to honor Claude's `subagent_type` hints (e.g., return `[webFetch, webSearch]` for `'researcher'`).

The sub-agent runs as a single-turn `streamText` with the prompt as the only user message. Its events do **not** enter the parent's `AgentEvent` stream — the parent sees one `tool_call_end` for `task` and one `tool_result` with `result.text` (the sub-agent's final assistant text). Matches the abstraction (sub-agent is opaque to the parent) and keeps intermediate context out of the parent's stream.

## Todo round-trip

The `todo` tool is also contextual — its execute writes to a per-continuation map, and `prepareStep` re-injects the latest todos into the system prompt before each subsequent step. Wiring:

1. **`todosByContinuation: Map<continuation, unknown>`** on the backend.
2. **Custom `execute` for `todo`**: reads continuation from `experimental_context`, writes the input to the map. Returns `'todos updated'`.
3. **`prepareStep` (set only when `todo` is in the toolset)**: reads continuation from `experimental_context`, looks up todos, formats via `formatTodos()`, returns `{system: combineSystem(baseSystem, 'Current todos:\n' + formatted)}`.
4. **`experimental_context: { continuation }`** is passed to every `streamText` call so both the tool's execute and `prepareStep` know which continuation they're running under.

`formatTodos(input)` handles both schema shapes: `{todos: [{content, status, activeForm}, …]}` becomes a `[x]/[~]/[ ]` checklist; `{text: string}` is verbatim. Returns `''` for unrecognized shapes.

### Reload from JSONL

Todos survive process restart by reconstruction, not separate persistence. On cache-miss reload, after loading history, the backend walks the loaded UIMessage[] backwards looking for the most recent `tool-todo` part with a settled `input` (via `findLatestTodoInput`) and seeds `todosByContinuation` from it. Single source of truth (the JSONL); no sidecar file.

## Continuation

The continuation token is a UUID minted on first query (or on resume, the caller's). Unlike Claude/Codex, the token is not assigned by an upstream service — Vercel has none. We mint it.

There's no `isContinuationInvalid` implementation — a missing JSONL is treated as "no prior history" rather than an invalidation signal. Callers that retain continuation tokens across long pauses (days/weeks) won't get a stale-session error from this backend.

## Auto-compaction

When `inputTokens / contextWindow >= contextThreshold` after a turn, the backend schedules compaction for the next turn. Before the next `streamText` call, `compactHistory` runs:

1. **Find the split.** Walk backward through history to the Nth-most-recent user-role message (where N = `keepLastTurns`). Split there. This rule guarantees we never sever a tool-call/result pair, since those always live between an assistant message and the next user message.
2. **Generate the summary.** `generateText` against `compactionModel` (defaults to the agent's model) with `COMPACTION_SYSTEM_PROMPT` and the older messages as input. Returns plain text — typically ~10% of the input length.
3. **Build the new history.** `[{role: 'user', content: 'Earlier in this conversation:\n<summary>'}, …recent]`. If the continuation has todos, inject a synthetic assistant UIMessage with one `tool-todo` part right after the summary so `findLatestTodoInput` still recovers them on subsequent reload.
4. **Atomic JSONL rewrite.** Serialize the new shape, write to `<persistPath>.tmp`, `renameSync` over the original. POSIX rename is atomic — no torn-write window.
5. **Update the in-memory cache** with the rewritten history.

### Knobs

| Option | Default | Notes |
|---|---|---|
| `autoCompact` | `true` | Master switch. Off matches the no-overflow-handling baseline. |
| `contextThreshold` | `0.8` | Fraction of context window. 0.8 leaves headroom for the next turn. |
| `compactionModel` | same as `model` | Override to use a cheaper model for summarization. |
| `keepLastTurns` | `4` | Recent user-led turns kept verbatim. Defines the "current context" window. |
| `contextWindow` | resolved from `MODEL_CONTEXT_WINDOWS` table by `model.modelId` prefix | Required override for unknown models. Without it, autoCompact silently disables for that backend. |

### Safeguards

- Skip compaction if `history.length < MIN_HISTORY_FOR_COMPACTION` (10) — overhead exceeds the win.
- Skip if no clean split point exists (history doesn't have `keepLastTurns` user messages).
- Skip if the summarizer returns empty text (defensive).
- On compaction failure, surface an `error` event but continue to the next turn — better to let the next streamText fail with its own error than to swallow.

### Compacted messages are gone

Compaction is destructive within agent-sdk's JSONL — the older messages are replaced by the summary. We don't keep a sidecar log; consumers that need an audit trail (e.g. Protos) maintain their own format independently.

## What we don't do

- **No multi-step `task` (Codex collaboration form).** The Claude one-shot form is implemented; Codex's spawn/sendInput/wait/resume/closeAgent multi-step protocol is not. A Vercel-routed model that wasn't trained on it likely won't drive it well anyway.
- **No `webSearch` / `todo` / `task` defaults from `tools.implementations`.** All three are contextual or provider-dependent; callers wire them via `withImpls` (or rely on Vercel's special-casing for `task`/`todo`).
- **No streaming UI helpers.** The AI SDK ships `result.toUIMessageStreamResponse()` etc. for HTTP/SSE delivery. We use those internally for persistence; we don't re-export them.
