import type {
  AgentRun,
  AgentType,
  Deployment,
  FeedbackEntry,
  FeedbackOutcome,
  FeedbackType,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// FeedbackStore
// ---------------------------------------------------------------------------

/**
 * Records and retrieves deployment feedback.
 *
 * Currently an in-memory implementation with the same interface that a
 * SpacetimeDB-backed production store would provide.  Swap the internals
 * without touching call-sites when the DB layer is ready.
 */
export class FeedbackStore {
  private entries = new Map<string, FeedbackEntry>();
  private agentRuns = new Map<string, AgentRun>();
  private deployments = new Map<string, Deployment>();

  // -- Writers --------------------------------------------------------------

  /** Record an agent run for later feedback correlation. */
  recordAgentRun(run: AgentRun): void {
    this.agentRuns.set(run.id, run);
  }

  /** Record a deployment. */
  recordDeployment(deployment: Deployment): void {
    this.deployments.set(deployment.id, deployment);
  }

  /** Submit feedback for a deployment / agent run pair. */
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
    return entry;
  }

  // -- Readers --------------------------------------------------------------

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

    // Group agent runs by type
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