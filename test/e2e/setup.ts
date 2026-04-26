/**
 * E2E test setup — loads `.env.test` (or whatever AGENT_SDK_ENV_FILE points
 * at) into `process.env` before tests run.
 *
 * No external dependency: this is just a minimal KEY=VALUE parser. If you
 * need fancier .env handling (multi-line, escapes), drop in `dotenv`.
 *
 * Existing env vars take precedence — so CI / explicit shell exports always
 * override the file. Useful when you want to override one variable from the
 * command line without editing the file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const envFile = process.env.AGENT_SDK_ENV_FILE ?? '.env.test';
const resolved = path.resolve(envFile);

if (fs.existsSync(resolved)) {
  const content = fs.readFileSync(resolved, 'utf-8');
  let loaded = 0;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding single or double quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
      loaded++;
    }
  }
  // Set AGENT_SDK_E2E_VERBOSE=1 to log how many env vars were loaded —
  // useful when debugging "why is this test skipping" issues, otherwise
  // just noise repeated per test file.
  if (loaded > 0 && process.env.AGENT_SDK_E2E_VERBOSE === '1') {
    console.error(`[e2e] loaded ${loaded} env var(s) from ${envFile}`);
  }
}
