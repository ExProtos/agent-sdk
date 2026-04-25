/**
 * End-to-end test of the polyfill bridge with a user-defined custom tool.
 *
 * Demonstrates:
 *   - A Tool defined inline with a real `execute()` closure
 *   - On Codex, the closure runs in *this* process (the parent), even though
 *     Codex spawns a separate MCP shim subprocess to expose the tool to the
 *     model. The bridge proxies invocations back over a Unix socket.
 *   - Native tools (tools.bash, etc.) and custom tools coexist seamlessly.
 *
 * Why `currentTime`: models don't know what time it is — the answer changes
 * with every query. A simple, useful tool that's verifiable by inspection.
 *
 * Run:
 *   pnpm exec tsx examples/codex-custom-tool.ts
 *
 * Try:
 *   you> what time is it in Tokyo?
 *   you> how many seconds until midnight UTC?
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { z } from 'zod';
import { Agent, codex, tools, type Tool } from '../src/index';

const CONT_FILE = '.codex-custom-tool-continuation';

const currentTime: Tool = {
  name: 'currentTime',
  description:
    'Get the current date and time. Optionally pass an IANA timezone (e.g. "America/Los_Angeles", "Asia/Tokyo"). Defaults to UTC.',
  schema: z.object({
    timezone: z.string().optional(),
  }),
  // No native.codex — the polyfill bridge will route invocations to this
  // execute() in the parent process.
  execute: async ({ timezone }: { timezone?: string }): Promise<string> => {
    const now = new Date();
    if (!timezone || timezone === 'UTC') {
      return `${now.toISOString()} (UTC)`;
    }
    try {
      const formatted = now.toLocaleString('en-US', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'long',
      });
      return `${formatted} (${timezone})`;
    } catch (err) {
      throw new Error(
        `Invalid timezone "${timezone}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

const agent = new Agent({
  backend: codex({
    // Mix of native tools (which fire automatically server-side) and
    // a polyfilled custom tool (which routes through the MCP bridge).
    tools: [...tools.all, currentTime],
  }),
});

// ── Chat loop ──────────────────────────────────────────────────────

let continuation: string | undefined = fs.existsSync(CONT_FILE)
  ? fs.readFileSync(CONT_FILE, 'utf-8').trim() || undefined
  : undefined;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

console.log(
  continuation
    ? `(resuming thread ${continuation.slice(0, 8)}…)\n`
    : '(new thread — type "exit" to quit)\n',
);

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
