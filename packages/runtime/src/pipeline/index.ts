import type {
  PipelineConfig,
  PipelineNode,
  PipelineContext,
  AgentType,
  AgentConfig,
  AgentRun,
  ForgeConfig,
  Deployment,
  ReviewOutput,
  CodeOutput,
  PlanOutput,
  VerificationOutput,
} from '../types/index.js';

import {
  BaseAgent,
  CoderAgent,
  ReviewerAgent,
  PlannerAgent,
  DeployerAgent,
  VerifierAgent,
  type ModelClientFn,
  type ToolExecutor,
} from '../agents/index.js';

import { ModelRouter } from '../router/index.js';

// ---------------------------------------------------------------------------
// Internal helper types
// ---------------------------------------------------------------------------

interface NodeExecutionResult {
  run: AgentRun;
  agent: BaseAgent | null;
}

// ---------------------------------------------------------------------------
// PipelineEngine
// ---------------------------------------------------------------------------

/**
 * DAG-based pipeline engine that orchestrates agent execution.
 *
 * Key features:
 *  - Topological sort of the pipeline DAG
 *  - Conditional edge evaluation (pass / fail / always)
 *  - Coder ↔ Reviewer loop with configurable max rounds
 *  - Model routing via `ModelRouter`
 *  - Pipeline-level timeout
 *  - Error recovery for non-fatal errors
 */
export class PipelineEngine {
  private config: PipelineConfig;
  private router: ModelRouter;
  private toolExecutor: ToolExecutor;
  private forgeConfig: ForgeConfig;
  private maxCoderReviewerRounds: number;

  constructor(
    config: PipelineConfig,
    forgeConfig: ForgeConfig,
    toolExecutor: ToolExecutor,
    modelRouter?: ModelRouter,
  ) {
    this.config = config;
    this.forgeConfig = forgeConfig;
    this.toolExecutor = toolExecutor;
    this.router = modelRouter ?? new ModelRouter(forgeConfig);
    this.maxCoderReviewerRounds =
      forgeConfig.agents.reviewer?.max_review_rounds ?? 3;
  }

  // -- public API -----------------------------------------------------------

  /**
   * Execute the full pipeline for a given user request.
   *
   * Returns the fully-populated `PipelineContext` with all intermediate
   * results, agent runs, and any errors encountered.
   */
  async execute(
    userRequest: string,
    modelClient: ModelClientFn,
  ): Promise<PipelineContext> {
    const context: PipelineContext = {
      pipelineId: this.config.id,
      userRequest,
      agentRuns: [],
      errors: [],
      metadata: {
        deployTarget: this.forgeConfig.deploy.target,
        language: this.forgeConfig.language,
      },
    };

    const executionOrder = this.topologicalSort();

    for (const nodeId of executionOrder) {
      const node = this.config.nodes.find((n) => n.id === nodeId);
      if (!node) continue;

      // Check conditional edges — skip if conditions are not met
      if (!this.shouldExecute(node, context)) continue;

      const pipelineStart = context.agentRuns[0]?.startedAt ?? Date.now();

      // -- Coder node triggers the special Coder ↔ Reviewer loop -----------
      if (node.agentType === 'coder') {
        const reviewerNode = this.config.nodes.find(
          (n) => n.agentType === 'reviewer',
        );
        await this.executeCoderReviewerLoop(
          node,
          reviewerNode ?? null,
          context,
          modelClient,
        );
      } else {
        const { run, agent } = await this.executeNode(
          node,
          context,
          modelClient,
        );
        context.agentRuns.push(run);

        if (run.status === 'error') {
          context.errors.push({
            agentName: node.agentType,
            stage: node.id,
            message: run.errorMessage || 'Unknown error',
            recoverable: false,
          });
        } else if (agent) {
          this.storeAgentResult(node.agentType, agent, context, run);
        }
      }

      // Pipeline-level timeout check
      const elapsed = Date.now() - pipelineStart;
      if (elapsed > this.forgeConfig.runtime.max_pipeline_duration_ms) {
        context.errors.push({
          agentName: 'system',
          stage: 'timeout',
          message: `Pipeline exceeded max duration of ${this.forgeConfig.runtime.max_pipeline_duration_ms}ms`,
          recoverable: false,
        });
        break;
      }
    }

    return context;
  }

  /** Expose the router so external code can update weights from feedback. */
  getRouter(): ModelRouter {
    return this.router;
  }

  // -- Coder ↔ Reviewer loop -----------------------------------------------

