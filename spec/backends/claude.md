# Claude backend

Wraps `@anthropic-ai/claude-agent-sdk`. The SDK owns the agent loop, multi-step tool execution, system prompt assembly, and credential reading. We translate its events into `AgentEvent` and supply the user's tool selection.

Implementation: `src/backends/claude/index.ts`. Single file, ~330 LOC.

## Public API

```typescript
export interface ClaudeBackendOptions {
  tools?: Tool[];
  permissionMode?: SDKOptions['permissionMode'];
  systemPrompt?: SDKOptions['systemPrompt'];
  additionalDirectories?: string[];
  env?: Record<string, string | undefined>;
}

export class ClaudeBackend implements Backend { /* … */ }
export function claude(options?: ClaudeBackendOptions): ClaudeBackend;
```

`tools`, `permissionMode`, `systemPrompt`, `additionalDirectories`, and `env` all pass through to the SDK. We don't bake in defaults — including `permissionMode: 'bypassPermissions'`. Callers running unattended must opt in explicitly.

## Tool resolution

For each tool the consumer passes:

| Condition | Treatment |
|---|---|
| `t.native?.claude` set | Wire name added to `allowedTools`; the SDK runs its built-in. `execute` is **not** called. |
| Has `execute`, no `native.claude` | Registered as an in-process MCP tool via `createSdkMcpServer`. Wire name becomes `mcp__agent-sdk-tools__<canonical>`; closure runs in the parent process. |
| No `native.claude` and no `execute` | Silently skipped — nothing to register. |

Custom tools (the second row) get an in-process SDK MCP server — **no subprocess shim** like Codex needs. Claude SDK ships `createSdkMcpServer({name, tools})` and a `tool(name, description, rawShape, handler)` helper that takes a live `McpServer` instance directly, so closures stay in the parent process and we avoid the Unix-socket bridge architecture.

### Schema shape promotion

Claude SDK's `tool()` helper requires `AnyZodRawShape` — the inner shape of a `z.object()`, not a full ZodType. For canonical tools whose schemas are object literals (`bash`, `read`, `write`, `glob`, `grep`, `webFetch`, `webSearch`), we pass `t.schema.shape` directly.

For non-object schemas (unions, arrays, primitives — none of our canonical tools, but custom user tools may use them) we promote: register with shape `{input: t.schema}` and mark the canonical name in a `wrappedToolNames: Set<string>`. The model emits `{input: <actualArgs>}`; the handler unwraps `args.input` before calling the user's `execute`, and event translation unwraps `block.input.input` so consumers see the canonical shape unchanged in `tool_call_end` events.

This is transparent to both the consumer and the `execute` body. The wrapper level only exists in the JSON Schema the model sees and in the SDK's tool_use block input.

### Coarse event translation

Complete content blocks (text/thinking/tool_use) surface as `text_end` / `thinking_end` / `tool_call_end`. No streaming deltas yet — the SDK exposes them, but mapping is deferred.

## Auth

`CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max) or `ANTHROPIC_API_KEY` must be in env when the SDK starts. We don't validate; we let the SDK fail. When both are set, the SDK picks one — no built-in preference. The e2e tests (`test/e2e/claude.e2e.test.ts`) explicitly strip `ANTHROPIC_API_KEY` via `claudeOAuthPreferredEnv` so subscription billing is preferred over metered API calls.

## Construction

```typescript
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
    if (t.execute === undefined) continue;
    const { shape, wrapped } = extractToolShape(t);
    if (wrapped) this.wrappedToolNames.add(t.name);
    customSdkTools.push(claudeTool(t.name, t.description, shape, async (args) => {
      const actualArgs = wrapped ? (args as { input: unknown }).input : args;
      const result = await t.execute!(actualArgs);
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
    }));
    const wire = `mcp__agent-sdk-tools__${t.name}`;
    allowedTools.push(wire);
    this.canonicalByWireName.set(wire, t.name);
  }

  const mcpServers = customSdkTools.length > 0
    ? { 'agent-sdk-tools': createSdkMcpServer({ name: 'agent-sdk-tools', tools: customSdkTools }) }
    : undefined;

  this.sdkOptions = { ...permissionMode, ...systemPrompt, ...additionalDirectories, ...env,
    ...(allowedTools.length > 0 && { allowedTools }),
    ...(mcpServers !== undefined && { mcpServers }),
  };
}
```

Spread-only conditional inclusion is deliberate: passing `undefined` to the SDK overrides its own defaults to `undefined`, which behaves differently from "not passed."

## `query()`

The SDK's `query()` accepts a `prompt` that can be either a string (one-shot) or an `AsyncIterable<SDKUserMessage>` (streaming). Use the streaming form so callers can `push()` follow-ups mid-conversation.

```typescript
query(input: QueryInput): AgentQuery {
  const stream = new MessageStream();
  if (input.message !== undefined) stream.push(input.message);

  const sdkResult = sdkQuery({
    prompt: stream,
    options: {
      ...this.sdkOptions,
      ...(input.cwd && { cwd: input.cwd }),
      ...(input.continuation && { resume: input.continuation }),
      ...(input.systemPromptAppend && {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemPromptAppend },
      }),
    },
  });

  // … events generator below
}
```

`systemPromptAppend` overrides the constructor's `systemPrompt` for this query — but only by selecting the SDK's `claude_code` preset and appending to it. The constructor's `systemPrompt` is honored when `systemPromptAppend` is omitted.

### `MessageStream` (push-based async iterable)

```typescript
class MessageStream {
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

