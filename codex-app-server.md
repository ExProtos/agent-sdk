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

## Implications for the wrapper

1. **Auth is a stateful flow, not a config value.** The wrapper's `CodexAgent` backend should expose `agent.login({ type, ... })` rather than pretending auth is an env var.

2. **Use generated types.** Don't hand-write the wire format. Run `codex app-server generate-ts --out src/generated/` and import from there. Regenerate when Codex updates.

3. **Threads ≠ sessions.** Map the wrapper's unified `sessionId` to thread IDs.

4. **Custom tools require an MCP server.** The wrapper needs to spin up an in-process MCP server, register custom tools on it, and add it to Codex's config (`~/.codex/config.toml` or via launch flag) so Codex can call into it.

5. **Process lifecycle is real.** Cold-start cost on first call (~1-2s). Keep the AppServer warm across queries. Restart on crash. Drain stdio pipes to avoid backpressure.

6. **Closer to MCP than to a library.** Treat as its own backend category in the wrapper, not as "OpenAI Agents SDK with subscription auth."
