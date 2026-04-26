# Per-Backend auth options

Add typed auth fields to `ClaudeBackendOptions` / `CodexBackendOptions` / `OpenAIBackendOptions` so callers can pass auth explicitly per Backend instance instead of via ambient `process.env` or the loose `env:` passthrough that exists on Claude and Codex today. Replace the env-passthrough fields with the typed equivalents — the typed fields cover the only documented use case (auth), and removing `env` eliminates a class of footguns (silent overrides, conflict with our managed `CODEX_HOME`, opaque error modes when typos slip through).

## Why

Today, two of the three SDK-wrapping backends accept auth only as a `Record<string, string>` env passthrough, and the OpenAI backend has no auth surface at all — it relies on the SDK's ambient `OPENAI_API_KEY`. This works for single-user processes but breaks down for two real cases:

1. **Multiple Backend instances in one process with different credentials.** A consumer that wants two `claude` Backends (different OAuth tokens, or a mix of API key and OAuth) currently has to monkey with `process.env` between calls or wedge everything into the loose `env:` field. Per-Backend typed fields make multi-account configurations straightforward and validated.
2. **Discoverability.** `env: { CLAUDE_CODE_OAUTH_TOKEN: '...' }` requires knowing the upstream env-var names. Typed `oauthToken: string` / `apiKey: string` fields are self-documenting and IDE-completable.

Secondary benefit: aligns the three SDK-wrapping backends with `vercel`'s shape, where auth lives inside the `LanguageModel` constructor, not in env.

## Current state

| Backend | Auth surface today | Where it goes |
|---|---|---|
| `claude` | `ClaudeBackendOptions.env?: Record<string, string \| undefined>` | Forwarded to SDK `query({env})`. Caller passes `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` keyed in. |
| `codex` | `CodexClientOptions.env?: Record<string, string \| undefined>` (via `CodexBackendOptions extends CodexClientOptions`) | Merged over `process.env` when spawning `codex app-server`. Auth is read entirely from `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`); `OPENAI_API_KEY` env is **not** consulted by the app-server (verified against codex-rs source — `enable_codex_api_key_env: false` at every call site, default OpenAI provider has `env_key: None`). The reason `OPENAI_API_KEY` appears to work today is that callers have run `codex login --with-api-key`, which writes the key into `auth.json`. |
| `openai` | None | `@openai/agents` constructs an OpenAI client from ambient `OPENAI_API_KEY` via the SDK's `setDefaultOpenAIKey`/default client. |
| `vercel` | `VercelBackendOptions.model: LanguageModel` | Auth lives inside the `LanguageModel` (e.g. `anthropic({apiKey})`). Already typed and per-instance. |

## Per-backend design

### Claude

Two auth modes: subscription OAuth and API key. Both upstream env vars (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) become typed fields:

```typescript
export interface ClaudeBackendOptions {
  // … existing fields …

  /**
   * Subscription OAuth token (Pro/Max). Equivalent to setting
   * `CLAUDE_CODE_OAUTH_TOKEN` in the SDK's env. Mutually exclusive with `apiKey`.
   */
  oauthToken?: string;

  /**
   * Anthropic API key. Equivalent to setting `ANTHROPIC_API_KEY`. Mutually
   * exclusive with `oauthToken`.
   */
  apiKey?: string;
}
```

**Wiring.** When either typed field is set, build a `{ ...process.env, <var>: <value> }` env record and pass it to the SDK. When both are unset, omit the SDK's `env` field entirely so the SDK uses its own default (`process.env`).

```typescript
let sdkEnv: Record<string, string | undefined> | undefined;
if (options.oauthToken !== undefined || options.apiKey !== undefined) {
  sdkEnv = { ...process.env };
  if (options.oauthToken !== undefined) sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
  if (options.apiKey !== undefined) sdkEnv.ANTHROPIC_API_KEY = options.apiKey;
}
```

Replace the current `options.env` passthrough at `claude/index.ts:202` with this construction.

**Removing `ClaudeBackendOptions.env`.** Auth was its only documented use; the typed fields cover it. Other env vars (proxies, debug flags) flow through ambient `process.env` because the SDK reads it by default. One in-tree consumer (`test/e2e/helpers.ts::claudeOAuthPreferredEnv`) migrates trivially to `oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN`.

