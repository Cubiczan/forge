// ---------------------------------------------------------------------------
// SpacetimeDB Client for Forge
// ---------------------------------------------------------------------------
//
// Provides a SpacetimeDB-backed drop-in replacement for the in-memory
// FeedbackStore. When a SpacetimeDB connection is available, all data flows
// through the database with real-time subscriptions. When disconnected,
// falls back to in-memory storage so the system keeps working.
//
// Usage:
//   const store = new SpacetimeFeedbackStore({ host, dbName });
//   await store.connect();
//   // use exactly like FeedbackStore
//   store.recordAgentRun(run);
//   await store.submitFeedback({ ... });
//   const rate = store.getSuccessRate('coder');
// ---------------------------------------------------------------------------

import type {
  AgentRun,
  AgentType,
  Deployment,
  FeedbackEntry,
  FeedbackOutcome,
  FeedbackType,
  SpacetimeConfig,
} from '../types/index.js';

import type {
  AgentRunsRow,
  DeploymentsRow,
  FeedbackRow,
  RoutingWeightsRow,
  RecordAgentRunInput,
  RecordDeploymentInput,
  SubmitFeedbackInput,
  AgentStats as AgentStatsRow,
} from './types.js';

// ---------------------------------------------------------------------------
// Connection config
// ---------------------------------------------------------------------------

export interface SpacetimeDBConnectionConfig {
  /** SpacetimeDB host URL. Defaults to https://spacetimedb.com */
  host?: string;
  /** Database name (as configured in forge.yaml under `spacetime.db_name`). */
  dbName: string;
  /** Optional auth token. If omitted the SDK uses anonymous auth. */
  token?: string;
  /** Optional identity string. If omitted a random one is generated. */
  identity?: string;
}

// ---------------------------------------------------------------------------
// Internal in-memory fallback store
// ---------------------------------------------------------------------------
// Mirrors the data shape of FeedbackStore so we can fall back transparently
// when SpacetimeDB is not reachable.

class InMemoryFallback {
  readonly feedback = new Map<string, FeedbackEntry>();
  readonly agentRuns = new Map<string, AgentRun>();
  readonly deployments = new Map<string, Deployment>();
}

// ---------------------------------------------------------------------------
// SpacetimeDBClient — low-level connection & reducer wrapper
// ---------------------------------------------------------------------------

export class SpacetimeDBClient {
  private config: Required<Pick<SpacetimeDBConnectionConfig, 'host'>> &
    SpacetimeDBConnectionConfig;
  private conn: any = null; // SpacetimeDB connection object (dynamically typed)
  private _connected = false;
  private fallback: InMemoryFallback;
  private connectPromise: Promise<void> | null = null;

  /** Resolved table caches — populated by subscriptions. */
  private agentRunsCache = new Map<number, AgentRunsRow>();
  private deploymentsCache = new Map<number, DeploymentsRow>();
  private feedbackCache = new Map<number, FeedbackRow>();
  private routingWeightsCache = new Map<number, RoutingWeightsRow>();

  constructor(config: SpacetimeDBConnectionConfig) {
    this.config = {
      host: config.host ?? 'https://spacetimedb.com',
      ...config,
    };
    this.fallback = new InMemoryFallback();
  }

  // -- Connection -----------------------------------------------------------