  end(): void { this.done = true; this.waiter?.(); }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => { this.waiter = r; });
      this.waiter = null;
    }
  }
}
```

`session_id: ''` is fine — the SDK fills it in. `parent_tool_use_id: null` because this is a top-level user turn, not a tool-use response.

### Event generator

```typescript
async function* events(): AsyncGenerator<AgentEvent> {
  try {
    for await (const message of sdkResult) {
      if (aborted) return;
      yield { type: 'activity' };
      yield* translateMessage(message, nameMap);
      // CRITICAL: end the input stream when the SDK signals turn completion.
      if (message.type === 'result') stream.end();
    }
  } catch (err) {
    yield { type: 'error', message: err.message ?? String(err), retryable: false };
  }
}
```

**Critical**: `stream.end()` on `result` is required. The SDK keeps its async iterator alive as long as the prompt iterable is open, so it can support `push()` calls during a turn. For our turn-scoped `query` model, the `result` message means the model is done — closing the input lets the SDK iterator terminate. Without this, queries hang forever after the model's reply.

`abort()` sets `aborted = true` and calls `stream.end()`. The next iteration of the `for await` returns.

`push(msg)` enqueues onto the `MessageStream`, which the SDK is still iterating from until `result`. (After `result`, push has no effect because the stream is ended.)

## Event translation

`translateMessage(message, canonicalByWireName)` is a generator that yields zero or more `AgentEvent` for each SDK message:

| SDK message | Yields |
|---|---|
| `system` with `subtype: 'init'` | `{ type: 'session_start', continuation: message.session_id }` |
| `assistant` | one event per content block: `text` → `text_end`; `thinking` → `thinking_end`; `tool_use` → `tool_call_end` (with canonical name lookup) |
| `user` (with array content) | for each `tool_result` block: `{ type: 'tool_result', result: { toolCallId, output, isError } }` |
| `result` | `{ type: 'session_end', stopReason: 'stop' or 'error', usage: {input,output,cacheRead,cacheWrite} }` |

Tool name canonicalization on `tool_use`:

```typescript
const name = canonicalByWireName?.get(block.name) ?? block.name;
yield { type: 'tool_call_end', toolCall: { id: block.id, name, input: block.input } };
```

Tools the consumer didn't register fall through with the wire name unchanged. This matters for built-in Claude tools the consumer didn't include in `tools` but which the SDK might still surface through `claude_code` preset behavior.

`stopReason` mapping:

- `result.subtype === 'success'` → `'stop'`
- everything else → `'error'`

Usage is read from `message.usage` with `?? 0` fallback per field — the SDK occasionally omits some fields.

## Continuation

The SDK's `init` message carries the session UUID. We surface that as `continuation`. To resume, pass `QueryInput.continuation`; the backend sets `options.resume` on the SDK call.

```typescript
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;
isContinuationInvalid(err: unknown): boolean {
  return STALE_SESSION_RE.test(err.message ?? String(err));
}
```

These three patterns cover the SDK errors when the resume target doesn't exist on disk anymore (the SDK stores transcripts under `~/.claude/sessions`).

## What we don't do

- **No streaming deltas.** The SDK's `partial_message` events go untranslated. Adding them would require tracking accumulated text per content block and emitting `text_start` / `text_delta` accordingly.
- **No interrupt API beyond stream end.** The SDK doesn't expose a turn-interrupt explicitly; aborting closes the input stream and the SDK eventually settles.
