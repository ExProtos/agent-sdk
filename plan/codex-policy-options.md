# Codex approval/sandbox policy options

Add typed `askForApproval` and `sandboxMode` fields to `CodexBackendOptions` and reconcile the hardcoded approval-decline handlers with the configured policy. Today there's no way to configure either through agent-sdk; callers must either edit `~/.codex/config.toml` globally or jam `-c approval_policy="never"` into `args:`. That works but isn't discoverable, isn't typed, and the hardcoded `decline` responses inside `client.ts` actively conflict with what a `'never'`-ask-for-approval caller expects.

The field name `askForApproval` (rather than `approvalPolicy`) mirrors codex's `AskForApproval` enum verbatim and avoids the English ambiguity of "policy: never" — `askForApproval: 'never'` reads as "never ask," not "never approve."

## Why

Three concrete pain points surface today:

1. **Unattended callers can't configure the policy through the typed surface.** `CodexBackendOptions` exposes `command` / `args` / `cwd` / `codexHome` but nothing about approval or sandbox behavior. The Claude backend has `permissionMode?: SDKOptions['permissionMode']` for exactly this; Codex needs the parallel.
2. **The hardcoded `{ decision: 'decline' }` is wrong for unattended consumers.** When codex's policy DOES route an approval request to the client (anything other than `never` / fully-permissive), agent-sdk auto-declines — so the action fails. There's no escape hatch. For a caller running with `approval_policy = "never"` this never fires, but for `on-request` or `granular` it kills any command that the model wanted to escalate.
3. **`thread/start`'s `config` blob is the right plumbing point but isn't being used.** `buildCodexConfig` currently only injects `mcp_servers` and `model_reasoning_effort`. The codex protocol accepts `approval_policy` and `sandbox_mode` in the same blob (per `codex-rs/protocol/src/protocol.rs:469`, `:531`, `:607`).

## Current state

| Knob | Today | Where |
|---|---|---|
| Approval policy | not exposed; defaults to codex's `on-request` unless overridden in `~/.codex/config.toml` or via `-c approval_policy="…"` in `args:`. | n/a |
| Sandbox mode | not exposed; defaults to codex's `read-only` (the model can't write or run commands). | n/a |
| Approval-flow callbacks | hardcoded `{ decision: 'decline' }` for `fileChangeApproval` / `applyPatchApproval` / `execCommandApproval` (`client.ts:60-65`). | `src/backends/codex/client.ts` |
| Permissions request | hardcoded `{ permissions: {}, scope: 'turn' }` (deny everything) | same |

Codex's enums (from `codex-rs/protocol/src/protocol.rs:939` and `codex-rs/protocol/src/config_types.rs:66`):

```rust
// AskForApproval (kebab-case on the wire)
"untrusted" | "on-failure" (deprecated) | "on-request" (default) | "granular" | "never"

// SandboxMode (kebab-case on the wire)
"read-only" (default) | "workspace-write" | "danger-full-access"
```

## Proposed surface

```typescript
export interface CodexBackendOptions {
  // … existing fields …

  /**
   * When (if ever) codex pauses to ask the client for approval before running
   * a command or making a file change. Mirrors codex's `AskForApproval` enum.
   *
   * Read each value as "ask for approval: <value>":
   * - `'never'` — never ask. Commands run subject to `sandboxMode`; failures
   *   are returned to the model. Right choice for unattended callers.
   *   **NOT "never approve" — actions still execute.**
   * - `'on-request'` — ask when the model decides to escalate. Codex's default.
   * - `'untrusted'` — auto-approve read-only safe commands; ask for the rest.
   * - `'granular'` — fine-grained per-category. Pass `granularApproval`
   *   alongside this value.
   *
   * If unset, codex falls back to `~/.codex/config.toml` (or its built-in default).
   */
  askForApproval?: 'never' | 'untrusted' | 'on-request' | 'granular';

  /**
   * Granular approval flags (only honored when `askForApproval: 'granular'`).
   * Each flag: true = allowed, false = auto-rejected. See codex's
   * `GranularApprovalConfig` for the field set.
   */
  granularApproval?: {
    shell?: boolean;       // true = ask, false = auto-reject
    fileChange?: boolean;
    // … keep shape mirrored to codex's GranularApprovalConfig struct
  };

  /**
   * Codex's sandbox mode — what the spawned commands can do filesystem-wise.
   *
   * - `'read-only'` — codex default; commands can read but not write.
   * - `'workspace-write'` — write inside the workspace, no network.
   * - `'danger-full-access'` — unrestricted. Pair with an OS-level sandbox
   *   if the host isn't trusted.
   *
   * If unset, codex falls back to `~/.codex/config.toml` (or its built-in default).
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
}
```

These are passive overrides — when unset, the existing config-file fallthrough is unchanged.

## Wiring

**`buildCodexConfig`** gains two more conditional fields:

