/**
 * Pre-built Tool definitions for the canonical coding-agent toolbox.
 *
 * The schema and description are informational on Claude and Codex —
 * each SDK has its own internal tool definitions when these fire natively.
 * They become load-bearing when used on a backend without a native (Vercel
 * AI SDK Agent, when added) or routed through the MCP bridge for a custom
 * tool.
 */

import { z } from 'zod';
import type { Tool } from './types';
import * as impl from './implementations';

export const bash: Tool = {
  name: 'bash',
  description: 'Run a shell command and return its combined stdout/stderr.',
  schema: z.object({
    command: z.string(),
    timeout: z.number().optional(),
  }),
  native: {
    claude: 'Bash',
    codex: 'command/exec',
  },
  execute: impl.bash,
};

export const read: Tool = {
  name: 'read',
  description: 'Read a file from the local filesystem.',
  schema: z.object({
    path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  native: {
    claude: 'Read',
    codex: 'fs/readFile',
  },
  execute: impl.read,
};

export const write: Tool = {
  name: 'write',
  description: 'Write a file to the local filesystem, overwriting any existing content.',
  schema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  native: {
    claude: 'Write',
    codex: 'fs/writeFile',
  },
  execute: impl.write,
};

/**
 * Edit a file. Accepts either of two shapes:
 *   - find/replace: { path, old_string, new_string } — Claude's Edit shape
 *   - unified-diff: { patch } — Codex's apply_patch shape
 *
 * The schema is a union so the model emits whichever shape its training
 * prefers; the in-process implementation (when we add it for Vercel)
 * discriminates by field presence. On Claude and
 * Codex backends the schema is informational — each backend uses its
 * native tool, which has its own schema.
 */
export const edit: Tool = {
  name: 'edit',
  description:
    'Edit a file. Provide either {path, old_string, new_string} for find/replace, or {patch} as a unified-diff.',
  schema: z.union([
    z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
    }),
    z.object({
      patch: z.string(),
    }),
  ]),
  native: {
    claude: 'Edit',
    codex: 'apply_patch',
  },
  execute: impl.edit,
};

/**
 * Find files matching a glob pattern. Claude has it as a dedicated `Glob`
 * tool. Codex doesn't have a dedicated tool — its model uses bash (find,
 * ls, etc.) via command/exec. Marking native.codex='command/exec' so the
 * Codex backend doesn't try to bridge a custom implementation (we'd just
 * shadow what bash already does well, and the model is trained to reach
 * for bash anyway).
 */
export const glob: Tool = {
  name: 'glob',
  description: 'Find files matching a glob pattern.',
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
  }),
  native: {
    claude: 'Glob',
    codex: 'command/exec',
  },
  execute: impl.glob,
};

/**
 * Search file contents. Claude has a dedicated `Grep` tool. Codex doesn't,
 * but its model is heavily trained on bash-based grep/rg via command/exec.
 * Same reasoning as glob — don't bridge a custom implementation, let
 * Codex use shell.
 */
export const grep: Tool = {
  name: 'grep',
  description: 'Search file contents with a regex pattern.',
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
  }),
  native: {
    claude: 'Grep',
    codex: 'command/exec',
  },
  execute: impl.grep,
};

/**
 * Fetch a URL. Native on both backends:
 *   - Claude: dedicated `WebFetch` tool
 *   - Codex: subsumed by the unified webSearch capability (action.type
 *     'openPage'). The Codex backend translates that action variant back
 *     to a `webFetch` event, so consumers see the same canonical name
 *     regardless of which backend served the request.
 *
 * `execute` is the in-process implementation used by backends that lack
 * a native (e.g. Vercel AI SDK Agent). It is NOT used on Codex — the
 * Codex backend sees `native.codex` is set and routes via Codex's native
 * browsing.
 */
export const webFetch: Tool = {
  name: 'webFetch',
  description: 'Fetch the content of a URL and return it as text.',
  schema: z.object({
    url: z.string().url(),
  }),
  native: {
    claude: 'WebFetch',
    codex: 'webSearch',
  },
  execute: impl.webFetch,
};

