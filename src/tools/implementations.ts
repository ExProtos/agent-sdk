/**
 * In-process implementations of builtin tools.
 *
 * These are the `execute()` functions attached to Tool definitions in
 * `builtin.ts`. They run in the user's Node process when:
 *   - The Vercel AI SDK Agent backend is in use (no native tools at all)
 *   - The Codex backend is in use AND the tool has no `native.codex`
 *     (executed via the in-process MCP bridge — see ./codex/mcp-bridge.ts)
 *
 * Conventions:
 *   - Stateless (no `this`, no module-level mutable state)
 *   - Side-effects only on the local filesystem / network / shell
 *   - Match the canonical Tool's schema exactly
 *   - Throw Error on failure (the bridge surfaces these as MCP errors;
 *     Vercel surfaces them as `tool-error` parts)
 *   - Return strings for human/model legibility unless a structured value
 *     is fundamentally what the tool produces (e.g. glob → string[])
 */

import { exec as execCb } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { glob as globAsync } from 'glob';

const exec = promisify(execCb);

const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_OUTPUT_BYTES = 1_000_000; // 1 MB — matches Protos's shell tool

export async function bash({
  command,
  timeout,
}: {
  command: string;
  timeout?: number;
}): Promise<string> {
  try {
    const { stdout, stderr } = await exec(command, {
      timeout: timeout ?? DEFAULT_BASH_TIMEOUT_MS,
      maxBuffer: MAX_BASH_OUTPUT_BYTES,
      shell: '/bin/bash',
    });
    // Combine stdout + stderr in shell order. We only get them split here,
    // so concatenate with stderr last — matches what the model usually
    // expects and avoids interleaving guesswork.
    return stdout + stderr;
  } catch (err) {
    // exec() rejects on non-zero exit OR on signal/timeout. The error has
    // .stdout/.stderr/.code/.signal. Surface it as a thrown Error with the
    // captured output so the model sees what happened.
    const e = err as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
    };
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    const reason =
      e.signal === 'SIGTERM'
        ? `command timed out after ${timeout ?? DEFAULT_BASH_TIMEOUT_MS}ms`
        : `command failed with exit code ${e.code}`;
    throw new Error(`${reason}\n${out}`, { cause: err });
  }
}

export async function read({
  path: filePath,
  offset,
  limit,
}: {
  path: string;
  offset?: number;
  limit?: number;
}): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8');
  if (offset === undefined && limit === undefined) return content;
  const lines = content.split('\n');
  const start = offset ?? 0;
  const end = limit !== undefined ? start + limit : lines.length;
  return lines.slice(start, end).join('\n');
}

export async function write({
  path: filePath,
  content,
}: {
  path: string;
  content: string;
}): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${filePath}`;
}

/**
 * Edit accepts two shapes (the union schema). Find/replace is implemented;
 * unified-diff is not — we throw a clear error for the patch shape so the
 * model knows to retry with find/replace.
 */
export async function edit(
  input:
    | { path: string; old_string: string; new_string: string }
    | { patch: string },
): Promise<string> {
  if ('patch' in input) {
    throw new Error(
      'unified-diff `patch` form is not implemented in the Vercel backend; use {path, old_string, new_string}',
    );
  }
  const { path: filePath, old_string, new_string } = input;
  const content = await fs.readFile(filePath, 'utf8');
  const idx = content.indexOf(old_string);
  if (idx === -1) {
    throw new Error(`old_string not found in ${filePath}`);
  }
  if (content.indexOf(old_string, idx + 1) !== -1) {
    throw new Error(
      `old_string is not unique in ${filePath} — provide more surrounding context`,
    );
  }
  const updated = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
  await fs.writeFile(filePath, updated, 'utf8');
  return `edited ${filePath}`;
}

export async function glob({
  pattern,
  path: cwd,
}: {
  pattern: string;
  path?: string;
}): Promise<string[]> {
  const results = await globAsync(pattern, {
    cwd: cwd ?? process.cwd(),
    nodir: true,
    absolute: false,
  });
  return results.sort();
}

/**
 * grep accepts an optional `path` (a directory to search) and `glob` filter
 * (file-name filter). Returns one match per line in `file:line:text` format.
 * Skips binary files heuristically (presence of NUL byte in the first 4KB).
 */
export async function grep({
  pattern,
  path: cwd,
  glob: globFilter,
}: {
  pattern: string;
  path?: string;
  glob?: string;
}): Promise<string> {
  const re = new RegExp(pattern);
  const searchRoot = cwd ?? process.cwd();
  const filter = globFilter ?? '**/*';
  const files = await globAsync(filter, {
    cwd: searchRoot,
    nodir: true,
    absolute: false,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });

  const results: string[] = [];
  for (const file of files.sort()) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(path.join(searchRoot, file));
    } catch {
      continue;
    }
    // Heuristic: skip files with NUL in first 4KB (likely binary).
    const head = buf.subarray(0, Math.min(4096, buf.length));
    if (head.includes(0)) continue;
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        results.push(`${file}:${i + 1}:${lines[i]}`);
      }
    }
  }
  return results.join('\n');
}

export async function webFetch({ url }: { url: string }): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`webFetch failed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}
