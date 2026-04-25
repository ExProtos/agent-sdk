# Agent Wrapper — Research Notes

Notes from designing a unified wrapper that abstracts over multiple agent SDKs, similar to how Vercel AI SDK abstracts over chat/completion APIs.

## The Goal

A single TypeScript library where you can write agent code once and run it on:

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`)
- **OpenAI Agents SDK** (`@openai/agents`)
- **Vercel AI SDK Agent** (`ai` v5+ `Agent` class)
- **Codex** (`codex app-server` — JSON-RPC over stdio/socket/ws)

…with provider portability for the model, the agent loop, tools, and session state, while preserving the unique features of each backend behind opt-in escape hatches.

## Files

| File | Contents |
|---|---|
| [agent-sdks.md](agent-sdks.md) | Comparison of the four agent SDKs — capabilities, auth, tools, sessions |
| [codex-app-server.md](codex-app-server.md) | Codex AppServer protocol details (verified against the OpenAI Codex repo) |
| [wrapper-design.md](wrapper-design.md) | Proposed architecture: unified event stream, tool catalog with polyfills, per-backend implementation sketches |
| [auth-and-tos.md](auth-and-tos.md) | Subscription OAuth tokens (`CLAUDE_CODE_OAUTH_TOKEN`, ChatGPT-via-Codex) vs API keys — what's supported, what's gray-area |
| [prior-art.md](prior-art.md) | Competitive analysis — `one-agent-sdk`, Rivet Sandbox Agent SDK, OpenClaw's Codex integration, Mastra, ACP, Pi, etc. Confirms gaps our wrapper would fill |
| [learnings-from-prior-art.md](learnings-from-prior-art.md) | Synthesis of patterns from NanoClaw, OpenClaw, Pi, and one-agent-sdk — concrete design decisions before coding |

## TL;DR

1. **Vercel AI SDK is the closest existing analog** to what we want, but at the model layer, not the agent-SDK layer. It's a peer to the agent SDKs, not a wrapper over them.
2. **A wrapper is feasible.** The hard part isn't the agent loop — it's normalizing tool semantics, sessions, and the genuinely-different process model of Codex.
3. **Polyfills are the right approach** for missing tools. Claude's Read/Write/Edit/Bash can be implemented via `fs/promises` + `child_process` for backends that lack them. OpenAI's `code_interpreter` and `computer_use` are the hard polyfills.
4. **Don't unify auth, hooks, or tracing.** Pass through to each backend's native mechanism via escape hatches. The wins from forced unification are smaller than the value of each SDK's distinct dashboard/observability story.
5. **Codex is structurally different** — it's an external process speaking JSON-RPC, not an in-process SDK. Closer to MCP than to a library. Worth treating as its own backend category.

## Status

Research / design phase. No code yet.

## Pre-build reading

Done. See [learnings-from-prior-art.md](learnings-from-prior-art.md) for the synthesis. Key takeaways:

- **NanoClaw's `AgentProvider`** shape is the cleanest minimal interface — adopt directly (`query()` → `{push, end, events, abort}` + opaque `continuation` token).
- **Pi's normalized event stream** with start/delta/end events carrying partial-message snapshots is the cleanest streaming protocol — adopt for our `AgentEvent` union.
- **Pi's `Operations` injection pattern** is exactly the right shape for our tool polyfill story — same tool definition, swappable execution backend.
- **OpenClaw's CodexAppServerClient** is the production reference for our Codex backend — generic typed JSON-RPC, singleton-per-config cache, separate auth bridge, generated protocol types.
- **Pi's OAuth `Provider` interface** (`{login, refreshToken, getApiKey, modifyModels?}`) covers five real flow shapes — adopt, but skip Pi's plaintext disk storage; defer storage to caller.
- **one-agent-sdk** is mostly what NOT to do — don't pick one provider's wire format as canonical; type per-backend options properly; don't bake in `bypassPermissions` defaults.

Ready for step 2: types-and-contracts spike.
