/**
 * Bridges Codex AppServer's MCP-server-in-subprocess model to in-process
 * Tool.execute() closures.
 *
 * Architecture:
 *   - This class runs in the user's Node process. It owns the Tool registry
 *     (with live `execute` closures).
 *   - It listens on a Unix socket (or TCP localhost on Windows) for invoke
 *     RPC calls from the MCP shim subprocess.
 *   - When the shim receives an MCP tool call from Codex, it forwards
 *     {tool, args} over the socket; we run the closure here and return the
 *     result.
 *
 * Lifecycle:
 *   - start() opens the socket and returns config the caller passes to
 *     thread/start (socket path + tool manifest).
 *   - stop() closes the socket. New invocations after stop() error cleanly.
 *
 * Wire protocol (newline-delimited JSON):
 *   →  {"id":N,"tool":"name","args":{...}}
 *   ←  {"id":N,"result":[{"type":"text","text":"..."}]}
 *   ←  {"id":N,"error":{"message":"..."}}
 */

import { createServer, type Server, type Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { Tool } from '../../tools/types';

export interface ToolManifest {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeConfig {
  /** Socket path the shim will connect to (Unix socket on POSIX, named pipe on Windows). */
  socketPath: string;
  /** Tool manifest (name + description + JSON Schema) — closures stay in parent. */
  manifest: ToolManifest[];
}

interface InvokeRequest {
  id: number;
  tool: string;
  args: unknown;
}

interface InvokeSuccess {
  id: number;
  result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
}

interface InvokeError {
  id: number;
  error: { message: string };
}

export class McpBridge {
  private server: Server | null = null;
  private socketPath: string | null = null;
  private readonly tools = new Map<string, Tool>();
  private readonly connections = new Set<Socket>();

  /**
   * Register a tool. Must have an `execute` function (no native.codex check
   * here — the caller decides which tools to register).
   */
  register(tool: Tool): void {
    if (typeof tool.execute !== 'function') {
      throw new Error(`Tool '${tool.name}' has no execute() — cannot bridge`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Open the socket and return the config the caller will pass to Codex's
   * thread/start.
   */
  async start(): Promise<BridgeConfig> {
    if (this.server) throw new Error('McpBridge already started');
    if (this.tools.size === 0) throw new Error('No tools registered');

    const socketPath = makeSocketPath();
    this.socketPath = socketPath;

    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socketPath, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });

    const manifest: ToolManifest[] = [];
    for (const tool of this.tools.values()) {
      manifest.push({
        name: tool.name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.schema) as Record<string, unknown>,
      });
    }

    return { socketPath, manifest };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    // Force-destroy any active shim connections — server.close() alone only
    // stops accepting NEW connections and waits for existing ones to drain,
    // which can hang indefinitely if the shim subprocess hasn't exited.
    for (const sock of this.connections) sock.destroy();
    this.connections.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Best-effort cleanup of the socket file (ENOENT is fine).
    if (this.socketPath && process.platform !== 'win32') {
      try {
        const fs = await import('node:fs/promises');
        await fs.unlink(this.socketPath);
      } catch {
        /* ignore */
      }
    }
    this.socketPath = null;
  }

  // ── internals ──

  private handleConnection(socket: Socket): void {
    socket.setEncoding('utf8');
    this.connections.add(socket);
    const lines = createInterface({ input: socket });

    lines.on('line', (line) => {
      void this.handleLine(line, socket);
    });

    socket.on('close', () => {
      this.connections.delete(socket);
    });

    socket.on('error', () => {
      this.connections.delete(socket);
    });
  }

  private async handleLine(line: string, socket: Socket): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: InvokeRequest;
    try {
      req = JSON.parse(trimmed) as InvokeRequest;
    } catch {
      return; // malformed; drop
    }
    if (typeof req.id !== 'number' || typeof req.tool !== 'string') return;

    const tool = this.tools.get(req.tool);
    if (!tool || !tool.execute) {
      sendError(socket, req.id, `unknown tool: ${req.tool}`);
      return;
    }

    // Validate args against the tool's Zod schema.
    const parsed = tool.schema.safeParse(req.args);
    if (!parsed.success) {
      sendError(socket, req.id, `invalid args: ${parsed.error.message}`);
      return;
    }

    try {
      const result = await tool.execute(parsed.data);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      const response: InvokeSuccess = {
        id: req.id,
        result: { content: [{ type: 'text', text }] },
      };
      socket.write(`${JSON.stringify(response)}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(socket, req.id, message);
    }
  }
}

function sendError(socket: Socket, id: number, message: string): void {
  const response: InvokeError = { id, error: { message } };
  try {
    socket.write(`${JSON.stringify(response)}\n`);
  } catch {
    /* socket closed */
  }
}

function makeSocketPath(): string {
  const id = `agent-sdk-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (process.platform === 'win32') {
    // Windows named pipe.
    return `\\\\.\\pipe\\${id}`;
  }
  return path.join(os.tmpdir(), `${id}.sock`);
}
