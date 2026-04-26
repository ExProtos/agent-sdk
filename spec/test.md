# Test

Test layout, framework, and what to verify.

## Framework

[vitest](https://vitest.dev) for both unit and e2e. Two configs:

- `vitest.config.ts` — unit suite. Includes `test/**/*.test.ts`, **excludes** `test/e2e/**`. Fast (~1s), no network, no credentials needed.
- `vitest.e2e.config.ts` — e2e suite. Sets up env from a `.env.test` file via `setupFiles: ['test/e2e/setup.ts']`, longer timeouts (30s+), `fileParallelism: false` to avoid cross-test interference with subprocess-spawning backends.

## Layout

Tests live in `test/`, mirroring `src/`:

```
test/
  agent.test.ts                      # Agent class shape
  tools/
    builtin.test.ts                  # catalog invariants
  backends/
    claude/index.test.ts             # event translation, MessageStream
    codex/index.test.ts              # translateNotification, translateItem
    codex/client.test.ts             # JSON-RPC parser, server-request defaults
    codex/mcp-bridge.test.ts         # socket protocol, schema validation
  e2e/
    setup.ts                         # loads .env.test → process.env
    helpers.ts                       # hasAnthropicAuth, codexE2eEnabled, collectEvents…
    claude.e2e.test.ts               # 3 tests against real Claude API
    codex.e2e.test.ts                # 4 tests including bridge round-trip
```

`.env.test.example` ships in the repo as a template:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
AGENT_SDK_CODEX_E2E=1
```

The actual `.env.test` is gitignored.

`test/e2e/setup.ts` reads `.env.test` (or `AGENT_SDK_ENV_FILE` if set) and populates `process.env`. It tolerates a missing file — e2e tests then skip via the helpers below.

## What to test

### Unit tests — verify spec invariants

These are the contracts the spec promises. Each describe block leads with a one-line comment naming the spec section it covers.

- **Tool catalog** — every entry has `name`, `description`, `schema`. Tools with native mappings have non-empty wire names. `tools.all` is non-empty and contains exactly the expected canonical names.
- **Tool schema validation** — `bash`, `read`, `write`, `edit` (both branches of the union), `glob`, `grep`, `webFetch`, `webSearch`, `todo` (both branches) accept valid input and reject invalid input via the Zod schema.
- **Claude event translation (`translateMessage`)** — `system/init` → `session_start`; `assistant` text/thinking/tool_use blocks → `text_end`/`thinking_end`/`tool_call_end`; `user` with `tool_result` blocks → `tool_result`; `result` → `session_end` with usage. Tool wire names map to canonical names when present in `canonicalByWireName`, fall through unchanged otherwise.
- **Claude `MessageStream`** — push enqueues, end terminates the iterator, the iterator awaits when the queue is empty.
- **Codex `translateNotification`** — `turn/started` no-op, `item/agentMessage/delta` → `text_delta`, `item/reasoning/textDelta` → `thinking_delta`, `item/completed` dispatches `translateItem`, `turn/completed` → `session_end` with `stopReason` from status, `error` → `error`. Filters notifications by `expectedThreadId`.
- **Codex `translateItem`** — `commandExecution` → `bash` tool_call + tool_result with `isError = exitCode !== 0`. `fileChange` → `edit` tool_call; tool_result emitted only when status is `completed | failed | declined`. `plan` → `todo` tool_call. `webSearch.action.type === 'openPage'` → `webFetch`; other actions → `webSearch`. `mcpToolCall` → tool_call_end + tool_result with the wire tool name unchanged.
- **Codex JSON-RPC parser** — newline-delimited JSON; non-JSON lines (banners, `\n` only) are silently dropped; responses without matching IDs are dropped; server-initiated requests get the right `defaultServerRequestResponse` per method.
- **MCP bridge** — `register` rejects tools without `execute`. `start` opens a socket; `stop` destroys connections before closing the server. A connection that sends `{id, tool, args}` gets back `{id, result: {content: [{type:'text', text}]}}` on success or `{id, error: {message}}` on schema-validation failure / unknown tool / `execute` throw.
- **Agent class** — `run` delegates to backend.query; `close` calls backend.close if present.
- **`isContinuationInvalid`** — Claude regex matches "no conversation found", "ENOENT…jsonl", "session not found" (case-insensitive); Codex regex matches "thread not found", "no such thread", "thread does not exist".

### E2E tests — verify it works against real backends

Each e2e test starts with a `hasAnthropicAuth()` or `codexE2eEnabled()` guard from `test/e2e/helpers.ts` and skips cleanly when credentials aren't configured. CI without credentials runs them and they all skip.

- **Claude — minimum viable run.** `claude({ tools: [tools.read] })`, run a one-shot query, expect `session_start` → `text_end` → `session_end` with `stopReason: 'stop'`.
- **Claude — tool call.** Ask the model to read a known file under `cwd`. Expect a `tool_call_end` with `name: 'read'` and a matching `tool_result`.
- **Claude — continuation.** Run two queries; pass the `continuation` from the first into the second. Verify the model recalls earlier context.
- **Codex — minimum viable run.** `codex({ tools: tools.all })`, simple message, expect `session_start`, eventually `session_end` with `stopReason: 'stop'`.
- **Codex — bash tool fires.** Ask for a shell command that's clearly bash. Expect `tool_call_end` with `name: 'bash'` and a `tool_result`.
- **Codex — bridge round-trip.** Define a custom tool with a closure that captures a sentinel string defined in the test. Pass it to `codex({ tools: [...] })`. Run a query that asks the model to call the custom tool. Expect `tool_call_end` with the custom tool's `name` and a `tool_result` carrying the sentinel — proving the closure ran in the parent process.
- **Codex — thread resume.** Two queries with continuation; the second references context from the first.

`test/e2e/helpers.ts` exposes:

- `hasAnthropicAuth()` — true when `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set.
- `codexE2eEnabled()` — true when `AGENT_SDK_CODEX_E2E` is truthy. (Required because Codex e2e takes longer and may need ChatGPT auth set up.)
- `collectEvents(query, predicate)` — drain the event stream until the predicate returns true (default: `session_end` or `error`); return the accumulated events.
- `collectEventsVerbose(query, ...)` — same but logs each event as it arrives. Useful when debugging — the prior debugging session needed verbose logging to surface the `ThreadStartResponse.thread.id` shape mismatch.

## What NOT to test

- **LLM output content.** Non-deterministic. Test that *some* `text_end` arrived, not what it said.
- **Wire formats of upstream SDKs.** If the Claude SDK changes its message shape, our translator breaks and unit tests catch it; we don't need a contract test against Anthropic's protocol.
- **Subprocess interaction details.** Stub `CodexClient` for backend unit tests. The real client is exercised by the e2e suite.
- **MCP shim integration with Codex.** Tested only end-to-end via the bridge round-trip — building an MCP harness in unit tests is more brittle than the integration test it stands in for.

## Running

- `pnpm test` — unit only.
- `pnpm test:e2e` — e2e only.
- `pnpm test:all` — both, sequentially.

E2E tests opt in:

- Claude e2e runs when `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) is in `.env.test`.
- Codex e2e runs when `AGENT_SDK_CODEX_E2E=1` is in `.env.test` AND `codex login` has been run (or `OPENAI_API_KEY` is set).

The CI default is "run unit tests, expect e2e to skip" — having e2e in CI without credentials would surface skips without false positives.
