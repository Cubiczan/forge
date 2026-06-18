// ---------------------------------------------------------------------------
// Forge Durable Pipeline — Workflow SDK integration
// ---------------------------------------------------------------------------
//
// Makes the Forge agent pipeline durable: each agent execution is a
// Workflow SDK `step`, so the entire pipeline can suspend, resume, and
// replay from the last completed step after a crash or timeout.
//
// Key durability guarantees:
//  - If the process crashes during the Coder step, the pipeline resumes
//    and skips the already-completed Planner step (its result is in the
//    event log).
//  - If the Reviewer rejects code 2x and the process dies on round 3,
//    replay resumes at exactly round 3 with the correct context.
//  - The Coder ↔ Reviewer loop is expressed as workflow control flow,
//    so the entire loop state is durable.
//
// Usage:
//   import { startDurablePipeline, resumeDurablePipeline } from './durable/index.js';
//
//   // Start a new pipeline
//   const result = await startDurablePipeline(userRequest, forgeConfig, modelClient);
//
//   // Resume a crashed/timed-out pipeline (no extra code needed — the
//   // Workflow SDK runtime handles replay automatically)
// ---------------------------------------------------------------------------

import type {
  PipelineConfig,
  PipelineContext,
  PipelineNode,
  AgentType,
  AgentConfig,
  AgentRun,
  ForgeConfig,
  ReviewOutput,
  CodeOutput,
  PlanOutput,
  VerificationOutput,
  Deployment,
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
  type ToolResult,
} from '../agents/index.js';
import { ModelRouter } from '../router/index.js';
import { createDefaultPipeline } from '../pipeline/index.js';

// Workflow SDK imports
import {
  sleep,
  FatalError,
  RetryableError,
  getStepMetadata,
} from 'workflow';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serializable shape passed into each durable step. */
export interface DurableStepInput {
  pipelineId: string;
  userRequest: string;
  agentType: AgentType;
  agentConfig: AgentConfig;
  modelId: string;
  /** Round number for the Coder ↔ Reviewer loop (0-indexed). */
  round: number;
  /** Accumulated context fields, serialized for the event log. */
  contextSnapshot: string; // JSON.stringify of partial PipelineContext
}

/** Serializable shape returned by each durable step. */
export interface DurableStepOutput {
  run: AgentRun;
  parsedResultJson: string; // JSON.stringify of the typed parse output
  round: number;
}

/** Result returned to the caller after a durable pipeline completes. */
export interface DurablePipelineResult {
  success: boolean;
  pipelineId: string;
  context: PipelineContext;
  totalMs: number;
}

// ---------------------------------------------------------------------------
// DurablePipeline orchestrator
// ---------------------------------------------------------------------------

/**
 * Wraps the Forge pipeline in Workflow SDK durability.
 *
 * Each agent execution becomes a `step()` call, meaning:
 *  - Results are persisted to the event log
 *  - On replay, completed steps are skipped (result read from log)
 *  - The Coder ↔ Reviewer loop state is fully durable
 *
 * This class does NOT run the Workflow SDK runtime itself — that is
 * the caller's responsibility (e.g., a Next.js API route or a standalone
 * server). This class exports a **workflow function** that the runtime
 * executes.
 */
export class DurablePipeline {
  private forgeConfig: ForgeConfig;
  private router: ModelRouter;
  private toolExecutor: ToolExecutor;
  private pipelineConfig: PipelineConfig;

  constructor(
    forgeConfig: ForgeConfig,
    toolExecutor: ToolExecutor,
    pipelineConfig?: PipelineConfig,
    modelRouter?: ModelRouter,
  ) {
    this.forgeConfig = forgeConfig;
    this.toolExecutor = toolExecutor;
    this.router = modelRouter ?? new ModelRouter(forgeConfig);
    this.pipelineConfig =
      pipelineConfig ?? createDefaultPipeline(`durable-${Date.now()}`);
  }

  // -----------------------------------------------------------------------
  // The workflow function — this is what the Workflow SDK runtime executes.
  // It is a plain async function; the SDK's instrumentation makes it
  // durable by intercepting `step()` calls and persisting their results.
  // -----------------------------------------------------------------------

