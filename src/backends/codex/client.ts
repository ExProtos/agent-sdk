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

import type { ServerNotification } from './protocol.js';

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
}

export class CodexClient {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private nextId = 1;
  private closed = false;
  private initialized = false;

  private constructor(options: CodexClientOptions) {
    const command = options.command ?? 'codex';
    const args = options.args ?? ['app-server'];
    const env = { ...process.env, ...options.env };

    this.child = spawn(command, args, {
      env,
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

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
      // Server-initiated requests have an id; we reply with default `{}` for now.
      // (Codex sends approval requests, fuzzy file search, etc. — minimal stub.)
      if ('id' in msg && (msg as RpcRequest).id !== undefined) {
        this.write({ id: (msg as RpcRequest).id, result: {} });
        return;
      }
      this.dispatchNotification(msg as RpcNotification);
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
    const notif = { method: n.method, params: n.params } as ServerNotification;
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
