import { describe, expect, it } from 'vitest';
import {
  all,
  applyPatch,
  bash,
  edit,
  glob,
  grep,
  read,
  webFetch,
  webSearch,
  write,
} from '../../src/tools/builtin';
import type { Tool } from '../../src/tools/types';

describe('builtin tools', () => {
  it('all is the canonical 9-tool set', () => {
    expect(all).toEqual([bash, read, write, edit, applyPatch, glob, grep, webFetch, webSearch]);
    expect(all).toHaveLength(9);
  });

  it('every tool has unique name', () => {
    const names = all.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool has a non-empty description', () => {
    for (const tool of all) {
      expect(tool.description, `${tool.name} has empty description`).toBeTruthy();
      expect(tool.description.length, `${tool.name} description too short`).toBeGreaterThan(10);
    }
  });

  it('only tools with deliberate polyfills ship execute()', () => {
    const expectedExecutes = new Set(['webFetch']);
    for (const tool of all) {
      const has = typeof tool.execute === 'function';
      const expected = expectedExecutes.has(tool.name);
      expect(has, `${tool.name}: execute() ${expected ? 'expected' : 'unexpected'}`).toBe(expected);
    }
  });
});

describe('native tool mappings', () => {
  // What's mapped on each backend, asserted explicitly so changes are loud.
  const expectedClaude: Record<string, string | undefined> = {
    bash: 'Bash',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    glob: 'Glob',
    grep: 'Grep',
    webFetch: 'WebFetch',
    webSearch: 'WebSearch',
    // applyPatch intentionally unmapped on Claude
  };
  const expectedCodex: Record<string, string | undefined> = {
    bash: 'command/exec',
    read: 'fs/readFile',
    write: 'fs/writeFile',
    applyPatch: 'apply_patch',
    glob: 'command/exec', // Codex's model uses bash for file finding
    grep: 'command/exec', // Codex's model uses bash/rg for content search
    webFetch: 'webSearch', // Codex's openPage action subsumes webFetch
    webSearch: 'webSearch',
    // edit intentionally unmapped on Codex (use applyPatch for unified-diff)
  };

  it.each(all)('$name has the expected native.claude mapping', (tool: Tool) => {
    expect(tool.native?.claude).toBe(expectedClaude[tool.name]);
  });

  it.each(all)('$name has the expected native.codex mapping', (tool: Tool) => {
    expect(tool.native?.codex).toBe(expectedCodex[tool.name]);
  });
});

describe('schema validation', () => {
  it('bash accepts {command} and rejects non-string', () => {
    expect(bash.schema.safeParse({ command: 'ls' }).success).toBe(true);
    expect(bash.schema.safeParse({ command: 'ls', timeout: 5000 }).success).toBe(true);
    expect(bash.schema.safeParse({ command: 42 }).success).toBe(false);
    expect(bash.schema.safeParse({}).success).toBe(false);
  });

  it('read accepts {path} and optional offset/limit', () => {
    expect(read.schema.safeParse({ path: '/etc/hosts' }).success).toBe(true);
    expect(read.schema.safeParse({ path: '/etc/hosts', offset: 0, limit: 100 }).success).toBe(true);
    expect(read.schema.safeParse({}).success).toBe(false);
  });

  it('write requires both path and content', () => {
    expect(write.schema.safeParse({ path: '/tmp/x', content: 'hi' }).success).toBe(true);
    expect(write.schema.safeParse({ path: '/tmp/x' }).success).toBe(false);
    expect(write.schema.safeParse({ content: 'hi' }).success).toBe(false);
  });

  it('edit requires path, old_string, new_string', () => {
    expect(edit.schema.safeParse({ path: '/x', old_string: 'a', new_string: 'b' }).success).toBe(true);
    expect(edit.schema.safeParse({ path: '/x' }).success).toBe(false);
  });

  it('glob requires pattern, path optional', () => {
    expect(glob.schema.safeParse({ pattern: '**/*.ts' }).success).toBe(true);
    expect(glob.schema.safeParse({ pattern: '**/*.ts', path: '/src' }).success).toBe(true);
    expect(glob.schema.safeParse({}).success).toBe(false);
  });

  it('grep requires pattern, path/glob optional', () => {
    expect(grep.schema.safeParse({ pattern: 'foo' }).success).toBe(true);
    expect(grep.schema.safeParse({ pattern: 'foo', path: '/src', glob: '*.ts' }).success).toBe(true);
    expect(grep.schema.safeParse({}).success).toBe(false);
  });

  it('webFetch requires a URL', () => {
    expect(webFetch.schema.safeParse({ url: 'https://example.com' }).success).toBe(true);
    expect(webFetch.schema.safeParse({ url: 'not a url' }).success).toBe(false);
    expect(webFetch.schema.safeParse({}).success).toBe(false);
  });

  it('webSearch requires query', () => {
    expect(webSearch.schema.safeParse({ query: 'rust async runtimes' }).success).toBe(true);
    expect(webSearch.schema.safeParse({}).success).toBe(false);
  });

  it('applyPatch requires patch string', () => {
    expect(applyPatch.schema.safeParse({ patch: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n' }).success).toBe(true);
    expect(applyPatch.schema.safeParse({}).success).toBe(false);
    expect(applyPatch.schema.safeParse({ patch: 42 }).success).toBe(false);
  });
});

describe('Tool type guarantees', () => {
  it('every tool can be passed where a Tool is expected', () => {
    const list: Tool[] = [bash, read, write, edit, applyPatch, glob, grep, webFetch, webSearch];
    expect(list.length).toBe(9);
  });
});