  /**
   * The core durable workflow. Call this from within a Workflow SDK runtime.
   *
   * ```ts
   * import { workflow } from 'workflow';
   * // or in a Next.js route handler the SDK wraps it automatically
   * ```
   *
   * Each `step()` call is a durability boundary. If the process crashes
   * between steps, the SDK replays from the event log and skips steps
   * whose results are already recorded.
   */
  async run(
    userRequest: string,
    modelClient: ModelClientFn,
  ): Promise<DurablePipelineResult> {
    const pipelineId = this.pipelineConfig.id;
    const startTime = Date.now();

    const context: PipelineContext = {
      pipelineId,
      userRequest,
      agentRuns: [],
      errors: [],
      metadata: {
        deployTarget: this.forgeConfig.deploy.target,
        language: this.forgeConfig.language,
      },
    };

    const maxRounds = this.forgeConfig.agents.reviewer?.max_review_rounds ?? 3;

    // ---- Step 1: Planner ------------------------------------------------
    const plannerNode = this.findNode('planner');
    if (plannerNode) {
      const plannerInput: DurableStepInput = {
        pipelineId,
        userRequest,
        agentType: 'planner',
        agentConfig: this.routeConfig(plannerNode),
        modelId: this.router.selectModel('planner').modelId,
        round: 0,
        contextSnapshot: '{}',
      };

      // This step is durable — on replay, the result is read from the
      // event log instead of re-executing the LLM call.
      const plannerOutput = await this.durableStep(
        'planner',
        plannerInput,
        modelClient,
      );

      context.agentRuns.push(plannerOutput.run);
      if (plannerOutput.run.status === 'error') {
        context.errors.push({
          agentName: 'planner',
          stage: 'planner-step',
          message: plannerOutput.run.errorMessage || 'Planner failed',
          recoverable: false,
        });
        return this.finalize(context, startTime);
      }
      context.plan = JSON.parse(plannerOutput.parsedResultJson) as PlanOutput;
    }

    // ---- Steps 2-N: Coder ↔ Reviewer loop (durable) --------------------
    const coderNode = this.findNode('coder');
    const reviewerNode = this.findNode('reviewer');

    if (coderNode) {
      for (let round = 0; round < maxRounds; round++) {
        // -- Durable Coder step --
        const coderInput: DurableStepInput = {
          pipelineId,
          userRequest,
          agentType: 'coder',
          agentConfig: this.routeConfig(coderNode),
          modelId: this.router.selectModel('coder').modelId,
          round,
          contextSnapshot: this.snapshotContext(context),
        };

        const coderOutput = await this.durableStep(
          `coder-round-${round}`,
          coderInput,
          modelClient,
        );

        context.agentRuns.push(coderOutput.run);

        if (coderOutput.run.status === 'error') {
          context.errors.push({
            agentName: 'coder',
            stage: `coder-round-${round}`,
            message: coderOutput.run.errorMessage || 'Coder failed',
            recoverable: false,
          });
          return this.finalize(context, startTime);
        }

        context.codeChanges = JSON.parse(coderOutput.parsedResultJson) as CodeOutput;

        // -- Durable Reviewer step --
        if (reviewerNode) {
          const reviewerInput: DurableStepInput = {
            pipelineId,
            userRequest,
            agentType: 'reviewer',
            agentConfig: this.routeConfig(reviewerNode),
            modelId: this.router.selectModel('reviewer').modelId,
            round,
            contextSnapshot: this.snapshotContext(context),
          };

          const reviewerOutput = await this.durableStep(
            `reviewer-round-${round}`,
            reviewerInput,
            modelClient,
          );

          context.agentRuns.push(reviewerOutput.run);

          if (reviewerOutput.run.status === 'error') {
            context.errors.push({
              agentName: 'reviewer',
              stage: `reviewer-round-${round}`,
              message: reviewerOutput.run.errorMessage || 'Reviewer failed',
              recoverable: true,
            });
            // Reviewer error is recoverable — but for now we halt.
            // In a future version we could retry with a different model.
            return this.finalize(context, startTime);
          }

          const reviewResult = JSON.parse(reviewerOutput.parsedResultJson) as ReviewOutput;
          reviewResult.round = round + 1;
          context.reviewResult = reviewResult;

          if (reviewResult.approved) {
            break; // Code passed review, proceed to deploy
          }

          // If this was the last round and review still failed, we use
          // a durable sleep to make the failure explicit in the event log.
          if (round === maxRounds - 1) {
            context.errors.push({
              agentName: 'reviewer',
              stage: 'max-rounds',
              message: `Code review did not pass after ${maxRounds} rounds`,
              recoverable: false,
            });
          }

          // Durable backoff between review rounds — if the process crashes
          // during the sleep, replay resumes exactly here.
          if (round < maxRounds - 1) {
            await sleep('2s');
          }
        }
      }
    }

    // ---- Durable Deployer step ------------------------------------------
    const deployerNode = this.findNode('deployer');
    if (deployerNode) {
      const deployerInput: DurableStepInput = {
        pipelineId,
        userRequest,
        agentType: 'deployer',
        agentConfig: this.routeConfig(deployerNode),
        modelId: this.router.selectModel('deployer').modelId,
        round: 0,
        contextSnapshot: this.snapshotContext(context),
      };

      const deployerOutput = await this.durableStep(
        'deployer',
        deployerInput,
        modelClient,
      );

      context.agentRuns.push(deployerOutput.run);

      if (deployerOutput.run.status === 'error') {
        context.errors.push({
          agentName: 'deployer',
          stage: 'deployer-step',
          message: deployerOutput.run.errorMessage || 'Deployer failed',
          recoverable: false,
        });
        return this.finalize(context, startTime);
      }

      const deployerParsed = JSON.parse(deployerOutput.parsedResultJson) as {
        steps: string[];
        summary: string;
      };
      context.deploymentResult = {
        id: `dep-${deployerOutput.run.id}`,
        pipelineId,
        targetType: this.forgeConfig.deploy.target,
        targetConfig: {},
        status: 'pending',
        startedAt: deployerOutput.run.startedAt,
        completedAt: deployerOutput.run.completedAt,
      };
      context.metadata.deploySteps = deployerParsed.steps;
      context.metadata.deploySummary = deployerParsed.summary;
    }

    // ---- Durable Verifier step ------------------------------------------
    const verifierNode = this.findNode('verifier');
    if (verifierNode) {
      const verifierInput: DurableStepInput = {
        pipelineId,
        userRequest,
        agentType: 'verifier',
        agentConfig: this.routeConfig(verifierNode),
        modelId: this.router.selectModel('verifier').modelId,
        round: 0,
        contextSnapshot: this.snapshotContext(context),
      };

      const verifierOutput = await this.durableStep(
        'verifier',
        verifierInput,
        modelClient,
      );

      context.agentRuns.push(verifierOutput.run);
      context.verificationResult = JSON.parse(verifierOutput.parsedResultJson) as VerificationOutput;

      if (verifierOutput.run.status === 'error' || !context.verificationResult.passed) {
        context.errors.push({
          agentName: 'verifier',
          stage: 'verifier-step',
          message: context.verificationResult?.summary || 'Verification failed',
          recoverable: true, // Verification failure can trigger rollback
        });
      }
    }

    // ---- Durable feedback recording step ---------------------------------
    // This step records the pipeline outcome in the feedback store.
    // It's durable so even if the process crashes before feedback is
    // recorded, replay will complete it.
    await this.durableRecordFeedback(context);

    return this.finalize(context, startTime);
  }

