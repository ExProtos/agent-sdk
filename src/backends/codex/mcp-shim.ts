/**
 * MCP server shim — runs as a subprocess that Codex spawns.
 *
 * Reads from env at startup:
 *   AGENT_SDK_SOCKET   — path to parent's socket
 *   AGENT_SDK_MANIFEST — JSON-encoded ToolManifest[]
 *
 * Speaks stdio MCP to Codex. For every tool call from Codex, sends an invoke
 * RPC to the parent over the socket and returns the parent's result. The
 * shim never sees the actual tool's `execute` — that closure stays in the
 * parent's process.
 *
 * One shim instance per Codex thread that uses polyfilled tools. Codex
 * keeps it alive for the duration of the thread.
 */

import { connect, type Socket } from 'node:net';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';

interface ManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface InvokeResponse {
  id: number;
  result?: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
  error?: { message: string };
}

const socketPath = process.env.AGENT_SDK_SOCKET;
const manifestJson = process.env.AGENT_SDK_MANIFEST;

if (!socketPath || !manifestJson) {
  process.stderr.write(
    'agent-sdk mcp-shim: AGENT_SDK_SOCKET and AGENT_SDK_MANIFEST must be set in env\n',
  );
  process.exit(1);
}

const manifest: ManifestEntry[] = JSON.parse(manifestJson);
const socket = await openSocket(socketPath);
const lines = createInterface({ input: socket });

let nextId = 1;
const pending = new Map<number, (response: InvokeResponse) => void>();

lines.on('line', (line) => {
  if (!line.trim()) return;
  let response: InvokeResponse;
  try {
    response = JSON.parse(line) as InvokeResponse;
  } catch {
    return;
  }
  const handler = pending.get(response.id);
  if (handler) {
    pending.delete(response.id);
    handler(response);
  }
});

socket.on('error', (err) => {
  process.stderr.write(`agent-sdk mcp-shim: socket error: ${String(err)}\n`);
});

socket.on('close', () => {
  for (const handler of pending.values()) {
    handler({ id: 0, error: { message: 'parent socket closed' } });
  }
  pending.clear();
});

const server = new Server(
  { name: 'agent-sdk-polyfills', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: McpTool[] = manifest.map((m) => ({
    name: m.name,
    description: m.description,
    inputSchema: m.inputSchema as McpTool['inputSchema'],
  }));
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const id = nextId++;
  const args = req.params.arguments ?? {};

  const response = await new Promise<InvokeResponse>((resolve) => {
    pending.set(id, resolve);
    socket.write(`${JSON.stringify({ id, tool: req.params.name, args })}\n`);
  });

  if (response.error) {
    return {
      content: [{ type: 'text', text: response.error.message }],
      isError: true,
    };
  }
  return response.result ?? { content: [{ type: 'text', text: '' }] };
});

await server.connect(new StdioServerTransport());

// ── helpers ──

function openSocket(target: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(target);
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}
