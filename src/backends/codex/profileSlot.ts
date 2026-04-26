/**
 * Resolves a wrapper-managed CODEX_HOME slot for `profile` / `apiKey` auth.
 *
 * Layout: `~/.agent-sdk/codex/<cwdHash>/<profile>/`
 *   - cwdHash = sha256(realpath(cwd)).slice(0, 16) — symlink-stable
 *   - profile = literal profile name, or 'default' when only `apiKey` is set
 *
 * The dir is wrapper-owned cache, not a credential store. apiKey writes are
 * unconditional overwrites (changing modes is intentional). For OAuth, the
 * caller seeds auth.json via `codex.login()` or the equivalent shell command.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ResolveOptions {
  apiKey?: string;
  profile?: string;
  cwd?: string;
}

export interface ResolveResult {
  codexHome: string;
}

/**
 * Compute the slot dir, materialize it on disk, and ensure auth.json exists
 * (writing one for `apiKey`, throwing a copy-pasteable error for unset OAuth
 * profiles). Returns `undefined` when neither field is set — the caller
 * should fall through to ambient `~/.codex/`.
 */
export function resolveProfileSlot(opts: ResolveOptions): ResolveResult | undefined {
  const effectiveProfile = opts.profile ?? (opts.apiKey !== undefined ? 'default' : undefined);
  if (effectiveProfile === undefined) return undefined;

  const cwd = opts.cwd ?? process.cwd();
  const dir = slotDir(cwd, effectiveProfile);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const authPath = path.join(dir, 'auth.json');
  if (opts.apiKey !== undefined) {
    writeApiKeyAuth(authPath, opts.apiKey);
  } else if (!fs.existsSync(authPath)) {
    throw new Error(notInitializedMessage(effectiveProfile, dir));
  }

  return { codexHome: dir };
}

export function slotDir(cwd: string, profile: string): string {
  const realCwd = fs.realpathSync(cwd);
  const cwdHash = createHash('sha256').update(realCwd).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.agent-sdk', 'codex', cwdHash, profile);
}

export function writeApiKeyAuth(authPath: string, apiKey: string): void {
  const contents = JSON.stringify({ auth_mode: 'ApiKey', OPENAI_API_KEY: apiKey }) + '\n';
  fs.writeFileSync(authPath, contents, { mode: 0o600 });
}

export function notInitializedMessage(profile: string, dir: string): string {
  return [
    `Codex profile '${profile}' is not initialized for this project.`,
    'To set it up, run one of:',
    '',
    `  CODEX_HOME='${dir}' codex login                  # ChatGPT OAuth`,
    `  CODEX_HOME='${dir}' codex login --with-api-key   # API key`,
    '',
    `Or call codex.login({ profile: '${profile}' }) from your code.`,
  ].join('\n');
}
