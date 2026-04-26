import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UIMessage } from 'ai';

import { appendUIMessage, readUIMessages } from '../src/persistence';

function tmpfile(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-test-')),
    'session.jsonl',
  );
}

const userMsg: UIMessage = {
  id: 'u-1',
  role: 'user',
  parts: [{ type: 'text', text: 'hello' }],
};

const assistantMsg: UIMessage = {
  id: 'a-1',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'hi back', state: 'done' },
  ],
};

describe('appendUIMessage', () => {
  it('writes one JSONL line per message', () => {
    const f = tmpfile();
    appendUIMessage(f, userMsg);
    appendUIMessage(f, assistantMsg);

    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(userMsg);
    expect(JSON.parse(lines[1]!)).toEqual(assistantMsg);
  });

  it('creates parent directories as needed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-test-'));
    const nested = path.join(dir, 'a', 'b', 'c', 'session.jsonl');
    appendUIMessage(nested, userMsg);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('appends, never overwrites', () => {
    const f = tmpfile();
    appendUIMessage(f, userMsg);
    appendUIMessage(f, assistantMsg);
    appendUIMessage(f, userMsg);
    expect(readUIMessages(f)).toHaveLength(3);
  });
});

describe('readUIMessages', () => {
  it('returns empty array for missing file', () => {
    const f = path.join(os.tmpdir(), 'definitely-does-not-exist-' + Math.random() + '.jsonl');
    expect(readUIMessages(f)).toEqual([]);
  });

  it('round-trips appended messages', () => {
    const f = tmpfile();
    appendUIMessage(f, userMsg);
    appendUIMessage(f, assistantMsg);
    expect(readUIMessages(f)).toEqual([userMsg, assistantMsg]);
  });

  it('skips blank lines', () => {
    const f = tmpfile();
    fs.writeFileSync(
      f,
      JSON.stringify(userMsg) + '\n\n' + JSON.stringify(assistantMsg) + '\n',
    );
    expect(readUIMessages(f)).toEqual([userMsg, assistantMsg]);
  });

  it('throws on malformed JSON (corruption is a bug, not empty state)', () => {
    const f = tmpfile();
    fs.writeFileSync(f, JSON.stringify(userMsg) + '\n{not valid json\n');
    expect(() => readUIMessages(f)).toThrow();
  });
});
