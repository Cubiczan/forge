import type { AgentConfig, AgentType, ToolDefinition } from '../types/index.js';

/** Tool names each agent may call. Matches the sets documented in SCOPE.md. */
export const AGENT_TOOL_NAMES: Record<AgentType, readonly string[]> = {
  planner: ['file_read', 'search'],
  coder: ['file_read', 'file_write', 'shell_exec', 'search'],
  reviewer: ['file_read', 'search'],
  deployer: ['shell_exec', 'file_read'],
  verifier: ['http_check', 'shell_exec'],
};

/**
 * Tools advertised to the model for this agent.
 * An explicit non-empty `config.tools` list wins; otherwise the agent's
 * built-in set is taken from the executor's registry.
 */
export function resolveAgentTools(
  config: Pick<AgentConfig, 'type' | 'tools'>,
  available: ToolDefinition[],
): ToolDefinition[] {
  if (config.tools.length > 0) return config.tools;
  const allowed = new Set<string>(AGENT_TOOL_NAMES[config.type]);
  return available.filter((tool) => allowed.has(tool.name));
}

export function configWithModelAndTools(
  config: AgentConfig,
  modelId: string,
  available: ToolDefinition[],
): AgentConfig {
  const next: AgentConfig = { ...config, model: modelId };
  return { ...next, tools: resolveAgentTools(next, available) };
}
