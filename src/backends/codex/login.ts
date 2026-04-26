/**
 * `codex.login()` — bootstrap auth for a wrapper-managed CODEX_HOME slot.
 *
 *   - apiKey path: writes the synthetic auth.json directly. No subprocess.
 *   - OAuth path: shells out to `codex login` with CODEX_HOME pointed at the
 *     slot. The codex CLI runs an interactive browser-based OAuth round-trip.
 *
 * Always overwrites any existing auth.json — the slot is wrapper-owned cache,
 * not a credential store. Re-running this is the documented way to switch
 * a profile from OAuth to API key or vice versa.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { slotDir, writeApiKeyAuth } from './profileSlot';

export interface LoginOptions {
  /**
   * Profile name. Defaults to `'default'` when `apiKey` is set; required
   * otherwise (you can't bootstrap an unnamed OAuth profile).
   */
  profile?: string;
  /**
   * OpenAI API key. When set, writes auth.json directly without running
   * `codex login`.
   */
  apiKey?: string;
  /**
   * Cwd used to derive the slot. Defaults to `process.cwd()`.
   */
  cwd?: string;
}

export interface LoginResult {
  codexHome: string;
  mode: 'oauth' | 'apiKey';
}

export async function codexLogin(opts: LoginOptions = {}): Promise<LoginResult> {
  const effectiveProfile = opts.profile ?? (opts.apiKey !== undefined ? 'default' : undefined);
  if (effectiveProfile === undefined) {
    throw new Error('codex.login: pass `profile` (for OAuth) or `apiKey` (for API key auth)');
  }

  const cwd = opts.cwd ?? process.cwd();
  const dir = slotDir(cwd, effectiveProfile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (opts.apiKey !== undefined) {
    writeApiKeyAuth(path.join(dir, 'auth.json'), opts.apiKey);
    return { codexHome: dir, mode: 'apiKey' };
  }

  const result = spawnSync('codex', ['login'], {
    stdio: 'inherit',
    env: { ...process.env, CODEX_HOME: dir },
  });

  if (result.error !== undefined) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(
        "'codex' binary not found on PATH. Install it from https://github.com/openai/codex (or `npm i -g @openai/codex` if you use the npm package).",
      );
    }
    throw err;
  }

  if (result.status !== 0) {
    throw new Error(`codex login exited with status ${result.status}`);
  }

  return { codexHome: dir, mode: 'oauth' };
}
