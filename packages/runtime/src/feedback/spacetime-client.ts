/**
 * SpacetimeDB-backed FeedbackStore.
 *
 * Drop-in replacement for the in-memory FeedbackStore that talks to the
 * Forge SpacetimeDB module via its HTTP API.
 *
 * Tables: agent_runs, deployments, feedback, agent_versions, routing_weights
 * Reducers: record_agent_run, record_deployment, submit_feedback,
 *             update_routing_weight, activate_agent_version
 */

import type {
  AgentRun,
  AgentType,
  Deployment,
  FeedbackEntry,
  FeedbackOutcome,
  FeedbackType,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// SpacetimeDB HTTP helpers
// ---------------------------------------------------------------------------

interface CallResponse<T = unknown> {
  ok: boolean;
  status?: number;
  error?: string;
  result?: T;
}

interface QueryRow {
  [key: string]: unknown;
}

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// SpacetimeDBFeedbackStore
// ---------------------------------------------------------------------------

/**
 * Persistent FeedbackStore backed by SpacetimeDB.
 *
 * Pass the full database URL (e.g. `https://spacetimedb.com/@sam/forge-7d0qe`).
 */
export class SpacetimeDBFeedbackStore {
  private host: string;
  private database: string;
  private connected = false;

  constructor(host: string, database: string) {
    this.host = host.replace(/\/$/, '');
    this.database = database;
  }

  // -- Connection -----------------------------------------------------------

  /** Verify the database is reachable. Returns true on first success. */
  async connect(): Promise<boolean> {
    if (this.connected) return true;
    try {
      const res = await this.rawQuery<QueryRow>(
        'SELECT * FROM agent_runs LIMIT 1'
      );
      this.connected = true;
      return true;
    } catch {
      return false;
    }
  }

  // -- Writers ---------------------------------------------------------------

  recordAgentRun(run: AgentRun): void {
    // Fire-and-forget — the reducer will handle persistence.
    this.callReducer('record_agent_run', {
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
    }).catch(() => {
      // Log but don't throw — store writes are best-effort
    });
  }

  recordDeployment(deployment: Deployment): void {
    this.callReducer('record_deployment', {
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
    }).catch(() => {});
  }

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

    await this.callReducer('submit_feedback', {
      deployment_id: params.deploymentId,
      agent_run_id: params.agentRunId,
      feedback_type: params.feedbackType,
      outcome: params.outcome,
      score: params.score,
      signal_data_json: JSON.stringify(params.signalData),
    });

    return entry;
  }

  // -- Readers ---------------------------------------------------------------

  getFeedbackForDeployment(deploymentId: string): FeedbackEntry[] {
    // Synchronous reads return empty — real data comes from subscriptions.
    // The runtime should use `queryFeedbackForDeployment()` for async reads.
    return [];
  }

  async queryFeedbackForDeployment(deploymentId: string): Promise<FeedbackEntry[]> {
    const rows = await this.rawQuery<QueryRow>(
      `SELECT * FROM feedback WHERE deployment_id = '${deploymentId}' ORDER BY created_at DESC`
    );
    return rows.map(this.mapFeedbackRow);
  }

  getAllFeedback(): FeedbackEntry[] {
    return [];
  }

  async queryAllFeedback(): Promise<FeedbackEntry[]> {
    const rows = await this.rawQuery<QueryRow>(
      'SELECT * FROM feedback ORDER BY created_at DESC'
    );
    return rows.map(this.mapFeedbackRow);
  }

  getFeedbackForAgent(_agentType: AgentType): FeedbackEntry[] {
    return [];
  }

  async queryFeedbackForAgent(agentType: AgentType): Promise<FeedbackEntry[]> {
    const rows = await this.rawQuery<QueryRow>(
      `SELECT f.* FROM feedback f JOIN agent_runs a ON f.agent_run_id = a.run_id WHERE a.agent_name = '${agentType}' ORDER BY f.created_at DESC`
    );
    return rows.map(this.mapFeedbackRow);
  }

  getSuccessRate(_agentType: AgentType): number {
    return 0;
  }

  async querySuccessRate(agentType: AgentType): Promise<number> {
    const rows = await this.rawQuery<QueryRow>(
      `SELECT f.outcome FROM feedback f JOIN agent_runs a ON f.agent_run_id = a.run_id WHERE a.agent_name = '${agentType}'`
    );
    if (rows.length === 0) return 0;
    const successes = rows.filter(r => r.outcome === 'success').length;
    return successes / rows.length;
  }

  // -- Aggregation -------------------------------------------------------

  getStats() {
    return {
      totalRuns: 0,
      totalDeployments: 0,
      totalFeedback: 0,
      successRate: 0,
      byAgent: {},
    };
  }

  async queryStats(): Promise<{
    totalRuns: number;
    totalDeployments: number;
    totalFeedback: number;
    successRate: number;
    byAgent: Record<string, { runs: number; successRate: number; avgLatencyMs: number }>;
  }> {
    const [runRows, deployRows, feedbackRows] = await Promise.all([
      this.rawQuery<QueryRow>('SELECT * FROM agent_runs'),
      this.rawQuery<QueryRow>('SELECT * FROM deployments'),
      this.rawQuery<QueryRow>('SELECT * FROM feedback'),
    ]);

    // Group runs by agent name
    const byAgentName: Record<string, { runs: QueryRow[] }> = {};
    for (const r of runRows) {
      const name = (r.agent_name as string) || 'unknown';
      (byAgentName[name] ?? (byAgentName[name] = [])).push(r);
    }

    // Feedback for agent-type success rates
    const feedbackByRunId = new Map<string, QueryRow>();
    for (const f of feedbackRows) {
      feedbackByRunId.set(f.agent_run_id as string, f);
    }

    const byAgent: Record<string, { runs: number; successRate: number; avgLatencyMs: number }> = {};
    for (const [agentName, runs] of Object.entries(byAgentName)) {
      let fbSuccesses = 0;
      let fbTotal = 0;
      let totalLatency = 0;
      for (const run of runs) {
        const fb = feedbackByRunId.get(run.run_id as string);
        if (fb) {
          fbTotal++;
          if (fb.outcome === 'success') fbSuccesses++;
        }
        totalLatency += (run.latency_ms as number) || 0;
      }
      byAgent[agentName] = {
        runs: runs.length,
        successRate: fbTotal > 0 ? fbSuccesses / fbTotal : 0,
        avgLatencyMs: runs.length > 0 ? totalLatency / runs.length : 0,
      };
    }

    const allFeedback = feedbackRows.length;
    const globalSuccesses = feedbackRows.filter(f => f.outcome === 'success').length;

    return {
      totalRuns: runRows.length,
      totalDeployments: deployRows.length,
      totalFeedback: allFeedback,
      successRate: allFeedback > 0 ? globalSuccesses / allFeedback : 0,
      byAgent,
    };
  }

  // -- Internal -----------------------------------------------------------

  private mapFeedbackRow(row: QueryRow): FeedbackEntry {
    return {
      id: String(row.id),
      deploymentId: row.deployment_id as string,
      agentRunId: row.agent_run_id as string,
      feedbackType: row.feedback_type as FeedbackType,
      outcome: row.outcome as FeedbackOutcome,
      score: row.score as number,
      signalData: row.signal_data_json
        ? JSON.parse(row.signal_data_json as string)
        : {},
      createdAt: row.created_at as number,
    };
  }

  /**
   * Call a reducer on the SpacetimeDB module.
   * POST {host}/{database}/call/{reducer_name}
   */
  private async callReducer(
    reducerName: string,
    args: Record<string, unknown>
  ): Promise<CallResponse> {
    const url = `${this.host}/${this.database}/call/${reducerName}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [args] }),
    });

    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, error: text };
    }
    return text ? JSON.parse(text) : { ok: true };
  }

  /**
   * Run a SQL query via the subscribe endpoint.
   * GET {host}/{database}/subscribe?query={sql}
   */
  private async rawQuery<T>(sql: string): Promise<T[]> {
    const url = `${this.host}/${this.database}/subscribe?query=${encodeURIComponent(sql)}`;
    const response = await fetch(url);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `SpacetimeDB query failed (${response.status}): ${text.slice(0, 500)}`
      );
    }

    const data = JSON.parse(text);

    // The subscribe endpoint returns rows as an array of arrays.
    // We need column names — query for column info first, or
    // use the SQL column aliases approach.
    // For now, assume the reducer handles the mapping and we
    // query with explicit column selections.

    // SpacetimeDB subscribe returns: { sql: string, rows: any[][] }
    // Each row is a positional array matching the SELECT columns.
    // We'll also query the table schema to map positions to names.

    if (Array.isArray(data?.rows)) {
      // Try to get column names from the query response
      const columns = this.extractColumnNames(sql);
      return (data.rows as unknown[][]).map(row => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < Math.min(columns.length, row.length); i++) {
          obj[columns[i]] = row[i];
        }
        return obj as T;
      });
    }

    return [];
  }

  /** Extract column names from a SELECT query (simple parser). */
  private extractColumnNames(sql: string): string[] {
    // Match: SELECT col1, col2 AS alias, ... FROM ...
    const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
    if (!selectMatch) return [];
    const cols = selectMatch[1];
    return cols.split(',').map(c => {
      const trimmed = c.trim();
      // Handle "expr AS alias"
      const asMatch = trimmed.match(/\s+AS\s+(.+)$/i);
      if (asMatch) return asMatch[1].trim();
      // Handle just "col_name"
      return snakeToCamel(trimmed.split(/\s/)[0]);
    });
  }
}