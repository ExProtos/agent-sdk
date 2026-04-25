# agent-sdk

A thin TypeScript layer over [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) and [Codex AppServer](https://github.com/openai/codex/tree/main/codex-rs/app-server). Write your assistant once, run it on either backend.

The wrapper does not reimplement the agent loop — it delegates to each backend's own runtime. Its job is normalizing what each backend exposes:

- **Unified event stream** across both backends (`session_start`, `text_delta`, `tool_call_end`, `tool_result`, `session_end`, …)
- **Canonical tool names** so consumer code doesn't have to know that Claude calls it `Bash` and Codex calls it `commandExecution` — both surface as `name: 'bash'`
- **Built-in tool catalog** that maps to native tools where each backend supports them
- **MCP bridge** for user-defined custom tools — your closures run in your process, even on Codex (where Codex spawns a subprocess MCP shim that proxies calls back over a Unix socket)

Designed for general-purpose assistants (NanoClaw / OpenClaw / protos style), not specifically for coding agents — though it works well for those too.

~3k LOC, 142 tests (135 unit + 7 e2e), MIT.

## Status

- ✅ Claude Agent SDK backend
- ✅ Codex AppServer backend (with custom-tool MCP bridge)
- 🚧 Vercel AI SDK Agent backend — coming next, unlocks local models (Ollama, vLLM, LM Studio, llama.cpp) and provider-agnostic model selection

## Quick start

```bash
pnpm install
```

```typescript
import { Agent, claude, tools } from 'agent-sdk';

const agent = new Agent({
  backend: claude({
    tools: tools.all,
    permissionMode: 'bypassPermissions',
  }),
});

const query = agent.run({ message: 'Find every TODO in src/ and summarize them.' });

for await (const event of query.events) {
  switch (event.type) {
    case 'text_end':
      console.log(event.text);
      break;
    case 'tool_call_end':
      console.log(`→ ${event.toolCall.name}(${JSON.stringify(event.toolCall.input)})`);
      break;
  }
}

await agent.close();
```

Swap `claude` for `codex` and the same code runs against Codex.

## Auth

The wrapper doesn't manage credentials — it accepts whatever the underlying SDK reads.

| Backend | Env var |
|---|---|
| Claude (Pro/Max OAuth) | `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` to get it) |
| Claude (API key) | `ANTHROPIC_API_KEY` |
| Codex (ChatGPT subscription) | `~/.codex/auth.json` — run `codex login` once |
| Codex (API key) | `OPENAI_API_KEY` |

Subscription OAuth is licensed for personal use; for multi-user products, use the API keys.

## Built-in tools

Pre-built `Tool` definitions that map to each backend's native equivalent:

| Tool | Claude native | Codex native |
|---|---|---|
| `bash` | `Bash` | `command/exec` |
| `read` | `Read` | `fs/readFile` |
| `write` | `Write` | `fs/writeFile` |
| `edit` | `Edit` | `apply_patch` |
| `glob` | `Glob` | `command/exec` (via shell) |
| `grep` | `Grep` | `command/exec` (via shell) |
| `webFetch` | `WebFetch` | `webSearch` (`openPage` action) |
| `webSearch` | `WebSearch` | `webSearch` |
| `todo` | `TodoWrite` | `plan` |

Pass `tools.all` for the full set, or pick individuals:

```typescript
codex({ tools: [tools.bash, tools.read, tools.write] })
```

## Custom tools

Define tools with an `execute` closure. They run in your process; on Codex, the wrapper spawns a small MCP shim subprocess that proxies tool calls back to your closure over a Unix socket — closures never cross process boundaries.

```typescript
import { z } from 'zod';
import { Agent, codex, type Tool } from 'agent-sdk';

const fetchSlackChannel: Tool = {
  name: 'fetchSlackChannel',
  description: 'Fetch recent messages from a Slack channel.',
  schema: z.object({ channel: z.string() }),
  execute: async ({ channel }) => {
    return await slackClient.conversations.history({ channel });
  },
};

const agent = new Agent({
  backend: codex({ tools: [fetchSlackChannel] }),
});
```

The `slackClient` closure stays in your process — it has access to env vars, in-memory connection pools, anything else in scope. The MCP shim subprocess just proxies the call.

## Tests

```bash
pnpm test           # unit only (fast, no network)
pnpm test:e2e       # against real backends (requires .env.test)
pnpm test:all       # both
```

Unit tests run in ~1 second and don't touch the network. E2E tests hit real backends and skip cleanly when credentials aren't configured.

For e2e, copy `.env.test.example` to `.env.test` and fill in:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...    # for Claude e2e
AGENT_SDK_CODEX_E2E=1                        # opt in to Codex e2e
```

## Examples

`examples/` contains runnable demos:

- `chat.ts` — interactive Claude chat loop
- `codex-chat.ts` — interactive Codex chat loop
- `codex-custom-tool.ts` — custom tool (`currentTime`) running on Codex via the MCP bridge

```bash
pnpm exec tsx examples/codex-custom-tool.ts
```

## Architecture notes

| Concern | Approach |
|---|---|
| Agent loop | Delegated to each backend's SDK |
| Auth | Pass-through to backend; no in-wrapper storage |
| Sandboxing | Out of scope — run the wrapper inside a container if you need isolation |
| Streaming | Pi-style event union with `*_start` / `*_delta` / `*_end` and partial-message snapshots |
| Tool registration | Native where supported; in-process MCP via subprocess shim where not |
| Subprocess lifecycle | Lazy-spawn on first query; clean up on `agent.close()` |

See `docs/` for the original research and design notes that led to the current shape.

## Why a wrapper at all

Two main reasons:

1. **Provider portability with subscription auth.** Claude Agent SDK supports `CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max subscriptions); Codex AppServer supports ChatGPT OAuth via `codex login`. Building a portable assistant means writing against both. This wrapper handles the impedance.

2. **Custom tools as closures, not subprocesses.** MCP servers normally need to be standalone executables. The MCP bridge lets you pass a regular TS function with closure-captured state and have it actually run on Codex. That's the bridge architecture's main value-add.

Vercel AI SDK Agent support is the next major addition — unlocks local models (Ollama / vLLM / LM Studio / llama.cpp) and provider-agnostic model selection.

## License

MIT
