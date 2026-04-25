import type { AgentEvent, AgentQuery, Backend, QueryInput } from './types.js';

export interface AgentConfig {
  backend: Backend;
}

/**
 * Public entry point. Wraps a chosen Backend. The Backend owns the agent loop
 * and tool registry; this class is a thin router. We may grow it (logging,
 * retries, multiplexing across backends) — for now it's just a stable handle.
 */
export class Agent {
  readonly backend: Backend;

  constructor(config: AgentConfig) {
    this.backend = config.backend;
  }

  run(input: QueryInput): AgentQuery {
    return this.backend.query(input);
  }

  async close(): Promise<void> {
    await this.backend.close?.();
  }
}

export type { AgentEvent, AgentQuery, Backend, QueryInput };
