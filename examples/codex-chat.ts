/**
 * Interactive CLI chat against the Codex backend.
 *
 * Requires:
 *   1. `codex` CLI installed and on PATH (npm i -g @openai/codex or via brew)
 *   2. Logged in: `codex login` (ChatGPT OAuth) or `codex login --with-api-key`
 *
 * Run:
 *   pnpm exec tsx examples/codex-chat.ts
 *
 * Continuation persisted to .codex-continuation.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { Agent, codex, tools } from '../src/index';

const CONT_FILE = '.codex-continuation';

// webFetch is a Claude-only native tool. The Codex backend sees it has an
// execute() and no native.codex, so it spins up the MCP bridge + MCP
// shim subprocess, and the model can call it.
const agent = new Agent({
  backend: codex({
    tools: [tools.webFetch],
  }),
});

let continuation: string | undefined = fs.existsSync(CONT_FILE)
  ? fs.readFileSync(CONT_FILE, 'utf-8').trim() || undefined
  : undefined;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

if (continuation) {
  console.log(`(resuming thread ${continuation.slice(0, 8)}…)\n`);
} else {
  console.log('(new thread — type "exit" to quit)\n');
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
  let inThinking = false;

  for await (const event of query.events) {
    switch (event.type) {
      case 'session_start':
        continuation = event.continuation;
        fs.writeFileSync(CONT_FILE, continuation);
        break;

      case 'text_delta':
        if (!assistantStarted) {
          process.stdout.write('codex> ');
          assistantStarted = true;
        }
        if (inThinking) {
          process.stdout.write('\x1b[0m\n');
          inThinking = false;
        }
        process.stdout.write(event.delta);
        break;

      case 'text_end':
        if (assistantStarted) process.stdout.write('\n');
        break;

      case 'thinking_delta':
        if (!inThinking) {
          process.stdout.write('\x1b[2m(thinking) ');
          inThinking = true;
        }
        process.stdout.write(event.delta);
        break;

      case 'thinking_end':
        if (inThinking) {
          process.stdout.write('\x1b[0m\n');
          inThinking = false;
        }
        break;

      case 'tool_call_end': {
        const inputStr = JSON.stringify(event.toolCall.input);
        const truncated = inputStr.length > 100 ? inputStr.slice(0, 100) + '…' : inputStr;
        process.stdout.write(`\n\x1b[36m→ ${event.toolCall.name}(${truncated})\x1b[0m\n`);
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
        process.stdout.write(`\x1b[2m(stop=${event.stopReason})\x1b[0m\n\n`);
        break;

      case 'error':
        process.stderr.write(`\x1b[31m[error] ${event.message}\x1b[0m\n`);
        break;
    }
  }
}

await agent.close();
rl.close();
