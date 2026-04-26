/**
 * Factories for OpenAI's hosted tools — web search, file search, code
 * interpreter, computer use, image generation. Each one wraps the
 * corresponding `@openai/agents` factory and stashes the resulting SDK
 * tool object in `Tool.hosted.openai` so the openai-agents backend can
 * forward it directly into the underlying Agent.
 *
 * Schemas on these wrappers are no-op `z.object({})` because the model
 * never sees them — hosted tools are dispatched server-side by OpenAI,
 * which knows the real schemas. We carry just enough to surface a
 * canonical name in the event stream.
 *
 * Other backends (Claude, Codex, Vercel) ignore `hosted.openai` entirely
 * and treat these tools as no-ops since they have no `execute` and no
 * `native.{claude,codex}` mapping.
 */
import {
  webSearchTool,
  fileSearchTool,
  codeInterpreterTool,
  imageGenerationTool,
  computerTool,
  type Computer,
} from '@openai/agents';
import { z } from 'zod';
import type { Tool } from '../../tools/types';

const NO_INPUT = z.object({});

export function webSearch(options?: Parameters<typeof webSearchTool>[0]): Tool {
  return {
    name: 'webSearch',
    description: 'OpenAI hosted web search.',
    schema: NO_INPUT,
    hosted: { openai: webSearchTool(options) },
  };
}

export function fileSearch(
  vectorStoreIds: string | string[],
  options?: Parameters<typeof fileSearchTool>[1],
): Tool {
  return {
    name: 'fileSearch',
    description: 'OpenAI hosted file search over configured vector stores.',
    schema: NO_INPUT,
    hosted: { openai: fileSearchTool(vectorStoreIds, options) },
  };
}

export function codeInterpreter(
  options?: Parameters<typeof codeInterpreterTool>[0],
): Tool {
  return {
    name: 'codeInterpreter',
    description: 'OpenAI hosted code interpreter (sandboxed Python).',
    schema: NO_INPUT,
    hosted: { openai: codeInterpreterTool(options) },
  };
}

export function imageGeneration(
  options?: Parameters<typeof imageGenerationTool>[0],
): Tool {
  return {
    name: 'imageGeneration',
    description: 'OpenAI hosted image generation.',
    schema: NO_INPUT,
    hosted: { openai: imageGenerationTool(options) },
  };
}

export function computerUse<TComputer extends Computer = Computer>(
  options: Parameters<typeof computerTool<unknown, TComputer>>[0],
): Tool {
  return {
    name: 'computerUse',
    description: 'OpenAI hosted computer use — drives a screen via screenshots and click/type/scroll actions.',
    schema: NO_INPUT,
    hosted: { openai: computerTool<unknown, TComputer>(options) },
  };
}
