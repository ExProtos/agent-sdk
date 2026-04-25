# Auth & ToS

How each backend handles authentication, and what the subscription-OAuth path actually means commercially.

## Auth options per backend

| Backend | API key | Subscription OAuth | Cloud provider OAuth |
|---|---|---|---|
| Claude Agent SDK | `ANTHROPIC_API_KEY` | ✅ `CLAUDE_CODE_OAUTH_TOKEN` | Bedrock / Vertex / Foundry |
| OpenAI Agents SDK | `OPENAI_API_KEY` | ❌ | Azure OpenAI |
| Vercel AI SDK Agent | Whatever provider accepts | Whatever provider accepts | Whatever provider accepts |
| Codex AppServer | `OPENAI_API_KEY` env, or `account/login/start { type: "apiKey" }` | ✅ `account/login/start { type: "chatgpt" }` | — |

## How subscription OAuth tokens work

### Claude Agent SDK + `CLAUDE_CODE_OAUTH_TOKEN`

1. User runs `claude setup-token` (Anthropic's CLI). Browser opens, OAuth flow runs, token printed.
2. Token is `sk-ant-oat01-…` — tied to user's Pro/Max subscription.
3. SDK reads `CLAUDE_CODE_OAUTH_TOKEN` env var and uses it as a bearer token.
4. SDK adds the right `anthropic-beta` header and prepends a Claude-Code system-prompt prefix automatically.
5. Calls billed against subscription, not API metered usage.

This is a **documented, supported** auth path in the SDK. Not a hack.

### Codex AppServer + ChatGPT OAuth

1. User invokes `account/login/start` with `type: "chatgpt"` (or runs `codex login` interactively).
2. Browser-based OAuth completes, tokens persisted to `$CODEX_HOME` (default `~/.codex/`).
3. Codex refreshes tokens automatically.
4. Calls billed against ChatGPT Plus/Pro subscription.

Also documented and supported by Codex.

## ToS — the actually-important part

Both subscription OAuth paths are licensed for **personal interactive use**. The token authenticates *you*, not your application.

### Clearly fine

- Personal assistant for *you* in your own DMs (Slack DMs to yourself, your own iMessage, your own Telegram)
- A coding agent on your laptop that you drive interactively
- One human (you) consuming Claude/GPT responses paid for by your one subscription

### Gray area

- A small group chat where a couple of family members occasionally @-mention the agent
- Volume that looks like automation (cron jobs, scheduled scrapes) even if it's "just you"

### Not fine

- Multi-user team Slack or Discord where coworkers/customers consume Claude/GPT via your subscription
- Any commercial product or service powered by your personal subscription
- High-volume automation that looks like a service

### The decision rule

> If Anthropic / OpenAI looked at the message logs, would it look like *you* using the AI, or like you running a service on top of your subscription?

If the former → fine. If the latter → use an API key.

## NanoClaw context

NanoClaw uses `CLAUDE_CODE_OAUTH_TOKEN` by default and supports ChatGPT-via-Codex through its `/add-codex` skill. The architecture is fine; the ToS question is purely about *who* is on the receiving end of the agent's responses.

NanoClaw setup:
- Single-user DMs → use OAuth, you're fine
- Multi-user channels → use API key (`ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` for Codex), or wire each user's own subscription through their own NanoClaw instance

## Wrapper-design implication

**Don't unify auth** in the wrapper. Pass through to each backend.

- Claude/OpenAI/Vercel: env vars or constructor args. Document which are accepted.
- Codex: stateful login flow. Expose as `agent.login({ type, ... })` — this is the one place where auth genuinely doesn't fit the env-var pattern.

Document the subscription-OAuth ToS caveat prominently in the wrapper's README. Users who don't read it and wire their personal token into a multi-user product are the most likely failure mode.
