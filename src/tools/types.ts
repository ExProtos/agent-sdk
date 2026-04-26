/**
 * Tool definition. A single Tool can be:
 *   - Registered as a native tool on Claude Agent SDK (by name match in `native.claude`)
 *   - Registered as a native tool on Codex AppServer (by name match in `native.codex`)
 *   - Registered as an in-process MCP tool on Vercel AI SDK Agent (always
 *     uses `execute`, since Vercel has no native tools)
 *
 * Backends pick native where available, fall back to `execute` where not.
 */

import type { z } from 'zod';

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  /**
   * Backend-native tool indicator. If set, the backend handles this tool
   * itself and `execute` is not called. A tool with neither
   * `native.<backend>` nor `execute` is silently dropped on that backend.
   *
   * Value semantics by backend:
   *   - `claude` / `codex`: string — the SDK's wire name (e.g. `'Bash'`,
   *     `'commandExecution'`); backend plumbs it through and the SDK runs
   *     it server-side.
   *   - `vercel`: string — the canonical name (`'task'`, `'todo'`); backend
   *     special-cases the tool in-process to provide contextual behavior.
   *   - `openai`: string OR object —
   *       - String: a canonical marker the backend recognizes (`'task'`,
   *         `'todo'`, `'web_search'`, `'code_interpreter'`,
   *         `'image_generation'`). Backend dispatches: special-cases the
   *         contextual ones; lazy-constructs the SDK hosted tool with
   *         default options for the rest.
   *       - Object: a pre-configured SDK tool instance from `@openai/agents`
   *         (e.g. `webSearchTool({userLocation})`,
   *         `fileSearchTool(['vs_id'])`, `computerTool({computer})`).
   *         Backend forwards verbatim. The `hostedTools.*` factories
   *         produce this form.
   */
  native?: {
    claude?: string;
    codex?: string;
    vercel?: string;
    openai?: string | object;
  };
  /** In-process implementation. Required unless every backend has a native mapping. */
  execute?(input: TInput): Promise<TOutput>;
}

export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
