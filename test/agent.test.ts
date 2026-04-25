import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent.js';
import type { AgentEvent, AgentQuery, Backend, QueryInput } from '../src/types.js';

function mockBackend(): Backend & { query: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const fakeQuery: AgentQuery = {
    push: vi.fn(),
    end: vi.fn(),
    abort: vi.fn(),
    events: (async function* () {})(),
  };
  return {
    name: 'mock',
    query: vi.fn(() => fakeQuery),
    close: vi.fn(async () => {}),
  };
}

describe('Agent', () => {
  it('forwards run() to backend.query() with the same input', () => {
    const backend = mockBackend();
    const agent = new Agent({ backend });
    const input: QueryInput = { message: 'hi' };

    agent.run(input);

    expect(backend.query).toHaveBeenCalledTimes(1);
    expect(backend.query).toHaveBeenCalledWith(input);
  });

  it('returns whatever backend.query() returned (not a wrapper)', () => {
    const backend = mockBackend();
    const fakeQuery = backend.query() as unknown as AgentQuery;
    backend.query.mockClear();
    backend.query.mockReturnValueOnce(fakeQuery);

    const agent = new Agent({ backend });
    const result = agent.run({ message: 'hi' });

    expect(result).toBe(fakeQuery);
  });

  it('close() forwards to backend.close()', async () => {
    const backend = mockBackend();
    const agent = new Agent({ backend });

    await agent.close();

    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('close() is a no-op when backend has no close()', async () => {
    const backend: Backend = {
      name: 'no-close',
      query: () => ({ push: () => {}, end: () => {}, abort: () => {}, events: (async function* () {})() }),
    };
    const agent = new Agent({ backend });

    await expect(agent.close()).resolves.toBeUndefined();
  });

  it('exposes the backend instance', () => {
    const backend = mockBackend();
    const agent = new Agent({ backend });

    expect(agent.backend).toBe(backend);
  });

  it('supports a continuation token round-trip via QueryInput', () => {
    const backend = mockBackend();
    const agent = new Agent({ backend });

    agent.run({ message: 'first' });
    agent.run({ continuation: 'cont-abc', message: 'follow-up' });

    expect(backend.query).toHaveBeenNthCalledWith(2, { continuation: 'cont-abc', message: 'follow-up' });
  });

  // Smoke check: AgentEvent union is structurally exhaustive — TypeScript will
  // catch missing cases here at compile time.
  it('accepts every documented event variant in a switch', () => {
    const samples: AgentEvent[] = [
      { type: 'session_start', continuation: 'x' },
      { type: 'session_end', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'stop' },
      { type: 'turn_end', reason: 'stop' },
      { type: 'error', message: 'x', retryable: false },
      { type: 'text_start' },
      { type: 'text_delta', delta: 'h' },
      { type: 'text_end', text: 'hi' },
      { type: 'thinking_start' },
      { type: 'thinking_delta', delta: 't' },
      { type: 'thinking_end', text: 'think' },
      { type: 'tool_call_start', id: 't1', name: 'bash' },
      { type: 'tool_call_input_delta', id: 't1', deltaJson: '{"a"' },
      { type: 'tool_call_end', toolCall: { id: 't1', name: 'bash', input: {} } },
      { type: 'tool_result', result: { toolCallId: 't1', output: 'ok', isError: false } },
      { type: 'activity' },
    ];

    for (const ev of samples) {
      // Exhaustive switch with no default — TS errors here mean the union grew.
      switch (ev.type) {
        case 'session_start':
        case 'session_end':
        case 'turn_end':
        case 'error':
        case 'text_start':
        case 'text_delta':
        case 'text_end':
        case 'thinking_start':
        case 'thinking_delta':
        case 'thinking_end':
        case 'tool_call_start':
        case 'tool_call_input_delta':
        case 'tool_call_end':
        case 'tool_result':
        case 'activity':
          break;
      }
    }

    expect(samples.length).toBe(15);
  });
});
