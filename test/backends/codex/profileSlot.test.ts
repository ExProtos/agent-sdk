import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveProfileSlot,
  slotDir,
  writeApiKeyAuth,
  notInitializedMessage,
} from '../../../src/backends/codex/profileSlot';

// Reroute HOME so tests don't touch the real ~/.agent-sdk/codex/.
let tmpHome: string;
let realHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-test-home-'));
  realHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  else delete process.env.HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('resolveProfileSlot', () => {
  it('returns undefined when neither apiKey nor profile is set', () => {
    expect(resolveProfileSlot({})).toBeUndefined();
  });

  it("defaults profile to 'default' when only apiKey is set", () => {
    const result = resolveProfileSlot({ apiKey: 'sk-test', cwd: tmpHome });
    expect(result).toBeDefined();
    expect(result!.codexHome.endsWith('/default')).toBe(true);
  });

  it('uses literal profile name when profile is set', () => {
    // Pre-seed auth.json so the no-apiKey path doesn't throw.
    const dir = slotDir(tmpHome, 'work');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}');

    const result = resolveProfileSlot({ profile: 'work', cwd: tmpHome });
    expect(result!.codexHome.endsWith('/work')).toBe(true);
  });

  it('writes auth.json with apiKey contents', () => {
    const result = resolveProfileSlot({ apiKey: 'sk-abc123', cwd: tmpHome });
    const contents = fs.readFileSync(path.join(result!.codexHome, 'auth.json'), 'utf8');
    const parsed = JSON.parse(contents);
    expect(parsed).toEqual({ auth_mode: 'ApiKey', OPENAI_API_KEY: 'sk-abc123' });
  });

  it('writes auth.json with mode 0600', () => {
    const result = resolveProfileSlot({ apiKey: 'sk-test', cwd: tmpHome });
    const stat = fs.statSync(path.join(result!.codexHome, 'auth.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('overwrites existing auth.json unconditionally when apiKey is set', () => {
    const dir = slotDir(tmpHome, 'work');
    fs.mkdirSync(dir, { recursive: true });
    // Pre-existing OAuth-style auth.json
    fs.writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'Chatgpt', tokens: { access: 'old' } }),
    );

    resolveProfileSlot({ profile: 'work', apiKey: 'sk-new', cwd: tmpHome });
    const contents = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    expect(contents).toEqual({ auth_mode: 'ApiKey', OPENAI_API_KEY: 'sk-new' });
  });

  it('throws with multi-line copy-pasteable message when profile is unset', () => {
    expect(() => resolveProfileSlot({ profile: 'work', cwd: tmpHome })).toThrow(
      /not initialized.*codex login/s,
    );
  });

  it('error message includes the resolved absolute dir', () => {
    const dir = slotDir(tmpHome, 'work');
    expect(() => resolveProfileSlot({ profile: 'work', cwd: tmpHome })).toThrow(
      new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('mkdir -p creates parents (cwdHash + profile)', () => {
    resolveProfileSlot({ apiKey: 'sk-test', cwd: tmpHome });
    expect(fs.existsSync(path.join(tmpHome, '.agent-sdk', 'codex'))).toBe(true);
  });

  it('same cwd produces stable cwdHash across calls', () => {
    const a = slotDir(tmpHome, 'p');
    const b = slotDir(tmpHome, 'p');
    expect(a).toBe(b);
  });

  it('different cwds produce different slot dirs', () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-cwd-'));
    try {
      expect(slotDir(tmpHome, 'p')).not.toBe(slotDir(tmp2, 'p'));
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe('writeApiKeyAuth', () => {
  it('writes a single line of JSON with trailing newline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-write-'));
    try {
      const p = path.join(dir, 'auth.json');
      writeApiKeyAuth(p, 'sk-x');
      const contents = fs.readFileSync(p, 'utf8');
      expect(contents.endsWith('\n')).toBe(true);
      expect(JSON.parse(contents)).toEqual({
        auth_mode: 'ApiKey',
        OPENAI_API_KEY: 'sk-x',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('notInitializedMessage', () => {
  it('mentions both OAuth and API-key login commands', () => {
    const msg = notInitializedMessage('work', '/some/dir');
    expect(msg).toContain('codex login');
    expect(msg).toContain('--with-api-key');
    expect(msg).toContain('/some/dir');
    expect(msg).toContain("codex.login({ profile: 'work' })");
  });
});
