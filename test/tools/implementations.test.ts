import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { bash, edit, glob, grep, read, write } from '../../src/tools/implementations';

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-test-'));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

// ── bash ──

describe('bash', () => {
  it('returns combined stdout/stderr on success', async () => {
    const out = await bash({ command: 'echo hello' });
    expect(out).toBe('hello\n');
  });

  it('captures stderr', async () => {
    const out = await bash({ command: 'echo to-err 1>&2' });
    expect(out).toBe('to-err\n');
  });

  it('throws on non-zero exit with combined output', async () => {
    await expect(
      bash({ command: 'echo before; echo after-err 1>&2; exit 7' }),
    ).rejects.toThrow(/exit code 7[\s\S]*before[\s\S]*after-err/);
  });

  it('honors a timeout', async () => {
    await expect(bash({ command: 'sleep 5', timeout: 200 })).rejects.toThrow(/timed out/);
  });
});

// ── read ──

describe('read', () => {
  it('reads a file', async () => {
    const f = path.join(work, 'a.txt');
    await fsp.writeFile(f, 'one\ntwo\nthree\n');
    expect(await read({ path: f })).toBe('one\ntwo\nthree\n');
  });

  it('slices by line offset and limit', async () => {
    const f = path.join(work, 'a.txt');
    await fsp.writeFile(f, 'one\ntwo\nthree\nfour\nfive\n');
    expect(await read({ path: f, offset: 1, limit: 2 })).toBe('two\nthree');
  });

  it('returns full file when only offset is given', async () => {
    const f = path.join(work, 'a.txt');
    await fsp.writeFile(f, 'one\ntwo\nthree\n');
    expect(await read({ path: f, offset: 1 })).toBe('two\nthree\n');
  });

  it('throws on missing file', async () => {
    await expect(read({ path: path.join(work, 'nope.txt') })).rejects.toThrow();
  });
});

// ── write ──

describe('write', () => {
  it('writes a file and reports byte count', async () => {
    const f = path.join(work, 'out.txt');
    const result = await write({ path: f, content: 'hello' });
    expect(result).toMatch(/wrote 5 bytes/);
    expect(await fsp.readFile(f, 'utf8')).toBe('hello');
  });

  it('overwrites existing content', async () => {
    const f = path.join(work, 'out.txt');
    await fsp.writeFile(f, 'old');
    await write({ path: f, content: 'new' });
    expect(await fsp.readFile(f, 'utf8')).toBe('new');
  });

  it('creates parent directories as needed', async () => {
    const f = path.join(work, 'a', 'b', 'c', 'out.txt');
    await write({ path: f, content: 'nested' });
    expect(await fsp.readFile(f, 'utf8')).toBe('nested');
  });
});

// ── edit ──

describe('edit', () => {
  it('replaces a unique substring', async () => {
    const f = path.join(work, 'src.txt');
    await fsp.writeFile(f, 'alpha BETA gamma');
    await edit({ path: f, old_string: 'BETA', new_string: 'beta' });
    expect(await fsp.readFile(f, 'utf8')).toBe('alpha beta gamma');
  });

  it('throws when old_string is not found', async () => {
    const f = path.join(work, 'src.txt');
    await fsp.writeFile(f, 'one two three');
    await expect(
      edit({ path: f, old_string: 'four', new_string: 'x' }),
    ).rejects.toThrow(/not found/);
  });

  it('throws when old_string is not unique', async () => {
    const f = path.join(work, 'src.txt');
    await fsp.writeFile(f, 'foo foo bar');
    await expect(
      edit({ path: f, old_string: 'foo', new_string: 'baz' }),
    ).rejects.toThrow(/not unique/);
  });

  it('throws on the patch shape (not implemented)', async () => {
    await expect(edit({ patch: '--- a\n+++ b\n@@ ...' })).rejects.toThrow(/not implemented/);
  });
});

// ── glob ──

describe('glob', () => {
  it('returns matching files relative to cwd, sorted', async () => {
    await fsp.mkdir(path.join(work, 'src'), { recursive: true });
    await fsp.writeFile(path.join(work, 'src', 'a.ts'), '');
    await fsp.writeFile(path.join(work, 'src', 'b.ts'), '');
    await fsp.writeFile(path.join(work, 'src', 'c.js'), '');
    const result = await glob({ pattern: 'src/*.ts', path: work });
    expect(result).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('handles ** recursive patterns', async () => {
    await fsp.mkdir(path.join(work, 'a', 'b'), { recursive: true });
    await fsp.writeFile(path.join(work, 'top.ts'), '');
    await fsp.writeFile(path.join(work, 'a', 'mid.ts'), '');
    await fsp.writeFile(path.join(work, 'a', 'b', 'deep.ts'), '');
    const result = await glob({ pattern: '**/*.ts', path: work });
    expect(result).toEqual(['a/b/deep.ts', 'a/mid.ts', 'top.ts']);
  });

  it('returns [] on no matches', async () => {
    expect(await glob({ pattern: '*.nope', path: work })).toEqual([]);
  });
});

// ── grep ──

describe('grep', () => {
  it('returns file:line:text for each match', async () => {
    await fsp.writeFile(path.join(work, 'a.txt'), 'foo\nbar\nfoo again\n');
    await fsp.writeFile(path.join(work, 'b.txt'), 'no match here\n');
    const result = await grep({ pattern: 'foo', path: work });
    expect(result).toContain('a.txt:1:foo');
    expect(result).toContain('a.txt:3:foo again');
    expect(result).not.toContain('b.txt');
  });

  it('honors the glob filter', async () => {
    await fsp.writeFile(path.join(work, 'a.ts'), 'pattern');
    await fsp.writeFile(path.join(work, 'b.md'), 'pattern');
    const result = await grep({ pattern: 'pattern', path: work, glob: '*.ts' });
    expect(result).toContain('a.ts:1:');
    expect(result).not.toContain('b.md');
  });

  it('skips binary files (NUL byte heuristic)', async () => {
    await fsp.writeFile(
      path.join(work, 'binary.bin'),
      Buffer.concat([Buffer.from('header\0'), Buffer.from('searchme more')]),
    );
    await fsp.writeFile(path.join(work, 'text.txt'), 'searchme here');
    const result = await grep({ pattern: 'searchme', path: work });
    expect(result).toContain('text.txt:1:');
    expect(result).not.toContain('binary.bin');
  });

  it('returns empty string on no matches', async () => {
    await fsp.writeFile(path.join(work, 'a.txt'), 'nothing here');
    expect(await grep({ pattern: 'absent', path: work })).toBe('');
  });

  it('skips node_modules and .git by default', async () => {
    await fsp.mkdir(path.join(work, 'node_modules', 'pkg'), { recursive: true });
    await fsp.writeFile(path.join(work, 'node_modules', 'pkg', 'x.ts'), 'needle');
    await fsp.writeFile(path.join(work, 'src.ts'), 'needle');
    const result = await grep({ pattern: 'needle', path: work });
    expect(result).toContain('src.ts:1:');
    expect(result).not.toContain('node_modules');
  });
});