**Resolution.** If neither typed field is set, the SDK falls back to ambient `process.env` (preserves backwards compat for callers who were relying on env-var-based auth).

### Codex

Codex auth is **entirely file-based** for the app-server we spawn. Both auth modes — ChatGPT OAuth and API key — live in the same `auth.json` file:

```jsonc
// auth.json schema (from codex-rs/login/src/auth/storage.rs)
{
  "auth_mode": "ApiKey" | "Chatgpt",
  "OPENAI_API_KEY": "sk-...",   // populated by `codex login --with-api-key`
  "tokens": { ... },             // populated by `codex login` (OAuth)
  "last_refresh": "..."
}
```

Mode resolution: `auth_mode` field if set; else `ApiKey` if `OPENAI_API_KEY` field is non-null; else `Chatgpt`. There is no env-var fallback at runtime. The `OPENAI_API_KEY` *env var* is irrelevant — only the field inside `auth.json` matters.

The only knob the codex CLI exposes for relocating auth is the `CODEX_HOME` env var (verified — there is no `--codex-home` flag); when set, it reads `$CODEX_HOME/auth.json`.

```typescript
export interface CodexBackendOptions extends CodexClientOptions {
  // … existing fields …

  /**
   * Profile name. Identifies a wrapper-managed `CODEX_HOME` slot under
   * `~/.agent-sdk/codex/<cwdHash>/<profile>/`. Defaults to `'default'`
   * when `apiKey` is set; otherwise unset means "use ambient ~/.codex/"
   * (current behavior).
   *
   * The profile owns the session/history state; rotating the API key
   * within the same profile preserves it.
   */
  profile?: string;

  /**
   * OpenAI API key. When set, the wrapper writes (or refreshes) an
   * `auth.json` (`{auth_mode: "ApiKey", OPENAI_API_KEY: <key>}`) into
   * the profile's `CODEX_HOME`. May be combined with `profile` (named
   * slot); on its own, the slot defaults to `'default'`.
   */
  apiKey?: string;

  /**
   * Override the cwd used to derive the per-project profile slot.
   * Defaults to `process.cwd()`. Pass an explicit value when constructing
   * a Backend from a different working directory than where you ran
   * `codex.login()` — same-cwd is required for the slots to match.
   */
  cwd?: string;
}
```

**Path layout.** All wrapper-managed CODEX_HOMEs live under `~/.agent-sdk/codex/`, keyed by cwd hash and profile name only — never by API-key hash. Rotating a key within a profile preserves that profile's session/history state.

```
~/.agent-sdk/codex/
  <cwdHash>/
    <profile>/
      auth.json          # written by wrapper when apiKey set; otherwise populated by `codex login`
      sessions/, history.jsonl, …  # codex CLI's own state, scoped to this profile
```

- `cwdHash = sha256(realpath(cwd)).slice(0, 16)`
- `<profile>` = literal `options.profile`, or `'default'` when only `apiKey` was passed.

`realpath()` resolves symlinks before hashing, so a symlinked checkout and the underlying real path produce the same slot. `codex.login({ cwd: '/Users/me/proj' })` and a Backend constructed from `/Volumes/symlinked/proj` (resolving to the same real path) share state correctly.

The cwd hash is intentional: codex stores session JSONLs and history under the same `CODEX_HOME`, so without per-cwd scoping a profile would leak transcripts across projects. Cross-project sharing is still available — omit both fields and codex will use ambient `~/.codex/`.

**Activation.** The cache mechanism kicks in only when at least one of `profile` or `apiKey` is set. Existing callers passing neither keep using ambient `~/.codex/` (full backwards compat).

