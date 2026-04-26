import { describe, expect, it } from 'vitest';
import {
  all,
  bash,
  edit,
  glob,
  grep,
  read,
  task,
  todo,
  webFetch,
  webSearch,
  withImpls,
  write,
} from '../../src/tools/builtin';
import type { Tool } from '../../src/tools/types';

describe('builtin tools', () => {
  it('all is the canonical 10-tool set', () => {
    expect(all).toEqual([bash, read, write, edit, glob, grep, webFetch, webSearch, todo, task]);
    expect(all).toHaveLength(10);
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

  it('only tools with intentional implementations ship execute()', () => {
    // Tools with in-process implementations (used by the Vercel backend
    // and by Codex's MCP bridge for tools that lack a `native.codex`).
    // webSearch needs an external API + key, todo and task have no clean
    // out-of-backend semantics, so they stay execute-less for now.
    const expectedExecutes = new Set([
      'bash', 'read', 'write', 'edit', 'glob', 'grep', 'webFetch',
    ]);
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
    todo: 'TodoWrite',
    task: 'Task',
  };
  const expectedCodex: Record<string, string | undefined> = {
    bash: 'command/exec',
    read: 'fs/readFile',
    write: 'fs/writeFile',
    edit: 'apply_patch',
    glob: 'command/exec',
    grep: 'command/exec',
    webFetch: 'webSearch',
    webSearch: 'webSearch',
    todo: 'plan',
    task: 'collabAgentToolCall',
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

  it('edit accepts the find/replace shape', () => {
    expect(edit.schema.safeParse({ path: '/x', old_string: 'a', new_string: 'b' }).success).toBe(true);
  });

  it('edit accepts the unified-diff shape', () => {
    expect(edit.schema.safeParse({ patch: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n' }).success).toBe(true);
  });

  it('edit rejects partial find/replace shape', () => {
    expect(edit.schema.safeParse({ path: '/x' }).success).toBe(false);
    expect(edit.schema.safeParse({ path: '/x', old_string: 'a' }).success).toBe(false);
  });

  it('edit rejects unrelated shapes', () => {
    expect(edit.schema.safeParse({}).success).toBe(false);
    expect(edit.schema.safeParse({ random: 'thing' }).success).toBe(false);
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

  it('todo accepts the structured todos shape', () => {
    expect(
      todo.schema.safeParse({
        todos: [
          { content: 'do thing', status: 'pending', activeForm: 'Doing thing' },
          { content: 'finished', status: 'completed', activeForm: 'Finishing' },
        ],
      }).success,
    ).toBe(true);
  });

  it('todo accepts the freeform text shape', () => {
    expect(todo.schema.safeParse({ text: 'step 1\nstep 2\n' }).success).toBe(true);
  });

  it('todo rejects unknown status values', () => {
    expect(
      todo.schema.safeParse({
        todos: [{ content: 'x', status: 'wat', activeForm: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('todo rejects unrelated shapes', () => {
    expect(todo.schema.safeParse({}).success).toBe(false);
    expect(todo.schema.safeParse({ random: 'thing' }).success).toBe(false);
  });

  it('task accepts the Claude one-shot shape', () => {
    expect(
      task.schema.safeParse({
        description: 'Find TODOs',
        prompt: 'Search src/ for TODO comments and summarize.',
        subagent_type: 'general-purpose',
      }).success,
    ).toBe(true);
  });

  it('task accepts the Codex collab shape (spawn)', () => {
    expect(
      task.schema.safeParse({
        tool: 'spawnAgent',
        prompt: 'Investigate this',
        model: 'gpt-5',
        receiverThreadIds: ['abc'],
      }).success,
    ).toBe(true);
  });

  it('task accepts collab shape with only `tool`', () => {
    expect(task.schema.safeParse({ tool: 'wait' }).success).toBe(true);
    expect(task.schema.safeParse({ tool: 'closeAgent' }).success).toBe(true);
  });

  it('task rejects unknown collab tool values', () => {
    expect(task.schema.safeParse({ tool: 'destroyAgent' }).success).toBe(false);
  });

  it('task rejects unrelated shapes', () => {
    expect(task.schema.safeParse({}).success).toBe(false);
    expect(task.schema.safeParse({ random: 'thing' }).success).toBe(false);
  });

});

describe('Tool type guarantees', () => {
  it('every tool can be passed where a Tool is expected', () => {
    const list: Tool[] = [bash, read, write, edit, glob, grep, webFetch, webSearch, todo, task];
    expect(list.length).toBe(10);
  });
});

describe('withImpls', () => {
  it('replaces execute on the named tool, leaves others untouched', () => {
    const myFetch = async ({ url }: { url: string }) => `body of ${url}`;
    const result = withImpls(all, { webFetch: myFetch });

    const overridden = result.find((t) => t.name === 'webFetch')!;
    expect(overridden.execute).toBe(myFetch);
    // Schema and other fields preserved.
    expect(overridden.schema).toBe(webFetch.schema);
    expect(overridden.description).toBe(webFetch.description);
    expect(overridden.native).toEqual(webFetch.native);

    // Other tools untouched (same object reference, since we only clone
    // entries that get an override).
    expect(result.find((t) => t.name === 'bash')).toBe(bash);
    expect(result.find((t) => t.name === 'read')).toBe(read);
  });

  it('plugs execute into a tool that ships without one (webSearch)', () => {
    const mySearch = async ({ query }: { query: string }) => `results for ${query}`;
    const result = withImpls(all, { webSearch: mySearch });
    const ws = result.find((t) => t.name === 'webSearch')!;
    expect(ws.execute).toBe(mySearch);
  });

  it('does not mutate the input array', () => {
    const before = all.map((t) => t.execute);
    withImpls(all, { webFetch: async () => 'x' });
    const after = all.map((t) => t.execute);
    expect(after).toEqual(before);
  });

  it('throws on an unknown tool name', () => {
    expect(() => withImpls(all, { not_a_tool: async () => '' })).toThrow(/no tool named 'not_a_tool'/);
  });

  it('lists known tool names in the error', () => {
    expect(() => withImpls(all, { typo: async () => '' })).toThrow(/bash, read, write/);
  });

  it('returns the array unchanged when overrides is empty', () => {
    const result = withImpls(all, {});
    expect(result).toEqual(all);
  });

  it('handles multiple overrides at once', () => {
    const a = async () => 'a';
    const b = async () => 'b';
    const result = withImpls(all, { webFetch: a, webSearch: b });
    expect(result.find((t) => t.name === 'webFetch')!.execute).toBe(a);
    expect(result.find((t) => t.name === 'webSearch')!.execute).toBe(b);
  });
});
