/**
 * Vercel AI SDK backend.
 *
 * Delegates the agent loop to ai-sdk's `streamText` (the same primitive
 * `Agent.stream` calls underneath). Unlike Claude/Codex, this backend has
 * **no native tools** — every tool the model can invoke must have an
 * in-process `execute()`. Tools without one are silently skipped.
 *
 * Provider portability: pass any `LanguageModel` — `@ai-sdk/anthropic`,
 * `@ai-sdk/openai`, `@ai-sdk/google`, or any `@ai-sdk/openai-compatible`
 * endpoint (Ollama, LM Studio, vLLM, llama.cpp). This is the unique
 * unlock vs the other backends.
 *
 * Continuation: a minted UUID keyed against an in-memory `ModelMessage[]`
 * map (L1 cache). With the optional `jsonlPath` config, conversation
 * history is also persisted to disk as `UIMessage[]` JSONL (one message
 * per line) — this is the only backend that supports cross-restart
 * resume out of the box, since Vercel has no native session storage.
 *
 * Mid-turn `push()` is supported: a follow-up message arriving while the
 * generator is mid-stream queues a second `streamText` invocation against
 * the updated history. If no `push()` arrives, the query is single-shot:
 * one turn, then `session_end`.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  convertToModelMessages,
  readUIMessageStream,
  streamText,
  tool as vercelTool,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StopCondition,
  type TextStreamPart,
  type ToolSet,
} from 'ai';

import type {
  AgentEvent,
  AgentQuery,
  Backend,
  QueryInput,
  StopReason,
  TokenUsage,
} from '../../types';
import type { Tool } from '../../tools/types';
import { appendUIMessage, readUIMessages } from '../../persistence';

export interface VercelBackendOptions {
  /** Required. Any AI SDK LanguageModel. */
  model: LanguageModel;
  /**
   * Tools to expose. Tools without `execute` are silently skipped — there
   * are no native tools on this backend. Tools with `native.*` set on
   * other backends are still wired here as long as `execute` is provided.
   */
  tools?: Tool[];
  /** System prompt. Mapped to streamText's `system` parameter. */
  instructions?: string;
  /** Stop condition. Defaults to ai-sdk's built-in `stepCountIs(20)`. */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  /** Pass-through call settings. */
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  /**
   * Override the directory where session JSONL files are written.
   * Defaults to `<process.cwd()>/.agent-sdk/sessions/`. Each continuation
   * gets one file at `<sessionsDir>/<continuation>.jsonl`. Persistence
   * is always on — this option exists primarily so tests can isolate to
   * a temp directory without juggling `process.chdir`.
   */
  sessionsDir?: string;
  /**
   * Decide which tools a sub-agent (the `task` tool) gets when spawned.
   * Receives the model-supplied `subagent_type` hint (Claude convention;
   * empty string if absent). Default: every parent tool except `task`
   * itself — single-level delegation, no recursive spawning.
   *
   * To honor Claude's `subagent_type` semantics (researcher, code-reviewer,
   * …), return a tailored `Tool[]` for each. To allow recursion, include
   * the `task` tool in the returned list — at your own risk.
   */
  subagentTools?: (subagent_type: string) => Tool[];
}

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export class VercelBackend implements Backend {
  readonly name = 'vercel';

  private readonly model: LanguageModel;
  private readonly toolSet: ToolSet;
  private readonly callOptions: Pick<
    VercelBackendOptions,
    'instructions' | 'stopWhen' | 'maxOutputTokens' | 'temperature' | 'topP' | 'topK'
  >;
  private readonly sessionsDir: string;
  // L1 cache: continuation token → ModelMessage[]. Populated on first query
  // and on cache-miss reloads from disk.
  private readonly histories = new Map<string, ModelMessage[]>();

  constructor(options: VercelBackendOptions) {
    this.model = options.model;
    this.sessionsDir =
      options.sessionsDir ?? path.join(process.cwd(), '.agent-sdk', 'sessions');

    const parentTools = options.tools ?? [];
    const set: ToolSet = {};
    for (const t of parentTools) {
      if (t.name === 'task') {
        // The task tool is contextual — it needs the parent's model and
        // a derived tool subset. Build a closure-bound replacement here
        // rather than calling the canonical execute (which has none).
        const subagentToolsFor =
          options.subagentTools ??
          ((_: string) => parentTools.filter((p) => p.name !== 'task'));
        const model = this.model;
        const callOptions = () => this.callOptions;
        set[t.name] = vercelTool({
          description: t.description,
          inputSchema: t.schema,
          execute: async (input: unknown) =>
            runSubAgent(input, model, subagentToolsFor, callOptions()),
        });
        continue;
      }
      if (!t.execute) continue;
      set[t.name] = vercelTool({
        description: t.description,
        inputSchema: t.schema,
        execute: async (input: unknown) => t.execute!(input),
      });
    }
    this.toolSet = set;

    this.callOptions = {
      ...(options.instructions !== undefined && { instructions: options.instructions }),
      ...(options.stopWhen !== undefined && { stopWhen: options.stopWhen }),
      ...(options.maxOutputTokens !== undefined && { maxOutputTokens: options.maxOutputTokens }),
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.topP !== undefined && { topP: options.topP }),
      ...(options.topK !== undefined && { topK: options.topK }),
    };
  }

  query(input: QueryInput): AgentQuery {
    const continuation = input.continuation ?? randomUUID();
    const filePath = path.join(this.sessionsDir, `${continuation}.jsonl`);

    const pushQueue: string[] = [];
    let endRequested = false;
    let aborted = false;
    let resolveWait: (() => void) | null = null;
    const abortController = new AbortController();

    const wakeup = () => {
      const r = resolveWait;
      resolveWait = null;
      r?.();
    };

    const model = this.model;
    const tools = this.toolSet;
    const callOptions = this.callOptions;
    const histories = this.histories;
    const systemAppend = input.systemPromptAppend;
    const persistPath = filePath;
    const initialMessage = input.message;

    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: 'session_start', continuation };

      // Load history: in-memory first, fall back to disk on miss.
      let history = histories.get(continuation);
      if (history === undefined) {
        const stored = readUIMessages(persistPath);
        history = stored.length > 0 ? await convertToModelMessages(stored) : [];
        histories.set(continuation, history);
      }

      // Append the inbound user message and persist as a UIMessage.
      if (initialMessage !== undefined) {
        history.push({ role: 'user', content: initialMessage });
        appendUIMessage(persistPath, {
          id: randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: initialMessage }],
        });
      }

      let lastUsage: TokenUsage = ZERO_USAGE;
      let lastStopReason: StopReason = 'stop';

      try {
        // Run turns until: nothing queued + end()/no-push, or aborted.
        while (!aborted) {
          const lastIsUser =
            history.length > 0 && history[history.length - 1]!.role === 'user';

          if (!lastIsUser) {
            // Need a user message before we can stream. Wait on push() or end().
            if (pushQueue.length === 0 && !endRequested) {
              await new Promise<void>((r) => {
                resolveWait = r;
              });
            }
            if (aborted) break;
            if (pushQueue.length === 0) break; // end() with empty queue
            const next = pushQueue.shift()!;
            history.push({ role: 'user', content: next });
            appendUIMessage(persistPath, {
              id: randomUUID(),
              role: 'user',
              parts: [{ type: 'text', text: next }],
            });
          }

          const system = combineSystem(callOptions.instructions, systemAppend);

          const result = streamText({
            model,
            tools,
            messages: history,
            abortSignal: abortController.signal,
            ...(system !== undefined && { system }),
            ...(callOptions.stopWhen !== undefined && { stopWhen: callOptions.stopWhen }),
            ...(callOptions.maxOutputTokens !== undefined && {
              maxOutputTokens: callOptions.maxOutputTokens,
            }),
            ...(callOptions.temperature !== undefined && { temperature: callOptions.temperature }),
            ...(callOptions.topP !== undefined && { topP: callOptions.topP }),
            ...(callOptions.topK !== undefined && { topK: callOptions.topK }),
          });

          // Persistence runs concurrently with fullStream consumption — both
          // tee from the same underlying source per the SDK's internals.
          const persistPromise = (async () => {
            for await (const msg of readUIMessageStream({
              stream: result.toUIMessageStream(),
            })) {
              appendUIMessage(persistPath, msg);
            }
          })();

          const textBuf = new Map<string, string>();
          const reasoningBuf = new Map<string, string>();

          for await (const part of result.fullStream) {
            if (aborted) break;
            yield { type: 'activity' };
            yield* translatePart(part, textBuf, reasoningBuf);
            if (part.type === 'finish-step') {
              lastUsage = mapUsage(part.usage);
              lastStopReason = mapStopReason(part.finishReason);
            } else if (part.type === 'finish') {
              lastUsage = mapUsage(part.totalUsage);
            }
          }

          // Wait for persistence to drain before we fold steps into history,
          // so the JSONL never lags the in-memory cache.
          await persistPromise;

          if (aborted) break;

          const steps = await result.steps;
          for (const step of steps) {
            history.push(...step.response.messages);
          }
          histories.set(continuation, history);

          yield { type: 'turn_end', reason: lastStopReason };

          // Single-shot semantics: if no push() arrived during the turn, finish.
          if (pushQueue.length === 0 && !endRequested) break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: msg, retryable: false };
      }

      const finalReason: StopReason = aborted ? 'aborted' : lastStopReason;
      yield { type: 'session_end', stopReason: finalReason, usage: lastUsage };
    }

    return {
      push: (m) => {
        pushQueue.push(m);
        wakeup();
      },
      end: () => {
        endRequested = true;
        wakeup();
      },
      abort: () => {
        aborted = true;
        abortController.abort();
        wakeup();
      },
      events: events(),
    };
  }

  async close(): Promise<void> {
    this.histories.clear();
  }
}