**Resolution at construction:**
1. `effectiveProfile = options.profile ?? (options.apiKey !== undefined ? 'default' : undefined)`
2. If `effectiveProfile === undefined` → no cache; ambient `CODEX_HOME` / `~/.codex/`. Done.
3. Compute `dir = ~/.agent-sdk/codex/<cwdHash>/<effectiveProfile>/` and `mkdir -p` it (mode 0700).
4. If `options.apiKey` is set: write `dir/auth.json` (`{auth_mode: "ApiKey", OPENAI_API_KEY: <key>}`, mode 0600), unconditionally overwriting whatever is there. The wrapper-managed dir under `~/.agent-sdk/codex/` is pure cache — not a credential store. If a profile previously held OAuth tokens and the caller now passes `apiKey`, the new mode wins; re-running `codex login` for that profile re-establishes OAuth.
5. Else (profile only) and `dir/auth.json` is missing: throw a constructor error. Use a multi-line message with the exact command, formatted to be copy-pasteable as one block:
   ```
   Codex profile '<profile>' is not initialized for this project.
   To set it up, run one of:

     CODEX_HOME='<absolute-dir>' codex login                  # ChatGPT OAuth
     CODEX_HOME='<absolute-dir>' codex login --with-api-key   # API key

   Or call codex.login({ profile: '<profile>' }) from your code.
   ```
6. Set `CODEX_HOME=<dir>` in the spawn env.

**`codex.login()` helper.** Attached as a property on the `codex` factory function — same import as the Backend constructor, no separate symbol to discover:

```typescript
import { codex } from 'agent-sdk';

await codex.login({ profile: 'work' });                        // OAuth, scoped to process.cwd()
await codex.login({ profile: 'ci', apiKey: 'sk-...' });        // writes API-key auth.json
await codex.login({ profile: 'work', cwd: '/path/to/repo' });  // bootstrap a different project's profile
```

Signature: `codex.login(opts: { profile?: string; apiKey?: string; cwd?: string }): Promise<{ codexHome: string; mode: 'oauth' | 'apiKey' }>`. `cwd` defaults to `process.cwd()` so the dir derivation matches what the Backend would compute when constructed in the same place. The helper resolves the same `~/.agent-sdk/codex/<cwdHash>/<profile>/` dir, then either (a) `spawnSync('codex', ['login'], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: dir } })` for OAuth, or (b) writes the synthetic `auth.json` directly for `apiKey`, unconditionally overwriting whatever is there. Same cache-not-credential-store stance as the Backend. Useful for CLI tools that want to bootstrap before constructing a Backend, or for setup scripts that prepare profiles for many projects.

Implementation note: TypeScript supports `function codex(...): CodexBackend` plus `codex.login = function (...) { ... }` natively — declared as `codex: { (opts: CodexBackendOptions): CodexBackend; login(opts: ...): Promise<...> }` in the export.

**Profile sharing.** Two Backend instances with the same effective profile in the same cwd share `auth.json` and session state. Last-write-wins on `auth.json` is fine — the dir is wrapper-owned cache, never a long-term credential store. If you want concurrent Backends with different keys, give each one a distinct `profile` so they don't churn each other's cached `auth.json`.

**Never touch `~/.codex/`.** That's the user's own codex CLI state, populated by `codex login` in normal use. The wrapper writes only under `~/.agent-sdk/codex/`. Even when `profile`/`apiKey` are unset and the codex CLI falls back to ambient `~/.codex/`, the wrapper does nothing to that dir — no reads, no writes, no mode mutations.

**No cleanup on `close()`.** The cache is intentionally durable so codex's per-profile session/history state survives across runs. Stale cwd-hash dirs (project moved, profile abandoned) just sit; users can `rm -rf ~/.agent-sdk/codex/<cwdHash>/` if they care.

**Alternative (rejected for now): `loginApiKey` JSON-RPC.** The app-server v1 protocol exposes a `loginApiKey` method (`codex-rs/app-server-protocol/src/protocol/v1.rs:112-115`) that sets credentials per session without touching disk. Useful for the apiKey path. Skipped because (a) we haven't verified whether the handler persists or is in-memory only, and (b) it requires extending `CodexClient` to send a method post-handshake. Doesn't help the profile-only / OAuth case anyway. Track as a follow-up.

**No `env` passthrough on Codex.** The current `CodexClientOptions.env` field is removed from the `CodexBackendOptions` surface entirely. Auth has typed fields; everything else (proxies, debug flags) can be set via `process.env` before constructing the Backend, the same as for any other library. This is a small breaking change for any caller passing `env: { OPENAI_API_KEY }` today — migrate to `apiKey: '...'`.

