# Todo

Things we've decided are worth doing but haven't yet. Each entry: what, why, rough shape. Cross off when shipped.

## Codex tool disabling

Expose Codex's TOML tool toggles through `CodexBackendOptions` so consumers can turn off specific built-ins (e.g. web search) on a per-backend basis.

**Why.** Codex has no per-call allowlist like Claude's `allowedTools`, but its TOML config does support some toggles (e.g. `tools.web_search = false`). The `thread/start` request accepts a `config` blob that passes these through. We currently use that field exclusively for wiring the MCP bridge — adding a passthrough lets consumers narrow Codex's surface without forking the wrapper.

**Shape.**

```typescript
codex({
  tools: tools.all,
  codexConfig: {
    tools: { web_search: false },
    // any other TOML keys Codex's config schema accepts
  },
})
```

**What changes.** ~10 LOC in `src/backends/codex/index.ts`:

- Add `codexConfig?: Record<string, unknown>` to `CodexBackendOptions`.
- Merge it into `buildCodexConfig(bridge)` alongside the `mcp_servers` entry. Bridge entry wins on key collision (we own that key).
- Document the limitation: granularity is whatever Codex's TOML exposes, not per-tool. Bash is load-bearing for Codex's loop and effectively always available.

**Caveat.** We'd need to verify the exact set of Codex TOML keys that disable tools. Today only `tools.web_search` is confirmed; others (`tools.apply_patch`, `tools.plan`, …) need checking against upstream Codex's config schema before documenting.

## Verify Codex's `item/completed` duplication behavior

Confirm whether Codex actually emits `item/completed` more than once for the same item id over a long-lived item's lifecycle (`fileChange`, `collabAgentToolCall`).

**Why.** spec/backends/codex.md currently hedges: the typed `status` field includes `inProgress`, which *hints* duplicates can happen, but we haven't observed it on the wire. The "Duplicate `tool_call_end` is possible" subsection is written defensively as a result. If duplicates never occur in practice, that whole section can collapse to a single sentence ("translateItem is 1:1 with item/completed; no dedupe needed"). If they do, the existing consumer rule stands — but with evidence behind it.

**Shape.** ~5 min of e2e instrumentation:

- In an e2e run that exercises a long-lived `fileChange` (the multi-edit cases already do), log every raw `item/completed` notification with `{type, id, status}` before it hits `translateItem`.
- Group by `id`, count entries per group. Any group with count > 1 confirms the behavior.
- Repeat for `collabAgentToolCall` once we have an e2e that spawns a sub-agent.

**Outcome.** Either delete the hedge in spec/backends/codex.md and add a one-line "verified single-emission, no dedupe needed" note, or keep the section and replace "though we haven't observed it on the wire" with a concrete reproduction (which item type, which conditions).

## Vercel backend auto-compaction

Build within-backend auto-compaction for the Vercel backend so it matches Claude/Codex behavior when the context window fills up during a long conversation.

**Why.** Claude Agent SDK and Codex AppServer both auto-compact natively — when usage approaches the context limit, they summarize older turns and continue. The Vercel backend currently does nothing: when context overflows, the underlying provider just errors. AI SDK doesn't ship a compaction primitive (`pruneMessages` is mechanical drop-old-reasoning/tool-calls; `prepareStep` is a per-step hook with no built-in summarization), so we have to write the policy ourselves. Cross-backend / cross-model compaction stays the consumer's job; this is purely the Claude/Codex parity case.

**Shape.** ~150 LOC in `src/backends/vercel/index.ts`:

```typescript
vercel({
  model,
  // optional knobs; defaults shown
  autoCompact: true,
  contextThreshold: 0.8,        // fraction of context window
  compactionModel: undefined,   // defaults to `model`; can be cheaper
  keepLastTurns: 4,
})
```

Algorithm, run between turns (never mid-turn):

1. After `streamText` finishes, read `usage.inputTokens` from the finish part. If `inputTokens / contextWindow >= contextThreshold`, schedule compaction for next turn.
2. Before next `streamText` call, if scheduled: split history into `[older, lastN]`. Run a `generateText` against `compactionModel` with a tuned prompt summarizing `older`. Build new history as `[{role: 'user', content: 'Earlier in this conversation: <summary>'}, ...lastN]`. Persist the swap to JSONL (replace the older entries with the summary message — keeps reload coherent).
3. Continue with the new history.

**Open questions** (defer until building):

- Token budget per model — do we hardcode a table, or read from the provider's metadata? Provider metadata via the AI SDK's `LanguageModel` interface is inconsistent across providers; a hardcoded fallback table is probably required.
- Compaction prompt — needs iteration. Claude Code's `/compact` prompt is a real artifact; we'd reverse-engineer the same shape.
- JSONL durability during compaction — the rewrite isn't atomic. If the process crashes mid-compaction, JSONL is in a torn state. Probably write the new compacted history to a sibling `.jsonl.tmp` then rename — or accept the risk for v0.
- Per-message-role placement of the summary — system message (cleanest, but some providers don't support mid-conversation system messages) vs. synthetic user message ("Earlier in this conversation: …"). Synthetic user is safer cross-provider.

**Non-goals.** No tail-of-conversation compaction (we keep the last N turns verbatim — no summarizing the active context). No cross-provider summary normalization (each provider sees a free-form text summary).
