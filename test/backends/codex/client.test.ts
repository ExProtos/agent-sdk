/**
 * Tests for the Codex JSON-RPC client.
 *
 * Strategy: spawn a fake Node subprocess that emits canned JSON-RPC traffic.
 * This exercises the real spawn() / stdio plumbing without depending on the
 * actual `codex` binary.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { CodexClient, CodexRpcError } from '../../../src/backends/codex/client';

/**
 * Write a tiny Node script to a temp file that can stand in for `codex
 * app-server`. The script speaks newline-delimited JSON-RPC and runs whatever
 * behavior we tell it to.
 */
function makeFakeServer(behavior: string): string {
  const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
${behavior}
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    onMessage(msg);
  } catch (e) { /* ignore */ }
});
`;
  const file = path.join(os.tmpdir(), `fake-codex-${Date.now()}-${Math.random()}.js`);
  fs.writeFileSync(file, script);
  return file;
}

function fakeServerOptions(behavior: string) {
  const file = makeFakeServer(behavior);
  return {
    command: process.execPath, // node binary
    args: [file],
  };
}

describe('CodexClient', () => {
  it('completes the initialize handshake', async () => {
    const opts = fakeServerOptions(`
      function onMessage(msg) {
        if (msg.method === 'initialize' && typeof msg.id !== 'undefined') {
          send({ id: msg.id, result: { serverInfo: { name: 'fake' } } });
        }
      }
    `);

    const client = await CodexClient.start(opts);
    expect(client).toBeInstanceOf(CodexClient);
    await client.close();
  });

  it('routes responses by id back to the correct request', async () => {
    const opts = fakeServerOptions(`
      function onMessage(msg) {
        if (msg.method === 'initialize') {
          send({ id: msg.id, result: {} });
        } else if (msg.method === 'echo') {
          send({ id: msg.id, result: { echoed: msg.params } });
        }
      }
    `);

    const client = await CodexClient.start(opts);
    const result = await client.request<{ echoed: { x: number } }>('echo', { x: 42 });
    expect(result).toEqual({ echoed: { x: 42 } });
    await client.close();
  });

  it('rejects with CodexRpcError on RPC error responses', async () => {
    const opts = fakeServerOptions(`
      function onMessage(msg) {
        if (msg.method === 'initialize') {
          send({ id: msg.id, result: {} });
        } else if (msg.method === 'fail') {
          send({ id: msg.id, error: { code: -1, message: 'expected failure', data: { extra: true } } });
        }
      }
    `);

    const client = await CodexClient.start(opts);
    try {
      await client.request('fail', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CodexRpcError);
      expect((err as CodexRpcError).method).toBe('fail');
      expect((err as CodexRpcError).code).toBe(-1);
      expect((err as CodexRpcError).message).toContain('expected failure');
      expect((err as CodexRpcError).data).toEqual({ extra: true });
    } finally {
      await client.close();
    }
  });

  it('dispatches notifications to handlers', async () => {
    // Trigger the notification via a request the test sends AFTER attaching
    // the handler — otherwise it races with start() resolving and may arrive
    // before any handler is registered.
    const opts = fakeServerOptions(`
      function onMessage(msg) {
        if (msg.method === 'initialize') {
          send({ id: msg.id, result: {} });
        } else if (msg.method === 'trigger') {
          send({ method: 'thread/started', params: { thread: { id: 'test-thread' } } });
          send({ id: msg.id, result: {} });
        }
      }
    `);

    const client = await CodexClient.start(opts);
    const received: unknown[] = [];

    const detach = client.onNotification((n) => received.push(n));
    await client.request('trigger', {});

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: 'thread/started',
      params: { thread: { id: 'test-thread' } },
    });

    detach();
    await client.close();
  });

  it('detach function unregisters the handler', async () => {
    const opts = fakeServerOptions(`
      function onMessage(msg) {
        if (msg.method === 'initialize') send({ id: msg.id, result: {} });
        if (msg.method === 'ping') {
          send({ method: 'pong', params: {} });
          send({ id: msg.id, result: 'ok' });
        }
      }
    `);

    const client = await CodexClient.start(opts);
    const received: unknown[] = [];
    const detach = client.onNotification((n) => received.push(n));

    await client.request('ping');
    detach();
    await client.request('ping');

    // Wait briefly to make sure all notifications are flushed.
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1); // only the first ping's notification got through

    await client.close();
  });

  it('replies to server-initiated requests with default {}', async () => {
    const opts = fakeServerOptions(`
      let waitingForReply = null;
      function onMessage(msg) {
        if (msg.method === 'initialize') {
          send({ id: msg.id, result: {} });
        } else if (typeof msg.id !== 'undefined' && 'result' in msg && waitingForReply !== null) {
          // Got the client's reply to our server-initiated request.
          send({ method: 'sawReply', params: { reply: msg.result } });
          waitingForReply = null;
        }
      }
      // After init, send a server-initiated request
      setTimeout(() => {
        waitingForReply = 1;
        send({ id: 9001, method: 'someServerRequest', params: {} });
      }, 50);
    `);

    const client = await CodexClient.start(opts);
    const received: unknown[] = [];
    client.onNotification((n) => received.push(n));

    // Wait for the server request → reply → echo cycle.
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toContainEqual(
      expect.objectContaining({
        method: 'sawReply',
        params: { reply: {} },
      }),
    );

    await client.close();
  });

  it('rejects pending requests when the subprocess exits', async () => {
    const opts = fakeServerOptions(`
      function onMessage(msg) {
        if (msg.method === 'initialize') send({ id: msg.id, result: {} });
        if (msg.method === 'die') {
          // Don't reply — just exit.
          process.exit(0);
        }
      }
    `);

    const client = await CodexClient.start(opts);
    await expect(client.request('die', {})).rejects.toThrow();
  });

  it('rejects new requests after close()', async () => {
    const opts = fakeServerOptions(`
      function onMessage(msg) {
        if (msg.method === 'initialize') send({ id: msg.id, result: {} });
      }
    `);

    const client = await CodexClient.start(opts);
    await client.close();
    await expect(client.request('anything')).rejects.toThrow(/closed/);
  });

  it('ignores non-JSON output on stdout (banners, debug logs, etc.)', async () => {
    const opts = fakeServerOptions(`
      function onMessage(msg) {
        if (msg.method === 'initialize') {
          process.stdout.write('this is not json\\n');
          process.stdout.write('still not json\\n');
          send({ id: msg.id, result: {} });
        }
      }
    `);

    // If non-JSON crashed the line parser, this would hang or throw.
    const client = await CodexClient.start(opts);
    expect(client).toBeInstanceOf(CodexClient);
    await client.close();
  });

  it('notify() does not expect a response', async () => {
    const opts = fakeServerOptions(`
      let saw = null;
      function onMessage(msg) {
        if (msg.method === 'initialize') {
          send({ id: msg.id, result: {} });
        } else if (msg.method === 'fire') {
          saw = msg;
          send({ method: 'sawFire', params: { hadId: typeof msg.id !== 'undefined' } });
        }
      }
    `);

    const client = await CodexClient.start(opts);
    const received: unknown[] = [];
    client.onNotification((n) => received.push(n));

    client.notify('fire', { x: 1 });

    // Wait briefly.
    await new Promise((r) => setTimeout(r, 100));

    const saw = received.find(
      (r) => typeof r === 'object' && r !== null && 'method' in r && (r as { method: string }).method === 'sawFire',
    ) as { params: { hadId: boolean } } | undefined;

    expect(saw).toBeDefined();
    expect(saw!.params.hadId).toBe(false); // notifications should not carry an id

    await client.close();
  });

  it('routes approval requests through onApprovalRequest when set', async () => {
    // Fake server: after handshake, sends a server-initiated
    // commandExecution/requestApproval, then echoes back the result it
    // got via a sawApproval notification so the test can observe it.
    const opts = fakeServerOptions(`
      let approvalReply = null;
      function onMessage(msg) {
        if (msg.method === 'initialize' && typeof msg.id !== 'undefined') {
          send({ id: msg.id, result: { serverInfo: { name: 'fake' } } });
          // Send the approval request after the handshake completes.
          setTimeout(() => {
            send({
              id: 99,
              method: 'item/commandExecution/requestApproval',
              params: { command: ['rm', '-rf', '/tmp/test'] },
            });
          }, 10);
          return;
        }
        // The client's response to our approval request comes back as
        // a JSON-RPC response (not a method call) — id matches the 99
        // we sent.
        if (msg.id === 99 && msg.result !== undefined) {
          send({ method: 'sawApproval', params: { result: msg.result } });
        }
      }
    `);

    const calls: Array<{ method: string; params: unknown }> = [];
    const client = await CodexClient.start({
      ...opts,
      onApprovalRequest: async (req) => {
        calls.push({ method: req.method, params: req.params });
        return { decision: 'accept' };
      },
    });

    const sawApproval: { result: { decision: string } }[] = [];
    client.onNotification((n) => {
      if (n.method === 'sawApproval') {
        sawApproval.push(n.params as { result: { decision: string } });
      }
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('item/commandExecution/requestApproval');
    expect(calls[0].params).toEqual({ command: ['rm', '-rf', '/tmp/test'] });
    expect(sawApproval.length).toBe(1);
    expect(sawApproval[0].result).toEqual({ decision: 'accept' });

    await client.close();
  });

  it('falls back to default decline when onApprovalRequest is not set', async () => {
    const opts = fakeServerOptions(`
      function onMessage(msg) {
        if (msg.method === 'initialize' && typeof msg.id !== 'undefined') {
          send({ id: msg.id, result: { serverInfo: { name: 'fake' } } });
          setTimeout(() => {
            send({
              id: 88,
              method: 'item/commandExecution/requestApproval',
              params: { command: ['ls'] },
            });
          }, 10);
          return;
        }
        if (msg.id === 88 && msg.result !== undefined) {
          send({ method: 'sawApproval', params: { result: msg.result } });
        }
      }
    `);

    const client = await CodexClient.start(opts);
    const sawApproval: { result: { decision: string } }[] = [];
    client.onNotification((n) => {
      if (n.method === 'sawApproval') {
        sawApproval.push(n.params as { result: { decision: string } });
      }
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(sawApproval.length).toBe(1);
    expect(sawApproval[0].result).toEqual({ decision: 'decline' });

    await client.close();
  });

  it('falls back to decline when onApprovalRequest throws', async () => {
    const opts = fakeServerOptions(`
      function onMessage(msg) {
        if (msg.method === 'initialize' && typeof msg.id !== 'undefined') {
          send({ id: msg.id, result: { serverInfo: { name: 'fake' } } });
          setTimeout(() => {
            send({
              id: 77,
              method: 'item/commandExecution/requestApproval',
              params: {},
            });
          }, 10);
          return;
        }
        if (msg.id === 77 && msg.result !== undefined) {
          send({ method: 'sawApproval', params: { result: msg.result } });
        }
      }
    `);

    // Suppress stderr so the "handler threw" warning doesn't pollute output.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true);

    try {
      const client = await CodexClient.start({
        ...opts,
        onApprovalRequest: async () => {
          throw new Error('handler boom');
        },
      });
      const sawApproval: { result: { decision: string } }[] = [];
      client.onNotification((n) => {
        if (n.method === 'sawApproval') {
          sawApproval.push(n.params as { result: { decision: string } });
        }
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(sawApproval.length).toBe(1);
      expect(sawApproval[0].result).toEqual({ decision: 'decline' });

      await client.close();
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