### OpenAI

Single auth mode: API key. Wire via `@openai/agents-openai`'s `OpenAIProvider`, which is what `RunConfig.modelProvider` accepts:

```typescript
export interface OpenAIBackendOptions {
  // … existing fields …

  /**
   * OpenAI API key. If unset, falls back to ambient `OPENAI_API_KEY`.
   */
  apiKey?: string;

  /**
   * Optional override for the OpenAI base URL (proxy / Azure / on-prem).
   */
  baseURL?: string;

  /**
   * Optional OpenAI organization / project IDs.
   */
  organization?: string;
  project?: string;
}
```

**Wiring.** At Backend construction, build an `OpenAIProvider` if any of the new fields are set:

```typescript
import { OpenAIProvider } from '@openai/agents-openai';

const modelProvider = (options.apiKey || options.baseURL || options.organization || options.project)
  ? new OpenAIProvider({
      ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
      ...(options.baseURL !== undefined && { baseURL: options.baseURL }),
      ...(options.organization !== undefined && { organization: options.organization }),
      ...(options.project !== undefined && { project: options.project }),
    })
  : undefined;
```

Pass it through on every `run(this.agent, ..., { modelProvider, ... })` call (the events generator at `openai/index.ts` around line 240). When `modelProvider` is `undefined`, omit the field — the SDK falls back to its global default (current behavior).

**Why `OpenAIProvider` and not `setDefaultOpenAIKey`/`setDefaultOpenAIClient`.** The default-setters are process-global; calling them from a Backend constructor would race when multiple Backends coexist (last-wins). `OpenAIProvider` is per-call and matches our per-Backend model.

## Common semantics

