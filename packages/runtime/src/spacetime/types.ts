// ---------------------------------------------------------------------------
// SpacetimeDB table row types — mirrors the Rust module schema.
//
// These are the **database row** types as received from SpacetimeDB subscriptions
// and API responses. They differ slightly from the domain types in
// `../types/index.ts` (e.g. they use `u64` auto-inc IDs from SpacetimeDB and
// store JSON blobs as strings).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AgentRuns
// ---------------------------------------------------------------------------

export interface AgentRunsRow {
  /** SpacetimeDB internal auto-increment ID. */
  id: number;
  pipelineId: string;
  agentName: string;
  agentVersion: string;
  modelProvider: string;
  modelId: string;
  inputSummary: string;
  outputSummary: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** "running" | "success" | "error" | "rejected" */
  status: string;
  errorMessage: string | null;
  startedAt: number;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

export interface DeploymentsRow {
  id: number;
  pipelineId: string;
  targetType: string;
  targetConfigJson: string;
  /** "pending" | "building" | "deploying" | "live" | "rolled_back" | "failed" */
  status: string;
  commitSha: string | null;
  startedAt: number;
  completedAt: number | null;
  healthCheckUrl: string | null;
  rollbackReason: string | null;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export interface FeedbackRow {
  id: number;
  deploymentId: string;
  agentRunId: string;
  /** "auto_verify" | "manual_review" | "monitoring_alert" | "user_report" */
  feedbackType: string;
  /** "success" | "partial" | "failure" */
  outcome: string;
  /** 0.0 – 1.0 */
  score: number;
  signalDataJson: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// AgentVersions
// ---------------------------------------------------------------------------

export interface AgentVersionsRow {
  id: number;
  agentName: string;
  version: string;
  configJson: string;
  createdAt: number;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// RoutingWeights
// ---------------------------------------------------------------------------

export interface RoutingWeightsRow {
  id: number;
  agentType: string;
  provider: string;
  modelId: string;
  weight: number;
  successRate: number;
  sampleCount: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Reducer argument types (sent to SpacetimeDB reducers)
// ---------------------------------------------------------------------------

export interface RecordAgentRunInput {
  id: string;
  pipelineId: string;
  agentName: string;
  agentVersion: string;
  modelProvider: string;
  modelId: string;
  inputSummary: string;
  outputSummary: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  status: string;
  errorMessage?: string | null;
  startedAt: number;
  completedAt?: number | null;
}

export interface RecordDeploymentInput {
  id: string;
  pipelineId: string;
  targetType: string;
  targetConfigJson: string;
  status: string;
  commitSha?: string | null;
  startedAt: number;
  completedAt?: number | null;
  healthCheckUrl?: string | null;
  rollbackReason?: string | null;
}

export interface SubmitFeedbackInput {
  deploymentId: string;
  agentRunId: string;
  feedbackType: string;
  outcome: string;
  score: number;
  signalDataJson: string;
}

export interface UpdateRoutingWeightInput {
  agentType: string;
  provider: string;
  modelId: string;
  weight: number;
}

// ---------------------------------------------------------------------------
// Reducer return types
// ---------------------------------------------------------------------------

export interface AgentStats {
  totalRuns: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number;
  avgTokensIn: number;
  avgTokensOut: number;
  successRate: number;
}

// ---------------------------------------------------------------------------
// All table names for convenience
// ---------------------------------------------------------------------------

export const SPACETIME_TABLES = [
  'agent_runs',
  'deployments',
  'feedback',
  'agent_versions',
  'routing_weights',
] as const;

export type SpacetimeTableName = (typeof SPACETIME_TABLES)[number];