export function vercel(options: VercelBackendOptions): VercelBackend {
  return new VercelBackend(options);
}

// ── Sub-agent runner (for the `task` tool) ──

/**
 * Spawn a sub-agent for the `task` tool. Accepts the Claude one-shot form
 * `{description, prompt, subagent_type}`. The Codex multi-step form
 * (`{tool, prompt?, model?, receiverThreadIds?}`) is not supported on
 * Vercel — it requires long-lived sub-thread management that doesn't map
 * cleanly to a single in-process invocation.
 *
 * The sub-agent runs as a fresh `generateText` call:
 *   - same model as the parent (no override in v0)
 *   - tools from `subagentToolsFor(subagent_type)` — defaults to all
 *     parent tools except `task` (no recursive spawning)
 *   - sub-agent events do NOT enter the parent's AgentEvent stream;
 *     the parent sees one `tool_call_end` and one `tool_result` only
 *
 * Returns the sub-agent's final assistant text.
 */
export async function runSubAgent(
  input: unknown,
  model: LanguageModel,
  subagentToolsFor: (subagent_type: string) => Tool[],
  callOptions: Pick<
    VercelBackendOptions,
    'instructions' | 'stopWhen' | 'maxOutputTokens' | 'temperature' | 'topP' | 'topK'
  >,
): Promise<string> {
  // Discriminate the union schema. Codex form has a `tool` discriminator
  // ('spawnAgent' | 'sendInput' | …); Claude form has `prompt` + optional
  // `description` / `subagent_type`. Reject Codex form explicitly.
  if (typeof input !== 'object' || input === null) {
    throw new Error('task tool: input must be an object');
  }
  if ('tool' in input) {
    throw new Error(
      'task tool: Codex multi-step form is not supported on Vercel; pass {description, prompt, subagent_type}',
    );
  }
  if (!('prompt' in input) || typeof (input as { prompt: unknown }).prompt !== 'string') {
    throw new Error('task tool: input requires a `prompt` string');
  }
  const claudeForm = input as {
    description?: string;
    prompt: string;
    subagent_type?: string;
  };
  const subagent_type = claudeForm.subagent_type ?? '';

  // Build the sub-agent's tool set from the provided Tool[].
  const tools: ToolSet = {};
  for (const t of subagentToolsFor(subagent_type)) {
    if (!t.execute) continue;
    tools[t.name] = vercelTool({
      description: t.description,
      inputSchema: t.schema,
      execute: async (subInput: unknown) => t.execute!(subInput),
    });
  }

  // Use streamText (not generateText) so the same provider mocks/configs
  // that work for the parent backend also work here. We only need the
  // final text — `result.text` is a Promise that resolves once the
  // tool-loop terminates.
  const result = streamText({
    model,
    tools,
    messages: [{ role: 'user', content: claudeForm.prompt }],
    ...(callOptions.instructions !== undefined && { system: callOptions.instructions }),
    ...(callOptions.stopWhen !== undefined && { stopWhen: callOptions.stopWhen }),
    ...(callOptions.maxOutputTokens !== undefined && {
      maxOutputTokens: callOptions.maxOutputTokens,
    }),
    ...(callOptions.temperature !== undefined && { temperature: callOptions.temperature }),
    ...(callOptions.topP !== undefined && { topP: callOptions.topP }),
    ...(callOptions.topK !== undefined && { topK: callOptions.topK }),
  });

  return await result.text;
}

