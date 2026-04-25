/**
 * Smoke test for the Claude backend.
 *
 * Requires either CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in env.
 * Run from repo root:
 *   pnpm exec tsx examples/claude-hello.ts
 */

import { Agent, claude, tools } from '../src/index';

const agent = new Agent({
  backend: claude({
    tools: [tools.read, tools.bash],
    permissionMode: 'bypassPermissions',
  }),
});

const query = agent.run({
  message: 'List the files in the current directory using bash, then say hi.',
});

let continuation: string | undefined;

for await (const event of query.events) {
  switch (event.type) {
    case 'session_start':
      continuation = event.continuation;
      console.log(`[session ${event.continuation}]`);
      break;
    case 'text_end':
      console.log(`\n${event.text}\n`);
      break;
    case 'thinking_end':
      console.log(`(thinking) ${event.text.slice(0, 80)}...`);
      break;
    case 'tool_call_end':
      console.log(`→ ${event.toolCall.name}(${JSON.stringify(event.toolCall.input).slice(0, 80)})`);
      break;
    case 'tool_result':
      console.log(`← ${typeof event.result.output === 'string' ? event.result.output.slice(0, 80) : '[non-string]'}${event.result.isError ? ' [error]' : ''}`);
      break;
    case 'session_end':
      console.log(
        `\n[done · stop=${event.stopReason} · in=${event.usage.input} out=${event.usage.output}]`,
      );
      break;
    case 'error':
      console.error(`[error] ${event.message}`);
      break;
  }
}

await agent.close();

if (continuation) {
  console.log(`\nContinuation token (resume with this): ${continuation}`);
}
