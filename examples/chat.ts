/**
 * Interactive CLI chat against the Claude backend.
 *
 * Each user input opens a new query passing the continuation token from the
 * previous turn — simplest model that exercises session_start, the event
 * stream, tool calls, and resume semantics.
 *
 * Usage:
 *   pnpm exec tsx examples/chat.ts
 *
 * Continuation is persisted to .chat-continuation in the current dir so
 * consecutive runs resume the same thread. Delete that file to start fresh.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { z } from 'zod';
import { Agent, claude, type Tool } from '../src/index';

const CONT_FILE = '.chat-continuation';

const tools: Tool[] = [
  { name: 'bash', description: 'Run a shell command', schema: z.object({ command: z.string() }), native: { claude: 'Bash' } },
  { name: 'read', description: 'Read a file', schema: z.object({ path: z.string() }), native: { claude: 'Read' } },
  { name: 'write', description: 'Write a file', schema: z.object({ path: z.string(), content: z.string() }), native: { claude: 'Write' } },
  { name: 'edit', description: 'Edit a file', schema: z.object({ path: z.string() }), native: { claude: 'Edit' } },
  { name: 'glob', description: 'Find files', schema: z.object({ pattern: z.string() }), native: { claude: 'Glob' } },
  { name: 'grep', description: 'Search files', schema: z.object({ pattern: z.string() }), native: { claude: 'Grep' } },
];

const agent = new Agent({
  backend: claude({
    tools,
    permissionMode: 'bypassPermissions',
  }),
});

let continuation: string | undefined = fs.existsSync(CONT_FILE)
  ? fs.readFileSync(CONT_FILE, 'utf-8').trim() || undefined
  : undefined;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

if (continuation) {
  console.log(`(resuming session ${continuation.slice(0, 8)}…)\n`);
} else {
  console.log('(new session — type "exit" to quit)\n');
}

while (true) {
  const message = (await ask('you> ')).trim();
  if (!message) continue;
  if (message === 'exit' || message === 'quit') break;

  const query = agent.run({
    message,
    ...(continuation !== undefined && { continuation }),
  });

  let assistantStarted = false;

  for await (const event of query.events) {
    switch (event.type) {
      case 'session_start':
        continuation = event.continuation;
        fs.writeFileSync(CONT_FILE, continuation);
        break;

      case 'text_end':
        if (!assistantStarted) {
          process.stdout.write('claude> ');
          assistantStarted = true;
        }
        process.stdout.write(event.text + '\n');
        break;

      case 'thinking_end':
        process.stdout.write(`\x1b[2m(thinking) ${event.text.slice(0, 100)}…\x1b[0m\n`);
        break;

      case 'tool_call_end': {
        const inputStr = JSON.stringify(event.toolCall.input);
        const truncated = inputStr.length > 100 ? inputStr.slice(0, 100) + '…' : inputStr;
        process.stdout.write(`\x1b[36m→ ${event.toolCall.name}(${truncated})\x1b[0m\n`);
        break;
      }

      case 'tool_result': {
        const out = typeof event.result.output === 'string'
          ? event.result.output
          : JSON.stringify(event.result.output);
        const truncated = out.length > 200 ? out.slice(0, 200) + '…' : out;
        const prefix = event.result.isError ? '\x1b[31m←' : '\x1b[2m←';
        process.stdout.write(`${prefix} ${truncated}\x1b[0m\n`);
        break;
      }

      case 'session_end':
        process.stdout.write(
          `\x1b[2m(in=${event.usage.input} out=${event.usage.output} stop=${event.stopReason})\x1b[0m\n\n`,
        );
        break;

      case 'error':
        process.stderr.write(`\x1b[31m[error] ${event.message}\x1b[0m\n`);
        break;
    }
  }
}

await agent.close();
rl.close();
