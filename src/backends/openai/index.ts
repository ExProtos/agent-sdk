/**
 * OpenAI Agents backend — wraps `@openai/agents`.
 *
 * Separate from the Codex backend even though both target OpenAI models:
 * this one is the API-key path with hosted tools (web_search, file_search,
 * code_interpreter, computer_use, image_generation) and built-in tracing;
 * Codex is the ChatGPT-subscription path through `codex app-server`.
 *
 * v0 scope:
 * - One Agent per backend instance, built at construction time
 * - Hosted tools (web search, code interpreter, etc.) dispatched server-side
 *   via `Tool.native.openai` (string marker for default config, SDK tool
 *   object for customized config from hostedTools.* factories)
 * - Function tools wrapped via SDK's `tool({...})` helper; closures run in-process
 * - Special-cases for `task` (closure-bound child Agent) and `todo`
 *   (callModelInputFilter re-injects todos into instructions per step)
 * - Continuation via SDK's Session abstraction:
 *     - `useConversations: true` → server-side OpenAIConversationsSession
 *     - `sessionsDir` set        → JsonlSession (our impl) at <dir>/<id>.jsonl
 *     - neither                  → MemorySession (lost on process exit)
 * - Auto-compaction on by default for non-Conversations sessions: wraps the
 *   underlying Session in OpenAIResponsesCompactionSession, which calls
 *   OpenAI's `responses.compact` API after each turn that crosses the SDK's
 *   internal threshold and rewrites the local items in place. Opt out via
 *   `autoCompact: false`.
 * - No mid-turn push() — same as Codex; `run()` is single-turn-shaped
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  Agent,
  MemorySession,
  OpenAIConversationsSession,
  OpenAIResponsesCompactionSession,
  RunAgentUpdatedStreamEvent,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  Usage,
  codeInterpreterTool,
  imageGenerationTool,
  run,
  tool,
  webSearchTool,
  type AgentInputItem,
  type ModelSettings,
  type Session,
  type Tool as SdkTool,
} from '@openai/agents';
import { z } from 'zod';
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

// ── Public API ──

export interface OpenAIBackendOptions {
  /** Required. OpenAI model name (e.g. 'gpt-5', 'gpt-4.1'). */
  model: string;
  /**
   * Tools to expose. Resolved per `Tool.native.openai` / `Tool.execute` /
   * special-cases for `task` and `todo`. Tools without a path are silently
   * skipped — same posture as Vercel.
   */
  tools?: Tool[];
  /** System prompt. Mapped to Agent.instructions. */
  instructions?: string;
  /** Pass-through model settings (temperature, top_p, …). */
  modelSettings?: ModelSettings;
  /** Maximum agent turns. Defaults to 20. */
  maxTurns?: number;
  /**
   * Decide which tools a sub-agent (the `task` tool) gets when spawned.
   * Receives the model-supplied `subagent_type` hint (Claude convention;
   * empty string if absent). Default: every parent tool except `task`
   * itself — single-level delegation, no recursive spawning.
   */
  subagentTools?: (subagent_type: string) => Tool[];
  /**
   * If set, persist conversation history to <sessionsDir>/<continuation>.jsonl
   * via our JsonlSession impl. If unset, conversations live in memory only
   * and are lost on process exit. Mutually exclusive with `useConversations`.
   */
  sessionsDir?: string;
  /**
   * If true, use OpenAI's hosted Conversations API for continuation.
   * Continuation token = OpenAI conversation ID (server-side). Mutually
   * exclusive with `sessionsDir` and `autoCompact`. Default false.
   */
  useConversations?: boolean;
  /**
   * If true, wrap the underlying session in OpenAIResponsesCompactionSession
   * to auto-compact when history grows. The decorator calls OpenAI's
   * `responses.compact` API and rewrites the local Session items in place.
   * Mutually exclusive with `useConversations` (Conversations sessions
   * manage history server-side; the decorator requires local storage).
   * Default `true` — matches Claude/Codex/Vercel parity (auto-compact on
   * by default; opt out explicitly with `autoCompact: false`).
   */
  autoCompact?: boolean;
}

const DEFAULT_MAX_TURNS = 20;
const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const STALE_SESSION_RE =
  /conversation.*not found|session.*not found|no such (conversation|session)/i;

export class OpenAIBackend implements Backend {
  readonly name = 'openai';

  private readonly model: string;
  private readonly instructions: string | undefined;
  private readonly modelSettings: ModelSettings | undefined;
  private readonly maxTurns: number;
  private readonly sessionsDir: string | undefined;
  private readonly useConversations: boolean;
  private readonly autoCompact: boolean;
  private readonly subagentToolsFor: (subagent_type: string) => Tool[];

