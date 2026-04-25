/**
 * Bridge tests — exercise the parent side without spawning the actual MCP
 * shim. We connect a fake "shim" client to the bridge's socket and send
 * invoke RPCs directly.
 */

import { describe, expect, it } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { PolyfillBridge } from '../../../src/backends/codex/polyfill-bridge';
import type { Tool } from '../../../src/tools/types';

interface InvokeResp {
  id: number;
  result?: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
  error?: { message: string };
}

async function connectAndCall(
  socketPath: string,
  request: { id: number; tool: string; args: unknown },
): Promise<InvokeResp> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    const lines = createInterface({ input: socket });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    lines.on('line', (line) => {
      try {
        const resp = JSON.parse(line) as InvokeResp;
        socket.end();
        resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
    socket.once('error', reject);
  });
}

const echoTool: Tool = {
  name: 'echo',
  description: 'Echo back the message',
  schema: z.object({ message: z.string() }),
  execute: async ({ message }: { message: string }) => `echoed: ${message}`,
};

const addTool: Tool = {
  name: 'add',
  description: 'Add two numbers',
  schema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
};

const throwingTool: Tool = {
  name: 'thrower',
  description: 'Always throws',
  schema: z.object({}),
  execute: async () => {
    throw new Error('intentional failure');
  },
};

const noExecuteTool: Tool = {
  name: 'noExecute',
  description: 'Has no execute',
  schema: z.object({}),
};

describe('PolyfillBridge', () => {
  it('register() rejects tools without execute', () => {
    const bridge = new PolyfillBridge();
    expect(() => bridge.register(noExecuteTool)).toThrow(/has no execute/);
  });

  it('start() returns socket path and manifest', async () => {
    const bridge = new PolyfillBridge();
    bridge.register(echoTool);
    bridge.register(addTool);
    const config = await bridge.start();

    try {
      expect(typeof config.socketPath).toBe('string');
      expect(config.manifest).toHaveLength(2);
      expect(config.manifest.map((m) => m.name).sort()).toEqual(['add', 'echo']);
      for (const m of config.manifest) {
        expect(m.description).toBeTruthy();
        expect(m.inputSchema).toBeTruthy();
        expect((m.inputSchema as Record<string, unknown>).type).toBe('object');
      }
    } finally {
      await bridge.stop();
    }
  });

  it('start() rejects when no tools registered', async () => {
    const bridge = new PolyfillBridge();
    await expect(bridge.start()).rejects.toThrow(/No tools registered/);
  });

  it('start() rejects double-start', async () => {
    const bridge = new PolyfillBridge();
    bridge.register(echoTool);
    await bridge.start();
    try {
      await expect(bridge.start()).rejects.toThrow(/already started/);
    } finally {
      await bridge.stop();
    }
  });

  it('handles invoke RPC and returns text result', async () => {
    const bridge = new PolyfillBridge();
    bridge.register(echoTool);
    const config = await bridge.start();

    try {
      const resp = await connectAndCall(config.socketPath, {
        id: 1,
        tool: 'echo',
        args: { message: 'hello' },
      });
      expect(resp.id).toBe(1);
      expect(resp.result?.content).toEqual([{ type: 'text', text: 'echoed: hello' }]);
      expect(resp.result?.isError).toBeUndefined();
    } finally {
      await bridge.stop();
    }
  });

  it('serializes object results as JSON', async () => {
    const bridge = new PolyfillBridge();
    bridge.register(addTool);
    const config = await bridge.start();

    try {
      const resp = await connectAndCall(config.socketPath, {
        id: 7,
        tool: 'add',
        args: { a: 2, b: 3 },
      });
      expect(resp.id).toBe(7);
      const text = resp.result?.content[0]?.text;
      expect(JSON.parse(text!)).toEqual({ sum: 5 });
    } finally {
      await bridge.stop();
    }
  });

  it('rejects unknown tool names', async () => {
    const bridge = new PolyfillBridge();
    bridge.register(echoTool);
    const config = await bridge.start();

    try {
      const resp = await connectAndCall(config.socketPath, {
        id: 2,
        tool: 'doesNotExist',
        args: {},
      });
      expect(resp.id).toBe(2);
      expect(resp.error?.message).toMatch(/unknown tool/);
    } finally {
      await bridge.stop();
    }
  });

  it('rejects args that fail schema validation', async () => {
    const bridge = new PolyfillBridge();
    bridge.register(addTool);
    const config = await bridge.start();

    try {
      const resp = await connectAndCall(config.socketPath, {
        id: 3,
        tool: 'add',
        args: { a: 'not a number', b: 5 },
      });
      expect(resp.id).toBe(3);
      expect(resp.error?.message).toMatch(/invalid args/);
    } finally {
      await bridge.stop();
    }
  });

  it('returns error response when execute() throws', async () => {
    const bridge = new PolyfillBridge();
    bridge.register(throwingTool);
    const config = await bridge.start();

    try {
      const resp = await connectAndCall(config.socketPath, {
        id: 4,
        tool: 'thrower',
        args: {},
      });
      expect(resp.id).toBe(4);
      expect(resp.error?.message).toBe('intentional failure');
    } finally {
      await bridge.stop();
    }
  });

  it('stop() is idempotent', async () => {
    const bridge = new PolyfillBridge();
    bridge.register(echoTool);
    await bridge.start();
    await bridge.stop();
    await expect(bridge.stop()).resolves.toBeUndefined();
  });

  it('handles multiple sequential invocations on one connection', async () => {
    const bridge = new PolyfillBridge();
    bridge.register(echoTool);
    const config = await bridge.start();

    try {
      const responses: InvokeResp[] = [];
      const socket: Socket = createConnection(config.socketPath);
      const lines = createInterface({ input: socket });

      const collected = new Promise<void>((resolve) => {
        let count = 0;
        lines.on('line', (line) => {
          responses.push(JSON.parse(line));
          count++;
          if (count === 3) {
            socket.end();
            resolve();
          }
        });
      });

      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id: 1, tool: 'echo', args: { message: 'a' } })}\n`);
        socket.write(`${JSON.stringify({ id: 2, tool: 'echo', args: { message: 'b' } })}\n`);
        socket.write(`${JSON.stringify({ id: 3, tool: 'echo', args: { message: 'c' } })}\n`);
      });

      await collected;

      expect(responses).toHaveLength(3);
      expect(responses.map((r) => r.id).sort()).toEqual([1, 2, 3]);
      const texts = responses.map((r) => r.result?.content[0]?.text).sort();
      expect(texts).toEqual(['echoed: a', 'echoed: b', 'echoed: c']);
    } finally {
      await bridge.stop();
    }
  });
});
