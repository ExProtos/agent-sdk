/**
 * Pre-built Tool definitions for the canonical coding-agent toolbox.
 *
 * v0: native mappings only. The schema and description are informational —
 * Claude SDK and Codex AppServer use their own internal tool descriptions
 * when these tools fire natively. They become load-bearing when we add
 * the Vercel backend (polyfilled execution via in-process MCP).
 */

import { z } from 'zod';
import type { Tool } from './types';
import * as polyfills from './polyfills';

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
};

/**
 * Edit a file. Accepts either of two shapes:
 *   - find/replace: { path, old_string, new_string } — Claude's Edit shape
 *   - unified-diff: { patch } — Codex's apply_patch shape
 *
 * The schema is a union so the model emits whichever shape its training
 * prefers; the polyfill (when we add it for Vercel) discriminates by
 * field presence and runs the appropriate implementation. On Claude and
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
};

/**
 * Find files matching a glob pattern. Claude has it as a dedicated `Glob`
 * tool. Codex doesn't have a dedicated tool — its model uses bash (find,
 * ls, etc.) via command/exec. Marking native.codex='command/exec' so the
 * Codex backend doesn't try to polyfill (we'd just shadow what bash already
 * does well, and the model is trained to reach for bash anyway).
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
};

/**
 * Search file contents. Claude has a dedicated `Grep` tool. Codex doesn't,
 * but its model is heavily trained on bash-based grep/rg via command/exec.
 * Same reasoning as glob — don't polyfill, let Codex use shell.
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
};

/**
 * Fetch a URL. Native on both backends:
 *   - Claude: dedicated `WebFetch` tool
 *   - Codex: subsumed by the unified webSearch capability (action.type
 *     'openPage'). The Codex backend translates that action variant back
 *     to a `webFetch` event, so consumers see the same canonical name
 *     regardless of which backend served the request.
 *
 * `execute` is the in-process polyfill used by backends that lack a native
 * (e.g. Vercel AI SDK Agent). It is NOT used on Codex — the Codex backend
 * sees `native.codex` is set and routes via Codex's native browsing.
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
  execute: polyfills.webFetch,
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
 * Default coding-agent toolbox.
 */
export const all: Tool[] = [bash, read, write, edit, glob, grep, webFetch, webSearch];