  private readonly agent: Agent;
  private readonly canonicalByWireName = new Map<string, string>();
  private readonly hasTodoTool: boolean;
  private readonly todosByContinuation = new Map<string, unknown>();
  private readonly sessions = new Map<string, Session>();

  constructor(options: OpenAIBackendOptions) {
    if (options.useConversations && options.sessionsDir !== undefined) {
      throw new Error(
        'OpenAIBackend: useConversations and sessionsDir are mutually exclusive',
      );
    }
    // Only throw when the caller explicitly sets autoCompact: true alongside
    // useConversations. The autoCompact default is true for parity with the
    // other backends; the implicit default silently drops to false when
    // useConversations is on (Conversations manages history server-side).
    if (options.useConversations && options.autoCompact === true) {
      throw new Error(
        'OpenAIBackend: useConversations and autoCompact are mutually exclusive',
      );
    }

    this.model = options.model;
    this.instructions = options.instructions;
    this.modelSettings = options.modelSettings;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.sessionsDir = options.sessionsDir;
    this.useConversations = options.useConversations ?? false;
    // Default autoCompact to true unless useConversations is on (where it
    // doesn't apply — server-side history management).
    this.autoCompact = options.autoCompact ?? !this.useConversations;

    const parentTools = options.tools ?? [];
    this.hasTodoTool = parentTools.some((t) => t.native?.openai === 'todo');
    this.subagentToolsFor =
      options.subagentTools
      ?? ((_: string) => parentTools.filter((p) => p.native?.openai !== 'task'));

    const sdkTools = this.buildSdkTools(parentTools);

    this.agent = new Agent({
      name: 'agent-sdk',
      ...(this.instructions !== undefined && { instructions: this.instructions }),
      model: this.model,
      ...(this.modelSettings !== undefined && { modelSettings: this.modelSettings }),
      tools: sdkTools,
    });
  }

  isContinuationInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  async close(): Promise<void> {
    this.sessions.clear();
    this.todosByContinuation.clear();
  }

  query(input: QueryInput): AgentQuery {
    const continuation = input.continuation ?? randomUUID();
    const session = this.sessionFor(continuation);
    const abortController = new AbortController();
    let aborted = false;

    // Side-channel for events that aren't part of the SDK stream (e.g.
    // push() error). The events generator drains these whenever it yields.
    const sideEvents: AgentEvent[] = [];

    const agent = this.agent;
    const maxTurns = this.maxTurns;
    const todosByContinuation = this.todosByContinuation;
    const hasTodoTool = this.hasTodoTool;
    const canonicalByWireName = this.canonicalByWireName;
    const initialMessage = input.message;
    const initialAttachments = input.attachments ?? [];

    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: 'session_start', continuation };

      // Empty-message AND no attachments resume: just open the continuation.
      if (initialMessage === undefined && initialAttachments.length === 0) {
        // Drain any sideEvents that arrived before iteration started.
        while (sideEvents.length > 0) yield sideEvents.shift()!;
        yield { type: 'session_end', usage: ZERO_USAGE, stopReason: 'stop' };
        return;
      }

      let lastUsage: TokenUsage = ZERO_USAGE;
      let lastStopReason: StopReason = 'stop';

