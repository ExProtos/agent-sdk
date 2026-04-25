# Prior Art

Competitive analysis from web search (April 2026). Goal: confirm nothing already does what we'd build before starting.

## Direct competitors

**None found.** No project wraps all four of {Claude Agent SDK, OpenAI Agents SDK, Vercel AI SDK Agent v5, Codex AppServer} behind one TS surface.

## Closest cousins — read these before building

### `one-agent-sdk` ([github.com/odysa/one-agent-sdk](https://github.com/odysa/one-agent-sdk))

Tiny (4 stars, v0.1.7 Mar 2026, MIT). Same architectural choice as our plan: in-process TS, swap-by-string, dynamic imports.

**Covers:** Claude Agent SDK + Codex SDK + Copilot + Kimi + raw OpenAI/Anthropic/OpenRouter, behind a Claude-Agent-SDK-shaped `query()` API.

**Misses:** Vercel AI SDK Agent (the local-models path), native Codex *app-server* JSON-RPC (uses `@openai/codex-sdk` which wraps the CLI), tool polyfills with semantic matching, per-model profiles, OAuth subscription auth surface.

This is essentially v0 of what we'd build. **Read its provider adapter layout first.** We'd be writing v2 with Vercel AI SDK Agent + native app-server + polyfills + profiles + OAuth added.

### Rivet Sandbox Agent SDK ([sandboxagent.dev](https://sandboxagent.dev/) · [github.com/rivet-dev/sandbox-agent](https://github.com/rivet-dev/sandbox-agent))

Launched Jan 2026. Rust binary you run *inside* a sandbox; controls Claude Code, Codex, OpenCode, Amp, Pi over HTTP/SSE. Universal event schema (`session.*`, `item.*`, `permission.*`, `question.*`).

**Different deployment model** (control plane, not embeddable in-process library). But its event schema is the best public reference we have for the unified-event-stream design.

### OpenClaw ([github.com/openclaw/openclaw](https://github.com/openclaw/openclaw))

Justin's other project (`~/src/openclaw`). Uses **Pi** as its agent core (`@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent` 0.70.2) and integrates **Codex AppServer directly via JSON-RPC** — not via `@openai/codex-sdk`.

Reference scripts:
- `scripts/sync-codex-app-server-protocol.ts` — copies generated types from a local clone of `openai/codex` into `extensions/codex/src/app-server/protocol-generated/`, with selective JSON-schema pinning and import rewriting.
- `scripts/check-codex-app-server-protocol.ts` — drift check.
- `scripts/prepare-codex-ci-auth.ts` and `prepare-codex-ci-config.ts` — auth/config setup for live Codex tests.
- `scripts/test-live-codex-harness-docker.sh` — live integration test harness.
- `extensions/codex/src/app-server/` — actual JSON-RPC client implementation.

**Most directly relevant prior art for our Codex backend.** OpenClaw has already solved schema sync, lifecycle management, and live-test harness. Our wrapper's Codex backend should crib from this layout heavily.

## Adjacent — different axis, not real overlap

