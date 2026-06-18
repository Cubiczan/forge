import type {
  AgentType,
  ModelProvider,
  ModelRoute,
  RoutingDecision,
  FeedbackEntry,
  ForgeConfig,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Default model assignments per task type
// ---------------------------------------------------------------------------

const DEFAULT_ROUTES: Record<AgentType, ModelRoute[]> = {
  planner: [
    { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', weight: 0.8 },
    { provider: 'openai', modelId: 'gpt-4o', weight: 0.2 },
  ],
  coder: [
    { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', weight: 0.9 },
    { provider: 'openai', modelId: 'gpt-4o', weight: 0.1 },
  ],
  reviewer: [
    { provider: 'openai', modelId: 'gpt-4o', weight: 0.7 },
    { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', weight: 0.3 },
  ],
  deployer: [
    { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', weight: 0.8 },
    { provider: 'openai', modelId: 'gpt-4o', weight: 0.2 },
  ],
  verifier: [
    { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', weight: 0.8 },
    { provider: 'openai', modelId: 'gpt-4o', weight: 0.2 },
  ],
};

// ---------------------------------------------------------------------------
// ModelRouter
// ---------------------------------------------------------------------------

/**
 * Routes agent tasks to the best LLM model using weighted selection.
 *
 * Features:
 *  - Per-task-type routing with configurable weights
 *  - Config overrides (from forge.yaml) take precedence
 *  - Fallback chain (all routes sorted by weight) for resilience
 *  - Self-tuning: `updateWeights()` adjusts weights based on feedback outcomes
 */
export class ModelRouter {
  private routes: Map<AgentType, ModelRoute[]> = new Map();
  private configOverrides: Map<AgentType, string> = new Map();

  constructor(config?: ForgeConfig) {
    // Seed with defaults (deep-copy to avoid shared mutation)
    for (const [taskType, routes] of Object.entries(DEFAULT_ROUTES)) {
      this.routes.set(taskType as AgentType, routes.map((r) => ({ ...r })));
    }

    // Apply config overrides
    if (config) {
      for (const [agentType, agentConfig] of Object.entries(config.agents)) {
        this.configOverrides.set(agentType as AgentType, agentConfig.model);
      }
    }
  }

  // -- public API -----------------------------------------------------------

  /**
   * Select the best model for a given task type via weighted random routing.
   * If a config override exists, it is used directly (deterministic).
   */
  selectModel(taskType: AgentType): RoutingDecision {
    // Config override wins
    const override = this.configOverrides.get(taskType);
    if (override) {
      return {
        provider: this.inferProvider(override),
        modelId: override,
        taskType,
        reason: 'Config override from forge.yaml',
      };
    }

    const routes = this.routes.get(taskType);
    if (!routes || routes.length === 0) {
      return {
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-20250514',
        taskType,
        reason: 'No routes configured, using fallback',
      };
    }

    // Weighted random selection
    const totalWeight = routes.reduce((sum, r) => sum + r.weight, 0);
    let random = Math.random() * totalWeight;

    for (const route of routes) {
      random -= route.weight;
      if (random <= 0) {
        return {
          provider: route.provider,
          modelId: route.modelId,
          taskType,
          reason: `Weighted selection (weight=${route.weight.toFixed(2)}, total=${totalWeight.toFixed(2)})`,
        };
      }
    }

    // Last resort — return the highest-weight route
    const best = [...routes].sort((a, b) => b.weight - a.weight)[0];
    return {
      provider: best.provider,
      modelId: best.modelId,
      taskType,
      reason: 'Fallback to highest-weight route',
    };
  }

  /**
   * Return the full fallback chain for a task type (sorted by weight
   * descending). The pipeline can try each in order if the primary fails.
   */
  getFallbackChain(taskType: AgentType): RoutingDecision[] {
    const override = this.configOverrides.get(taskType);
    if (override) {
      return [
        {
          provider: this.inferProvider(override),
          modelId: override,
          taskType,
          reason: 'Config override',
        },
      ];
    }

    const routes = this.routes.get(taskType) || [];
    return [...routes]
      .sort((a, b) => b.weight - a.weight)
      .map((r) => ({
        provider: r.provider,
        modelId: r.modelId,
        taskType,
        reason: `Fallback (weight=${r.weight.toFixed(2)})`,
      }));
  }

  /**
   * Adjust routing weights based on real feedback outcomes.
   *
   * This is the self-tuning mechanism of the feedback flywheel:
   *  - `success`  → increase weight
   *  - `failure`  → decrease weight
   *  - `partial`  → no change
   *
   * After updating, weights are normalised so they sum to 1.0 per task type.
   */
  updateWeights(feedback: FeedbackEntry[]): void {
    const LEARNING_RATE = 0.1;
    const MIN_WEIGHT = 0.05;
    const MAX_WEIGHT = 1.0;

    for (const entry of feedback) {
      const taskType = entry.signalData.taskType as AgentType | undefined;
      if (!taskType) continue;

      const routes = this.routes.get(taskType);
      if (!routes) continue;

      const provider = entry.signalData.provider as ModelProvider | undefined;
      const modelId = entry.signalData.modelId as string | undefined;
      if (!provider || !modelId) continue;

      const route = routes.find(
        (r) => r.provider === provider && r.modelId === modelId,
      );
      if (!route) continue;

      if (entry.outcome === 'success') {
        route.weight = Math.min(MAX_WEIGHT, route.weight + LEARNING_RATE);
      } else if (entry.outcome === 'failure') {
        route.weight = Math.max(MIN_WEIGHT, route.weight - LEARNING_RATE);
      }
      // 'partial' → no change
    }

    // Normalise weights per task type
    for (const [, routes] of this.routes) {
      const total = routes.reduce((sum, r) => sum + r.weight, 0);
      if (total > 0) {
        for (const route of routes) {
          route.weight = route.weight / total;
        }
      }
    }
  }

  /**
   * Get a snapshot of current routing weights for observability / dashboards.
   */
  getRoutingSnapshot(): Record<
    string,
    { provider: string; modelId: string; weight: number }[]
  > {
    const snapshot: Record<
      string,
      { provider: string; modelId: string; weight: number }[]
    > = {};

    for (const [taskType, routes] of this.routes) {
      snapshot[taskType] = routes.map((r) => ({
        provider: r.provider,
        modelId: r.modelId,
        weight: Math.round(r.weight * 100) / 100,
      }));
    }

    return snapshot;
  }

  // -- private helpers ------------------------------------------------------

  private inferProvider(model: string): ModelProvider {
    if (model.startsWith('claude') || model.includes('anthropic')) {
      return 'anthropic';
    }
    return 'openai';
  }
}