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

## Faster grep implementation

The default `grep` impl (`src/tools/implementations.ts`) globs every candidate file then reads each one fully into a Buffer to check for matches. Fine for small trees but slow + memory-heavy for repos with thousands of files or any large file in the search set.

**Why.** Read-everything-then-match is `O(total bytes)`, single-threaded, and allocates the full file as a Buffer before scanning. A streaming line reader would short-circuit on the first match per file and keep memory bounded. Even better: shell out to `rg` (ripgrep) when it's on PATH — it's typically 10-100x faster, handles `.gitignore` correctly, has its own binary-detection heuristic, and parallelizes file reads.

**Shape.** Two layers:

1. Detect `rg` on PATH at module load. If present, the grep impl shells out to it: `rg --no-heading --line-number --color=never <pattern> [--glob <filter>] <root>`. Parse the output line by line into `file:line:text`. ~30 LOC.
2. If not present, fall back to the current implementation but switch to a streaming line reader (`readline.createInterface({ input: fs.createReadStream(file) })`) instead of `fs.readFile` + `split('\n')`. Drops worst-case memory from `O(file size)` to `O(line size)`. ~30 LOC.

**Caveats.**
- `rg` arg semantics differ slightly from our schema (e.g., glob filter vs. file-type flag). Need to translate.
- Binary detection: ripgrep's heuristic is more sophisticated than our 4KB NUL-byte check. Different files may be skipped on the rg path — acceptable since rg's behavior is what users expect when they have it installed.
- `.gitignore` semantics: rg honors it by default; our impl doesn't. Document the divergence or pass `--no-ignore` for parity.