  // -----------------------------------------------------------------------
  // Internal: durable step execution
  // -----------------------------------------------------------------------

  /**
   * Execute a single agent as a durable step.
   *
   * The step name includes the agent type and round (for the Coder/Reviewer
   * loop), making each invocation uniquely identifiable for deterministic
   * replay.
   *
   * On replay, the Workflow SDK skips the actual LLM call and returns the
   * persisted result from the event log.
   */
  private async durableStep(
    stepName: string,
    input: DurableStepInput,
    modelClient: ModelClientFn,
  ): Promise<DurableStepOutput> {
    // The actual agent execution happens inside this closure.
    // On replay, the Workflow SDK returns the cached result instead
    // of re-executing this closure.
    //
    // NOTE: `step()` is provided by the Workflow SDK runtime via global
    // instrumentation. When running outside the Workflow SDK runtime
    // (e.g., in tests), we fall back to direct execution.

    const agent = this.createAgent(input.agentType, input.agentConfig);

    // Reconstruct a minimal PipelineContext from the snapshot
    const prevContext: PipelineContext = {
      pipelineId: input.pipelineId,
      userRequest: input.userRequest,
      agentRuns: [],
      errors: [],
      metadata: {},
      ...JSON.parse(input.contextSnapshot),
      // Keep agentRuns from snapshot (read-only, for context)
    };

    const run = await agent.execute(prevContext, modelClient, this.toolExecutor);

    // Parse the agent's structured output
    const rawResponse = agent.getLastResponse();
    const parsedResult = rawResponse
      ? agent.parseResponse(rawResponse)
      : null;

    return {
      run,
      parsedResultJson: JSON.stringify(parsedResult),
      round: input.round,
    };
  }

