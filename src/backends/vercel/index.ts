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
  generateText,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool as vercelTool,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StopCondition,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
} from 'ai';

import * as fs from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import type {
  AgentEvent,
  AgentQuery,
  Attachment,
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

  /**
   * Auto-compact the conversation when input tokens approach the context
   * window. Matches Claude/Codex backends, which auto-compact natively.
   * Default `true`. Set `false` to disable; the underlying provider will
   * then error on context overflow.
   */
  autoCompact?: boolean;
  /**
   * Fraction of the model's context window that triggers compaction.
   * Default `0.8` (compact when `inputTokens / contextWindow >= 0.8`).
   */
  contextThreshold?: number;
  /**
   * Model used for the summarization call. Defaults to the same model as
   * the agent. A cheaper model (e.g. `gpt-4o-mini`, `claude-haiku`) is a
   * common override since summarization is a one-shot generation that
   * doesn't need the agent's full capability.
   */
  compactionModel?: LanguageModel;
  /**
   * Number of recent user-led turns kept verbatim, never compacted. The
   * summary covers all messages before the Nth-most-recent user message;
   * everything from that user message onward flows through unchanged.
   * Default `4`.
   */
  keepLastTurns?: number;
  /**
   * Override the model's context window in tokens. Required when the
   * model's `modelId` isn't recognized by our hardcoded table — without
   * either, autoCompact silently disables (the underlying provider will
   * still error on overflow).
   */
  contextWindow?: number;
}

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// AI SDK's streamText defaults to stepCountIs(1) — i.e. stop after one step,
// which means a turn that calls a tool ends after the tool result instead of
// continuing to a final answer. We default to stepCountIs(20) so the agent
// loop actually runs to completion. Callers can override via VercelBackendOptions.
const DEFAULT_STOP_WHEN: StopCondition<ToolSet> = stepCountIs(20);

const DEFAULT_CONTEXT_THRESHOLD = 0.8;
const DEFAULT_KEEP_LAST_TURNS = 4;
// Don't compact if the conversation is too short to win anything — the
// summarization call's overhead exceeds the saved tokens.
const MIN_HISTORY_FOR_COMPACTION = 10;

/**
 * Hardcoded context-window sizes by model identifier prefix. Match is by
 * `startsWith` so e.g. `claude-sonnet-4-5-20250929` resolves via the
 * `claude-sonnet-` entry. Caller can override via `contextWindow` option
 * for unknown models.
 */
const MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  // Anthropic
  ['claude-opus-4', 200_000],
  ['claude-sonnet-4', 200_000],
  ['claude-haiku-4', 200_000],
  ['claude-3-7-sonnet', 200_000],
  ['claude-3-5-sonnet', 200_000],
  ['claude-3-5-haiku', 200_000],
  ['claude-3-opus', 200_000],
  ['claude-3-sonnet', 200_000],
  ['claude-3-haiku', 200_000],
  // OpenAI
  ['gpt-5', 400_000],
  ['gpt-4.1', 1_000_000],
  ['gpt-4o', 128_000],
  ['o3', 200_000],
  ['o1', 200_000],
  // Google
  ['gemini-2.5', 1_000_000],
  ['gemini-2.0', 1_000_000],
  ['gemini-1.5-pro', 2_000_000],
  ['gemini-1.5-flash', 1_000_000],
];

function resolveContextWindow(model: LanguageModel, override: number | undefined): number | undefined {
  if (override !== undefined) return override;
  const id = (model as { modelId?: string }).modelId;
  if (typeof id !== 'string') return undefined;
  for (const [prefix, size] of MODEL_CONTEXT_WINDOWS) {
    if (id.startsWith(prefix)) return size;
  }
  return undefined;
}

const COMPACTION_SYSTEM_PROMPT = `You are summarizing the earlier portion of a conversation between a user and an AI assistant so it can be continued without exceeding the model's context window.

Write a concise summary that preserves:
- The user's overall goal and any specific requests
- Key decisions made and their rationale
- Files read, written, or modified (with paths)
- Tool outputs that the assistant relied on for later reasoning
- Open questions or unresolved issues
- The current task and any in-progress work

Drop:
- Pleasantries, acknowledgements, and chit-chat
- Verbose tool output already captured by the conclusions drawn from it
- Redundant restatements of the same information
- Reasoning that led to a discarded approach

Output a plain-text summary in third person ("the user asked…", "the assistant ran…"). No headers or bullet markers — flowing prose. Aim for ~10% of the input length.`;

export class VercelBackend implements Backend {
  readonly name = 'vercel';