      let runInput: string | AgentInputItem[];
      try {
        runInput = await buildOpenAIRunInput(initialMessage, initialAttachments);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message, retryable: false };
        yield { type: 'session_end', usage: ZERO_USAGE, stopReason: 'error' };
        return;
      }

      try {
        const stream = await run(agent, runInput, {
          stream: true,
          session,
          maxTurns,
          signal: abortController.signal,
          context: { continuation },
          ...(hasTodoTool && {
            callModelInputFilter: (args: { modelData: { input: AgentInputItem[]; instructions?: string } }) => {
              const todos = todosByContinuation.get(continuation);
              if (todos === undefined) return args.modelData;
              const formatted = formatTodos(todos);
              if (formatted === '') return args.modelData;
              const combined = combineSystem(args.modelData.instructions, `Current todos:\n${formatted}`);
              const out: { input: AgentInputItem[]; instructions?: string } = { input: args.modelData.input };
              if (combined !== undefined) out.instructions = combined;
              return out;
            },
          }),
        });

        const textBuf = new Map<string, string>();
        const reasoningBuf = new Map<string, string>();

        for await (const ev of stream) {
          if (aborted) break;
          // Drain any pushed side-events before yielding the SDK event.
          while (sideEvents.length > 0) yield sideEvents.shift()!;
          yield { type: 'activity' };
          yield* translateStreamEvent(ev, canonicalByWireName, textBuf, reasoningBuf);
        }
        await stream.completed;
        lastUsage = mapUsage(stream.runContext.usage);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: msg, retryable: false };
        lastStopReason = 'error';
      }

      // Drain any remaining side-events before terminating.
      while (sideEvents.length > 0) yield sideEvents.shift()!;

      const finalReason: StopReason = aborted ? 'aborted' : lastStopReason;
      yield { type: 'session_end', stopReason: finalReason, usage: lastUsage };
    }

    return {
      push: (_msg: string) => {
        // run() is single-turn-shaped on @openai/agents — same as Codex.
        // Push doesn't make sense; surface a clear error.
        sideEvents.push({
          type: 'error',
          message:
            'push() not supported on OpenAI Agents backend; end() and run() with continuation instead',
          retryable: false,
        });
      },
      end: () => {
        // Single-shot semantics: end() is a no-op once the SDK stream completes.
      },
      abort: () => {
        aborted = true;
        abortController.abort();
      },
      events: events(),
    };
  }

  // ── Tool wiring ──

  private buildSdkTools(parentTools: Tool[]): SdkTool[] {
    const out: SdkTool[] = [];
    for (const t of parentTools) {
      const resolved = resolveTool(t, {
        task: (t) => this.buildTaskTool(t),
        todo: (t) => this.buildTodoTool(t),
      });
      if (resolved === undefined) continue;
      out.push(resolved.sdkTool);
      registerWireName(this.canonicalByWireName, resolved.wireName, t.name);
    }
    return out;
  }

  private buildTaskTool(taskTool: Tool): SdkTool {
    const subagentToolsFor = this.subagentToolsFor;
    const model = this.model;
    const modelSettings = this.modelSettings;
    const instructions = this.instructions;

    // Use the canonical union schema verbatim — wrapSchemaForOpenAI flattens
    // it into a top-level keyed object the SDK's tool() helper accepts.
    const { params, unwrap } = wrapSchemaForOpenAI(taskTool.schema as z.ZodTypeAny);
    const strictParams = strictifyZodForOpenAI(params);
    return tool({
      name: 'task',
      description: taskTool.description,
      strict: true,
      parameters: strictParams,
      execute: async (args: unknown) => {
        const denulled = normalizeNullsToUndefined(args, params);
        const input = unwrap(denulled);
        if (typeof input !== 'object' || input === null) {
          throw new Error('task tool: input must be an object');
        }
        if ('tool' in input) {
          throw new Error(
            'task tool: Codex multi-step form is not supported on OpenAI Agents; pass the Claude form (description, prompt, subagent_type)',
          );
        }
        const i = input as { description?: string; prompt: string; subagent_type?: string };
        if (typeof i.prompt !== 'string') {
          throw new Error('task tool: input requires a `prompt` string');
        }
        const subagentType = i.subagent_type ?? '';
        const childTools = subagentToolsFor(subagentType).filter(
          (t) => t.native?.openai !== 'task',
        );
        const childSdkTools: SdkTool[] = [];
        for (const ct of childTools) {
          // Children get hosted + function-tool paths; no task/todo
          // builders passed → those markers fall through and are skipped.
          const resolved = resolveTool(ct);
          if (resolved !== undefined) childSdkTools.push(resolved.sdkTool);
        }
        const child = new Agent({
          name: 'agent-sdk-subagent',
          ...(instructions !== undefined && { instructions }),
          model,
          ...(modelSettings !== undefined && { modelSettings }),
          tools: childSdkTools,
        });
        const result = await run(child, i.prompt);
        const text = result.finalOutput;
        return typeof text === 'string' ? text : JSON.stringify(text);
      },
    });
  }

  private buildTodoTool(todoTool: Tool): SdkTool {
    const todos = this.todosByContinuation;
    // Use the canonical union schema (Claude's structured + Codex's text) —
    // wrapSchemaForOpenAI flattens it into option0/option1, the model picks
    // one, unwrap returns whichever branch was filled. We store the
    // unwrapped value and let formatTodos discriminate at injection time.
    const { params, unwrap } = wrapSchemaForOpenAI(todoTool.schema as z.ZodTypeAny);
    const strictParams = strictifyZodForOpenAI(params);
    return tool({
      name: 'todo',
      description: todoTool.description,
      strict: true,
      parameters: strictParams,
      execute: async (args: unknown, runContext) => {
        const denulled = normalizeNullsToUndefined(args, params);
        const input = unwrap(denulled);
        const ctx = runContext?.context as { continuation?: string } | undefined;
        if (ctx?.continuation !== undefined) {
          todos.set(ctx.continuation, input);
        }
        return 'todos updated';
      },
    });
  }

  // ── Session resolution ──

  private sessionFor(continuation: string): Session {
    const cached = this.sessions.get(continuation);
    if (cached !== undefined) return cached;

    let session: Session;
    if (this.useConversations) {
      session = new OpenAIConversationsSession({ conversationId: continuation });
    } else if (this.sessionsDir !== undefined) {
      const filePath = path.join(this.sessionsDir, `${continuation}.jsonl`);
      session = new JsonlSession({ sessionId: continuation, filePath });
    } else {
      session = new MemorySession({ sessionId: continuation });
    }

    if (this.autoCompact && !this.useConversations) {
      // Compaction decorator requires the underlying session to expose the
      // 'responses' API tag; MemorySession and our JsonlSession both qualify.
      // The decorator's typing is strict about the API tag on the underlying
      // session — cast through unknown since our JsonlSession doesn't carry
      // the brand statically.
      session = new OpenAIResponsesCompactionSession({
        underlyingSession: session as unknown as Session & { __openai_session_api?: 'responses' },
      });
    }

    this.sessions.set(continuation, session);
    return session;
  }
}

