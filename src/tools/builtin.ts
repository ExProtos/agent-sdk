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
 * Find/replace edit. Claude's `Edit` shape — single `old_string` must match
 * exactly once. Codex has `apply_patch` (unified diff format) which is a
 * different shape, so `native.codex` is intentionally unset; users targeting
 * Codex get its native `apply_patch` regardless of whether they include this
 * tool in the list.
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

export const webFetch: Tool = {
  name: 'webFetch',
  description: 'Fetch the content of a URL and return it. Claude-only.',
  schema: z.object({
    url: z.string().url(),
  }),
  native: {
    claude: 'WebFetch',
  },
};

/**
 * Web search. Claude has a native `WebSearch` tool (provider runs the search
 * server-side). Codex performs web searches as part of its loop and emits
 * `webSearch` items, but doesn't expose a tool clients invoke explicitly —
 * `native.codex` is intentionally unset.
 */
export const webSearch: Tool = {
  name: 'webSearch',
  description: 'Search the web and return relevant results.',
  schema: z.object({
    query: z.string(),
  }),
  native: {
    claude: 'WebSearch',
  },
};

/**
 * Default coding-agent toolbox. Convenience for the common case.
 * Equivalent to `[bash, read, write, edit, glob, grep, webFetch, webSearch]`.
 */
export const all: Tool[] = [bash, read, write, edit, glob, grep, webFetch, webSearch];
