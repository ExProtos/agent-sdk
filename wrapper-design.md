# Wrapper Design

Proposed architecture for a unified agent-SDK wrapper.

## Three layers

```
┌─────────────────────────────────────────┐
│  Public API — Agent class, tool catalog │
└─────────────────────────────────────────┘
                    │
┌─────────────────────────────────────────┐
│  Backend interface — UnifiedAgent       │
│  - run() yielding AgentEvent            │
│  - resume()                             │
│  - login() (Codex)                      │
└─────────────────────────────────────────┘
                    │
┌──────────┬─────────┬──────────┬─────────┐
│  Claude  │ OpenAI  │  Vercel  │  Codex  │
│  Agent   │ Agents  │  AI SDK  │  App-   │
│  SDK     │  SDK    │  Agent   │  Server │
└──────────┴─────────┴──────────┴─────────┘
```

## Unified event stream

All four backends emit a sequence of: text deltas, tool calls, tool results, status events. Normalize:

```typescript
type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: unknown; isError?: boolean }
  | { type: 'step_finish'; reason: 'tool_calls' | 'stop' | 'length' }
  | { type: 'finish'; usage: TokenUsage; sessionId?: string }
  | { type: 'error'; error: Error };
```

This is the smallest abstraction with the highest payoff — works for all backends, no polyfills required.

## UnifiedAgent interface

```typescript
interface UnifiedAgent {
  run(input: { prompt: string; sessionId?: string }): AsyncIterable<AgentEvent>;
  resume?(sessionId: string, input: { prompt: string }): AsyncIterable<AgentEvent>;
  close?(): Promise<void>;
}
```

Public API wraps this:

```typescript
import { Agent, tools, sandbox } from 'unified-agent';

const agent = new Agent({
  backend: 'claude' | 'openai' | 'vercel' | 'codex',
  model: 'claude-sonnet-4-6',
  tools: [
    tools.read, tools.write, tools.bash,
    tools.webSearch({ provider: 'tavily' }),
    tools.codeInterpreter({ runtime: 'pyodide' }),
  ],
  sandbox: sandbox.docker({ image: 'python:3.12' }),
  // escape hatches
  claude: { /* SDK-specific options */ },
  openai: { /* ... */ },
  vercel: { /* ... */ },
  codex: { /* ... */ },
});
```

## Tool catalog with native-or-polyfill resolution

```typescript
defineTool({
  name: 'bash',
  schema: z.object({ command: z.string(), timeout: z.number().optional() }),
  native: {
    claude: { name: 'Bash' },
    codex: { name: 'command/exec' },
    openai: null,
    vercel: null,
  },
  polyfill: async ({ command, timeout }) => {
    return await sandbox.exec(command, { timeout });
  },
});
```

At construction time, the wrapper picks native where available, polyfill where not.

### Initial catalog

| Tool | Claude | Codex | OpenAI | Vercel | Polyfill |
|---|---|---|---|---|---|
| `read` / `write` / `edit` | ✅ | ✅ | — | — | `fs/promises` |
| `bash` | ✅ | ✅ | — | — | `child_process` / Docker |
| `glob` / `grep` | ✅ | — | — | — | `fast-glob` / ripgrep |
| `web_search` | ✅ | — | ✅ | — | Tavily / Brave / Serper |
| `web_fetch` | ✅ | — | — | — | `fetch` + readability |
| `code_interpreter` | — | — | ✅ | — | Pyodide / Docker+Python |
| `file_search` (RAG) | — | — | ✅ | — | LanceDB / Turbopuffer + embeddings |
| `computer_use` | ✅ Anthropic | — | ✅ OpenAI | — | Browserbase / Anchor + protocol shim |

### Tool semantics matter, not just signatures

Polyfills must match observable contract — clip output the same way, format errors the same way, respect timeouts the same way. Models are *trained on* specific tool behaviors. A polyfill that returns 200KB of stdout when Claude's native `Bash` would return 30KB-truncated will cause the model to behave differently. This is where the maintenance pain lives.

### Native tools run as your host user — `sandbox` forces polyfill mode

