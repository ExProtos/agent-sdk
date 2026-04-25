/**
 * Core types for the unified agent wrapper.
 *
 * Shape borrowed from NanoClaw's AgentProvider; event union borrowed from Pi
 * (start/delta/end with partial-message snapshots).
 */

export type StopReason = 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  output: unknown;
  isError: boolean;
}

/**
 * Streaming events emitted by a running agent. Consumers can render from
 * `delta` (incremental) or wait for `*_end` events (final state).
 */
export type AgentEvent =
  // Lifecycle
  /**
   * Emitted once at the start of a query. `continuation` is the opaque token
   * to pass back as `QueryInput.continuation` to resume this thread later.
   */
  | { type: 'session_start'; continuation: string }
  | { type: 'session_end'; usage: TokenUsage; stopReason: StopReason }
  | { type: 'turn_end'; reason: StopReason }
  | { type: 'error'; message: string; retryable: boolean }

  // Streaming text
  | { type: 'text_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'text_end'; text: string }

  // Streaming reasoning/thinking
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end'; text: string }

  // Tool calls (model → tool)
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_input_delta'; id: string; deltaJson: string }
  | { type: 'tool_call_end'; toolCall: ToolCall }

  // Tool results (tool → model)
  | { type: 'tool_result'; result: ToolResult }

  // Liveness — emitted on every underlying SDK event so timers stay honest
  | { type: 'activity' };

/**
 * Input to a query. `continuation` is opaque — provider decides what it means
 * (Claude session ID, Codex thread ID, replay history, etc.).
 */
export interface QueryInput {
  prompt: string;
  continuation?: string;
  cwd?: string;
  systemPromptAppend?: string;
}

/**
 * Active query handle. Push follow-ups, abort, or iterate the event stream.
 */
export interface AgentQuery {
  push(message: string): void;
  end(): void;
  abort(): void;
  events: AsyncIterable<AgentEvent>;
}

/**
 * Per-backend implementations conform to this. Backends own:
 * - Their agent loop (we don't reimplement it)
 * - Translation from native SDK events → AgentEvent
 * - Continuation-token semantics
 * - Native tool registration where supported
 */
export interface Backend {
  readonly name: string;
  query(input: QueryInput): AgentQuery;
  /**
   * True if `err` indicates the stored continuation token is invalid (session
   * not found, transcript missing, etc.). Caller clears the token and retries.
   */
  isContinuationInvalid?(err: unknown): boolean;
  /** Optional cleanup — relevant for subprocess-based backends (Codex). */
  close?(): Promise<void>;
}