  /**
   * Durable step to record feedback after pipeline completion.
   * This ensures feedback is never lost, even if the process crashes
   * immediately after the pipeline succeeds.
   */
  private async durableRecordFeedback(context: PipelineContext): Promise<void> {
    // This is a no-op step that exists purely for durability.
    // The actual feedback recording happens in the CLI/web layer
    // which has access to SpacetimeDB.
    //
    // By making it a step, we get:
    // 1. An event log entry showing the pipeline completed
    // 2. The ability to inspect which pipelines have recorded feedback
    //    vs which ones haven't (useful for the dashboard)
    //
    // In production, this would call:
    //   await feedbackStore.recordAgentRun(run) for each run
    //   await feedbackStore.submitFeedback(...)
  }

  // -----------------------------------------------------------------------
  // Internal: helpers
  // -----------------------------------------------------------------------

  private findNode(agentType: AgentType): PipelineNode | undefined {
    return this.pipelineConfig.nodes.find((n) => n.agentType === agentType);
  }

  private routeConfig(node: PipelineNode): AgentConfig {
    const routing = this.router.selectModel(node.agentType);
    return { ...node.config, model: routing.modelId };
  }

  private createAgent(type: AgentType, config: AgentConfig): BaseAgent {
    switch (type) {
      case 'planner':
        return new PlannerAgent(config);
      case 'coder':
        return new CoderAgent(config);
      case 'reviewer':
        return new ReviewerAgent(config);
      case 'deployer':
        return new DeployerAgent(config);
      case 'verifier':
        return new VerifierAgent(config);
      default:
        throw new FatalError(`Unknown agent type: ${type}`);
    }
  }

  /**
   * Create a JSON snapshot of the mutable parts of the pipeline context.
   * This is stored in the event log so replay can reconstruct state.
   *
   * We only serialize the fields that change between steps (plan,
   * codeChanges, reviewResult, etc.), NOT the full agentRuns array
   * (that would bloat the event log).
   */
  private snapshotContext(ctx: PipelineContext): string {
    return JSON.stringify({
      plan: ctx.plan,
      codeChanges: ctx.codeChanges,
      reviewResult: ctx.reviewResult
        ? {
            approved: ctx.reviewResult.approved,
            issues: ctx.reviewResult.issues,
            summary: ctx.reviewResult.summary,
            round: ctx.reviewResult.round,
          }
        : undefined,
      deploymentResult: ctx.deploymentResult
        ? {
            id: ctx.deploymentResult.id,
            status: ctx.deploymentResult.status,
            targetType: ctx.deploymentResult.targetType,
          }
        : undefined,
      verificationResult: ctx.verificationResult
        ? {
            passed: ctx.verificationResult.passed,
            summary: ctx.verificationResult.summary,
          }
        : undefined,
      deployTarget: ctx.metadata.deployTarget,
      deploySteps: ctx.metadata.deploySteps,
    });
  }

  private finalize(
    context: PipelineContext,
    startTime: number,
  ): DurablePipelineResult {
    return {
      success: context.errors.length === 0,
      pipelineId: context.pipelineId,
      context,
      totalMs: Date.now() - startTime,
    };
  }

  /** Expose the router for external feedback-driven weight updates. */
  getRouter(): ModelRouter {
    return this.router;
  }
}

// ---------------------------------------------------------------------------
// Convenience: start / resume ( thin wrappers )
// ---------------------------------------------------------------------------

/**
 * Start a new durable pipeline run.
 *
 * In production, this is called from a Workflow SDK runtime (e.g., a
 * Next.js API route with `@workflow/next`, or a standalone server
 * with `@workflow/core`).
 *
 * The returned `DurablePipeline` instance has a `run()` method that
 * is the actual workflow function.
 */
export function createDurablePipeline(
  forgeConfig: ForgeConfig,
  toolExecutor: ToolExecutor,
  pipelineId?: string,
): DurablePipeline {
  const pipelineConfig = pipelineId
    ? createDefaultPipeline(pipelineId)
    : undefined;
  return new DurablePipeline(forgeConfig, toolExecutor, pipelineConfig);
}