/**
 * Polyfill implementations for builtin tools.
 *
 * These are the `execute()` functions that get attached to Tool definitions
 * in `builtin.ts`. They run in the user's Node process when:
 *   - The Vercel AI SDK Agent backend is in use (no native tools at all)
 *   - The Codex backend is in use AND the tool has no `native.codex`
 *     (executed via the in-process MCP shim — see ./codex/polyfill-bridge.ts)
 *
 * Polyfills should be:
 *   - Stateless (closures over module scope only — no `this`)
 *   - Side-effecting only on the local filesystem / network
 *   - Match the canonical Tool's schema exactly
 *   - Throw Error on failure (the bridge will surface as an MCP error)
 */

export async function webFetch({ url }: { url: string }): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`webFetch failed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}
