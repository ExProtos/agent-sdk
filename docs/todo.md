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
