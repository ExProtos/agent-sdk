# agent-sdk

A thin TypeScript layer over four agent runtimes:

- **[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)** — Anthropic, Pro/Max OAuth or API key.
- **[Codex AppServer](https://github.com/openai/codex/tree/main/codex-rs/app-server)** — OpenAI's `codex` CLI, ChatGPT subscription or API key.
- **[Vercel AI SDK](https://sdk.vercel.ai)** — provider-agnostic. Any `LanguageModel` works (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible` against Ollama / vLLM / LM Studio / llama.cpp, …).
- **[OpenAI Agents SDK](https://github.com/openai/openai-agents-js)** — OpenAI API key. Adds OpenAI's hosted tools (web search, code interpreter, file search, computer use, image generation) and built-in tracing.

Write your assistant once, swap the backend with one line.

The wrapper does not reimplement the agent loop — it delegates to each backend's own runtime. Its job is normalizing what each backend exposes:

- **Unified event stream** across all four backends (`session_start`, `text_delta`, `tool_call_end`, `tool_result`, `session_end`, …)
- **Canonical tool names** — Claude's `Bash`, Codex's `commandExecution`, OpenAI's `web_search_call` all surface as `bash`, `webSearch`, etc.
- **Built-in tool catalog** that maps to native tools per backend, with a single `Tool` type.
- **Custom tools as closures** — your `execute` runs in your process on every backend. Codex's MCP integration normally requires standalone server processes; the wrapper ships a small subprocess shim that proxies tool calls back to your closures over a Unix socket. Claude, Vercel, and OpenAI Agents register closures directly via their SDKs' in-process helpers.
- **Auto-compaction by default** on every backend (Claude/Codex/OpenAI Agents native; Vercel implemented in-backend).
- **Image attachments** as a first-class field on `QueryInput` — translated to each backend's native multimodal shape.

Designed for general-purpose assistants, not specifically for coding agents — though it works well for those too.

~5k LOC, 309 unit tests + 16 e2e, MIT.

## Status

- ✅ Claude Agent SDK backend
- ✅ Codex AppServer backend (custom-tool MCP bridge, ChatGPT subscription support)
- ✅ Vercel AI SDK backend (provider-agnostic, JSONL persistence, in-backend auto-compaction, image attachments)
- ✅ OpenAI Agents SDK backend (hosted tools, JSONL persistence, OpenAI-side compaction, opt-in Conversations API)

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

Swap the backend with no other changes:

```typescript
import { codex, vercel, openai, hostedTools } from 'agent-sdk';
import { anthropic } from '@ai-sdk/anthropic';

// Codex (auth from ~/.codex/auth.json, populated by `codex login`)
new Agent({ backend: codex({ tools: tools.all }) });

// Vercel — any AI SDK provider works
new Agent({ backend: vercel({ model: anthropic('claude-sonnet-4-5'), tools: tools.all }) });

// OpenAI Agents — adds hosted tools
new Agent({
  backend: openai({
    model: 'gpt-5-mini',
    tools: [...tools.all, hostedTools.codeInterpreter()],
  }),
});
```

## Auth

Each backend takes typed auth fields on its options; ambient env vars work as a fallback.

| Backend | Typed fields | Env fallback |
|---|---|---|
| Claude | `oauthToken` (Pro/Max) or `apiKey` | `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` |
| Codex | `codexHome` (path to a `CODEX_HOME` dir) | ambient `~/.codex/` from `codex login` |
| Vercel | none (auth lives inside the `LanguageModel`) | provider-dependent |
| OpenAI | `apiKey`, `baseURL`, `organization`, `project` | `OPENAI_API_KEY` |

```typescript
claude({ oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN });
claude({ apiKey: 'sk-ant-…' });

openai({ model: 'gpt-5-mini', apiKey: 'sk-…' });

// Codex: just a path passthrough. Caller manages auth.json themselves.
//   CODEX_HOME=/path/to/profile codex login                  # ChatGPT OAuth
//   CODEX_HOME=/path/to/profile codex login --with-api-key   # API key
codex({ codexHome: '/path/to/profile' });
codex({});  // ambient ~/.codex/
```

Subscription OAuth is licensed for personal use; for multi-user products, use the API keys.

## Codex: approval and sandbox policy

Codex's defaults (`approval_policy: 'on-request'`, `sandbox_mode: 'read-only'`) prompt the client for permission and forbid writes — fine for interactive use, wrong for unattended callers. Three typed fields configure this:

```typescript
codex({
  askForApproval: 'never',          // never ask — commands run subject to sandboxMode
  sandboxMode: 'workspace-write',   // 'read-only' | 'workspace-write' | 'danger-full-access'
  onApprovalRequest: async (req) => ({ decision: 'accept' }),  // optional callback
});
```

Without `onApprovalRequest`, the client auto-declines any approval codex routes to it. Pair `askForApproval: 'never'` with the right `sandboxMode` for unattended use.

## Built-in tools

Pre-built `Tool` definitions that map to each backend's native equivalent:

| Tool | Claude | Codex | Vercel | OpenAI Agents |
|---|---|---|---|---|
| `bash` | `Bash` | `command/exec` | in-process | in-process |
| `read` | `Read` | `fs/readFile` | in-process | in-process |
| `write` | `Write` | `fs/writeFile` | in-process | in-process |
| `edit` | `Edit` | `apply_patch` | in-process | in-process |
| `glob` | `Glob` | shell-based | in-process | in-process |
| `grep` | `Grep` | shell-based | in-process | in-process |
| `webFetch` | `WebFetch` | `webSearch` (openPage) | in-process | in-process |
| `webSearch` | `WebSearch` | `webSearch` | (none — use `withImpls`) | hosted (`web_search`) |
| `todo` | `TodoWrite` | `plan` | special-case + system-prompt re-injection | special-case + `callModelInputFilter` |
| `task` | `Task` | `collabAgentToolCall` | special-case (nested `streamText`) | special-case (nested `run`) |

Pass `tools.all` for the full set, or pick individuals:

```typescript
codex({ tools: [tools.bash, tools.read, tools.write] });
```

For Vercel/OpenAI Agents, in-process tools have an `execute` closure shipped in `tools/implementations.ts`. Tools without one (e.g. `webSearch` on Vercel) are silently skipped — plug a provider via `withImpls`:

```typescript
import { tools, withImpls, vercel } from 'agent-sdk';

const myTools = withImpls(tools.all, {
  webSearch: async ({ query }) => brave.search(query),
});
vercel({ model, tools: myTools });
```

## OpenAI hosted tools

The OpenAI Agents backend can dispatch hosted tools server-side (web search, code interpreter, file search, computer use, image generation):

```typescript
import { openai, hostedTools, tools } from 'agent-sdk';

openai({
  model: 'gpt-5',
  tools: [
    ...tools.all,
    hostedTools.codeInterpreter(),
    hostedTools.fileSearch(['vs_abc123']),
    hostedTools.computerUse({ computer: myComputerImpl }),
  ],
});
```

`tools.webSearch` already declares OpenAI hosted dispatch by default, so it works out of the box on the OpenAI Agents backend. Use the `hostedTools.webSearch({...})` factory to customize options (location, search context size).

## Custom tools

Define tools with an `execute` closure. They run in your process on every backend. On Codex, the wrapper spawns a small MCP shim subprocess that proxies tool calls back to your closure over a Unix socket — closures never cross process boundaries.

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

new Agent({ backend: codex({ tools: [fetchSlackChannel] }) });
```

The `slackClient` closure stays in your process — it has access to env vars, in-memory connection pools, anything else in scope. The Codex MCP shim subprocess just proxies the call.

## Image attachments

Pass images alongside the user message — backends translate to their native multimodal shape:

```typescript
agent.run({
  message: 'What is in this picture?',
  attachments: [
    { type: 'image', source: { kind: 'url', url: 'https://example.com/cat.jpg' } },
    { type: 'image', source: { kind: 'path', path: '/tmp/photo.png' } },
    { type: 'image', source: { kind: 'base64', data: '...', mimeType: 'image/jpeg' } },
  ],
});
```

`url` / `base64` / `path` source forms — pick whichever matches what you have. Backends that need bytes (Claude, Vercel) read paths from disk and base64-encode; Codex passes paths through as `localImage`. Attachments apply to the first turn only; follow-ups via `query.push(...)` are text-only.

## Persistence and continuation

Each backend exposes its session ID as a continuation token; pass it back to resume.

| Backend | Where transcripts live | Default behavior |
|---|---|---|
| Claude | `~/.claude/projects/<project>/<session>.jsonl` | SDK-managed |
| Codex | `~/.codex/sessions/` + sqlite index | AppServer-managed |
| Vercel | `<cwd>/.agent-sdk/sessions/<continuation>.jsonl` | We own it (UIMessage[] JSONL) |
| OpenAI Agents | In-memory only by default; opt into JSONL via `sessionsDir`, or hosted Conversations via `useConversations: true` | Memory-only default; both alternatives available |

For Vercel and OpenAI Agents (local mode), JSONL persistence is automatic when the path is set — reload across process restarts works without extra wiring.

## Auto-compaction

When the conversation approaches the model's context window, the backend summarizes older turns and continues. On by default everywhere:

| Backend | How |
|---|---|
| Claude | SDK-native (Anthropic SDK summarizes internally) |
| Codex | AppServer-native (Rust-side summarization) |
| Vercel | In-backend — between turns, when `inputTokens / contextWindow >= 0.8`. Hardcoded model-→-context-window table; `contextWindow` override for unknown models. |
| OpenAI Agents | Wraps Session in `OpenAIResponsesCompactionSession`, which calls OpenAI's `responses.compact` API. Automatic for local sessions; doesn't apply to Conversations (server-managed). |

Disable with `autoCompact: false` on the relevant backend's options.

## Tests

```bash
pnpm test           # unit only (fast, no network)
pnpm test:e2e       # against real backends (requires .env.test)
pnpm test:all       # both
```

Unit tests run in ~1 second and don't touch the network. E2E tests hit real backends and skip cleanly when credentials aren't configured.

For e2e, copy `.env.test.example` to `.env.test` and fill in the credentials you want to exercise.

## Examples

`examples/` contains runnable demos:

- `chat.ts` — interactive Claude chat loop
- `codex-chat.ts` — interactive Codex chat loop
- `codex-custom-tool.ts` — custom tool (`currentTime`) running on Codex via the MCP bridge
- `vercel-chat.ts` — Vercel chat loop (uses `@ai-sdk/anthropic` by default)
- `claude-hello.ts` — minimal one-shot Claude run

```bash
pnpm exec tsx examples/codex-custom-tool.ts
```

## Architecture notes

| Concern | Approach |
|---|---|
| Agent loop | Delegated to each backend's SDK |
| Auth | Pass-through to backend; no in-wrapper storage |
| Sandboxing | Out of scope — run the wrapper inside a container if you need isolation |
| Streaming | Pi-style event union with `*_start` / `*_delta` / `*_end` |
| Tool registration | Native where supported; in-process closures via each SDK's helper (Claude `createSdkMcpServer`, Vercel/OpenAI `tool()`); Codex uses a subprocess MCP shim |
| Subprocess lifecycle | Lazy-spawn on first query; clean up on `agent.close()` |
| Compaction | SDK-native on Claude/Codex/OpenAI; in-backend on Vercel |

See `spec/` for the regeneration-grade design docs and `docs/todo.md` for open follow-ups.

## Why a wrapper at all

Three main reasons:

1. **Provider portability with subscription auth.** Claude Agent SDK supports Pro/Max OAuth; Codex AppServer supports ChatGPT OAuth. Building a portable assistant means writing against both. The wrapper handles the impedance.

2. **Provider-agnostic + local models.** Vercel AI SDK lets the same agent code run against Anthropic, OpenAI, Google, Ollama, vLLM, LM Studio, llama.cpp — anything with an `@ai-sdk/*` provider. One canonical event stream regardless.

3. **Custom tools as closures, not subprocesses.** MCP servers normally need to be standalone executables. The wrapper lets you pass a regular TS function with closure-captured state and have it run on every backend — even Codex, which assumes external MCP server processes.

## License

MIT
