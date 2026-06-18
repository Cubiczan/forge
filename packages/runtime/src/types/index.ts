// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  id: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

export interface PipelineNode {
  id: string;
  agentType: AgentType;
  config: AgentConfig;
  maxRetries: number;
  timeoutMs: number;
}

export interface PipelineEdge {
  from: string;
  to: string;
  condition?: EdgeCondition;
}

export type EdgeCondition = 'pass' | 'fail' | 'always';

export type AgentType = 'planner' | 'coder' | 'reviewer' | 'deployer' | 'verifier';

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

export interface AgentConfig {
  name: string;
  type: AgentType;
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  tools: ToolDefinition[];
  maxReviewRounds?: number;
}

export interface AgentRun {
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
  status: AgentRunStatus;
  errorMessage?: string;
  startedAt: number;
  completedAt?: number;
}

export type AgentRunStatus = 'running' | 'success' | 'error' | 'rejected';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  handler: string; // tool handler key
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: unknown;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

export interface ModelRoute {
  provider: ModelProvider;
  modelId: string;
  weight: number;
}

export type ModelProvider = 'anthropic' | 'openai';

export interface RoutingDecision {
  provider: ModelProvider;
  modelId: string;
  taskType: AgentType;
  reason: string;
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

export interface Deployment {
  id: string;
  pipelineId: string;
  targetType: string;
  targetConfig: Record<string, unknown>;
  status: DeploymentStatus;
  commitSha?: string;
  startedAt: number;
  completedAt?: number;
  healthCheckUrl?: string;
  rollbackReason?: string;
}

export type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'live' | 'rolled_back' | 'failed';

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export interface FeedbackEntry {
  id: string;
  deploymentId: string;
  agentRunId: string;
  feedbackType: FeedbackType;
  outcome: FeedbackOutcome;
  score: number;
  signalData: Record<string, unknown>;
  createdAt: number;
}

export type FeedbackType = 'auto_verify' | 'manual_review' | 'monitoring_alert' | 'user_report';
export type FeedbackOutcome = 'success' | 'partial' | 'failure';

// ---------------------------------------------------------------------------
// Forge config (forge.yaml)
// ---------------------------------------------------------------------------

export interface ForgeConfig {
  name: string;
  language: string;
  agents: Record<AgentType, AgentForgeConfig>;
  deploy: DeployConfig;
  runtime: RuntimeConfig;
  spacetime?: SpacetimeConfig;
}

export interface AgentForgeConfig {
  model: string;
  max_tokens: number;
  temperature: number;
  max_review_rounds?: number;
}

export interface DeployConfig {
  target: string;
  config: Record<string, string>;
}

export interface RuntimeConfig {
  max_pipeline_duration_ms: number;
  max_agent_tokens: number;
  max_shell_commands: number;
  allowed_shell_commands: string[];
}

export interface SpacetimeConfig {
  host: string;
  database: string;
}

// ---------------------------------------------------------------------------
// Pipeline execution context passed between agents
// ---------------------------------------------------------------------------

export interface PipelineContext {
  pipelineId: string;
  userRequest: string;
  plan?: PlanOutput;
  codeChanges?: CodeOutput;
  reviewResult?: ReviewOutput;
  deploymentResult?: Deployment;
  verificationResult?: VerificationOutput;
  agentRuns: AgentRun[];
  errors: PipelineError[];
  metadata: Record<string, unknown>;
}

export interface PlanOutput {
  tasks: string[];
  approach: string;
  filesToModify: string[];
  filesToCreate: string[];
}

export interface CodeOutput {
  filesChanged: FileChange[];
  summary: string;
}

export interface FileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  content?: string;
  diff?: string;
}

export interface ReviewOutput {
  approved: boolean;
  issues: ReviewIssue[];
  summary: string;
  round: number;
}

export interface ReviewIssue {
  severity: 'error' | 'warning' | 'info';
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface VerificationOutput {
  passed: boolean;
  checks: VerificationCheck[];
  summary: string;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface PipelineError {
  agentName: string;
  stage: string;
  message: string;
  recoverable: boolean;
}