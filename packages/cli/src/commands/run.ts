import type { PipelineEvent } from '../index.js';
import {
  PipelineEngine,
  createDefaultPipeline,
  createDurablePipeline,
  loadForgeConfig,
  ToolExecutorImpl,
  FeedbackStore,
  ModelRouter,
} from '@forge/runtime';
import type { ForgeConfig } from '@forge/runtime';
import {
  createModelClient as createForgeModelClient,
  inferModelProvider,
  providerLabel,
} from '@forge/runtime';
import type { ModelClientFn } from '@forge/runtime';
import { tracePrismLLM } from '../observability/prism.js';

interface RunOptions {
  configPath: string;
  dryRun: boolean;
  verbose: boolean;
  onEvent: (event: PipelineEvent) => void;
}

interface RunResult {
  success: boolean;
  pipelineId: string;
  agentRuns: { id: string; agent: string; status: string; latencyMs: number }[];
  deploymentId?: string;
  totalMs: number;
  errors: { agent: string; message: string }[];
}

export async function runPipeline(
  request: string,
  opts: RunOptions
): Promise<RunResult> {
  const config = loadConfig(opts.configPath);
  const feedbackStore = new FeedbackStore();
  const router = new ModelRouter(config);
  const tools = new ToolExecutorImpl({
    allowedCommands: config.runtime.allowed_shell_commands,
    maxShellCommands: config.runtime.max_shell_commands,
  });

  const pipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const pipelineConfig = createDefaultPipeline(pipelineId);

  // Create model client
  const modelClient = createModelClient(opts);

  // Use the durable pipeline (Workflow SDK) by default.
  // Falls back to the non-durable PipelineEngine when:
  //  - --no-durable flag is passed
  //  - Workflow SDK runtime is not available
  const useDurable = !process.env.FORGE_NO_DURABLE;

  if (useDurable) {
    opts.onEvent({ agent: 'system', message: 'Starting durable pipeline (Workflow SDK)...', level: 'info' });
    try {
      const durablePipeline = createDurablePipeline(config, tools, pipelineId);
      const result = await durablePipeline.run(request, modelClient);

      for (const run of result.context.agentRuns) {
        feedbackStore.recordAgentRun(run);
        opts.onEvent({
          agent: run.agentName,
          message: `${run.agentName} — ${run.status} (${run.latencyMs}ms)`,
          level: run.status === 'error' ? 'error' : 'info',
        });
      }

      if (opts.dryRun) {
        opts.onEvent({ agent: 'system', message: 'Dry run complete — no deployment', level: 'info' });
      }

      return {
        success: result.success,
        pipelineId: result.pipelineId,
        agentRuns: result.context.agentRuns.map(r => ({
          id: r.id, agent: r.agentName, status: r.status, latencyMs: r.latencyMs,
        })),
        deploymentId: result.context.deploymentResult?.id,
        totalMs: result.totalMs,
        errors: result.context.errors.map(e => ({ agent: e.agentName, message: e.message })),
      };
    } catch (err) {
      // If Workflow SDK is not available (e.g. not running in a workflow
      // runtime), fall back to the non-durable engine.
      const msg = err instanceof Error ? err.message : String(err);
      opts.onEvent({ agent: 'system', message: `Durable pipeline unavailable, falling back: ${msg}`, level: 'warn' });
    }
  }

  // Non-durable fallback
  const engine = new PipelineEngine(pipelineConfig, config, tools, router);

  opts.onEvent({ agent: 'system', message: 'Pipeline starting...', level: 'info' });

  const startTime = Date.now();

  const context = await engine.execute(request, modelClient);

  // Record all agent runs in feedback store
  for (const run of context.agentRuns) {
    feedbackStore.recordAgentRun(run);
    opts.onEvent({
      agent: run.agentName,
      message: `${run.agentName} — ${run.status} (${run.latencyMs}ms)`,
      level: run.status === 'error' ? 'error' : 'info',
    });
  }

  // If dry-run, stop before deployment
  if (opts.dryRun) {
    opts.onEvent({ agent: 'system', message: 'Dry run complete — no deployment', level: 'info' });
    return {
      success: context.errors.length === 0,
      pipelineId,
      agentRuns: context.agentRuns.map(r => ({
        id: r.id,
        agent: r.agentName,
        status: r.status,
        latencyMs: r.latencyMs,
      })),
      totalMs: Date.now() - startTime,
      errors: context.errors.map(e => ({ agent: e.agentName, message: e.message })),
    };
  }

  return {
    success: context.errors.length === 0,
    pipelineId,
    agentRuns: context.agentRuns.map(r => ({
      id: r.id,
      agent: r.agentName,
      status: r.status,
      latencyMs: r.latencyMs,
    })),
    deploymentId: context.deploymentResult?.id,
    totalMs: Date.now() - startTime,
    errors: context.errors.map(e => ({ agent: e.agentName, message: e.message })),
  };
}

function loadConfig(configPath: string): ForgeConfig {
  const projectDir = process.cwd();
  try {
    return loadForgeConfig(projectDir);
  } catch {
    // Fallback: try the provided path directly
    const fs = require('fs');
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `No forge.yaml found. Run "forge init" to create one, or specify --config <path>.`
      );
    }
    throw new Error(`Failed to load ${configPath}. Check it's valid YAML with the correct schema.`);
  }
}

function createModelClient(opts: RunOptions): ModelClientFn {
  const inner = createForgeModelClient({
    onRoute: ({ provider, model }) => {
      opts.onEvent({
        agent: 'router',
        message: `Routing to ${providerLabel(provider)}: ${model}`,
        level: 'info',
      });
    },
  });

  return async (messages, agentConfig) => {
    const startedAt = Date.now();
    const result = await inner(messages, agentConfig);
    const provider = inferModelProvider(agentConfig.model);
    await tracePrismLLM({
      traceId: agentConfig.model,
      agentId: agentConfig.type,
      agentName: agentConfig.name,
      model: agentConfig.model,
      inputMessages: messages.map(m => ({ role: m.role, content: m.content })),
      output: result.content,
      latencyMs: Date.now() - startedAt,
      tokenCountInput: result.usage?.inputTokens,
      tokenCountOutput: result.usage?.outputTokens,
      metadata: {
        provider,
        tool_calls: result.toolCalls?.length ?? 0,
      },
    }).catch(() => undefined);
    return result;
  };
}
