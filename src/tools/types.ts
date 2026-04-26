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
   * Native tool name on each backend. If set, the backend uses its built-in
   * implementation and `execute` is not called. If not set, `execute` is
   * wired up — in-process for Vercel, via the MCP bridge for Codex.
   */
  native?: {
    claude?: string;
    codex?: string;
  };
  /**
   * Backend-hosted tool descriptors. The OpenAI Agents backend recognizes
   * `hosted.openai` and forwards the stashed SDK tool object directly into
   * the underlying Agent. Other backends ignore `hosted.*` entirely.
   *
   * The value is opaque (`unknown`) to avoid leaking @openai/agents types
   * into the public Tool interface — `hostedTools.*` factories in the
   * openai-agents backend produce the right shape.
   */
  hosted?: {
    openai?: unknown;
  };
  /** In-process implementation. Required unless every backend has a native mapping. */
  execute?(input: TInput): Promise<TOutput>;
}

export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