  private readonly model: LanguageModel;
  private readonly toolSet: ToolSet;
  private readonly callOptions: Pick<
    VercelBackendOptions,
    'instructions' | 'stopWhen' | 'maxOutputTokens' | 'temperature' | 'topP' | 'topK'
  >;
  private readonly sessionsDir: string;
  private readonly hasTodoTool: boolean;
  // L1 cache: continuation token → ModelMessage[]. Populated on first query
  // and on cache-miss reloads from disk.
  private readonly histories = new Map<string, ModelMessage[]>();
  // Per-continuation `todo` tool state. The most recent tool input (either
  // the structured Claude shape or freeform Codex shape) is stored as-is
  // and re-injected into the system prompt before each step via prepareStep.
  // In-memory while the backend instance lives; on cache-miss reload, todos
  // are reconstructed by walking the loaded UIMessage[] for the most recent
  // tool-todo part (see findLatestTodoInput) — the JSONL is the single
  // source of truth, no sidecar file.
  private readonly todosByContinuation = new Map<string, unknown>();
  // Per-continuation flag: true if the next turn should compact the history
  // before calling streamText. Set when a turn finishes with usage above
  // the configured threshold; cleared after compaction runs.
  private readonly compactionPending = new Set<string>();
  // Auto-compaction config (resolved at construction).
  private readonly autoCompact: boolean;
  private readonly contextThreshold: number;
  private readonly compactionModel: LanguageModel | undefined;
  private readonly keepLastTurns: number;
  private readonly contextWindow: number | undefined;