export function openai(options: OpenAIBackendOptions): OpenAIBackend {
  return new OpenAIBackend(options);
}

// ── JsonlSession (our local Session impl) ──

/**
 * Session implementation backed by a JSONL file. One AgentInputItem per
 * line, JSON-encoded. AgentInputItem is the SDK's typed discriminated
 * union — designed for serialization, since it's literally what gets
 * posted to the model verbatim.
 *
 * Format is tied to @openai/agents versions; major SDK bumps may break
 * the file format. Acceptable trade — same posture as Vercel with UIMessage.
 */
export class JsonlSession implements Session {
  private items: AgentInputItem[] | undefined;

  constructor(private readonly opts: { sessionId: string; filePath: string }) {}

  async getSessionId(): Promise<string> {
    return this.opts.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (this.items === undefined) this.items = readJsonlItems(this.opts.filePath);
    return limit !== undefined ? this.items.slice(-limit) : [...this.items];
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (this.items === undefined) this.items = readJsonlItems(this.opts.filePath);
    this.items.push(...items);
    appendJsonlItems(this.opts.filePath, items);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    if (this.items === undefined) this.items = readJsonlItems(this.opts.filePath);
    const popped = this.items.pop();
    if (popped !== undefined) rewriteJsonl(this.opts.filePath, this.items);
    return popped;
  }

  async clearSession(): Promise<void> {
    this.items = [];
    fs.rmSync(this.opts.filePath, { force: true });
  }
}

export function readJsonlItems(filePath: string): AgentInputItem[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const out: AgentInputItem[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    out.push(JSON.parse(line) as AgentInputItem);
  }
  return out;
}

