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
 * Find/replace edit (Claude's `Edit` shape). Single `old_string` must match
 * exactly once. Distinct from `applyPatch` (unified-diff format used by Codex)
 * — they're different cognitive operations and models are trained on one or
 * the other.
 */
export const edit: Tool = {
  name: 'edit',
  description: 'Replace exact text in a file. The `old_string` must appear exactly once.',
  schema: z.object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
  }),
  native: {
    claude: 'Edit',
  },
};

/**
 * Apply a unified-diff patch (Codex's `apply_patch` shape). Can span multiple
 * files and multiple hunks. Distinct from `edit` — see edit's docstring.
 *
 * No polyfill is planned: models that don't natively speak unified-diff
 * (everything except OpenAI's coding models) tend to be unreliable at it.
 * Users wanting cross-backend file edits should prefer `edit`.
 */
export const applyPatch: Tool = {
  name: 'applyPatch',
  description:
    'Apply a unified-diff patch. Can span multiple files and multiple hunks. The patch must be in standard unified-diff format.',
  schema: z.object({
    patch: z.string(),
  }),
  native: {
    codex: 'apply_patch',
  },
};

export const glob: Tool = {
  name: 'glob',
  description: 'Find files matching a glob pattern. Claude-only.',
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
  }),
  native: {
    claude: 'Glob',
  },
};

export const grep: Tool = {
  name: 'grep',
  description: 'Search file contents with a regex pattern. Claude-only.',
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
  }),
  native: {
    claude: 'Grep',
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
 * Default coding-agent toolbox. Convenience for the common case — both
 * `edit` and `applyPatch` are included so the same `tools.all` works
 * across Claude (uses edit) and Codex (uses applyPatch). Each backend
 * exposes only what it natively supports.
 */
export const all: Tool[] = [
  bash,
  read,
  write,
  edit,
  applyPatch,
  glob,
  grep,
  webFetch,
  webSearch,
];
