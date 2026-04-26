import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codex } from '../../../src/backends/codex/index';
import { codexLogin } from '../../../src/backends/codex/login';

let tmpHome: string;
let realHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-login-'));
  realHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  else delete process.env.HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('codex.login', () => {
  it('is attached to the codex factory', () => {
    expect(typeof codex.login).toBe('function');
    expect(codex.login).toBe(codexLogin);
  });

  it('apiKey path writes auth.json without spawning anything', async () => {
    const result = await codex.login({ apiKey: 'sk-abc', cwd: tmpHome });
    expect(result.mode).toBe('apiKey');
    expect(result.codexHome.endsWith('/default')).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(path.join(result.codexHome, 'auth.json'), 'utf8'));
    expect(parsed).toEqual({ auth_mode: 'ApiKey', OPENAI_API_KEY: 'sk-abc' });
  });

  it('apiKey + profile uses the named slot', async () => {
    const result = await codex.login({ profile: 'work', apiKey: 'sk-x', cwd: tmpHome });
    expect(result.codexHome.endsWith('/work')).toBe(true);
  });

  it('throws when neither profile nor apiKey is set', async () => {
    await expect(codex.login({})).rejects.toThrow(/profile.*apiKey/);
  });

  it('OAuth path surfaces a clear error when codex binary is missing', async () => {
    const realPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      await expect(codex.login({ profile: 'work', cwd: tmpHome })).rejects.toThrow(
        /codex.*binary not found/i,
      );
    } finally {
      if (realPath !== undefined) process.env.PATH = realPath;
      else delete process.env.PATH;
    }
  });
});
