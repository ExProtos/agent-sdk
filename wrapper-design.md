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

In-process. Provider-agnostic at the *model* layer — you can use Claude, GPT, Gemini, etc. behind it. All tools polyfilled (Vercel ships none).

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
- Vercel's `useChat` rendering Claude Agent SDK output
- Claude's prebuilt toolbox running under OpenAI's tracing dashboard  
- Codex's subscription auth with Claude's tool semantics on Vercel's UI layer
- Provider portability for the model with backend portability for the agent runtime

That's the unlock.
