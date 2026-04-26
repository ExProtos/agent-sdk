/**
 * Interactive CLI chat against the Vercel backend, wired to Anthropic via
 * @ai-sdk/anthropic. Mirrors examples/chat.ts (which targets the Claude
 * backend) so you can compare the two side by side.
 *
 * Usage:
 *   pnpm exec tsx examples/vercel-chat.ts
 *
 * Auth:
 *   ANTHROPIC_API_KEY must be set. (The Claude OAuth token is Claude-Code
 *   specific and isn't accepted by @ai-sdk/anthropic.)
 *
 * Persistence:
 *   The Vercel backend auto-persists conversation history as
 *   `<cwd>/.agent-sdk/sessions/<continuation>.jsonl`, so we only need to
 *   remember the continuation token across runs. Saved to .vercel-chat-
 *   continuation; delete it to start fresh.
 *
 * Switch providers by swapping the `model` line — every other line stays
 * the same. e.g.:
 *   import { openai } from '@ai-sdk/openai';
 *   model: openai('gpt-5'),
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { anthropic } from '@ai-sdk/anthropic';
import { Agent, vercel, tools } from '../src/index';

const CONT_FILE = '.vercel-chat-continuation';

const agent = new Agent({
  backend: vercel({
    model: anthropic('claude-sonnet-4-5'),
    tools: tools.all,
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

      case 'text_delta':
        if (!assistantStarted) {
          process.stdout.write('vercel> ');
          assistantStarted = true;
        }
        process.stdout.write(event.delta);
        break;

      case 'text_end':
        if (assistantStarted) process.stdout.write('\n');
        assistantStarted = false;
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
        const out =
          typeof event.result.output === 'string'
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