| Project | What it does | Why it's not us |
|---|---|---|
| [Mastra](https://mastra.ai/) | TS agent framework using Vercel AI SDK at the model layer | Doesn't wrap Claude Agent SDK or OpenAI Agents SDK — just model APIs |
| [LangGraph](https://langchain-ai.github.io/langgraphjs/) | Stateful graph-based agents (Python + TS) | Same — abstracts model APIs, not agent SDKs |
| [VoltAgent](https://github.com/VoltAgent/voltagent), [Inngest AgentKit](https://agentkit.inngest.com/), [Google ADK-TS](https://google.github.io/adk-docs/), [IQAI ADK-TS](https://github.com/IQAIcom/adk-ts) | Various agent frameworks | All abstract at the model API layer |
| [Agent Client Protocol](https://agentclientprotocol.com/) (Zed) | JSON-RPC standard; each agent ships its own ACP adapter | The unified surface lives on the *client* (editor) side; no single TS lib that orchestrates all four backends |
| [`@posthog/code-agent`](https://www.npmjs.com/package/@posthog/code-agent) | TS SDK wrapping Claude Code + OpenAI models | Pre-alpha, product-internal, doesn't cover OpenAI Agents SDK proper or Vercel AI SDK Agent |
| [Pi](https://github.com/badlogic/pi-mono) | From-scratch agent loop with built-in tools | Not a wrapper. **But:** only existing TS thing with subscription OAuth on both Anthropic + OpenAI (+ Copilot, Gemini). Read for OAuth surface inspiration. |
| [LiteLLM + Claude Agent SDK](https://docs.litellm.ai/docs/tutorials/claude_agent_sdk) | Lets Claude Agent SDK talk to other model providers via proxy | Different axis: changes the *model* under one SDK, not the SDK |

## What NOT to use

### `@openai/codex-sdk` ([npm](https://www.npmjs.com/package/@openai/codex-sdk))

OpenAI-published, but **not** a JSON-RPC client for `codex app-server`. It spawns the `codex` CLI with `exec --experimental-json` and parses JSONL. Sealed against custom tool registration; no MCP API surface; auth is implicit via inherited `~/.codex/auth.json`.

For our wrapper this is the wrong layer. Going to `codex app-server` directly via JSON-RPC gives us:
- Programmatic custom-tool registration via MCP server registration RPCs
- Explicit `account/login/start` OAuth surface
- Full event fidelity

Useful only as: (a) a reference for the Codex event-stream shapes its types document, (b) a transitive dep on `@openai/codex` (the CLI npm package) which conveniently resolves the per-platform native binary — we may want to depend on that *just for the binary resolution* and skip the SDK layer entirely.

Active (near-daily releases, latest 0.125.0 on 2026-04-24), but on the wrong path for us.

### `mrsekut/codex-executor` ([github.com/mrsekut/codex-executor](https://github.com/mrsekut/codex-executor))

Was a standalone TS JSON-RPC client for `codex app-server`. **Archived March 2026.** Possibly worth grepping for protocol shapes.

## Confirmed gaps our spec would fill

1. ✅ **Vercel AI SDK Agent v5 as a peer backend** — nobody does this in a multi-agent-SDK wrapper. Local-model story falls out naturally.
2. ✅ **Native Codex `app-server` JSON-RPC client** in a *general-purpose* multi-backend wrapper. OpenClaw has one but it's project-specific; the only standalone TS client (`codex-executor`) was archived March 2026.
3. ✅ **Tool polyfills with semantic matching** (Bash/Read/Write native on Claude, polyfilled via `child_process`/`fs` on the others). Nobody advertises this.
4. ✅ **Per-model tool profiles** (frontier vs `local-coder` vs `local-research` vs `local-minimal`). Pi has model capability lists; nobody has profiles.
5. ✅ **Subscription OAuth across both Anthropic and OpenAI in one wrapper interface.** Pi is the only existing TS thing with both, and Pi isn't a wrapper.

## Recommended pre-build reading order

1. **OpenClaw's `extensions/codex/src/app-server/`** + the two protocol scripts — most directly relevant Codex implementation.
2. **`one-agent-sdk`'s provider adapter layout** — closest architectural twin for the multi-backend dispatch.
3. **Rivet Sandbox Agent SDK's universal event schema** — reference for our `AgentEvent` design.
4. **Pi's OAuth surface** (`@mariozechner/pi-agent-core` source) — for the subscription-auth UX pattern.
5. **`@openai/codex-sdk`'s `dist/index.d.ts`** — Codex event-stream shapes as reference, even though we won't depend on the SDK.

## Sources

- [one-agent-sdk](https://github.com/odysa/one-agent-sdk)
- [Rivet Sandbox Agent SDK](https://github.com/rivet-dev/sandbox-agent) · [launch post](https://rivet.dev/changelog/2026-01-28-sandbox-agent-sdk/)
- [@posthog/code-agent](https://www.npmjs.com/package/@posthog/code-agent) · [PostHog/code monorepo](https://github.com/PostHog/code)
- [Agent Client Protocol](https://agentclientprotocol.com/) · [claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)
- [pi-mono](https://github.com/badlogic/pi-mono) · [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- [Codex App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) · [@openai/codex-sdk](https://www.npmjs.com/package/@openai/codex-sdk) · [codex-executor (archived)](https://github.com/mrsekut/codex-executor)
- [Mastra](https://mastra.ai/)
- [Anthropic Max-billing-for-SDK feature request](https://github.com/anthropics/claude-agent-sdk-python/issues/559)
- [LiteLLM + Claude Agent SDK](https://docs.litellm.ai/docs/tutorials/claude_agent_sdk)
