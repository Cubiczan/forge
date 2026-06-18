// ---------------------------------------------------------------------------
// Forge Runtime — barrel export
// ---------------------------------------------------------------------------
//
// This is the single entry-point for all consumers of the `@forge/runtime`
// package.

// Types
export type * from './types/index.js';

// Agents
export {
  BaseAgent,
  CoderAgent,
  ReviewerAgent,
  PlannerAgent,
  DeployerAgent,
  VerifierAgent,
  type Message,
  type ModelResponse,
  type ToolCall,
  type ToolExecutor,
  type ToolResult,
  type ModelClientFn,
} from './agents/index.js';

// Pipeline
export { PipelineEngine, createDefaultPipeline } from './pipeline/index.js';

// Router
export { ModelRouter } from './router/index.js';

// Tools
export { ToolExecutorImpl } from './tools/index.js';
export type { ToolExecutor as ToolExecutorInterface } from './tools/index.js';

// Feedback
export { FeedbackStore } from './feedback/index.js';

// SpacetimeDB (drop-in persistent replacement for FeedbackStore)
export {
  SpacetimeDBClient,
  SpacetimeFeedbackStore,
  createSpacetimeFeedbackStore,
  SPACETIME_TABLES,
} from './spacetime/index.js';
export type {
  SpacetimeDBConnectionConfig,
  AgentRunsRow,
  DeploymentsRow,
  FeedbackRow,
  AgentVersionsRow,
  RoutingWeightsRow,
  RecordAgentRunInput,
  RecordDeploymentInput,
  SubmitFeedbackInput,
  UpdateRoutingWeightInput,
  AgentStats as SpacetimeAgentStats,
  SpacetimeTableName,
} from './spacetime/index.js';

// Config
export { loadForgeConfig, getExampleConfigPath } from './config/index.js';

// Durable Pipeline (Workflow SDK integration)
export {
  DurablePipeline,
  createDurablePipeline,
  type DurableStepInput,
  type DurableStepOutput,
  type DurablePipelineResult,
} from './durable/index.js';