Important execution-model detail (verified against the [Claude Agent SDK permissions docs](https://code.claude.com/docs/en/agent-sdk/permissions)): Claude Agent SDK runs all built-in tools **in-process with host user permissions**. `Bash` calls actually `exec` in your Node process; `Write` calls actually `fs.writeFile`. The "sandbox" in the SDK's permission system is a *permission-prompt layer*, not OS-level isolation.

Implication: if the wrapper exposes a `sandbox` option, it must override native-tool resolution. When `sandbox` is set, the wrapper:

1. Adds the affected tool name to `disallowedTools` on the backend (blocks Claude's native `Bash`).
2. Registers the polyfilled version via in-process MCP, routed through the configured sandbox runtime (Docker, Firecracker, Pyodide, etc.).

```typescript
const agent = new Agent({
  backend: 'claude',
  tools: [tools.bash],
  sandbox: sandbox.docker({ image: 'python:3.12' }),
});
// Effective config passed to Claude Agent SDK:
//   disallowedTools: ['Bash']
//   mcpServers: { wrapper: { ... in-process MCP exposing 'bash' ... } }
```

This means `sandbox` is a **per-tool** decision, not a global one. Tools without dangerous side effects (`Read`, `Glob`, `Grep`) can stay native; tools that touch the shell or filesystem aggressively (`Bash`, `Write`, `Edit`) get force-polyfilled when `sandbox` is set.

### Wrapper hook layer

For backends that support hooks (Claude, OpenAI), the wrapper installs a `PreToolUse` hook that fires for every tool call — native or polyfilled. This is the wrapper's only universal interception point for:

- Audit logging
- Per-call permission prompts (when running unattended is not desired)
- Tool-result sanitization (post-call, via `PostToolUse`)
- Profile-based step caps

Codex's equivalent is the `permission.*` notification stream over JSON-RPC. Vercel AI SDK Agent doesn't have hooks; the wrapper has to wrap the tool handlers themselves at registration time.

## What NOT to unify

| Concern | Reason | Mitigation |
|---|---|---|
| **Auth** | Each backend has different shapes (env var vs OAuth flow vs login RPC) | Pass through. Document per-backend. Surface as `agent.login()` for Codex. |
| **Hooks / lifecycle callbacks** | Each SDK's hook model is too different and the value is in their dashboards | `escape hatches`: `claude: { hooks: {...} }`, `openai: { tracing: {...} }` |
| **Tracing / observability** | Native dashboards are the value | Don't try. Document where each backend's logs/dashboards live. |
| **Hosted-tool semantics** | Cost, security, and quality differ when you polyfill | Native first, polyfill second. Document trade-offs. |

## Per-backend implementation notes

### ClaudeAgent

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

class ClaudeAgent implements UnifiedAgent {
  async *run({ prompt, sessionId }: RunInput) {
    for await (const message of query({
      prompt,
      options: { 
        allowedTools: this.toolNames,
        resume: sessionId,
        ...this.escapeHatches.claude,
      },
    })) {
      yield translateClaudeMessage(message);
    }
  }
}
```

In-process, simplest case. Native tools used directly; polyfilled tools registered as MCP tools.

### OpenAIAgent

```typescript
import { Agent as OpenAIAgentSDK, run } from '@openai/agents';

class OpenAIAgent implements UnifiedAgent {
  async *run({ prompt, sessionId }: RunInput) {
    const agent = new OpenAIAgentSDK({
      model: this.model,
      tools: this.tools,  // hosted + polyfilled
      ...this.escapeHatches.openai,
    });
    
    const stream = run(agent, { 
      input: prompt,
      previousResponseId: sessionId,
    });
    
    for await (const event of stream) {
      yield translateOpenAIEvent(event);
    }
  }
}
```

In-process. Hosted tools (web_search, code_interpreter, computer_use) used natively where requested; everything else polyfilled.

### VercelAgent

```typescript
import { Agent as VercelAgentSDK, stepCountIs } from 'ai';

class VercelAgent implements UnifiedAgent {
  async *run({ prompt }: RunInput) {
    const agent = new VercelAgentSDK({
      model: this.model,  // any @ai-sdk/* provider
      tools: this.toolsAsVercelTools,
      stopWhen: stepCountIs(50),
      ...this.escapeHatches.vercel,
    });
    
    const stream = agent.stream({ prompt });
    for await (const part of stream.fullStream) {
      yield translateVercelPart(part);
    }
  }
}
```

In-process. Provider-agnostic at the *model* layer — you can use Claude, GPT, Gemini, **or any local model** behind it. All tools polyfilled (Vercel ships none).

**This is the primary reason Vercel AI SDK is in the wrapper.** See [Local models](#local-models) below.

### CodexAgent

```typescript
import { CodexAppServerClient } from './generated/codex-app-server';

class CodexAgent implements UnifiedAgent {
  private client?: CodexAppServerClient;
  
  async ensureRunning() {
    if (this.client) return;
    this.client = await CodexAppServerClient.spawn({ transport: 'stdio' });
    await this.client.initialize({ /* ... */ });
  }
  
  async login(opts: { type: 'apiKey' | 'chatgpt' | 'chatgptDeviceCode' }) {
    await this.ensureRunning();
    return this.client!.call('account/login/start', opts);
  }
  
  async *run({ prompt, sessionId }: RunInput): AsyncIterable<AgentEvent> {
    await this.ensureRunning();
    
    const account = await this.client!.call('account/read', {});
    if (!account.loggedIn) throw new AuthRequired({ availableMethods: ['apiKey', 'chatgpt'] });
    
    const thread = sessionId
      ? await this.client!.call('thread/resume', { threadId: sessionId })
      : await this.client!.call('thread/start', {});
    
    const turn = await this.client!.call('turn/start', {
      threadId: thread.id,
      input: prompt,
    });
    
    for await (const notification of this.client!.notifications(turn.id)) {
      yield translateCodexNotification(notification);
    }
  }
  
  async close() {
    await this.client?.close();
  }
}
```

Subprocess. Stateful login flow. Custom tools via MCP server.

## Local models

**The primary motivation for including Vercel AI SDK.** It's the only one of the four backends with provider-agnostic model selection — `@ai-sdk/openai` and community providers can target any local server: Ollama, LM Studio, vLLM, llama.cpp, LocalAI, TGI, etc.

### Why the others can't really do local

| Backend | Local? | Notes |
|---|---|---|
| Claude Agent SDK | Limited | Only Ollama, via its Anthropic-API-compatible mode (`/v1/messages`). Not vLLM/LM Studio/llama.cpp. |
| OpenAI Agents SDK | ❌ | Built on Responses API; almost no local server implements it. |
| Codex | ❌ | Same — Responses API only. |
| **Vercel AI SDK Agent** | **✅** | **Any provider — primary local-model path.** |

### Limited tool set for local models

Local models — even strong ones (Qwen 2.5 Coder 32B, DeepSeek V3, Llama 3.3 70B) — degrade much faster than frontier models on long agent loops with many tools. The wrapper should support **per-model tool profiles**:

```typescript
const agent = new Agent({
  backend: 'vercel',
  model: ollama('qwen2.5-coder:32b'),
  tools: [tools.read, tools.write, tools.bash, tools.grep],  // small toolbox
  toolProfile: 'local-coder',  // implies tighter limits + simplified tool descriptions
  stopWhen: stepCountIs(15),    // tighter than the 50 we'd use for frontier
});
```

Profiles affect:

- **Toolbox size** — frontier models can juggle 20+ tools; local models do better with 4-6.
- **Tool descriptions** — frontier models handle terse JSON-schema; local models often need more verbose, example-laden descriptions.
- **Output formatting** — Claude is trained on its specific `Bash` truncation; local models need whatever shape they parse most reliably. Polyfilled tools should emit per-profile output formats.
- **`stopWhen` limits** — local models fall into tool-call loops more easily. Cap aggressively.
- **Tool-result size budgets** — clip outputs harder; local models lose track in long contexts faster than Claude/GPT.

### Suggested profiles

| Profile | Tools | Step cap | Output budget |
|---|---|---|---|
| `frontier` (default) | Full catalog | 50 | Generous |
| `local-coder` | read, write, edit, bash, grep, glob | 15 | Tight |
| `local-research` | webSearch, webFetch, read, write | 10 | Tight |
| `local-minimal` | read, bash | 8 | Very tight |

Profiles are opinionated defaults — the user can still pass an explicit `tools` array to override.

### Practical advantages of the local path

- **No subscription-OAuth or API ToS concerns at all.** Bypasses the whole `CLAUDE_CODE_OAUTH_TOKEN` / ChatGPT-OAuth gray area.
- **Cost predictability** — free after hardware setup.
- **Privacy** — data stays on-device.
- **Offline capable.**

### Trade-offs to document

- Tool-use reliability is markedly worse than frontier models. Users should expect more failures and tighter loops.
- Some agent patterns (heavy multi-step reasoning, complex tool chaining) may not work well at all on local models. Frontier-only escape hatch worth keeping.
- Streaming behavior varies per server — some local servers stream tokens, some only stream completed messages.

## Build order

1. **Event-stream normalization across all four** — the smallest abstraction with the biggest payoff. No polyfills required. Validates the design.
2. **Tool catalog with `read`/`write`/`bash`/`webSearch`/`webFetch`** — covers 80% of agent use cases.
3. **Session-resume with native-or-replay fallback** — exposed best-effort.
4. **Code interpreter and computer use** — the hardest polyfills, and where polyfill quality really shows.
5. **UI streaming integration** (Vercel-AI-SDK-style) — the unique unlock that justifies the wrapper. Render output from any backend through `useChat`.

## What kills it

- Trying to unify too much (auth, tracing, hooks)
- Polyfills that don't match observable contract → model behaves differently per-backend → users blame the wrapper
- Letting the abstraction grow to LCD (lowest common denominator) where every backend's distinctive features get hidden
- Not staying current with SDK updates (Codex regenerated types, new Vercel AI SDK Agent features, etc.)

## What makes it worth doing

The unique combination matrix nobody currently offers:
- **Local models with the same agent code that runs against frontier APIs** (the primary motivation — only achievable via Vercel AI SDK as the backend)
- Vercel's `useChat` rendering Claude Agent SDK output
- Claude's prebuilt toolbox running under OpenAI's tracing dashboard
- Codex's subscription auth with Claude's tool semantics on Vercel's UI layer
- Provider portability for the model with backend portability for the agent runtime

That's the unlock.