  constructor(options: VercelBackendOptions) {
    this.model = options.model;
    this.sessionsDir =
      options.sessionsDir ?? path.join(process.cwd(), '.agent-sdk', 'sessions');

    const parentTools = options.tools ?? [];
    this.hasTodoTool = parentTools.some((t) => t.native?.vercel === 'todo');
    const set: ToolSet = {};
    for (const t of parentTools) {
      const execute = this.resolveExecute(t, parentTools, options);
      if (execute === undefined) continue;
      set[t.name] = vercelTool({ description: t.description, inputSchema: t.schema, execute });
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

    this.autoCompact = options.autoCompact ?? true;
    this.contextThreshold = options.contextThreshold ?? DEFAULT_CONTEXT_THRESHOLD;
    this.compactionModel = options.compactionModel;
    this.keepLastTurns = options.keepLastTurns ?? DEFAULT_KEEP_LAST_TURNS;
    this.contextWindow = resolveContextWindow(this.model, options.contextWindow);
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
    const todosByContinuation = this.todosByContinuation;
    const hasTodoTool = this.hasTodoTool;
    const systemAppend = input.systemPromptAppend;
    const persistPath = filePath;
    const initialMessage = input.message;
    const initialAttachments = input.attachments ?? [];
    const autoCompact = this.autoCompact;
    const contextThreshold = this.contextThreshold;
    const compactionModel = this.compactionModel ?? this.model;
    const keepLastTurns = this.keepLastTurns;
    const contextWindow = this.contextWindow;
    const compactionPending = this.compactionPending;

    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: 'session_start', continuation };

      // Load history: in-memory first, fall back to disk on miss.
      let history = histories.get(continuation);
      if (history === undefined) {
        const stored = readUIMessages(persistPath);
        history = stored.length > 0 ? await convertToModelMessages(stored) : [];
        histories.set(continuation, history);
        // Reconstruct todos from the same JSONL we just loaded — single
        // source of truth (no sidecar file). The JSONL already contains
        // every prior `todo` tool call as a tool-todo UIMessagePart;
        // walk it to find the latest input.
        if (hasTodoTool && !todosByContinuation.has(continuation)) {
          const recovered = findLatestTodoInput(stored);
          if (recovered !== undefined) todosByContinuation.set(continuation, recovered);
        }
      }

      // Append the inbound user message + attachments and persist as a UIMessage.
      if (initialMessage !== undefined || initialAttachments.length > 0) {
        try {
          const { modelContent, uiParts } = await buildInitialUserContent(
            initialMessage,
            initialAttachments,
          );
          history.push({ role: 'user', content: modelContent });
          appendUIMessage(persistPath, { id: randomUUID(), role: 'user', parts: uiParts });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          yield { type: 'error', message, retryable: false };
          yield { type: 'session_end', usage: ZERO_USAGE, stopReason: 'error' };
          return;
        }
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

          // Compaction is scheduled BEFORE we call streamText so the new turn
          // sees the rewritten history. The post-turn check below sets the
          // flag; here we drain it.
          if (autoCompact && compactionPending.has(continuation)) {
            compactionPending.delete(continuation);
            try {
              const compacted = await compactHistory({
                history,
                todos: todosByContinuation.get(continuation),
                model: compactionModel,
                keepLastTurns,
                persistPath,
              });
              if (compacted !== undefined) {
                history = compacted;
                histories.set(continuation, history);
              }
            } catch (err) {
              // If compaction fails, log via an error event but continue —
              // the next streamText will likely overflow, which produces its
              // own error. Better to surface both than to swallow.
              const msg = err instanceof Error ? err.message : String(err);
              yield { type: 'error', message: `compaction failed: ${msg}`, retryable: false };
            }
          }

          const baseSystem = combineSystem(callOptions.instructions, systemAppend);

          const result = streamText({
            model,
            tools,
            messages: history,
            abortSignal: abortController.signal,
            stopWhen: callOptions.stopWhen ?? DEFAULT_STOP_WHEN,
            ...(baseSystem !== undefined && { system: baseSystem }),
            ...(callOptions.maxOutputTokens !== undefined && {
              maxOutputTokens: callOptions.maxOutputTokens,
            }),
            ...(callOptions.temperature !== undefined && { temperature: callOptions.temperature }),
            ...(callOptions.topP !== undefined && { topP: callOptions.topP }),
            ...(callOptions.topK !== undefined && { topK: callOptions.topK }),
            // The todo tool needs a per-continuation channel for both
            // writes (the tool's execute) and reads (prepareStep injecting
            // the latest todos into the system prompt). experimental_context
            // is the AI SDK's escape hatch for per-call data.
            experimental_context: { continuation },
            ...(hasTodoTool && {
              prepareStep: ({ experimental_context }) => {
                const ctx = experimental_context as { continuation?: string } | undefined;
                if (ctx?.continuation === undefined) return {};
                const todos = todosByContinuation.get(ctx.continuation);
                if (todos === undefined) return {};
                const formatted = formatTodos(todos);
                if (formatted === '') return {};
                const combined = combineSystem(baseSystem, `Current todos:\n${formatted}`);
                return combined !== undefined ? { system: combined } : {};
              },
            }),
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

          // Schedule compaction for the next turn if input usage crossed the
          // threshold. The check needs both contextWindow (table or override)
          // and a non-zero inputTokens (which streamText populates on finish).
          if (
            autoCompact
            && contextWindow !== undefined
            && lastUsage.input > 0
            && lastUsage.input / contextWindow >= contextThreshold
          ) {
            compactionPending.add(continuation);
          }

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

  /**
   * Resolve a single Tool to the execute function we wire into vercelTool.
   * Returns undefined for tools with no usable path (will be silently
   * dropped). Three branches:
   *   - native.vercel === 'task' → closure-bound sub-agent runner
   *   - native.vercel === 'todo' → per-continuation map writer
   *   - has execute              → forward as-is
   */
  private resolveExecute(
    t: Tool,
    parentTools: Tool[],
    options: VercelBackendOptions,
  ): ((input: unknown, opts: { experimental_context?: unknown }) => Promise<unknown>) | undefined {
    if (t.native?.vercel === 'task') {
      const subagentToolsFor =
        options.subagentTools ??
        ((_: string) => parentTools.filter((p) => p.native?.vercel !== 'task'));
      const model = this.model;
      const callOptions = () => this.callOptions;
      return async (input) => runSubAgent(input, model, subagentToolsFor, callOptions());
    }
    if (t.native?.vercel === 'todo') {
      const todos = this.todosByContinuation;
      return async (input, opts) => {
        const ctx = opts.experimental_context as { continuation?: string } | undefined;
        if (ctx?.continuation !== undefined) todos.set(ctx.continuation, input);
        return 'todos updated';
      };
    }
    if (!t.execute) return undefined;
    return async (input) => t.execute!(input);
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
  if (!('prompt' in input) || typeof (input).prompt !== 'string') {
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
    stopWhen: callOptions.stopWhen ?? DEFAULT_STOP_WHEN,
    ...(callOptions.instructions !== undefined && { system: callOptions.instructions }),
    ...(callOptions.maxOutputTokens !== undefined && {
      maxOutputTokens: callOptions.maxOutputTokens,
    }),
    ...(callOptions.temperature !== undefined && { temperature: callOptions.temperature }),
    ...(callOptions.topP !== undefined && { topP: callOptions.topP }),
    ...(callOptions.topK !== undefined && { topK: callOptions.topK }),
  });

  return await result.text;
}

// ── Compaction ──

/**
 * Rewrite `history` so the older portion is replaced by a single summary
 * message. Returns the rewritten history (and persists it atomically to
 * `persistPath`), or undefined when compaction was skipped (e.g. history
 * too short, no clean split point).
 *
 * Algorithm:
 *   1. Find the Nth-most-recent user-role message; split right before it.
 *      This guarantees we never sever a tool-call/result pair, since those
 *      always live between an assistant message and the next user message.
 *   2. Run a `generateText` against `model` with the COMPACTION_SYSTEM_PROMPT
 *      and the older messages as input. Get back a plain-text summary.
 *   3. Build the new history:
 *        [synthetic user with summary]
 *        + [synthetic assistant with tool-todo part if todos present]
 *        + [recent verbatim]
 *   4. Atomically rewrite the JSONL — write `<persistPath>.tmp` with the
 *      new UIMessage shape, then `renameSync` over the original.
 */
export async function compactHistory(args: {
  history: ModelMessage[];
  todos: unknown;
  model: LanguageModel;
  keepLastTurns: number;
  persistPath: string;
}): Promise<ModelMessage[] | undefined> {
  const { history, todos, model, keepLastTurns, persistPath } = args;

  if (history.length < MIN_HISTORY_FOR_COMPACTION) return undefined;

  const splitIdx = findCompactionSplitIndex(history, keepLastTurns);
  if (splitIdx <= 0) return undefined; // No compaction win available

  const older = history.slice(0, splitIdx);
  const recent = history.slice(splitIdx);

  const summaryResult = await generateText({
    model,
    system: COMPACTION_SYSTEM_PROMPT,
    messages: older,
  });
  const summaryText = summaryResult.text.trim();
  if (summaryText === '') return undefined; // Defensive — model returned nothing

  // Build the new ModelMessage[] for the in-memory cache.
  const summaryUser: ModelMessage = {
    role: 'user',
    content: `Earlier in this conversation:\n${summaryText}`,
  };
  const newHistory: ModelMessage[] = [summaryUser, ...recent];

  // Build the new UIMessage[] for the JSONL rewrite. We mirror what we'd
  // normally append: the summary as a user message with a single TextUIPart,
  // optionally followed by a synthetic assistant tool-todo so reload still
  // finds the latest todos via findLatestTodoInput.
  const summaryUIMessage: UIMessage = {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: `Earlier in this conversation:\n${summaryText}` }],
  };
  const persisted: UIMessage[] = [summaryUIMessage];
  if (todos !== undefined) {
    persisted.push({
      id: randomUUID(),
      role: 'assistant',
      parts: [
        {
          type: 'tool-todo',
          toolCallId: randomUUID(),
          state: 'output-available',
          input: todos,
          output: 'todos updated',
        },
      ],
    });
  }
  // Recent ModelMessages get serialized back to UIMessages via the inverse
  // of convertToModelMessages. We don't have a public converter, so re-read
  // the existing JSONL and keep only its tail (the messages corresponding
  // to `recent`). This is exact because we know how many appended-since
  // entries to keep — same count as `recent.length`'s message-shape.
  const stored = readUIMessages(persistPath);
  // The trailing UIMessage[] that maps to `recent` is the last
  // `stored.length - olderUiCount` entries. We can't compute olderUiCount
  // exactly from older.length (UIMessages and ModelMessages don't have a
  // 1:1 ratio when tool calls are present), so use a heuristic: match
  // tail messages by user-role boundary.
  const recentUI = sliceTrailingTurns(stored, keepLastTurns);
  for (const m of recentUI) persisted.push(m);

  await rewriteJsonlAtomically(persistPath, persisted);
  return newHistory;
}

/**
 * Find the index in `history` where compaction should split — right before
 * the Nth-most-recent user-role message. Returns 0 if no such split point
 * exists (history too short to keep N user-led turns + still have something
 * to summarize).
 */
export function findCompactionSplitIndex(history: ModelMessage[], keepLastTurns: number): number {
  let userCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === 'user') {
      userCount++;
      if (userCount === keepLastTurns) return i;
    }
  }
  return 0;
}

