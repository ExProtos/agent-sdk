# Tools

The canonical tool catalog. Each tool is a single `Tool` definition exported from `src/tools/builtin.ts`. The spec for the `Tool` interface and how backends pick native vs. bridge vs. in-process is in [architecture.md](architecture.md) → Tool model.

The catalog name is the **canonical** name. It's the value the consumer's `switch (event.toolCall.name)` will see, regardless of which backend's native tool fired.

## Conventions

- All schemas use Zod 4 (`import { z } from 'zod'`).
- `description` is what the model sees on backends that take user-supplied descriptions (the bridge path; future Vercel backend). On Claude and Codex's natives the description is informational — the SDK's internal description wins.
- `native.claude` is the wire name passed to Claude's `allowedTools` — must match Claude's exact tool name.
- `native.codex` is the wire name on the corresponding Codex item type — must match Codex's emitted `item.type` so the Codex backend's translator skips bridge wiring (see backends/codex.md → Bridge eligibility).
- `execute` is provided only when the in-process path is reachable. Today only `webFetch` has one (placeholder for the planned Vercel backend; never invoked under Claude or Codex).

## `bash`

Run a shell command and return its combined stdout/stderr.

```typescript
{
  name: 'bash',
  description: 'Run a shell command and return its combined stdout/stderr.',
  schema: z.object({
    command: z.string(),
    timeout: z.number().optional(),
  }),
  native: { claude: 'Bash', codex: 'command/exec' },
}
```

The Codex backend translates `commandExecution` items to `bash` tool_call events with input `{command}` and a tool_result carrying `aggregatedOutput` and `isError = exitCode !== 0`.

## `read`

Read a file from the local filesystem.

```typescript
{
  name: 'read',
  description: 'Read a file from the local filesystem.',
  schema: z.object({
    path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  native: { claude: 'Read', codex: 'fs/readFile' },
}
```

## `write`

Write a file, overwriting any existing content.

```typescript
{
  name: 'write',
  description: 'Write a file to the local filesystem, overwriting any existing content.',
  schema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  native: { claude: 'Write', codex: 'fs/writeFile' },
}
```

## `edit`

Edit a file with either a find/replace pair or a unified-diff patch. Single canonical tool, **union schema**, so the model can emit whichever shape its training prefers.

```typescript
{
  name: 'edit',
  description:
    'Edit a file. Provide either {path, old_string, new_string} for find/replace, or {patch} as a unified-diff.',
  schema: z.union([
    z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
    z.object({ patch: z.string() }),
  ]),
  native: { claude: 'Edit', codex: 'apply_patch' },
}
```

The Codex backend translates `fileChange` items to `edit` tool_call events with input `{changes: [{path, kind, diff}]}`. Tool_result is emitted only when status is `completed | failed | declined` — interim `inProgress` updates are skipped to avoid orphaning the tool_call.

## `glob`

Find files matching a glob pattern.

```typescript
{
  name: 'glob',
  description: 'Find files matching a glob pattern.',
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
  }),
  native: { claude: 'Glob', codex: 'command/exec' },
}
```

Codex doesn't ship a dedicated glob tool — its model reaches for shell `find`/`ls` via `command/exec`. `native.codex: 'command/exec'` exists to mark this tool as "Codex covers it through bash" so the backend doesn't try to bridge a custom in-process implementation. The wrapper would just shadow what bash already does.

## `grep`

Search file contents with a regex pattern.

```typescript
{
  name: 'grep',
  description: 'Search file contents with a regex pattern.',
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
  }),
  native: { claude: 'Grep', codex: 'command/exec' },
}
```

Same reasoning as `glob` — Codex's model is heavily trained on `grep` / `rg` via shell.

## `webFetch`

Fetch a URL and return its content as text.

```typescript
{
  name: 'webFetch',
  description: 'Fetch the content of a URL and return it as text.',
  schema: z.object({ url: z.string().url() }),
  native: { claude: 'WebFetch', codex: 'webSearch' },
  execute: impl.webFetch,
}
```

Codex doesn't have a dedicated `webFetch` tool — its **unified `webSearch` capability** subsumes URL fetching via `action.type === 'openPage'`. The Codex backend's `translateItem` watches for that variant and emits `tool_call_end` named `webFetch` instead of `webSearch`, so consumers see one canonical name regardless of which Codex action variant fired.

`execute` is provided as a placeholder for the planned Vercel backend (Vercel ships no native tools, so every tool needs `execute`). On Claude and Codex it's never invoked — both have natives.

The current implementation in `src/tools/implementations.ts` is intentionally minimal:

```typescript
export async function webFetch({ url }: { url: string }): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`webFetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}
```

Don't add HTML-to-markdown extraction here. That's a richer-tool concern; consumers wanting clean markdown can wire their own Tool with their preferred extractor (Readability, Jina, Playwright, …).

## `webSearch`

Search the web and return relevant results.

```typescript
{
  name: 'webSearch',
  description: 'Search the web and return relevant results.',
  schema: z.object({ query: z.string() }),
  native: { claude: 'WebSearch', codex: 'webSearch' },
}
```

Both backends run the search server-side:

- Claude: dedicated `WebSearch` tool, filterable via `allowedTools`.
- Codex: part of its built-in browsing capability; not filterable per-call (controlled by Codex config). Codex's `webSearch` item also covers `findInPage` and `openPage`. The Codex backend translates `openPage` → `webFetch` (above) and the rest → `webSearch`.

## `todo`

Track multi-step plans as the agent works. **Union schema** because Claude's and Codex's plan formats differ.

```typescript
{
  name: 'todo',
  description:
    "Record or update the agent's multi-step plan. Either pass a structured `todos` array, or freeform `text`.",
  schema: z.union([
    z.object({
      todos: z.array(z.object({
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']),
        activeForm: z.string(),
      })),
    }),
    z.object({ text: z.string() }),
  ]),
  native: { claude: 'TodoWrite', codex: 'plan' },
}
```

Codex `plan` items carry a single `text` field (freeform). Claude `TodoWrite` carries a structured array. The union schema lets the model emit whatever its training prefers; the canonical name on the event is `todo` either way, with the raw input shape preserved.

## `tools.all`

```typescript
export const all: Tool[] = [bash, read, write, edit, glob, grep, webFetch, webSearch, todo];
```

Order is the declaration order above. Consumers pass either `tools.all` or a hand-picked subset:

```typescript
codex({ tools: tools.all })
codex({ tools: [tools.bash, tools.read, tools.write] })
```

Custom tools mix in normally — the backend only treats a tool as "custom" if it has `execute` and lacks `native.codex` (Codex bridge path) or lacks `native.claude` (Claude — currently skipped).
