# Codex AppServer Protocol

Verified against [openai/codex](https://github.com/openai/codex) source.

## What it is

`codex app-server` is the programmatic-access mode of the Codex CLI. It runs as a long-lived process and accepts agent commands over JSON-RPC. This is what Codex's own IDE extensions and TUI talk to, and it's what a wrapper backend would talk to.

**It is NOT a Responses-API-compatible HTTP server.** A standard `POST /v1/responses` client cannot talk to it. The method namespace is Codex-native.

## Protocol

- **JSON-RPC 2.0** (with the `"jsonrpc":"2.0"` header omitted on the wire — "similar to MCP" per the README).
- Bidirectional: server can send notifications, client can send requests.
- Schema is generated: `codex app-server generate-ts --out DIR` produces TypeScript types; `generate-json-schema --out DIR` produces JSON Schema.

Source: `codex-rs/app-server/README.md`, `codex-rs/app-server-protocol/`, `codex-rs/app-server-client/`, `codex-rs/app-server/src/`.

## Transports

Selected via `--listen <transport>`:

| Transport | Use case |
|---|---|
| `stdio://` (default) | Child-process model — newline-delimited JSON over stdin/stdout |
| `unix://[PATH]` | Local IPC — websocket-over-unix-socket via HTTP Upgrade. Default path: `$CODEX_HOME/app-server-control/app-server-control.sock` |
| `ws://IP:PORT` | Remote IPC (experimental). Also serves `/healthz` and `/readyz` HTTP probes. Bearer auth via `--ws-auth capability-token` or `signed-bearer-token` |
| `off` | No transport (used when launching for sub-subcommands like `generate-ts`) |

For a wrapper running in the same Node process, **stdio is the right choice** — simplest lifecycle, no port management.

## Method namespace (selected)

### Lifecycle
- `initialize` — handshake
- `account/read` — current login state
- `account/login/start` — begin login. Param `type: "apiKey" | "chatgpt" | "chatgptDeviceCode"`
- `account/login/cancel`
- `account/logout`
- `account/updated` — notification when auth state changes
- `account/rateLimits/read`

### Threads (sessions)
- `thread/start` — create a new thread
- `thread/resume` — resume an existing thread by ID
- `thread/fork` — branch from a thread state

### Turns (single agent run within a thread)
- `turn/start` — kick off a turn with a user message
- `turn/interrupt` — cancel an in-progress turn

### Notifications during a turn
- `item/started` — agent emitted a new item (text, tool call, etc.)
- `item/completed`
- `item/agentMessage/delta` — streaming text

### Native tools (server-side)
- `command/exec` — run a shell command
- `fs/readFile`
- `fs/writeFile`
- `apply_patch` — structured edits

### Custom tools
- `mcpServer/tool/call` — invoke a tool from a configured MCP server

## Auth

The AppServer **owns auth**. Clients drive login via JSON-RPC, not env vars.

```
client                              server
  │                                   │
  │  account/read                    →│
  │                                   │
  │←  { loggedIn: false }             │
  │                                   │
  │  account/login/start              │
  │  { type: "chatgpt" }             →│
  │                                   │
  │←  { url: "https://..." }          │  (browser opens)
  │                                   │
  │←  account/updated  (notification) │
  │                                   │
  │  account/read                    →│
  │                                   │
  │←  { loggedIn: true,               │
  │     plan: "pro", ... }            │
```

Tokens persist in `$CODEX_HOME` (default `~/.codex/`) and are refreshed automatically by Codex.

`OPENAI_API_KEY` from environment also works — Codex falls back to it if no logged-in account.

## Don't use `@openai/codex-sdk`

OpenAI publishes [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) (active, near-daily releases). It is **not** a JSON-RPC client for `codex app-server` — it spawns the `codex` CLI with `exec --experimental-json` and parses JSONL events. Sealed against custom tool registration; no MCP API surface; auth is implicit via inherited `~/.codex/auth.json`.

For our wrapper, going to `codex app-server` directly wins on:
- Programmatic MCP/custom-tool registration
- Explicit `account/login/start` OAuth surface
- Full protocol-level event fidelity

The only useful piece of `@openai/codex-sdk` for us is its transitive dep on `@openai/codex` (the CLI npm package), which resolves the per-platform native binary. We may depend on that **just for the binary resolution** and skip the SDK layer entirely.

## Reference implementation: OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) (Justin's other project, `~/src/openclaw`) integrates Codex AppServer directly via JSON-RPC. The relevant pieces:

- `scripts/sync-codex-app-server-protocol.ts` — copies generated TypeScript types from a local clone of `openai/codex` (`codex-rs/app-server-protocol/schema/typescript`) into `extensions/codex/src/app-server/protocol-generated/`. Selectively pins specific JSON schemas (e.g. `v2/ThreadStartResponse.json`, `v2/TurnCompletedNotification.json`) and rewrites TS imports.
- `scripts/check-codex-app-server-protocol.ts` — drift check.
- `scripts/prepare-codex-ci-auth.ts`, `prepare-codex-ci-config.ts` — auth/config setup for live tests.
- `scripts/test-live-codex-harness-docker.sh` — live integration test harness.
- `extensions/codex/src/app-server/` — JSON-RPC client implementation.

Read these before writing our Codex backend — they've already solved schema sync, lifecycle management, and live testing.

## Implications for the wrapper

1. **Auth is a stateful flow, not a config value.** The wrapper's `CodexAgent` backend should expose `agent.login({ type, ... })` rather than pretending auth is an env var.

2. **Use generated types.** Don't hand-write the wire format. Run `codex app-server generate-ts --out src/generated/` and import from there. Regenerate when Codex updates.

3. **Threads ≠ sessions.** Map the wrapper's unified `sessionId` to thread IDs.

4. **Custom tools require an MCP server.** The wrapper needs to spin up an in-process MCP server, register custom tools on it, and add it to Codex's config (`~/.codex/config.toml` or via launch flag) so Codex can call into it.

5. **Process lifecycle is real.** Cold-start cost on first call (~1-2s). Keep the AppServer warm across queries. Restart on crash. Drain stdio pipes to avoid backpressure.

6. **Closer to MCP than to a library.** Treat as its own backend category in the wrapper, not as "OpenAI Agents SDK with subscription auth."
