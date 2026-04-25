/**
 * Hand-written subset of the Codex AppServer JSON-RPC protocol.
 *
 * Full protocol has 50+ notifications and ~30 request methods; we only model
 * the ones we actually use. Generate from upstream (`codex app-server
 * generate-ts`) if/when we need broader coverage.
 *
 * Source of truth: https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema
 */

// ── Requests ──

export interface InitializeParams {
  clientInfo: { name: string; title?: string; version: string };
  capabilities?: { experimentalApi?: boolean };
}

export interface ThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  developerInstructions?: string | null;
}
export interface ThreadStartResponse {
  thread: { id: string };
  // Other fields (model, modelProvider, serviceTier, cwd, etc.) ignored.
}

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  developerInstructions?: string | null;
}
export interface ThreadResumeResponse {
  thread: { id: string };
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
}
export interface TurnStartResponse {
  turn: { id: string };
}

export interface TurnInterruptParams {
  threadId: string;
}

export type LoginAccountParams =
  | { type: 'apiKey'; apiKey: string }
  | { type: 'chatgpt' }
  | { type: 'chatgptDeviceCode' };

export type LoginAccountResponse =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string };

export interface GetAccountResponse {
  account: { type: 'apiKey' } | { type: 'chatgpt'; email: string; planType: string } | null;
  requiresOpenaiAuth: boolean;
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string };

// ── Notifications (server → client) ──

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TurnError {
  message: string;
}

/**
 * Subset of ThreadItem variants we surface as events. Other variants
 * (imageView, plan, etc.) flow through as raw notifications the consumer
 * can ignore.
 */
export type WebSearchAction =
  | { type: 'search'; query: string | null; queries: string[] | null }
  | { type: 'openPage'; url: string | null }
  | { type: 'findInPage'; url: string | null; pattern: string | null }
  | { type: 'other' };

export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'plan'; id: string; text: string }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: Array<{ path: string; kind: string; diff: string }>;
      status: 'inProgress' | 'completed' | 'failed' | 'declined';
    }
  | {
      type: 'webSearch';
      id: string;
      query: string;
      action: WebSearchAction | null;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      arguments: unknown;
      result: unknown;
      error: unknown;
    }
  | {
      type: 'dynamicToolCall';
      id: string;
      tool: string;
      arguments: unknown;
      success: boolean | null;
    }
  | { type: string; id: string };

export interface ItemNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface AgentMessageDelta {
  itemId: string;
  delta: string;
  threadId: string;
  turnId: string;
}

export interface ReasoningTextDelta {
  itemId: string;
  delta: string;
  threadId: string;
  turnId: string;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: { id: string; status: TurnStatus; error: TurnError | null };
}

export interface ErrorNotification {
  message: string;
}

/**
 * Discriminated union of notifications we explicitly handle. Anything else
 * comes through as `{ method: string; params: unknown }`.
 */
export type ServerNotification =
  | { method: 'thread/started'; params: { thread: { id: string } } }
  | { method: 'turn/started'; params: { threadId: string; turnId: string } }
  | { method: 'turn/completed'; params: TurnCompletedNotification }
  | { method: 'item/started'; params: ItemNotification }
  | { method: 'item/completed'; params: ItemNotification }
  | { method: 'item/agentMessage/delta'; params: AgentMessageDelta }
  | { method: 'item/reasoning/textDelta'; params: ReasoningTextDelta }
  | { method: 'error'; params: ErrorNotification }
  | { method: string; params: unknown };