  private async executeCoderReviewerLoop(
    coderNode: PipelineNode,
    reviewerNode: PipelineNode | null,
    context: PipelineContext,
    modelClient: ModelClientFn,
  ): Promise<void> {
    let reviewRound = 0;

    for (let round = 0; round < this.maxCoderReviewerRounds; round++) {
      reviewRound++;

      // ---- Run Coder ------------------------------------------------------
      const coderResult = await this.executeNode(
        coderNode,
        context,
        modelClient,
      );
      context.agentRuns.push(coderResult.run);

      if (coderResult.run.status === 'error') {
        context.errors.push({
          agentName: 'coder',
          stage: coderNode.id,
          message: coderResult.run.errorMessage || 'Coder agent failed',
          recoverable: false,
        });
        return;
      }

      // Parse structured code output
      if (coderResult.agent) {
        context.codeChanges = coderResult.agent.parseResponse(
          coderResult.agent.getLastResponse(),
        ) as CodeOutput;
      }

      // ---- Run Reviewer (if configured) -----------------------------------
      if (reviewerNode) {
        const reviewerResult = await this.executeNode(
          reviewerNode,
          context,
          modelClient,
        );
        context.agentRuns.push(reviewerResult.run);

        if (reviewerResult.run.status === 'error') {
          context.errors.push({
            agentName: 'reviewer',
            stage: reviewerNode.id,
            message: reviewerResult.run.errorMessage || 'Reviewer agent failed',
            recoverable: true,
          });
          return;
        }

        // Parse structured review output and set the round number
        if (!reviewerResult.agent) return;
        const reviewOutput = reviewerResult.agent.parseResponse(
          reviewerResult.agent.getLastResponse(),
        ) as ReviewOutput;
        reviewOutput.round = reviewRound;
        context.reviewResult = reviewOutput;

        if (reviewOutput.approved) {
          // Code passed review — exit the loop
          return;
        }

        // Last round and still not approved
        if (round === this.maxCoderReviewerRounds - 1) {
          context.errors.push({
            agentName: 'reviewer',
            stage: 'max_rounds',
            message: `Code review did not pass after ${this.maxCoderReviewerRounds} rounds`,
            recoverable: false,
          });
        }
      } else {
        // No reviewer configured — proceed after coding
        return;
      }
    }
  }

  // -- Single-node execution -----------------------------------------------

