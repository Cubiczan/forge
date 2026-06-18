// ---------------------------------------------------------------------------
// SpacetimeDB module — barrel export
// ---------------------------------------------------------------------------

export {
  SpacetimeDBClient,
  SpacetimeFeedbackStore,
  createSpacetimeFeedbackStore,
} from './client.js';

export type {
  SpacetimeDBConnectionConfig,
} from './client.js';

export type {
  AgentRunsRow,
  DeploymentsRow,
  FeedbackRow,
  AgentVersionsRow,
  RoutingWeightsRow,
  RecordAgentRunInput,
  RecordDeploymentInput,
  SubmitFeedbackInput,
  UpdateRoutingWeightInput,
  AgentStats,
  SpacetimeTableName,
} from './types.js';

export { SPACETIME_TABLES } from './types.js';