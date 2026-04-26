# Claude backend

Wraps `@anthropic-ai/claude-agent-sdk`. The SDK owns the agent loop, multi-step tool execution, system prompt assembly, and credential reading. We translate its events into `AgentEvent` and supply the user's tool selection.

Implementation: `src/backends/claude/index.ts`. Single file, ~250 LOC.

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

## v0 scope

- **Native tools only.** Tools with `Tool.native.claude` set are added to `allowedTools`. Tools without a `native.claude` mapping are silently skipped — in-process MCP registration for custom tools on Claude is a future addition. (On Codex these would route through the MCP bridge instead.)
- **Coarse event translation.** Complete content blocks (text/thinking/tool_use) surface as `text_end` / `thinking_end` / `tool_call_end`. No streaming deltas yet — the SDK exposes them, but mapping is deferred.
- **Auth: caller's responsibility.** `CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max) or `ANTHROPIC_API_KEY` must be in env when the SDK starts. We don't validate; we let the SDK fail.

## Construction

```typescript
constructor(options: ClaudeBackendOptions = {}) {
  this.tools = options.tools ?? [];
  // Build canonicalByWireName: wire name (e.g. 'Bash') → canonical name ('bash').
  // Used to rewrite tool names in tool_call_end events.
  const allowedTools: string[] = [];
  for (const t of this.tools) {
    if (t.native?.claude) {
      allowedTools.push(t.native.claude);
      this.canonicalByWireName.set(t.native.claude, t.name);
    }
  }
  this.sdkOptions = {
    ...permissionMode, ...systemPrompt, ...additionalDirectories, ...env,
    ...(allowedTools.length > 0 && { allowedTools }),
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
- **No custom tool registration.** Future work — the SDK supports MCP tools via `mcpServers` option, similar in shape to Codex's `mcp_servers` config. The wrapper would spawn a similar shim or expose an in-process MCP server. For v0, only `native.claude` matters.
- **No interrupt API beyond stream end.** The SDK doesn't expose a turn-interrupt explicitly; aborting closes the input stream and the SDK eventually settles.