  /** Whether the client is currently connected to SpacetimeDB. */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to SpacetimeDB.
   *
   * This is safe to call multiple times — subsequent calls are no-ops.
   * The connection is established lazily on first call.
   */
  async connect(): Promise<void> {
    if (this._connected) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this._doConnect();
    try {
      await this.connectPromise;
    } catch (err) {
      this.connectPromise = null;
      // Log but don't throw — we fall back to in-memory.
      console.warn(
        '[SpacetimeDB] Connection failed, using in-memory fallback:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Disconnect from SpacetimeDB and clear caches. */
  async disconnect(): Promise<void> {
    if (this.conn) {
      try {
        this.conn.disconnect?.();
      } catch {
        // best-effort
      }
      this.conn = null;
    }
    this._connected = false;
    this.connectPromise = null;
    this.agentRunsCache.clear();
    this.deploymentsCache.clear();
    this.feedbackCache.clear();
    this.routingWeightsCache.clear();
  }

  // -- Reducer calls --------------------------------------------------------

  /** Call the `record_agent_run` reducer on the SpacetimeDB module. */
  async callRecordAgentRun(input: RecordAgentRunInput): Promise<void> {
    if (!this._connected) return;
    try {
      await this.callReducer('record_agent_run', input);
    } catch (err) {
      console.warn('[SpacetimeDB] record_agent_run reducer failed:', err);
    }
  }

  /** Call the `record_deployment` reducer on the SpacetimeDB module. */
  async callRecordDeployment(input: RecordDeploymentInput): Promise<void> {
    if (!this._connected) return;
    try {
      await this.callReducer('record_deployment', input);
    } catch (err) {
      console.warn('[SpacetimeDB] record_deployment reducer failed:', err);
    }
  }

  /** Call the `submit_feedback` reducer on the SpacetimeDB module. */
  async callSubmitFeedback(input: SubmitFeedbackInput): Promise<void> {
    if (!this._connected) return;
    try {
      await this.callReducer('submit_feedback', input);
    } catch (err) {
      console.warn('[SpacetimeDB] submit_feedback reducer failed:', err);
    }
  }

  /** Call the `update_routing_weight` reducer. */
  async callUpdateRoutingWeight(
    agentType: string,
    provider: string,
    modelId: string,
    weight: number,
  ): Promise<void> {
    if (!this._connected) return;
    try {
      await this.callReducer('update_routing_weight', {
        agent_type: agentType,
        provider,
        model_id: modelId,
        weight,
      });
    } catch (err) {
      console.warn('[SpacetimeDB] update_routing_weight reducer failed:', err);
    }
  }

  // -- Cache access (populated by subscriptions) ----------------------------

  /** Get all cached feedback rows. */
  getFeedbackRows(): FeedbackRow[] {
    return [...this.feedbackCache.values()];
  }

  /** Get all cached agent run rows. */
  getAgentRunRows(): AgentRunsRow[] {
    return [...this.agentRunsCache.values()];
  }

  /** Get all cached deployment rows. */
  getDeploymentRows(): DeploymentsRow[] {
    return [...this.deploymentsCache.values()];
  }

  /** Get all cached routing weight rows. */
  getRoutingWeightRows(): RoutingWeightsRow[] {
    return [...this.routingWeightsCache.values()];
  }

  // -- Fallback access (for when SpacetimeDB is disconnected) ---------------

  get fallbackStore(): InMemoryFallback {
    return this.fallback;
  }

  // -- Internal -------------------------------------------------------------

  private async _doConnect(): Promise<void> {
    let sdk: any;
    try {
      sdk = await import('spacetimedb');
    } catch {
      throw new Error(
        'spacetimedb package is not installed. Run: bun add spacetimedb',
      );
    }

    const connectFn = sdk.connect ?? sdk.default?.connect;
    if (!connectFn) {
      throw new Error('Could not find connect() in @spacetime-db/sdk');
    }

    const { host, dbName, token, identity } = this.config;

    const conn = await connectFn(host, dbName, token, {
      onConnect: () => {
        this._connected = true;
        console.info('[SpacetimeDB] Connected to', dbName, 'at', host);
      },
      onDisconnect: () => {
        this._connected = false;
        console.info('[SpacetimeDB] Disconnected from', dbName);
      },
      onIdentity: (id: any) => {
        console.info('[SpacetimeDB] Identity:', String(id));
      },
    });

    this.conn = conn;

    // Subscribe to all tables and seed caches.
    await this.subscribeToTables(conn);
  }

  private async subscribeToTables(conn: any): Promise<void> {
    // The SpacetimeDB SDK v1 uses subscription queries.
    // We subscribe to each table and update our local caches on changes.
    const tables = [
      { name: 'agent_runs', cache: this.agentRunsCache },
      { name: 'deployments', cache: this.deploymentsCache },
      { name: 'feedback', cache: this.feedbackCache },
      { name: 'routing_weights', cache: this.routingWeightsCache },
    ] as const;

    for (const { name, cache } of tables) {
      try {
        // SDK v1 pattern: subscribe with table filter expressions
        const subscription = await conn.subscribe([name], (event: any) => {
          this.handleTableUpdate(cache, event);
        });

        // Seed the cache with existing rows from the initial subscription response.
        if (subscription?.rows) {
          for (const row of subscription.rows) {
            cache.set(row.id, row);
          }
        }
      } catch (err) {
        console.warn(
          `[SpacetimeDB] Failed to subscribe to table "${name}":`,
          err,
        );
      }
    }
  }

  /**
   * Handle a table update event from the SpacetimeDB subscription.
   *
   * The SDK v1 event shape is:
   * ```
   * {
   *   table_name: string,
   *   insertions: Row[],
   *   deletions: Row[],
   *   updates: Row[],
   * }
   * ```
   */
  private handleTableUpdate(
    cache: Map<number, any>,
    event: any,
  ): void {
    if (!event) return;

    // Handle different event formats from the SDK.
    const insertions = event.insertions ?? event.insert ?? [];
    const deletions = event.deletions ?? event.delete ?? [];
    const updates = event.updates ?? event.update ?? [];

    for (const row of insertions) {
      if (row?.id != null) cache.set(row.id, row);
    }
    for (const row of updates) {
      if (row?.id != null) cache.set(row.id, row);
    }
    for (const row of deletions) {
      if (row?.id != null) cache.delete(row.id);
    }
  }

  /**
   * Call a reducer by name.
   *
   * Supports both SDK v1 patterns:
   * - `conn.reducers.reducerName(args)`
   * - `conn.callReducer('reducer_name', args)`
   */
  private async callReducer(name: string, args: object): Promise<any> {
    if (!this.conn) return;

    // Convert camelCase to snake_case for the Rust reducer.
    const snakeArgs = camelToSnake(args);

    if (typeof this.conn.reducers?.[name] === 'function') {
      return this.conn.reducers[name](snakeArgs);
    }
    if (typeof this.conn.callReducer === 'function') {
      return this.conn.callReducer(name, snakeArgs);
    }

    throw new Error(`Cannot call reducer "${name}": no supported method on connection`);
  }
}

// ---------------------------------------------------------------------------
// SpacetimeFeedbackStore — drop-in replacement for FeedbackStore
// ---------------------------------------------------------------------------

/**
 * A SpacetimeDB-backed feedback store with the **exact same public API** as
 * the in-memory `FeedbackStore` from `../feedback/index.ts`.
 *
 * When connected to SpacetimeDB, data is persisted and shared across
 * processes via the database. When disconnected, falls back to in-memory
 * storage so existing code continues to work without changes.
 *
 * ```ts
 * // In forge.yaml:
 * // spacetime:
 * //   host: https://spacetimedb.com
 * //   db_name: forge-prod
 *
 * const store = new SpacetimeFeedbackStore({
 *   host: 'https://spacetimedb.com',
 *   dbName: 'forge-prod',
 * });
 * await store.connect();
 *
 * // Use exactly like FeedbackStore:
 * store.recordAgentRun(run);
 * store.recordDeployment(deployment);
 * const entry = await store.submitFeedback({ ... });
 * const feedback = store.getFeedbackForDeployment('deploy-1');
 * const rate = store.getSuccessRate('coder');
 * const stats = store.getStats();
 * ```
 */
export class SpacetimeFeedbackStore {
  private client: SpacetimeDBClient;

  constructor(config: SpacetimeDBConnectionConfig) {
    this.client = new SpacetimeDBClient(config);
  }

  // -- Connection (extra API beyond FeedbackStore) --------------------------

  /** Connect to SpacetimeDB. Safe to call multiple times. */
  async connect(): Promise<void> {
    await this.client.connect();
  }

  /** Disconnect from SpacetimeDB. */
  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  /** Whether currently connected to SpacetimeDB. */
  get isConnected(): boolean {
    return this.client.connected;
  }

  /** Access the underlying SpacetimeDB client for advanced operations. */
  get dbClient(): SpacetimeDBClient {
    return this.client;
  }

  // -- Writers (same API as FeedbackStore) ----------------------------------

  /** Record an agent run for later feedback correlation. */
  recordAgentRun(run: AgentRun): void {
    if (this.client.connected) {
      // Fire-and-forget to the database.
      this.client.callRecordAgentRun({
        id: run.id,
        pipelineId: run.pipelineId,
        agentName: run.agentName,
        agentVersion: run.agentVersion,
        modelProvider: run.modelProvider,
        modelId: run.modelId,
        inputSummary: run.inputSummary,
        outputSummary: run.outputSummary,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        latencyMs: run.latencyMs,
        status: run.status,
        errorMessage: run.errorMessage ?? null,
        startedAt: run.startedAt,
        completedAt: run.completedAt ?? null,
      });
    }

    // Always also store locally for immediate reads (eventual consistency
    // with the DB subscription).
    this.client.fallbackStore.agentRuns.set(run.id, run);
  }

  /** Record a deployment. */
  recordDeployment(deployment: Deployment): void {
    if (this.client.connected) {
      this.client.callRecordDeployment({
        id: deployment.id,
        pipelineId: deployment.pipelineId,
        targetType: deployment.targetType,
        targetConfigJson: JSON.stringify(deployment.targetConfig),
        status: deployment.status,
        commitSha: deployment.commitSha ?? null,
        startedAt: deployment.startedAt,
        completedAt: deployment.completedAt ?? null,
        healthCheckUrl: deployment.healthCheckUrl ?? null,
        rollbackReason: deployment.rollbackReason ?? null,
      });
    }

    this.client.fallbackStore.deployments.set(deployment.id, deployment);
  }

  /**
   * Submit feedback for a deployment / agent run pair.
   *
   * Identical signature to `FeedbackStore.submitFeedback`.
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

    if (this.client.connected) {
      await this.client.callSubmitFeedback({
        deploymentId: params.deploymentId,
        agentRunId: params.agentRunId,
        feedbackType: params.feedbackType,
        outcome: params.outcome,
        score: params.score,
        signalDataJson: JSON.stringify(params.signalData),
      });
    }

    // Store locally for immediate reads.
    this.client.fallbackStore.feedback.set(entry.id, entry);
    return entry;
  }

  // -- Readers (same API as FeedbackStore) ----------------------------------

  /** Get all feedback entries for a specific deployment. */
  getFeedbackForDeployment(deploymentId: string): FeedbackEntry[] {
    // Merge local fallback with any DB-synced entries.
    const local = [...this.client.fallbackStore.feedback.values()].filter(
      (e) => e.deploymentId === deploymentId,
    );

    if (this.client.connected) {
      const dbRows = this.client
        .getFeedbackRows()
        .filter((r) => r.deploymentId === deploymentId);

      // Convert DB rows to FeedbackEntry format and deduplicate.
      const dbEntries = dbRows.map(rowToFeedbackEntry);
      const seen = new Set<string>();
      const merged: FeedbackEntry[] = [];

      for (const entry of [...dbEntries, ...local]) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          merged.push(entry);
        }
      }
      return merged;
    }

    return local;
  }

  /** Get every feedback entry (used by the router to update weights). */
  getAllFeedback(): FeedbackEntry[] {
    const local = [...this.client.fallbackStore.feedback.values()];

    if (this.client.connected) {
      const dbEntries = this.client.getFeedbackRows().map(rowToFeedbackEntry);
      const seen = new Set<string>();
      const merged: FeedbackEntry[] = [];

      for (const entry of [...dbEntries, ...local]) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          merged.push(entry);
        }
      }
      return merged;
    }