export function appendJsonlItems(filePath: string, items: AgentInputItem[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = items.map((it) => JSON.stringify(it) + '\n').join('');
  fs.appendFileSync(filePath, lines);
}

export function rewriteJsonl(filePath: string, items: AgentInputItem[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = items.map((it) => JSON.stringify(it) + '\n').join('');
  fs.writeFileSync(filePath, content);
}

// ── Helpers ──

/**
 * Resolve a single Tool into the SDK tool to register and the wire name
 * to map back to canonical in events. Returns undefined for tools that
 * should be silently dropped (no usable path).
 *
 * Dispatch order:
 *   1. native.openai is an object (pre-built SDK tool) → forward verbatim
 *   2. native.openai === 'task' (and ctx.task provided) → ctx.task(t)
 *   3. native.openai === 'todo' (and ctx.todo provided) → ctx.todo(t)
 *   4. native.openai is a string → lazy-construct via buildHostedFromMarker
 *   5. has execute → wrapPlainTool
 *   6. otherwise → undefined
 *
 * Sub-agent tool wiring calls this with no `ctx`, so task/todo markers
 * fall through and the sub-agent gets neither (no recursive task spawn,
 * no contextual todo state in a one-shot child run).
 */
export function resolveTool(
  t: Tool,
  ctx: { task?: (t: Tool) => SdkTool; todo?: (t: Tool) => SdkTool } = {},
): { sdkTool: SdkTool; wireName: string } | undefined {
  const n = t.native?.openai;
  if (typeof n === 'object' && n !== null) {
    return { sdkTool: n as SdkTool, wireName: extractWireName(n, t.name) };
  }
  if (n === 'task' && ctx.task) return { sdkTool: ctx.task(t), wireName: t.name };
  if (n === 'todo' && ctx.todo) return { sdkTool: ctx.todo(t), wireName: t.name };
  if (typeof n === 'string') {
    const built = buildHostedFromMarker(n);
    if (built !== undefined) return built;
  }
  if (t.execute) return { sdkTool: wrapPlainTool(t), wireName: t.name };
  return undefined;
}

/**
 * Resolve a string `native.openai` marker that maps to one of OpenAI's
 * default-configured hosted tools. Contextual markers (`task`, `todo`)
 * are NOT handled here — they need the backend instance and are
 * dispatched separately in resolveTool.
 *
 * Returns undefined for unknown markers (or 'task'/'todo'); caller falls
 * through to the function-tool path or skips.
 */
const HOSTED_FACTORIES: Record<string, () => SdkTool> = {
  web_search: webSearchTool,
  code_interpreter: codeInterpreterTool,
  image_generation: imageGenerationTool,
};

export function buildHostedFromMarker(
  marker: string,
): { sdkTool: SdkTool; wireName: string } | undefined {
  const factory = HOSTED_FACTORIES[marker];
  if (factory === undefined) return undefined;
  const sdkTool = factory();
  return { sdkTool, wireName: extractWireName(sdkTool, marker) };
}

/**
 * Register a wire name → canonical mapping for event translation. Hosted
 * tools emit call items with a `_call` suffix on the type (`web_search`
 * tool → `web_search_call` item), so we register both forms when the wire
 * name doesn't already end in `_call`. Custom function tools emit items
 * with the function name as-is — no suffix to worry about.
 */
function registerWireName(map: Map<string, string>, wireName: string, canonical: string): void {
  map.set(wireName, canonical);
  if (!wireName.endsWith('_call')) map.set(`${wireName}_call`, canonical);
}

function extractWireName(sdkTool: unknown, fallback: string): string {
  if (typeof sdkTool !== 'object' || sdkTool === null) return fallback;
  const t = sdkTool as { name?: string; type?: string };
  return t.name ?? t.type ?? fallback;
}

/**
 * OpenAI's strict schema mode requires every property in `properties` to
 * also be in the `required` array. Zod `.optional()` produces a property
 * that's omitted from `required`, which fails. Convert each `.optional()`
 * field to `.nullable()` so the property stays in `required` but can be
 * null. After validation we normalize null → undefined so the user's
 * execute body sees the original optional semantics.
 *
 * Recurses into nested objects and into z.array element schemas.
 */
export function strictifyZodForOpenAI(
  schema: z.ZodObject<z.ZodRawShape>,
): z.ZodObject<z.ZodRawShape> {
  const newShape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(schema.shape)) {
    newShape[key] = strictifyZodValue(value as z.ZodTypeAny);
  }
  return z.object(newShape);
}

function strictifyZodValue(v: z.ZodTypeAny): z.ZodTypeAny {
  if (v instanceof z.ZodOptional) {
    const inner = (v as z.ZodOptional<z.ZodTypeAny>).unwrap();
    return strictifyZodValue(inner).nullable();
  }
  if (v instanceof z.ZodObject) {
    return strictifyZodForOpenAI(v as z.ZodObject<z.ZodRawShape>);
  }
  if (v instanceof z.ZodArray) {
    const elem = (v as z.ZodArray<z.ZodTypeAny>).element as z.ZodTypeAny;
    return z.array(strictifyZodValue(elem));
  }
  return v;
}

/**
 * After OpenAI returns args validated against the strictified schema, walk
 * them and turn null back into undefined for fields that were originally
 * `.optional()`. Keeps the user's `execute` body's view of "missing"
 * consistent with the original Tool definition.
 */
export function normalizeNullsToUndefined(args: unknown, originalSchema: z.ZodTypeAny): unknown {
  if (args === null || args === undefined) return args;
  if (originalSchema instanceof z.ZodObject) {
    if (typeof args !== 'object') return args;
    const out: Record<string, unknown> = {};
    const shape = (originalSchema as z.ZodObject<z.ZodRawShape>).shape;
    for (const [key, def] of Object.entries(shape)) {
      const v = (args as Record<string, unknown>)[key];
      if (def instanceof z.ZodOptional) {
        if (v === null || v === undefined) continue;
        const inner = (def as z.ZodOptional<z.ZodTypeAny>).unwrap();
        out[key] = normalizeNullsToUndefined(v, inner);
      } else if (def instanceof z.ZodObject || def instanceof z.ZodArray) {
        out[key] = normalizeNullsToUndefined(v, def as z.ZodTypeAny);
      } else {
        out[key] = v;
      }
    }
    return out;
  }
  if (originalSchema instanceof z.ZodArray && Array.isArray(args)) {
    const elem = (originalSchema as z.ZodArray<z.ZodTypeAny>).element as z.ZodTypeAny;
    return args.map((item) => normalizeNullsToUndefined(item, elem));
  }
  return args;
}

function wrapPlainTool(t: Tool): SdkTool {
  const { params, unwrap } = wrapSchemaForOpenAI(t.schema as z.ZodTypeAny);
  const strictParams = strictifyZodForOpenAI(params);
  return tool({
    name: t.name,
    description: t.description,
    strict: true,
    parameters: strictParams,
    execute: async (args: unknown) => {
      const denulled = normalizeNullsToUndefined(args, params);
      const actualArgs = unwrap(denulled);
      const result = await t.execute!(actualArgs);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  });
}

/**
 * The SDK's `tool()` helper requires `ToolInputParameters = ZodObjectLike` —
 * unions and non-objects are not allowed at the top level. We work around
 * this by transforming the schema:
 *
 *   - **ZodObject** → pass through unchanged. `unwrap` is identity.
 *   - **ZodUnion**  → flatten branches into a top-level keyed object,
 *                     `{option0?: <branch0>, option1?: <branch1>, …}`. The
 *                     model fills exactly one key; everything else stays
 *                     undefined. `unwrap` returns the value of the first
 *                     defined key. Same trick as the `{input: …}` wrapping
 *                     for non-objects, applied per-branch.
 *   - **anything else** → wrap as `{input: <schema>}`; `unwrap` extracts
 *                          `args.input`.
 *
 * This lets the canonical `edit`, `todo`, and `task` tools (all unions in
 * the catalog) flow through verbatim — the model picks whichever branch
 * its training prefers, and `execute` receives the original union shape.
 */
export function wrapSchemaForOpenAI(schema: z.ZodTypeAny): {
  params: z.ZodObject<z.ZodRawShape>;
  unwrap: (args: unknown) => unknown;
} {
  if (schema instanceof z.ZodObject) {
    return { params: schema as z.ZodObject<z.ZodRawShape>, unwrap: (a) => a };
  }
  if (schema instanceof z.ZodUnion) {
    const opts = (schema as unknown as { options: ReadonlyArray<z.ZodTypeAny> }).options;
    const shape: Record<string, z.ZodTypeAny> = {};
    for (let i = 0; i < opts.length; i++) {
      shape[optionKey(i)] = opts[i]!.optional();
    }
    return {
      params: z.object(shape),
      unwrap: (args: unknown) => {
        if (args === null || typeof args !== 'object') return args;
        const a = args as Record<string, unknown>;
        for (let i = 0; i < opts.length; i++) {
          const v = a[optionKey(i)];
          if (v !== undefined && v !== null) return v;
        }
        return args;
      },
    };
  }
  return {
    params: z.object({ input: schema }),
    unwrap: (args: unknown) =>
      args !== null && typeof args === 'object' ? (args as { input: unknown }).input : args,
  };
}

function optionKey(i: number): string {
  return `option${i}`;
}

/**
 * Format the `todo` tool input as a checklist for system-prompt injection.
 * Handles both branches of the canonical `todo` schema (Claude structured
 * shape and Codex freeform shape). Returns '' for unrecognized shapes.
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

export function combineSystem(
  base: string | undefined,
  append: string | undefined,
): string | undefined {
  if (base === undefined && append === undefined) return undefined;
  if (base === undefined) return append;
  if (append === undefined) return base;
  return `${base}\n\n${append}`;
}

/**
 * Build the second arg for `run(agent, …)`. Plain string when there are no
 * attachments (matches the SDK's simple-text path); otherwise a single
 * UserMessageItem with mixed `input_text` / `input_image` content. Path
 * attachments are read from disk and base64-encoded into a data URL.
 */
export async function buildOpenAIRunInput(
  message: string | undefined,
  attachments: Attachment[],
): Promise<string | AgentInputItem[]> {
  if (attachments.length === 0) return message ?? '';
  const content: Array<
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image: string }
  > = [];
  for (const att of attachments) content.push(await attachmentToOpenAIPart(att));
  if (message !== undefined) content.push({ type: 'input_text', text: message });
  return [{ role: 'user', content } as unknown as AgentInputItem];
}

async function attachmentToOpenAIPart(
  att: Attachment,
): Promise<{ type: 'input_image'; image: string }> {
  if (att.type !== 'image') {
    throw new Error(
      `OpenAI Agents backend: unsupported attachment type '${(att as { type: string }).type}'`,
    );
  }
  switch (att.source.kind) {
    case 'url':
      return { type: 'input_image', image: att.source.url };
    case 'base64':
      return {
        type: 'input_image',
        image: `data:${att.source.mimeType};base64,${att.source.data}`,
      };
    case 'path': {
      const data = (await fsp.readFile(att.source.path)).toString('base64');
      const mediaType = mediaTypeFromPath(att.source.path);
      return { type: 'input_image', image: `data:${mediaType};base64,${data}` };
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
      throw new Error(`OpenAI Agents backend: cannot infer image media type from extension '.${ext}'`);
  }
}

function mapUsage(usage: Usage): TokenUsage {
  // OpenAI's input_tokens_details has cached_tokens; output_tokens_details
  // doesn't expose a cache-write counterpart in the standard shape.
  const inputDetailsArr = usage.inputTokensDetails ?? [];
  let cacheRead = 0;
  for (const d of inputDetailsArr) {
    if (typeof d?.cached_tokens === 'number') cacheRead += d.cached_tokens;
  }
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead,
    cacheWrite: 0,
  };
}

// ── Event translation ──

/**
 * Translate one @openai/agents stream event into zero or more AgentEvents.
 *
 * Three event classes from the SDK:
 *  - RunRawModelStreamEvent    → text/reasoning/tool-input deltas
 *  - RunItemStreamEvent        → finalized message/tool/handoff items
 *  - RunAgentUpdatedStreamEvent → no user-visible event (already covered by `activity`)
 */
export function* translateStreamEvent(
  ev: RunRawModelStreamEvent | RunItemStreamEvent | RunAgentUpdatedStreamEvent,
  canonicalByWireName: Map<string, string>,
  textBuf: Map<string, string>,
  reasoningBuf: Map<string, string>,
): Generator<AgentEvent> {
  if (ev.type === 'raw_model_stream_event') {
    yield* translateRawEvent(ev.data, textBuf, reasoningBuf);
    return;
  }
  if (ev.type === 'run_item_stream_event') {
    yield* translateItemEvent(ev, canonicalByWireName, textBuf, reasoningBuf);
    return;
  }
  // 'agent_updated_stream_event' — no-op (covered by 'activity').
}

function* translateRawEvent(
  data: unknown,
  textBuf: Map<string, string>,
  reasoningBuf: Map<string, string>,
): Generator<AgentEvent> {
  const e = data as { type?: string; item_id?: string; delta?: string; text?: string };
  if (typeof e?.type !== 'string') return;
  switch (e.type) {
    case 'response.output_text.delta': {
      if (typeof e.item_id !== 'string' || typeof e.delta !== 'string') return;
      const seen = textBuf.has(e.item_id);
      if (!seen) {
        textBuf.set(e.item_id, '');
        yield { type: 'text_start' };
      }
      textBuf.set(e.item_id, (textBuf.get(e.item_id) ?? '') + e.delta);
      yield { type: 'text_delta', delta: e.delta };
      return;
    }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning.delta': {
      if (typeof e.item_id !== 'string' || typeof e.delta !== 'string') return;
      const seen = reasoningBuf.has(e.item_id);
      if (!seen) {
        reasoningBuf.set(e.item_id, '');
        yield { type: 'thinking_start' };
      }
      reasoningBuf.set(e.item_id, (reasoningBuf.get(e.item_id) ?? '') + e.delta);
      yield { type: 'thinking_delta', delta: e.delta };
      return;
    }
    case 'response.function_call_arguments.delta': {
      const ev = data as { item_id?: string; delta?: string };
      if (typeof ev.item_id !== 'string' || typeof ev.delta !== 'string') return;
      yield { type: 'tool_call_input_delta', id: ev.item_id, deltaJson: ev.delta };
      return;
    }
    // Other raw events are aggregated into RunItemStreamEvents — wait for those.
  }
}

