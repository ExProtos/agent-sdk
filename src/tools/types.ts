/**
 * Tool definition. A single Tool can be:
 *   - Registered as a native tool on Claude Agent SDK (by name match in `native.claude`)
 *   - Registered as a native tool on Codex AppServer (by name match in `native.codex`)
 *   - Registered as an in-process MCP tool on Vercel AI SDK Agent (always polyfilled)
 *
 * Backends pick native where available, polyfill via `execute` where not.
 */

import type { z } from 'zod';

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  /**
   * Native tool name on each backend. If set, the backend uses its built-in
   * implementation and `execute` is not called. If not set, `execute` is wired
   * up via in-process MCP.
   */
  native?: {
    claude?: string;
    codex?: string;
  };
  /** Polyfill implementation. Required unless every backend has a native mapping. */
  execute?(input: TInput): Promise<TOutput>;
}

export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