  /**
   * Execute a single pipeline node: create the agent (with model routing),
   * run it, and return both the run record and the agent instance.
   */
  private async executeNode(
    node: PipelineNode,
    context: PipelineContext,
    modelClient: ModelClientFn,
  ): Promise<NodeExecutionResult> {
    const agent = this.createRoutedAgent(node);
    if (!agent) {
      const errorRun: AgentRun = {
        id: `error-${Date.now()}`,
        pipelineId: context.pipelineId,
        agentName: node.agentType,
        agentVersion: '0.0.0',
        modelProvider: 'unknown',
        modelId: 'unknown',
        inputSummary: '',
        outputSummary: '',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        status: 'error',
        errorMessage: `Unknown agent type: ${node.agentType}`,
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
      return { run: errorRun, agent: null };
    }

    const run = await agent.execute(context, modelClient, this.toolExecutor);
    return { run, agent };
  }

  /**
   * Create an agent instance for the given node, applying model routing
   * so the best model is used for this task type.
   */
  private createRoutedAgent(node: PipelineNode): BaseAgent | null {
    const routing = this.router.selectModel(node.agentType);
    const configWithModel: AgentConfig = {
      ...node.config,
      model: routing.modelId,
    };
    return this.createAgent({ ...node, config: configWithModel });
  }

  /**
   * Create an agent for a node without model routing (uses the node's
   * configured model directly).
   */
  private createAgent(node: PipelineNode): BaseAgent | null {
    switch (node.agentType) {
      case 'planner':
        return new PlannerAgent(node.config);
      case 'coder':
        return new CoderAgent(node.config);
      case 'reviewer':
        return new ReviewerAgent(node.config);
      case 'deployer':
        return new DeployerAgent(node.config);
      case 'verifier':
        return new VerifierAgent(node.config);
      default:
        return null;
    }
  }

  // -- Agent result storage ------------------------------------------------

  /**
   * After a non-coder/reviewer agent succeeds, parse its output and store
   * the structured result in the pipeline context.
   */
  private storeAgentResult(
    agentType: AgentType,
    agent: BaseAgent,
    context: PipelineContext,
    run: AgentRun,
  ): void {
    const raw = agent.getLastResponse();
    if (!raw) return;

    switch (agentType) {
      case 'planner':
        context.plan = agent.parseResponse(raw) as PlanOutput;
        break;

      case 'deployer': {
        // Create a minimal Deployment record from the deployer's plan
        const parsed = agent.parseResponse(raw) as {
          steps: string[];
          summary: string;
        };
        context.deploymentResult = {
          id: `dep-${run.id}`,
          pipelineId: context.pipelineId,
          targetType: String(context.metadata.deployTarget || 'unknown'),
          targetConfig: {},
          status: 'pending',
          startedAt: run.startedAt,
          completedAt: run.completedAt,
        };
        context.metadata.deploySteps = parsed.steps;
        context.metadata.deploySummary = parsed.summary;
        break;
      }

      case 'verifier':
        context.verificationResult = agent.parseResponse(raw) as VerificationOutput;
        break;

      default:
        break;
    }
  }

  // -- DAG utilities -------------------------------------------------------

  /**
   * Determine if a node should execute based on its incoming edges.
   *
   * - No incoming edges → always execute (start node)
   * - `always` condition → execute
   * - `pass` condition → execute only if the source node's last run succeeded
   * - `fail` condition → execute only if the source node's last run errored/rejected
   */
  private shouldExecute(
    node: PipelineNode,
    context: PipelineContext,
  ): boolean {
    const incoming = this.config.edges.filter((e) => e.to === node.id);

    if (incoming.length === 0) return true;

    for (const edge of incoming) {
      switch (edge.condition) {
        case 'always':
          return true;

        case 'pass': {
          const fromNode = this.config.nodes.find((n) => n.id === edge.from);
          if (!fromNode) continue;
          const lastRun = this.findLastRun(fromNode.agentType, context);
          if (lastRun && lastRun.status !== 'success') return false;
          break;
        }

        case 'fail': {
          const fromNode = this.config.nodes.find((n) => n.id === edge.from);
          if (!fromNode) continue;
          const lastRun = this.findLastRun(fromNode.agentType, context);
          if (lastRun && lastRun.status !== 'error' && lastRun.status !== 'rejected')
            return false;
          break;
        }

        default:
          return true;
      }
    }

    return true;
  }

  /** Find the most recent AgentRun for a given agent type. */
  private findLastRun(
    agentType: AgentType,
    context: PipelineContext,
  ): AgentRun | undefined {
    for (let i = context.agentRuns.length - 1; i >= 0; i--) {
      if (context.agentRuns[i].agentName === agentType) {
        return context.agentRuns[i];
      }
    }
    return undefined;
  }

  /**
   * Kahn's algorithm — topological sort of pipeline nodes.
   * Returns node IDs in execution order.
   */
  private topologicalSort(): string[] {
    const inDegree: Map<string, number> = new Map();
    const adjacency: Map<string, string[]> = new Map();

    for (const node of this.config.nodes) {
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    for (const edge of this.config.edges) {
      adjacency.get(edge.from)?.push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
    }

    const queue: string[] = [];
    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) queue.push(nodeId);
    }

    const result: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      for (const neighbour of adjacency.get(current) || []) {
        const newDegree = (inDegree.get(neighbour) || 1) - 1;
        inDegree.set(neighbour, newDegree);
        if (newDegree === 0) {
          queue.push(neighbour);
        }
      }
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Factory — default Phase 1 pipeline
// ---------------------------------------------------------------------------

/**
 * Create the standard 5-stage pipeline configuration:
 * planner → coder ⇄ reviewer → deployer → verifier
 */
export function createDefaultPipeline(pipelineId: string): PipelineConfig {
  return {
    id: pipelineId,
    nodes: [
      {
        id: 'planner-1',
        agentType: 'planner',
        config: {
          name: 'planner',
          type: 'planner',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 4096,
          temperature: 0.2,
          systemPrompt: '',
          tools: [],
        },
        maxRetries: 1,
        timeoutMs: 120_000,
      },
      {
        id: 'coder-1',
        agentType: 'coder',
        config: {
          name: 'coder',
          type: 'coder',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          temperature: 0.2,
          systemPrompt: '',
          tools: [],
        },
        maxRetries: 1,
        timeoutMs: 300_000,
      },
      {
        id: 'reviewer-1',
        agentType: 'reviewer',
        config: {
          name: 'reviewer',
          type: 'reviewer',
          model: 'gpt-4o',
          maxTokens: 4096,
          temperature: 0.1,
          systemPrompt: '',
          tools: [],
        },
        maxRetries: 1,
        timeoutMs: 120_000,
      },
      {
        id: 'deployer-1',
        agentType: 'deployer',
        config: {
          name: 'deployer',
          type: 'deployer',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 4096,
          temperature: 0.1,
          systemPrompt: '',
          tools: [],
        },
        maxRetries: 1,
        timeoutMs: 300_000,
      },
      {
        id: 'verifier-1',
        agentType: 'verifier',
        config: {
          name: 'verifier',
          type: 'verifier',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 4096,
          temperature: 0.1,
          systemPrompt: '',
          tools: [],
        },
        maxRetries: 1,
        timeoutMs: 120_000,
      },
    ],
    edges: [
      { from: 'planner-1', to: 'coder-1', condition: 'pass' },
      { from: 'coder-1', to: 'reviewer-1', condition: 'pass' },
      { from: 'reviewer-1', to: 'coder-1', condition: 'fail' }, // loop back
      { from: 'reviewer-1', to: 'deployer-1', condition: 'pass' },
      { from: 'deployer-1', to: 'verifier-1', condition: 'pass' },
    ],
  };
}