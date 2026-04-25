export { Agent, type AgentConfig } from './agent';
export type {
  AgentEvent,
  AgentQuery,
  Backend,
  QueryInput,
  StopReason,
  TokenUsage,
  ToolCall,
  ToolResult,
} from './types';
export type { Tool, ToolResultContent } from './tools/types';
export * as tools from './tools/builtin';

export { claude, ClaudeBackend, type ClaudeBackendOptions } from './backends/claude/index';
export {
  codex,
  CodexBackend,
  type CodexBackendOptions,
} from './backends/codex/index';