/**
 * Return the trailing UIMessages corresponding to the last `keepLastTurns`
 * user-led turns. Used when persisting the compacted history — we keep
 * the file's tail verbatim and replace everything before it with the
 * synthetic summary message.
 */
export function sliceTrailingTurns(messages: UIMessage[], keepLastTurns: number): UIMessage[] {
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      userCount++;
      if (userCount === keepLastTurns) return messages.slice(i);
    }
  }
  return [...messages];
}

async function rewriteJsonlAtomically(filePath: string, messages: UIMessage[]): Promise<void> {
  const tmp = `${filePath}.tmp`;
  const content = messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length > 0 ? '\n' : '');
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

// ── Helpers ──

/**
 * Walk a UIMessage[] (most recently appended last) backwards looking for
 * the most recent `tool-todo` part with a settled `input`. Used on
 * cache-miss reload so the prepareStep injection survives process
 * restarts without a separate sidecar file — the JSONL is the single
 * source of truth.
 *
 * Returns the recovered tool input (the same shape that was passed
 * to the `todo` tool's execute originally), or undefined if no todo
 * call appears in the history.
 */
export function findLatestTodoInput(messages: UIMessage[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j]!;
      if (
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        (part as { type: string }).type === 'tool-todo'
      ) {
        const p = part as { input?: unknown };
        if (p.input !== undefined) return p.input;
      }
    }
  }
  return undefined;
}