function* translateItemEvent(
  ev: RunItemStreamEvent,
  canonicalByWireName: Map<string, string>,
  textBuf: Map<string, string>,
  reasoningBuf: Map<string, string>,
): Generator<AgentEvent> {
  switch (ev.name) {
    case 'message_output_created': {
      // Synthesize text_end from the accumulated buffer for any matching id;
      // also fall back to extracting text from rawItem if no buffer was built
      // (e.g. non-streamed path / a model that didn't emit deltas).
      const item = ev.item as { rawItem?: { id?: string; content?: unknown } };
      const id = item.rawItem?.id;
      let text = '';
      if (typeof id === 'string' && textBuf.has(id)) {
        text = textBuf.get(id) ?? '';
        textBuf.delete(id);
      } else {
        text = extractAssistantText(item.rawItem);
      }
      yield { type: 'text_end', text };
      return;
    }
    case 'reasoning_item_created': {
      const item = ev.item as { rawItem?: { id?: string; content?: unknown; summary?: unknown } };
      const id = item.rawItem?.id;
      let text = '';
      if (typeof id === 'string' && reasoningBuf.has(id)) {
        text = reasoningBuf.get(id) ?? '';
        reasoningBuf.delete(id);
      } else {
        text = extractReasoningText(item.rawItem);
      }
      yield { type: 'thinking_end', text };
      return;
    }
    case 'tool_called':
    case 'tool_search_called': {
      const item = ev.item as {
        rawItem?: {
          callId?: string;
          id?: string;
          name?: string;
          arguments?: string | unknown;
          type?: string;
        };
      };
      const raw = item.rawItem ?? {};
      const wireName = raw.name ?? (raw.type === 'tool_search_call' ? 'tool_search' : 'unknown');
      const canonical = canonicalByWireName.get(wireName) ?? wireName;
      const id = raw.callId ?? raw.id ?? randomUUID();
      const inputArgs =
        typeof raw.arguments === 'string' ? safeParseJson(raw.arguments) : (raw.arguments ?? {});
      yield {
        type: 'tool_call_end',
        toolCall: { id, name: canonical, input: inputArgs },
      };
      return;
    }
    case 'tool_output':
    case 'tool_search_output_created': {
      const item = ev.item as {
        rawItem?: { callId?: string; id?: string; output?: unknown; error?: unknown };
        output?: unknown;
      };
      const raw = item.rawItem ?? {};
      const id = raw.callId ?? raw.id ?? randomUUID();
      const output = raw.output ?? item.output ?? '';
      yield {
        type: 'tool_result',
        result: { toolCallId: id, output, isError: raw.error !== undefined },
      };
      return;
    }
    case 'handoff_requested':
    case 'handoff_occurred': {
      const item = ev.item as { rawItem?: { name?: string } };
      const target = item.rawItem?.name ?? 'unknown';
      yield { type: 'text_end', text: `(handoff ${ev.name === 'handoff_requested' ? 'requested' : 'occurred'}: ${target})` };
      return;
    }
    case 'tool_approval_requested': {
      yield {
        type: 'error',
        message: 'tool approval requested but not supported by this backend',
        retryable: false,
      };
      return;
    }
  }
}

