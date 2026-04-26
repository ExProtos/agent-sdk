/**
 * JSON-RPC 2.0 client for `codex app-server` over stdio.
 *
 * Codex omits the `"jsonrpc": "2.0"` header on the wire (per its README),
 * so we emit and accept newline-delimited JSON without it.
 *
 * Architecture cribbed from OpenClaw's CodexAppServerClient
 * (~/src/openclaw/extensions/codex/src/app-server/client.ts) — minus
 * websocket transport, OpenClaw-specific protocol validators, and most
 * of the auth-bridge plumbing.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { ServerNotification } from './protocol';

interface RpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

interface RpcNotification {
  method: string;
  params?: unknown;
}

type IncomingMessage = RpcResponse | RpcRequest | RpcNotification;

function isResponse(msg: unknown): msg is RpcResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'id' in msg &&
    ('result' in msg || 'error' in msg)
  );
}

/**
 * Codex protocol methods that ask the client for an `accept`/`decline`
 * decision before letting the model run a shell command, change a file,
 * or apply a patch. When the caller supplies an `onApprovalRequest`
 * handler, these are routed there; otherwise they default to `decline`.
 */
const APPROVAL_DECISION_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);

/**
 * The shape passed to a caller-supplied `onApprovalRequest` handler.
 * `params` is codex's raw params blob — the shape varies by `method`
 * and tracks codex's protocol; consult the codex source for current
 * fields. Handlers typically just inspect `method` and return a
 * decision, deferring the parameter introspection until they need it.
 */
export interface ApprovalRequest {
  method:
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/requestApproval'
    | 'applyPatchApproval'
    | 'execCommandApproval';
  params: unknown;
}

export type ApprovalRequestHandler = (
  req: ApprovalRequest,
) => Promise<{ decision: 'accept' | 'decline' }>;

/**
 * Default response shapes for server-initiated requests. Codex's protocol
 * has many request methods that expect typed responses (not just `{}`);
 * sending the wrong shape results in "missing field X" deserialization
 * errors that can stall the conversation. Mirrors OpenClaw's defaults.
 *
 * For all of these we choose the most conservative "decline / no-op"
 * variant — actual handling (approve a command, accept user input)
 * belongs in higher-level wiring once we expose hooks for it.
 */
function defaultServerRequestResponse(method: string): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { decision: 'decline' };

    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };

    case 'mcpServer/elicitation/request':
      // Codex asks for approval whenever the model tries to call an MCP-served
      // tool. Since the user explicitly passed the tool to the backend (via
      // the `tools` option), they've already approved it — auto-accept.
      // Note: this is global; if the user wires up additional MCP servers
      // via Codex's TOML config, those would also be auto-accepted. Caveat
      // that's worth tightening if it bites.
      return { action: 'accept', content: {}, _meta: null };

    case 'item/tool/call':
      return {
        contentItems: [
          {
            type: 'inputText',
            text: 'No handler registered for this app-server tool call.',
          },
        ],
        success: false,
      };

    case 'item/tool/requestUserInput':
      return { action: 'decline' };

    default:
      return {};
  }
}

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(`[${method}] ${message}`);
    this.name = 'CodexRpcError';
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

export type NotificationHandler = (n: ServerNotification) => void;

/**
 * Options for spawning the AppServer subprocess. Defaults to `codex
 * app-server` on PATH.
 */
export interface CodexClientOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  /**
   * Async handler for codex's per-action approval requests (run a command,
   * change a file, apply a patch, …). When unset, the client auto-declines
   * each request — safe but means anything codex routes to the client
   * fails silently. Set this when running with `askForApproval` other
   * than `'never'` and you want commands to actually execute.
   */
  onApprovalRequest?: ApprovalRequestHandler;
}

export class CodexClient {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly approvalHandler: ApprovalRequestHandler | undefined;
  private nextId = 1;
  private closed = false;
  private initialized = false;

  private constructor(options: CodexClientOptions) {
    const command = options.command ?? 'codex';
    const args = options.args ?? ['app-server'];
    const env = { ...process.env, ...options.env };
    this.approvalHandler = options.onApprovalRequest;

    this.child = spawn(command, args, {
      env,
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));

    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString('utf8').trim();
      if (text) process.stderr.write(`[codex] ${text}\n`);
    });

    this.child.once('error', (err) => this.closeWithError(err));
    this.child.once('exit', (code, signal) => {
      this.closeWithError(new Error(`codex app-server exited code=${code} signal=${signal}`));
    });

    // EPIPE / write-after-close on stdin can fire async without an exit event.
    this.child.stdin.on('error', (err) => this.closeWithError(err));
  }

  static async start(options: CodexClientOptions = {}): Promise<CodexClient> {
    const client = new CodexClient(options);
    await client.initialize();
    return client;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request('initialize', {
      clientInfo: { name: 'agent-sdk', title: 'agent-sdk', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
    this.initialized = true;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('codex client closed'));
    const id = this.nextId++;
    const message: RpcRequest = { id, method, ...(params !== undefined && { params }) };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        method,
      });
      this.write(message);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message: RpcNotification = { method, ...(params !== undefined && { params }) };
    this.write(message);
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.rejectPending(new Error('codex client closing'));
    this.child.kill('SIGTERM');
    // Give it a moment to exit cleanly, then SIGKILL.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 1000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ── internals ──

  private write(msg: RpcRequest | RpcResponse | RpcNotification): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(trimmed) as IncomingMessage;
    } catch {
      // Codex sometimes prints non-JSON to stdout (banners, etc.) — ignore.
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (isResponse(msg)) {
      this.handleResponse(msg);
      return;
    }
    if ('method' in msg) {
      if ('id' in msg && (msg).id !== undefined) {
        const req = msg;
        if (this.approvalHandler !== undefined && APPROVAL_DECISION_METHODS.has(req.method)) {
          // Async dispatch — handler may take arbitrary time. We must not
          // block handleLine, so fire-and-forget the await and write the
          // result when it resolves. If the handler throws, fall back to
          // the conservative default so the conversation doesn't stall.
          void this.dispatchApproval(req);
          return;
        }
        this.write({ id: req.id, result: defaultServerRequestResponse(req.method) });
        return;
      }
      this.dispatchNotification(msg);
    }
  }

  private async dispatchApproval(req: RpcRequest): Promise<void> {
    try {
      const decision = await this.approvalHandler!({
        method: req.method as ApprovalRequest['method'],
        params: req.params,
      });
      this.write({ id: req.id, result: decision });
    } catch (err) {
      process.stderr.write(
        `[codex] onApprovalRequest threw for ${req.method}; falling back to decline. ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      this.write({ id: req.id, result: defaultServerRequestResponse(req.method) });
    }
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id as number);
    if (!pending) return;
    this.pending.delete(response.id as number);
    if (response.error) {
      pending.reject(
        new CodexRpcError(response.error.message, pending.method, response.error.code, response.error.data),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private dispatchNotification(n: RpcNotification): void {
    const notif = { method: n.method, params: n.params };
    for (const handler of this.notificationHandlers) {
      try {
        handler(notif);
      } catch (err) {
        process.stderr.write(`[codex] notification handler threw: ${String(err)}\n`);
      }
    }
  }

  private closeWithError(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.rejectPending(err);
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}
