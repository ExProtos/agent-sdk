# OpenAI Agents SDK backend (planned)

A separate backend from Codex. Both target OpenAI models, but they're different runtimes:

- **Codex AppServer** (`codex app-server`, Rust binary) — current backend. Supports ChatGPT subscription auth via `codex login`. Ships its own toolbox (commandExecution, fileChange, etc.). What you want for "personal assistant on my Pro subscription."
- **OpenAI Agents SDK** (`@openai/agents`, npm package) — what this doc plans. API key only. Unlocks OpenAI's hosted tools. What you want for production apps with API billing and Computer Use / Code Interpreter.

## Why support it

Three things Codex doesn't expose:

1. **Hosted tools** — `web_search`, `file_search` (RAG), `code_interpreter` (sandboxed Python), `computer_use` (browser/desktop control). These run in OpenAI's infrastructure; you can't replicate them with an MCP bridge. Computer Use especially has no equivalent on Codex or Anthropic.
2. **Built-in tracing** — OpenAI's tracing dashboard captures every agent run automatically. Visible at platform.openai.com/traces. No setup; just works when you use the SDK.
3. **First-class handoffs** — multi-agent orchestration via the `handoff` primitive. Cleaner than rolling your own subagent dispatch.

These matter for production / commercial apps. Codex is for the subscription path; this is the API-key path with the richer tool surface.

## Integration shape

```typescript
import { Agent, openaiAgents, tools } from 'agent-sdk';
import { hostedTools } from 'agent-sdk/hosted';

const agent = new Agent({
  backend: openaiAgents({
    model: 'gpt-5',
    tools: [
      ...tools.all,                  // our canonical tools — function tools
      hostedTools.codeInterpreter(), // OpenAI-hosted, runs server-side
      hostedTools.webSearch(),
      hostedTools.computerUse({ display_width: 1280, display_height: 800 }),
    ],
  }),
});
```

`hostedTools.*` is a new namespace specifically for OpenAI-hosted tools. They're declarations, not implementations — the model invokes them and OpenAI's infra runs them. Our backend just emits the right shape into the `@openai/agents` request.

## What needs to be built

| Piece | Notes |
|---|---|
| `src/backends/openai-agents/index.ts` | `OpenAIAgentsBackend` class implementing `Backend`. Wraps `Agent` + `run` from `@openai/agents`. |
| Event translation | `@openai/agents` streams events similar to Vercel's `fullStream` (run items, output text, tool calls). Map to our `AgentEvent` union. |
| Function tool wiring | Our `Tool[]` → SDK's tool definitions. Each `tool.execute` becomes the SDK's tool function handler. In-process; no bridge needed. |
| `src/tools/hosted.ts` | New file. Factories for OpenAI hosted tools (`codeInterpreter`, `webSearch`, `fileSearch`, `computerUse`). These produce special Tool variants with no `execute` and a `hosted: { openai: 'web_search' \| ... }` marker. |
| Tool type extension | Add `hosted?: { openai?: string }` field to `Tool`. Backends that don't support a given hosted variant skip it cleanly (Claude can't use OpenAI's code_interpreter). |
| Continuation | OpenAI Responses API has stateful threads via `previous_response_id`. Map our continuation to that. |

## Auth

Just `OPENAI_API_KEY`. No subscription path here — that's Codex's job. We'd document explicitly: *"Use Codex backend if you want ChatGPT subscription auth; use this backend if you have an API key and want the hosted tools."*

## Hosted tools — handling on other backends

When a user includes `hostedTools.codeInterpreter()` in `tools` and points at the Claude or Codex backend:

- It's not native on Claude → Claude backend skips it silently
- It's not native on Codex → Codex backend skips it (no `execute` to bridge)
- Only the OpenAI Agents backend recognizes the `hosted.openai` marker and forwards it

Same pattern as `native.codex='apply_patch'` for `edit` — single Tool definition, backend-aware behavior.

## Open questions

1. **Computer Use protocol.** OpenAI's computer_use needs the agent to have a sandbox/VM to act on. Our wrapper doesn't manage that. Either we expose the screen-grab/click protocol as `AgentEvent` types and let the consumer execute (NanoClaw-orchestrator-style), or we require the consumer to provide a sandbox handle. Both are real work.

2. **Tracing.** OpenAI's tracing fires automatically when using `@openai/agents`. Do we expose anything? Probably no — just document that traces appear in the OpenAI dashboard when this backend is in use.

3. **Handoffs.** OpenAI's `handoff` is a special tool variant that switches the active agent. Mapping to our event stream requires either a new event variant (`handoff_to: 'agent-name'`) or a parent-event sequence. Worth a separate design discussion.

4. **Cost accounting.** OpenAI returns token usage per step; need to surface it in our `session_end.usage`.

## Estimate

~500 LOC for the backend + ~150 LOC for `hosted.ts` + ~50 LOC for the tool type extension. Plus tests. Couple of days once Computer Use plumbing is decided.

## Non-goals

- Not bridging hosted tools into other backends. If you want code interpreter on Claude, run a Pyodide sandbox yourself as a custom tool — that's a project's worth of work and out of scope.
- Not duplicating Codex's coverage. Users on subscription should use Codex; users on API should use this. We document both clearly.