/**
 * Render the most recent `todo` tool input into a human-readable string
 * for system-prompt injection. Handles both shapes the canonical `todo`
 * tool accepts:
 *   - `{ todos: [{ content, status, activeForm }, …] }` (Claude shape)
 *   - `{ text: string }` (Codex freeform shape)
 *
 * Returns the empty string for unrecognized shapes — caller treats that
 * as "nothing to inject."
 */
export function formatTodos(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const i = input as { text?: unknown; todos?: unknown };
  if (typeof i.text === 'string') return i.text;
  if (Array.isArray(i.todos)) {
    return i.todos
      .map((t) => {
        const item = t as { content?: unknown; status?: unknown };
        const box =
          item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
        const content = typeof item.content === 'string' ? item.content : String(item.content);
        return `${box} ${content}`;
      })
      .join('\n');
  }
  return '';
}

/**
 * Build the inbound first-turn user content in two shapes: the `ModelMessage`
 * payload streamText consumes, and the `UIMessagePart[]` we persist as the
 * canonical transcript. Path attachments are read from disk and base64-encoded
 * into a data URL so both shapes carry self-contained bytes.
 */
export async function buildInitialUserContent(
  message: string | undefined,
  attachments: Attachment[],
): Promise<{
  modelContent: string | Array<{ type: 'text'; text: string } | { type: 'image'; image: string | URL; mediaType?: string }>;
  uiParts: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; mediaType: string; url: string }
  >;
}> {
  if (attachments.length === 0) {
    const text = message ?? '';
    return {
      modelContent: text,
      uiParts: [{ type: 'text', text }],
    };
  }
  const modelContent: Array<
    { type: 'text'; text: string } | { type: 'image'; image: string | URL; mediaType?: string }
  > = [];
  const uiParts: Array<
    { type: 'text'; text: string } | { type: 'file'; mediaType: string; url: string }
  > = [];
  for (const att of attachments) {
    const { dataUrlOrUrl, mediaType, modelImage } = await loadAttachment(att);
    modelContent.push({ type: 'image', image: modelImage, ...(mediaType !== undefined && { mediaType }) });
    uiParts.push({ type: 'file', mediaType: mediaType ?? 'application/octet-stream', url: dataUrlOrUrl });
  }
  if (message !== undefined) {
    modelContent.push({ type: 'text', text: message });
    uiParts.push({ type: 'text', text: message });
  }
  return { modelContent, uiParts };
}

async function loadAttachment(
  att: Attachment,
): Promise<{ dataUrlOrUrl: string; mediaType: string | undefined; modelImage: string | URL }> {
  if (att.type !== 'image') {
    throw new Error(`Vercel backend: unsupported attachment type '${(att as { type: string }).type}'`);
  }
  switch (att.source.kind) {
    case 'url':
      return { dataUrlOrUrl: att.source.url, mediaType: undefined, modelImage: new URL(att.source.url) };
    case 'base64': {
      const url = `data:${att.source.mimeType};base64,${att.source.data}`;
      return { dataUrlOrUrl: url, mediaType: att.source.mimeType, modelImage: att.source.data };
    }
    case 'path': {
      const data = (await fs.readFile(att.source.path)).toString('base64');
      const mediaType = mediaTypeFromPath(att.source.path);
      const url = `data:${mediaType};base64,${data}`;
      return { dataUrlOrUrl: url, mediaType, modelImage: data };
    }
  }
}

function mediaTypeFromPath(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      throw new Error(`Vercel backend: cannot infer image media type from extension '.${ext}'`);
  }
}

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