function extractAssistantText(rawItem: unknown): string {
  if (typeof rawItem !== 'object' || rawItem === null) return '';
  const content = (rawItem as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c !== 'object' || c === null) continue;
    const part = c as { type?: string; text?: string };
    if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('');
}

function extractReasoningText(rawItem: unknown): string {
  if (typeof rawItem !== 'object' || rawItem === null) return '';
  const item = rawItem as { content?: unknown; summary?: unknown };
  const out: string[] = [];
  if (Array.isArray(item.summary)) {
    for (const s of item.summary) {
      if (typeof s === 'string') out.push(s);
      else if (typeof s === 'object' && s !== null && 'text' in s && typeof (s as { text: unknown }).text === 'string') {
        out.push((s as { text: string }).text);
      }
    }
  }
  if (Array.isArray(item.content)) {
    for (const c of item.content) {
      if (typeof c === 'string') out.push(c);
      else if (typeof c === 'object' && c !== null && 'text' in c && typeof (c as { text: unknown }).text === 'string') {
        out.push((c as { text: string }).text);
      }
    }
  }
  return out.join('\n');
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Walk a loaded AgentInputItem[] backwards looking for the most recent
 * function_call to the `todo` tool. Used on cache-miss reload so the
 * callModelInputFilter injection survives process restarts without a
 * separate sidecar file — the JSONL is the single source of truth.
 *
 * Returns the unwrapped tool input — the canonical Claude or Codex shape,
 * not the `{option0: …}` form the model emitted to satisfy the SDK's
 * top-level-object schema requirement.
 */
export function findLatestTodoInput(items: AgentInputItem[]): unknown {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as { type?: string; name?: string; arguments?: unknown } | undefined;
    if (item?.type !== 'function_call' || item.name !== 'todo') continue;
    let args: unknown = item.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return undefined;
      }
    }
    return unwrapStoredArgs(args);
  }
  return undefined;
}

/**
 * Reverse the schema-wrapping that wrapSchemaForOpenAI applies. Used when
 * reading args back from the JSONL store (where they were JSON-encoded by
 * the model in the wrapped shape) so we get the canonical shape back.
 *
 * Detects the wrapping form by structure: `{input: …}` (single-key, for
 * non-object schemas) or `{option0: …, option1: …, …}` (for unions).
 * Falls through unchanged if the shape doesn't match either pattern.
 */
export function unwrapStoredArgs(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args;
  const a = args as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length === 1 && keys[0] === 'input') return a.input;
  const optionKeys = keys.filter((k) => /^option\d+$/.test(k));
  if (optionKeys.length > 0) {
    for (const k of optionKeys) {
      const v = a[k];
      if (v !== undefined && v !== null) return v;
    }
  }
  return args;
}