    return local;
  }

  /** Get feedback entries correlated with a specific agent type. */
  getFeedbackForAgent(agentType: AgentType): FeedbackEntry[] {
    const allFeedback = this.getAllFeedback();
    const agentRuns = this.client.connected
      ? [
          ...this.client.fallbackStore.agentRuns.values(),
          ...this.client.getAgentRunRows().map(rowToAgentRun),
        ]
      : [...this.client.fallbackStore.agentRuns.values()];

    const runMap = new Map<string, AgentRun>();
    for (const run of agentRuns) {
      runMap.set(run.id, run);
    }

    return allFeedback.filter((e) => {
      const run = runMap.get(e.agentRunId);
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

  // -- Aggregation (same API as FeedbackStore) ------------------------------

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
    const allFeedback = this.getAllFeedback();
    const agentRuns = this.client.connected
      ? [
          ...this.client.fallbackStore.agentRuns.values(),
          ...this.client.getAgentRunRows().map(rowToAgentRun),
        ]
      : [...this.client.fallbackStore.agentRuns.values()];

    const deployments = this.client.connected
      ? [
          ...this.client.fallbackStore.deployments.values(),
          ...this.client.getDeploymentRows().map(rowToDeployment),
        ]
      : [...this.client.fallbackStore.deployments.values()];

    const byAgent: Record<
      string,
      { runs: number; successRate: number; avgLatencyMs: number }
    > = {};

    // Group runs by agent name.
    const grouped = new Map<string, AgentRun[]>();
    for (const run of agentRuns) {
      const list = grouped.get(run.agentName) ?? [];
      list.push(run);
      grouped.set(run.agentName, list);
    }

    for (const [agentName, runs] of grouped) {
      const feedback = allFeedback.filter((f) => {
        const run = agentRuns.find((r) => r.id === f.agentRunId);
        return run?.agentName === agentName;
      });
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
      totalRuns: agentRuns.length,
      totalDeployments: deployments.length,
      totalFeedback: allFeedback.length,
      successRate:
        allFeedback.length > 0
          ? allFeedback.filter((f) => f.outcome === 'success').length /
            allFeedback.length
          : 0,
      byAgent,
    };
  }
}

// ---------------------------------------------------------------------------
// Row → domain type converters
// ---------------------------------------------------------------------------

function rowToFeedbackEntry(row: FeedbackRow): FeedbackEntry {
  let signalData: Record<string, unknown> = {};
  try {
    signalData = JSON.parse(row.signalDataJson);
  } catch {
    // If JSON is invalid, use empty object.
  }

  return {
    id: `stb-${row.id}`,
    deploymentId: row.deploymentId,
    agentRunId: row.agentRunId,
    feedbackType: row.feedbackType as FeedbackType,
    outcome: row.outcome as FeedbackOutcome,
    score: row.score,
    signalData,
    createdAt: row.createdAt,
  };
}

function rowToAgentRun(row: AgentRunsRow): AgentRun {
  return {
    id: `stb-${row.id}`,
    pipelineId: row.pipelineId,
    agentName: row.agentName,
    agentVersion: row.agentVersion,
    modelProvider: row.modelProvider,
    modelId: row.modelId,
    inputSummary: row.inputSummary,
    outputSummary: row.outputSummary,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    latencyMs: row.latencyMs,
    status: row.status as AgentRun['status'],
    errorMessage: row.errorMessage ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
  };
}

function rowToDeployment(row: DeploymentsRow): Deployment {
  let targetConfig: Record<string, unknown> = {};
  try {
    targetConfig = JSON.parse(row.targetConfigJson);
  } catch {
    // If JSON is invalid, use empty object.
  }

  return {
    id: `stb-${row.id}`,
    pipelineId: row.pipelineId,
    targetType: row.targetType,
    targetConfig,
    status: row.status as Deployment['status'],
    commitSha: row.commitSha ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    healthCheckUrl: row.healthCheckUrl ?? undefined,
    rollbackReason: row.rollbackReason ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a flat object's camelCase keys to snake_case for the Rust module. */
function camelToSnake(obj: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
    result[snakeKey] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a SpacetimeFeedbackStore from a `SpacetimeConfig` (from forge.yaml).
 *
 * The returned store has the same API as `FeedbackStore` but persists data
 * to SpacetimeDB. Call `store.connect()` before use.
 */
export function createSpacetimeFeedbackStore(
  config: SpacetimeConfig,
): SpacetimeFeedbackStore {
  return new SpacetimeFeedbackStore({
    host: config.host,
    dbName: config.db_name,
  });
}