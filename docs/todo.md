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