```typescript
function buildCodexConfig(
  bridge: BridgeConfig | null,
  effort: CodexEffort | undefined,
  askForApproval: AskForApproval | undefined,
  granularApproval: GranularApprovalConfig | undefined,
  sandboxMode: SandboxMode | undefined,
): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};
  // … existing mcp_servers / model_reasoning_effort …
  if (askForApproval !== undefined) {
    // Wire field stays `approval_policy` (codex's serde name); only our
    // typed-surface name differs.
    config.approval_policy = askForApproval === 'granular' && granularApproval
      ? { granular: granularApproval }
      : askForApproval;
  }
  if (sandboxMode !== undefined) {
    config.sandbox_mode = sandboxMode;
  }
  return Object.keys(config).length > 0 ? config : null;
}
```

(The `granular` shape might be `{ Granular: { … } }` in serde — verify against the actual JSON wire format codex deserializes. Run a quick `codex app-server -c 'approval_policy.granular.shell=true' …` to confirm.)

**Constructor** stashes the new options on the instance the same way the existing ones are.

## The approval-handler problem

`client.ts:60-65` auto-declines all approval requests. That's the conflicting piece. Three reasonable resolutions:

1. **Hardcode `accept` instead of `decline`.** Unsafe. Even for `approval_policy: 'never'` callers, this is unreachable code (codex never escalates), so it's a no-op. But for `on-request` / `granular` callers, a default `accept` would silently approve everything — exactly the wrong default.

2. **Honor `askForApproval`.** Branch on the configured policy:
   - `'never'` → unreachable (codex never sends these requests). Doesn't matter what we return.
   - `'untrusted'` / `'on-request'` / `'granular'` → keep `decline`. Caller has explicitly opted into prompts and they have no way to handle them programmatically through agent-sdk yet.
   - Recommended for v1: keep current `decline` behavior, document loudly that "if you want to approve programmatically, use `'never'` instead — there's no callback hook yet."

3. **Add an `onApproval` callback option.** Most flexible:
   ```typescript
   onApprovalRequest?: (req: ApprovalRequest) => Promise<{ decision: 'accept' | 'decline' }>;
   ```
   Caller passes a handler; default stays `decline`. This is the right long-term shape but adds API surface. Defer; ship `(2)` first.

**Recommendation: pick (2) for this PR.** Add a doc comment to the new `askForApproval` field saying "if you set anything other than `'never'`, command-level approval requests will auto-decline — there's no programmatic accept path yet. Track follow-up: add `onApprovalRequest` callback."

## What to change (file by file)

### `src/backends/codex/index.ts`
- Add `askForApproval?`, `granularApproval?`, `sandboxMode?` to `CodexBackendOptions`.
- Stash them on the instance in the constructor.
- Update `buildCodexConfig`'s signature and body to fold them into the Codex config blob.
- Pass them through both `thread/start` call sites (line 200ish — the resume and fresh-start branches).

### `src/backends/codex/client.ts`
- Add a doc comment above the hardcoded `decline` block explaining the v1 limitation: programmatic accept isn't supported yet; callers wanting unattended operation set `askForApproval: 'never'`.
- No code change in this PR (defer the callback hook).

### `spec/backends/codex.md`
- Document the two new options and the relationship between approval policy and the hardcoded handlers. Recommend `askForApproval: 'never'` + `sandboxMode: 'workspace-write'` (or `'danger-full-access'`) for unattended consumers, paired with OS-level sandboxing.

### `README.md`
- Auth/config table mentions the new options.

### Tests
- Unit: each new field plumbs through to `buildCodexConfig` correctly (typed → expected JSON shape).
- Unit: `granular` variant produces the expected nested shape.
- E2E (only if cheap): a `'never'` policy run successfully executes a write under `'workspace-write'`; same run under default `'read-only'` fails.

## Open questions

1. **Granular shape on the wire.** codex's `Granular(GranularApprovalConfig)` enum variant — verify whether serde emits `{ "granular": { … } }`, `{ "Granular": { … } }`, or some other tag. Quick test against `codex app-server -c '…'` settles this. Don't ship the `granular` field until confirmed.
2. **`workspace_write` extra config.** Codex's `WorkspaceWrite` mode has its own sub-fields (allowed-write paths, network access, etc.) per `derive_sandbox_policy` (`config_toml.rs:644`). v1 ships only the high-level mode flag; sub-config can be a follow-up if anyone needs it.
3. **Programmatic approval callback.** As noted under "the approval-handler problem" — add `onApprovalRequest?` in a follow-up PR. Not urgent: the typical unattended consumer just wants `'never'`, which is the new typed option.
4. **Should `permissionMode` on `ClaudeBackendOptions` get a more typed shape too?** Currently `SDKOptions['permissionMode']` is the SDK's enum. Out of scope for this PR; mention only if we revisit Claude's surface in tandem.

## Once this lands

Protos's spec can document the recommended Codex configuration in `architecture.md` → Security considerations:

> **Codex backend (unattended):** set `approval_policy: 'never'` and `sandbox_mode: 'workspace-write'` (or `'danger-full-access'` paired with an OS-level sandbox). Without these, the codex backend's default `on-request` policy will issue approval requests that agent-sdk currently auto-declines, causing tool calls to fail.

And the coding skill can stop hedging about "more dangerous" — the unattended posture is explicit.