- **Backward compat.** When no new auth fields are set, behavior is unchanged — the SDK reads ambient env. No upgrade churn for existing callers.
- **Mutual exclusion.** On Claude: setting both `oauthToken` and `apiKey` is a constructor-time error. On Codex: `apiKey` and `profile` are *not* mutually exclusive (the key is the credential written into the profile's slot).
- **`env` passthrough removed on both Claude and Codex.** Auth is the typed fields; non-auth env vars flow through ambient `process.env`. This is a breaking change for any caller passing `env:` today (one in-tree consumer for Claude, none for Codex).

## What to change (file by file)

### `src/backends/claude/index.ts`
- Add `oauthToken?: string`, `apiKey?: string` to `ClaudeBackendOptions`.
- **Remove** `env?: Record<string, string | undefined>` from `ClaudeBackendOptions`. Breaking change.
- In the SDK options assembly (around line 195–204): when either typed field is set, pass `env: { ...process.env, <var>: <value> }`; when both unset, omit `env` entirely.
- Constructor-time mutual-exclusion check between `oauthToken` and `apiKey`.

### `src/backends/codex/index.ts` and `src/backends/codex/client.ts`
- Add `profile?: string`, `apiKey?: string` to `CodexBackendOptions`. Combinable.
- **Remove** `env?: Record<string, string | undefined>` from the user-facing `CodexBackendOptions`. (CodexClient may keep an internal env-merge for the spawn, but it's no longer plumbed through from Backend options.) Breaking change — call out in CHANGELOG.
- Add a small helper module (`profileSlot.ts` or similar) that takes `{ apiKey?, profile?, cwd }` and returns `{ codexHome: string } | undefined` (undefined = no cache, fall through to ambient). Logic:
  - `effectiveProfile = profile ?? (apiKey ? 'default' : undefined)`
  - If undefined, return undefined.
  - Compute `dir`, `mkdir -p`.
  - If `apiKey`: idempotent write of `dir/auth.json`.
  - Else if `auth.json` missing: throw with the multi-line copy-pasteable error.
  - Return `{ codexHome: dir }`.
- Implement `codex.login()` as a property on the `codex` factory function (declared as a TS function-with-property; lives in `src/backends/codex/login.ts`). Same dir resolution as the Backend; either spawns `codex login` interactively or writes the synthetic auth.json for an `apiKey`.
- In `CodexClient`'s constructor, call the helper and set `CODEX_HOME` on the spawn env when defined.
- No cleanup in `close()`.

### `src/backends/openai/index.ts`
- Add `apiKey?: string`, `baseURL?: string`, `organization?: string`, `project?: string` to `OpenAIBackendOptions`.
- Construct `OpenAIProvider` lazily at Backend construction; store as `this.modelProvider`.
- Pass `modelProvider` in every `run(...)` call's `RunConfig`.
- Import `OpenAIProvider` from `@openai/agents-openai` (already a transitive dep, but verify the export path).

### `spec/backends/claude.md` / `spec/backends/codex.md` / `spec/backends/openai.md`
- Update each Auth section to document the new typed fields. Codex section: document the `profile`/`apiKey` shape, the cache layout under `~/.agent-sdk/codex/<cwdHash>/<profile>/`, the `codex.login()` helper, and the `env` field removal.

### `src/index.ts`
- No new top-level export — `codex.login` rides along with the existing `codex` factory.

### Tests
- Add unit tests verifying the new fields wire through to the underlying SDK options (Claude env merge; Codex helper resolution + auth.json write/read; OpenAI `modelProvider` instance).
- Codex helper-specific tests: `apiKey`-only defaults profile to `'default'`; `profile`-only with missing auth.json throws with the documented multi-line message; `profile`+`apiKey` writes idempotently; same effective profile across calls reuses the dir.
- E2E coverage: at least one test per backend that hits the real service with a per-Backend auth — currently the e2e suite munges `process.env`; this is a chance to validate the new path end-to-end.

### CHANGELOG / README
- Note the additions; link from the README's per-backend examples to show the new pattern (`claude({ apiKey: '...' })`, `codex({ profile: 'work', apiKey: '...' })`).
- Call out the breaking change: `CodexBackendOptions.env` is removed.

## Backwards compatibility

- Existing callers relying on ambient `process.env` keep working unchanged (typed fields default to undefined; the SDK falls back to env).
- **Breaking changes** (both narrow):
  - `ClaudeBackendOptions.env` is removed. Callers using `env: { CLAUDE_CODE_OAUTH_TOKEN: ... }` migrate to `oauthToken: '...'`; ditto for API keys. One in-tree consumer (`test/e2e/helpers.ts::claudeOAuthPreferredEnv`).
  - `CodexBackendOptions.env` is removed. Callers using `env: { OPENAI_API_KEY }` migrate to `apiKey: '...'`. No in-tree consumers.
- For both backends: callers who used `env:` for *non-auth* variables (proxies, debug flags) set them via ambient `process.env` instead. The Claude SDK and `codex app-server` both read process env by default.

## Open questions

1. **`loginApiKey` RPC handler semantics.** The app-server v1 protocol has a `loginApiKey` method that may be a cleaner alternative to writing `auth.json` for the API-key path. Unverified: whether the handler persists to disk or stays in-memory. Worth checking before shipping; if in-memory only, it would let us skip the cache entirely for API-key callers (still need the cache for profile/OAuth). File: `codex-rs/app-server/src/message_processor*`. Defer to a follow-up.
2. **Stale cwd-hash dirs.** Move a project, hash changes, the old dir lingers at `~/.agent-sdk/codex/<oldHash>/`. Probably acceptable for v1 — small disk cost, easy to `rm -rf` manually. Could ship a `pnpm exec agent-sdk codex gc` helper later if it bites.
3. **`OpenAIProvider` close lifecycle.** `OpenAIProvider` has a `close()` method (clears websocket caches). Worth wiring into Backend disposal? Probably yes for completeness, though our backends don't currently surface a dispose hook. Defer; track separately.
4. **README/spec auth-table corrections.** Several places in the existing tree imply `OPENAI_API_KEY` env works for Codex (README auth table, `spec/architecture.md`, error messages in `src/backends/codex/index.ts`). It "works" only because users have `auth.json` from `codex login --with-api-key`. Fix these in the same PR — the misleading docs are a recurring source of confusion.

## Once this lands

`spec/architecture.md` in protos has a "Per-process auth caveat" paragraph that says only Vercel supports per-profile API keys. With this change, all four backends do. Strike the caveat (or rewrite it as "per-backend auth is per-Backend-instance; processes typically run one daemon for one user, but multi-account setups work").
