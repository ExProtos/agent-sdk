# Vercel AI SDK Agent backend (planned)

The next backend to ship. Unlocks **local models** and **provider-agnostic model selection** — both real gaps in the current Claude + Codex pair.

## Why

Vercel AI SDK is a peer to Claude Agent SDK and Codex AppServer at the *agent runtime* layer (`Agent` class with `stopWhen`, tool calls, multi-step loops, streaming). Where it differs:

- **Provider portability.** The model is a parameter (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, or any `@ai-sdk/openai-compatible` endpoint). Same agent code, swap the model.
- **Local models.** `@ai-sdk/openai-compatible` pointed at Ollama / LM Studio / vLLM / llama.cpp gives you a local-model agent. Neither Claude SDK nor Codex AppServer support local — this is the unique unlock.
- **No native tools.** Vercel doesn't ship a Read/Write/Bash toolbox. Every tool is user-supplied. This is where our `tools/implementations.ts` becomes load-bearing.
- **No subprocess model.** Tools run in-process; Vercel takes function tools directly. **No MCP bridge needed** for this backend.
- **UI integration.** Vercel AI SDK ships the React/streaming-UI ergonomics (`useChat`, RSC). Wrapping it lets the same agent emit events into a Next.js / web UI.

## Integration shape

```typescript
import { Agent, vercel, tools } from 'agent-sdk';
import { anthropic } from '@ai-sdk/anthropic';
// or:
// import { openai } from '@ai-sdk/openai';
// import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
// const ollama = createOpenAICompatible({ baseURL: 'http://localhost:11434/v1', name: 'ollama' });

const agent = new Agent({
  backend: vercel({
    model: anthropic('claude-sonnet-4-5'),
    tools: tools.all,                // implementations fire here, no native
    stopWhen: stepCountIs(20),       // pass-through to Vercel
  }),
});
```

## What needs to be built

| Piece | Notes |
|---|---|
| `src/backends/vercel/index.ts` | `VercelBackend` class implementing `Backend`. Wraps `Agent` from `ai`. |
| Event translation | Vercel emits `fullStream` parts (`text-delta`, `tool-call`, `tool-result`, `step-finish`, `finish`). Map to our `AgentEvent` union. Most parts have direct equivalents. |
| Tool wiring | Convert `Tool[]` → Vercel's `tools` map. Each entry uses `tool({ description, inputSchema, execute })` — our `tool.execute` plugs in directly. |
| Continuation/resume | Vercel doesn't have built-in session persistence — it's stateless. We'd carry conversation history ourselves and re-feed on resume. Or document the limitation. |
| Push-based input | Vercel's `agent.stream({ prompt })` is single-shot per call. `query.push()` becomes "feed another turn"; we re-invoke `agent.stream()` with accumulated history. |
| `peerDependencies` | `ai`, `@ai-sdk/anthropic`/`openai`/etc. — caller picks which providers to install. |

## Open questions

1. **Continuation token semantics.** Vercel doesn't manage threads. Our `continuation` would be an opaque pointer to a stored message history (in memory? on disk?). Or we could require the caller to pass full history each time. NanoClaw-style orchestrators pass continuation forward; we'd need them to also store the history somewhere they own.

2. **Tool description quality matters more.** On Claude/Codex, the SDK has its own tuned tool descriptions; ours are documentation. On Vercel, ours are what the model sees. Need to be careful to write good descriptions (and possibly per-model-family overrides).

3. **No native tool concept.** `tool.native.claude` and `tool.native.codex` are irrelevant for Vercel. Every tool needs `execute`. Tools that lack `execute` should be silently skipped (or warned about) on this backend.

4. **Implementations we'd actually need.** `webFetch` already has one. `glob` and `grep` would need real bodies (currently just stubs in builtin.ts) — for code-flavored agents on local models, these matter. `bash`/`read`/`write`/`edit` are easy via `child_process` and `fs/promises`.

5. **Multi-agent handoffs.** Vercel doesn't have a primitive; we'd need to layer one on (or punt).

## Estimate

~400 LOC for the backend itself + ~300 LOC for the missing tool implementations (glob/grep/bash/read/write/edit). Plus tests. Under a day of focused work once we pin down the continuation question.

## Non-goals

- Not trying to support every Vercel AI SDK feature (`generateObject`, custom `prepareStep`, etc.). Just the Agent path that maps to our `query()` flow.
- Not handling provider-specific quirks (cache control, thinking budgets, structured outputs) — those go through Vercel's per-provider knobs, exposed as escape hatches on `vercel({ ...vercelOptions })`.