/**
 * Web search. Both backends run the search server-side:
 *   - Claude exposes it as the `WebSearch` tool (filterable via allowedTools)
 *   - Codex runs it as part of its built-in browsing capability and emits
 *     `webSearch` items (not filterable per-call; controlled by Codex config)
 *
 * Codex's webSearch item also covers `openPage` (≈ webFetch) and
 * `findInPage`. The Codex backend translates each action variant back to
 * our canonical name in the event stream.
 */
export const webSearch: Tool = {
  name: 'webSearch',
  description: 'Search the web and return relevant results.',
  schema: z.object({
    query: z.string(),
  }),
  native: {
    claude: 'WebSearch',
    codex: 'webSearch',
  },
};

/**
 * Track multi-step plans as the agent works.
 *
 * Claude has `TodoWrite` (structured: array of todos with status). Codex has
 * `plan` items (freeform text). Schema is a union so the model emits whatever
 * its training prefers; events surface under one canonical name with the
 * raw input shape preserved.
 */
export const todo: Tool = {
  name: 'todo',
  description:
    'Record or update the agent\'s multi-step plan. Either pass a structured `todos` array, or freeform `text`.',
  schema: z.union([
    z.object({
      todos: z.array(
        z.object({
          content: z.string(),
          status: z.enum(['pending', 'in_progress', 'completed']),
          activeForm: z.string(),
        }),
      ),
    }),
    z.object({ text: z.string() }),
  ]),
  native: {
    claude: 'TodoWrite',
    codex: 'plan',
    vercel: 'todo',
    openai: 'todo',
  },
};

/**
 * Delegate work to a sub-agent. Both backends ship a primitive but with
 * very different shapes:
 *   - Claude `Task` is one-shot: { description, prompt, subagent_type } → result.
 *   - Codex `collabAgentToolCall` is multi-step: spawn / sendInput / wait /
 *     resume / closeAgent against a long-lived sub-thread.
 *
 * Schema is a union so the model emits whichever shape its training prefers.
 * The catalog name is `task` either way; consumers switch on a single
 * canonical name and discriminate on input shape if they care.
 */
export const task: Tool = {
  name: 'task',
  description:
    'Delegate work to a sub-agent. Claude form: one-shot {description, prompt, subagent_type}. Codex form: multi-step {tool, prompt?, model?, receiverThreadIds?} where tool is spawnAgent | sendInput | resumeAgent | wait | closeAgent.',
  schema: z.union([
    z.object({
      description: z.string(),
      prompt: z.string(),
      subagent_type: z.string(),
    }),
    z.object({
      tool: z.enum(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent']),
      prompt: z.string().optional(),
      model: z.string().optional(),
      receiverThreadIds: z.array(z.string()).optional(),
    }),
  ]),
  native: {
    claude: 'Task',
    codex: 'collabAgentToolCall',
    vercel: 'task',
    openai: 'task',
  },
};

/**
 * Default coding-agent toolbox.
 */
export const all: Tool[] = [
  bash,
  read,
  write,
  edit,
  glob,
  grep,
  webFetch,
  webSearch,
  todo,
  task,
];

/**
 * Replace `execute` on tools by canonical name. Returns a NEW Tool[] —
 * the inputs are not mutated. Other fields (schema, description, native)
 * are preserved from the base tool.
 *
 * Throws on keys that don't match any tool in `base` — catches typos and
 * stale references after a tool gets renamed.
 *
 * Use this to swap our anemic defaults for production-ready impls
 * (rendering web fetch, real search providers) and to plug execute
 * bodies into tools that ship without one (`webSearch`, `todo`, `task`):
 *
 * ```typescript
 * const myTools = withImpls(tools.all, {
 *   webFetch: async ({ url }) => fetchAndRenderMarkdown(url),
 *   webSearch: async ({ query }) => brave.search(query),
 * });
 * vercel({ tools: myTools });
 * ```
 */
export function withImpls(
  base: Tool[],
  overrides: Record<string, (input: any) => Promise<unknown>>,
): Tool[] {
  const byName = new Map(base.map((t) => [t.name, t]));
  for (const name of Object.keys(overrides)) {
    if (!byName.has(name)) {
      throw new Error(
        `withImpls: no tool named '${name}' in base — known: ${[...byName.keys()].join(', ')}`,
      );
    }
  }
  return base.map((t) =>
    overrides[t.name] !== undefined ? { ...t, execute: overrides[t.name]! } : t,
  );
}
