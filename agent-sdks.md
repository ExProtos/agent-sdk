# Agent SDK Comparison

The four candidate backends.

## At-a-glance matrix

| | Claude Agent SDK | OpenAI Agents SDK | Vercel AI SDK Agent | Codex |
|---|---|---|---|---|
| **Package** | `@anthropic-ai/claude-agent-sdk` | `@openai/agents` | `ai` (v5+) | `codex` binary |
| **Provider lock-in** | Anthropic only | OpenAI only | Provider-agnostic (`@ai-sdk/anthropic`, `@ai-sdk/openai`, etc.) | OpenAI only |
| **Subscription auth** | ✅ `CLAUDE_CODE_OAUTH_TOKEN` | ❌ API key only | ❌ Whatever provider accepts | ✅ ChatGPT OAuth via `account/login/start` |
| **In-process or subprocess** | In-process | In-process | In-process | Subprocess (JSON-RPC) |
| **Prebuilt code-agent tools** (Read/Write/Edit/Bash/Grep) | ✅ Rich, sandboxed | ❌ | ❌ BYO | ✅ `command/exec`, `fs/readFile`, `fs/writeFile`, `apply_patch` |
| **Hosted tools** | Web search/fetch | `web_search`, `file_search`, `code_interpreter`, `computer_use` | None | None (uses local) |
| **MCP support** | ✅ | ✅ | Partial | ✅ |
| **Session resume** | ✅ Native (cache-friendly) | Via `previous_response_id` chain | ❌ BYO history | ✅ `thread/resume` |
| **Multi-agent / handoffs** | Subagents | First-class `handoff` primitive | BYO | Threads |
| **Hooks / lifecycle** | `PreToolUse`, `PostToolUse`, `SessionStart`, etc. | Lifecycle hooks + guardrails | Limited | Notifications stream |
| **Tracing / observability** | Hooks-based, BYO | Built-in dashboard | Telemetry support | `~/.codex/logs/` |
| **UI / streaming story** | Headless | Headless | ✅ Best-in-class (`useChat`, RSC) | Headless |

## When to use each

- **Claude Agent SDK** — coding agents where the prebuilt toolbox is the value. Anthropic-only, fine for personal use on subscription token.
- **OpenAI Agents SDK** — multi-agent orchestration, hosted tools (Computer Use, Code Interpreter), built-in tracing dashboard.
- **Vercel AI SDK Agent** — chat UIs in Next.js / React apps, when you want provider portability and don't need a prebuilt toolbox.
- **Codex** — OpenAI-flavored coding agent with subscription auth (the OpenAI-side analog to running NanoClaw on `CLAUDE_CODE_OAUTH_TOKEN`).

## What's structurally similar across all four

- An "agent loop": prompt → model → tool calls → tool results → repeat until stop
- A tool concept (definitions + handlers)
- A streaming output: text deltas + tool events + finish events
- Some notion of session/thread continuation
- MCP for extending the toolset

These are the things the wrapper can normalize cleanly.

## What's structurally different

- **Process model** — three are libraries you import; Codex is a subprocess.
- **Tool registration** — Claude/OpenAI/Vercel accept in-memory tool definitions; Codex requires MCP for custom tools.
- **Auth shape** — Claude/Vercel/OpenAI use env vars or constructor args; Codex uses a stateful login RPC.
- **Hosted tool semantics** — OpenAI's `code_interpreter` runs in their infrastructure; everyone else runs locally.
- **Session resume cost** — Claude and Codex restore from disk (cheap, prompt-cache friendly); OpenAI threads requests via `previous_response_id`; Vercel replays history.

## Vercel AI SDK note

I initially called Vercel AI SDK "creeping into the agent space" — that was out of date. As of v5 it ships an actual `Agent` class with `stopWhen`, `prepareStep`, multi-step tool calls, and structured outputs. It's a genuine peer to the dedicated agent SDKs, just one that doesn't ship a prebuilt code-agent toolbox.

```typescript
import { Agent, stepCountIs } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const agent = new Agent({
  model: anthropic('claude-sonnet-4-5'),
  tools: { /* BYO */ },
  stopWhen: stepCountIs(20),
});

const result = await agent.generate({ prompt: '...' });
```

The biggest reason to wrap Vercel AI SDK Agent rather than skip it: its UI streaming integration (`useChat`, RSC) is unique. Wrapping it lets the unified library deliver an agent's output stream into a React chat UI without the consumer having to know which backend is running.
