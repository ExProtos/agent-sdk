import type { AgentEvent, AgentQuery, Backend, QueryInput } from './types.js';
import type { Tool } from './tools/types.js';

export interface AgentConfig {
  backend: Backend;
  tools?: Tool[];
}

/**
 * Public entry point. Wraps a chosen Backend. The Backend owns the agent loop;
 * this class is just a thin router from caller → backend, plus tool registry.
 */
export class Agent {
  readonly backend: Backend;
  readonly tools: Tool[];

  constructor(config: AgentConfig) {
    this.backend = config.backend;
    this.tools = config.tools ?? [];
  }

  run(input: QueryInput): AgentQuery {
    return this.backend.query(input);
  }

  async close(): Promise<void> {
    await this.backend.close?.();
  }
}

export type { AgentEvent, AgentQuery, Backend, QueryInput, Tool };
