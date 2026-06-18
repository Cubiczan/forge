import type {
  AgentRun,
  AgentType,
  Deployment,
  FeedbackEntry,
  FeedbackOutcome,
  FeedbackType,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// SpacetimeDB Configuration
// ---------------------------------------------------------------------------

const SPACETIMEDB_HOST = process.env.SPACETIMEDB_HOST || 'https://spacetimedb.com';
const SPACETIMEDB_DATABASE = process.env.SPACETIMEDB_DATABASE || '@sam/forge-7d0qe';

// ---------------------------------------------------------------------------
// SpacetimeDB HTTP API helpers
// ---------------------------------------------------------------------------

/**
 * Call a SpacetimeDB reducer via HTTP.
 *
 * SpacetimeDB exposes reducers at:
 *   POST https://<host>/<database>/reducer/<ReducerName>
 *
 * The body is the reducer argument (JSON).
 */
async function callReducer<T = unknown>(
  reducerName: string,
  arg: unknown
): Promise<T> {
  const url = `${SPACETIMEDB_HOST}/${SPACETIMEDB_DATABASE}/reducer/${reducerName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(arg),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown');
    throw new Error(
      `SpacetimeDB reducer "${reducerName}" failed (${res.status}): ${text}`
    );
  }

  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}

/**
 * Run a SQL query against SpacetimeDB via HTTP.
 *
 * GET https://<host>/<database>/sql?query=<encoded-sql>
 */
async function sqlQuery<T = Record<string, unknown>>(
  sql: string
): Promise<T[]> {
  const url = `${SPACETIMEDB_HOST}/${SPACETIMEDB_DATABASE}/sql?query=${encodeURIComponent(sql)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown');
    throw new Error(`SpacetimeDB SQL query failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  // The API returns { sql_error?: ..., rows?: T[] }
  if (data.sql_error) {
    throw new Error(`SpacetimeDB SQL error: ${data.sql_error}`);
  }
  return (data.rows ?? []) as T[];
}

// ---------------------------------------------------------------------------
// SpacetimeDB row types (mirror the Rust schema)
// ---------------------------------------------------------------------------

interface StdbAgentRun {
  id: number;
  run_id: string;
  pipeline_id: string;
  agent_name: string;
  agent_version: string;
  model_provider: string;
  model_id: string;
  input_summary: string;
  output_summary: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  status: string;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
}

interface StdbFeedback {
  id: number;
  deployment_id: string;
  agent_run_id: string;
  feedback_type: string;
  outcome: string;
  score: number;
  signal_data_json: string;
  created_at: number;
}

interface StdbRoutingWeight {
  id: number;
  agent_type: string;
  provider: string;
  model_id: string;
  weight: number;
  success_rate: number;
  sample_count: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// FeedbackStore — SpacetimeDB-backed implementation
// ---------------------------------------------------------------------------

/**
 * Records and retrieves deployment feedback.
 *
 * Persists all data to SpacetimeDB (`@sam/forge-7d0qe`).
 * The in-memory maps serve as a local read cache and fallback
 * when the SpacetimeDB HTTP API is unavailable.
 */
export class FeedbackStore {
  /** Local read cache (populated from SpacetimeDB on read) */
  private entries = new Map<string, FeedbackEntry>();
  private agentRuns = new Map<string, AgentRun>();
  private deployments = new Map<string, Deployment>();

  // -- Writers (persist to SpacetimeDB) ----------------------------------------

  /** Record an agent run — persists via the `record_agent_run` reducer. */
  async recordAgentRun(run: AgentRun): Promise<void> {
    this.agentRuns.set(run.id, run);

    try {
      await callReducer('record_agent_run', {
        run_id: run.id,
        pipeline_id: run.pipelineId,
        agent_name: run.agentName,
        agent_version: run.agentVersion,
        model_provider: run.modelProvider,
        model_id: run.modelId,
        input_summary: run.inputSummary,
        output_summary: run.outputSummary,
        tokens_in: run.tokensIn,
        tokens_out: run.tokensOut,
        latency_ms: run.latencyMs,
        status: run.status,
        error_message: run.errorMessage ?? null,
        started_at: run.startedAt,
        completed_at: run.completedAt ?? null,
      });
    } catch (err) {
      // Log but don't throw — local cache is the fallback.
      console.warn(`[FeedbackStore] Failed to persist agent run: ${err}`);
    }
  }

  /** Record a deployment — persists via the `record_deployment` reducer. */
  async recordDeployment(deployment: Deployment): Promise<void> {
    this.deployments.set(deployment.id, deployment);

    try {
      await callReducer('record_deployment', {
        deployment_id: deployment.id,
        pipeline_id: deployment.pipelineId,
        target_type: deployment.targetType,
        target_config_json: JSON.stringify(deployment.targetConfig),
        status: deployment.status,
        commit_sha: deployment.commitSha ?? null,
        started_at: deployment.startedAt,
        completed_at: deployment.completedAt ?? null,
        health_check_url: deployment.healthCheckUrl ?? null,
        rollback_reason: deployment.rollbackReason ?? null,
      });
    } catch (err) {
      console.warn(`[FeedbackStore] Failed to persist deployment: ${err}`);
    }
  }

  /**
   * Submit feedback — persists via the `submit_feedback` reducer.
   *
   * The reducer also auto-updates routing weights in the database,
   * so the self-improvement flywheel is fully server-side.
   */
  async submitFeedback(params: {
    deploymentId: string;
    agentRunId: string;
    feedbackType: FeedbackType;
    outcome: FeedbackOutcome;
    score: number;
    signalData: Record<string, unknown>;
  }): Promise<FeedbackEntry> {
    const entry: FeedbackEntry = {
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      deploymentId: params.deploymentId,
      agentRunId: params.agentRunId,
      feedbackType: params.feedbackType,
      outcome: params.outcome,
      score: params.score,
      signalData: params.signalData,
      createdAt: Date.now(),
    };

    this.entries.set(entry.id, entry);

    try {
      await callReducer('submit_feedback', {
        deployment_id: params.deploymentId,
        agent_run_id: params.agentRunId,
        feedback_type: params.feedbackType,
        outcome: params.outcome,
        score: params.score,
        signal_data_json: JSON.stringify(params.signalData),
      });
    } catch (err) {
      console.warn(`[FeedbackStore] Failed to persist feedback: ${err}`);
    }

    return entry;
  }

  // -- Readers (local cache first, SpacetimeDB fallback) ----------------------

  /** Get all feedback entries for a specific deployment. */
  getFeedbackForDeployment(deploymentId: string): FeedbackEntry[] {
    return [...this.entries.values()].filter(
      (e) => e.deploymentId === deploymentId,
    );
  }

  /** Get every feedback entry (used by the router to update weights). */
  getAllFeedback(): FeedbackEntry[] {
    return [...this.entries.values()];
  }

  /** Get feedback entries correlated with a specific agent type. */
  getFeedbackForAgent(agentType: AgentType): FeedbackEntry[] {
    return [...this.entries.values()].filter((e) => {
      const run = this.agentRuns.get(e.agentRunId);
      return run?.agentName === agentType;
    });
  }

  /** Compute success rate (0–1) for a given agent type. */
  getSuccessRate(agentType: AgentType): number {
    const feedback = this.getFeedbackForAgent(agentType);
    if (feedback.length === 0) return 0;
    const successes = feedback.filter((f) => f.outcome === 'success').length;
    return successes / feedback.length;
  }

  // -- SpacetimeDB direct queries ---------------------------------------------

  /**
   * Fetch routing weights from SpacetimeDB.
   * Used by the model router to pick the best provider+model.
   */
  async getRoutingWeights(agentType: string): Promise<StdbRoutingWeight[]> {
    try {
      const rows = await sqlQuery<StdbRoutingWeight>(
        `SELECT * FROM routing_weights WHERE agent_type = '${agentType.replace(/'/g, "''")}'`
      );
      return rows;
    } catch (err) {
      console.warn(`[FeedbackStore] Failed to fetch routing weights: ${err}`);
      return [];
    }
  }

  /**
   * Fetch recent feedback from SpacetimeDB to warm the local cache.
   * Call this on startup or periodically to stay in sync.
   */
  async syncFromSpacetimeDB(limit = 1000): Promise<void> {
    try {
      // Sync feedback
      const feedbackRows = await sqlQuery<StdbFeedback>(
        `SELECT * FROM feedback ORDER BY created_at DESC LIMIT ${limit}`
      );
      for (const row of feedbackRows) {
        const entry: FeedbackEntry = {
          id: `fb-stdb-${row.id}`,
          deploymentId: row.deployment_id,
          agentRunId: row.agent_run_id,
          feedbackType: row.feedback_type as FeedbackType,
          outcome: row.outcome as FeedbackOutcome,
          score: row.score,
          signalData: JSON.parse(row.signal_data_json),
          createdAt: row.created_at,
        };
        this.entries.set(entry.id, entry);
      }

      // Sync agent runs
      const runRows = await sqlQuery<StdbAgentRun>(
        `SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ${limit}`
      );
      for (const row of runRows) {
        const run: AgentRun = {
          id: row.run_id,
          pipelineId: row.pipeline_id,
          agentName: row.agent_name,
          agentVersion: row.agent_version,
          modelProvider: row.model_provider,
          modelId: row.model_id,
          inputSummary: row.input_summary,
          outputSummary: row.output_summary,
          tokensIn: row.tokens_in,
          tokensOut: row.tokens_out,
          latencyMs: row.latency_ms,
          status: row.status,
          errorMessage: row.error_message ?? undefined,
          startedAt: row.started_at,
          completedAt: row.completed_at ?? undefined,
        };
        this.agentRuns.set(run.id, run);
      }
    } catch (err) {
      console.warn(`[FeedbackStore] SpacetimeDB sync failed: ${err}`);
    }
  }

  // -- Aggregation ----------------------------------------------------------

  /** Aggregate stats for dashboards. */
  getStats(): {
    totalRuns: number;
    totalDeployments: number;
    totalFeedback: number;
    successRate: number;
    byAgent: Record<
      string,
      { runs: number; successRate: number; avgLatencyMs: number }
    >;
  } {
    const allFeedback = [...this.entries.values()];
    const byAgent: Record<
      string,
      { runs: number; successRate: number; avgLatencyMs: number }
    > = {};

    const grouped = this.groupRunsByAgent();
    for (const [agentName, runs] of grouped) {
      const feedback = this.getFeedbackForAgent(agentName as AgentType);
      byAgent[agentName] = {
        runs: runs.length,
        successRate:
          feedback.length > 0
            ? feedback.filter((f) => f.outcome === 'success').length /
              feedback.length
            : 0,
        avgLatencyMs:
          runs.reduce((sum, r) => sum + r.latencyMs, 0) / runs.length || 0,
      };
    }

    return {
      totalRuns: this.agentRuns.size,
      totalDeployments: this.deployments.size,
      totalFeedback: allFeedback.length,
      successRate:
        allFeedback.length > 0
          ? allFeedback.filter((f) => f.outcome === 'success').length /
            allFeedback.length
          : 0,
      byAgent,
    };
  }

  // -- Internal helpers -----------------------------------------------------

  private groupRunsByAgent(): Map<string, AgentRun[]> {
    const groups = new Map<string, AgentRun[]>();
    for (const run of this.agentRuns.values()) {
      const list = groups.get(run.agentName) ?? [];
      list.push(run);
      groups.set(run.agentName, list);
    }
    return groups;
  }
}