// ── Helpers ──

function combineSystem(base: string | undefined, append: string | undefined): string | undefined {
  if (base === undefined && append === undefined) return undefined;
  if (base === undefined) return append;
  if (append === undefined) return base;
  return `${base}\n\n${append}`;
}

function mapStopReason(reason: FinishReason): StopReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool-calls':
      return 'tool_calls';
    case 'error':
      return 'error';
    case 'content-filter':
    case 'other':
      return 'stop';
  }
}

function mapUsage(usage: LanguageModelUsage): TokenUsage {
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

/**
 * Translate one Vercel AI SDK `fullStream` part to zero or more AgentEvents.
 *
 * `textBuf` / `reasoningBuf` accumulate deltas keyed by part id so we can
 * synthesize `*_end` events with the full text — Vercel's `text-end` /
 * `reasoning-end` parts don't carry the text themselves.
 */
export function* translatePart(
  part: TextStreamPart<ToolSet>,
  textBuf: Map<string, string>,
  reasoningBuf: Map<string, string>,
): Generator<AgentEvent> {
  switch (part.type) {
    case 'text-start':
      textBuf.set(part.id, '');
      yield { type: 'text_start' };
      return;
    case 'text-delta':
      textBuf.set(part.id, (textBuf.get(part.id) ?? '') + part.text);
      yield { type: 'text_delta', delta: part.text };
      return;
    case 'text-end':
      yield { type: 'text_end', text: textBuf.get(part.id) ?? '' };
      textBuf.delete(part.id);
      return;

    case 'reasoning-start':
      reasoningBuf.set(part.id, '');
      yield { type: 'thinking_start' };
      return;
    case 'reasoning-delta':
      reasoningBuf.set(part.id, (reasoningBuf.get(part.id) ?? '') + part.text);
      yield { type: 'thinking_delta', delta: part.text };
      return;
    case 'reasoning-end':
      yield { type: 'thinking_end', text: reasoningBuf.get(part.id) ?? '' };
      reasoningBuf.delete(part.id);
      return;

    case 'tool-input-start':
      yield { type: 'tool_call_start', id: part.id, name: part.toolName };
      return;
    case 'tool-input-delta':
      yield { type: 'tool_call_input_delta', id: part.id, deltaJson: part.delta };
      return;
    case 'tool-input-end':
      // No event — `tool-call` next will carry the full input.
      return;

    case 'tool-call':
      yield {
        type: 'tool_call_end',
        toolCall: { id: part.toolCallId, name: part.toolName, input: part.input },
      };
      return;

    case 'tool-result':
      yield {
        type: 'tool_result',
        result: { toolCallId: part.toolCallId, output: part.output, isError: false },
      };
      return;

    case 'tool-error':
      yield {
        type: 'tool_result',
        result: {
          toolCallId: part.toolCallId,
          output: { error: part.error instanceof Error ? part.error.message : String(part.error) },
          isError: true,
        },
      };
      return;

    case 'error': {
      const msg = part.error instanceof Error ? part.error.message : String(part.error);
      yield { type: 'error', message: msg, retryable: false };
      return;
    }

    // Ignored: start, start-step, finish-step, finish (caller handles for
    // usage), abort, raw, source, file, tool-output-denied,
    // tool-approval-request.
    default:
      return;
  }
}
