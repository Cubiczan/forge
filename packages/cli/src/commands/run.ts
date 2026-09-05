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
import type { ForgeConfig, PipelineContext } from '@forge/runtime';
import type { Message, ModelResponse } from '@forge/runtime';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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
  const modelClient = createModelClient(config, opts, router);

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

type ModelClientFn = (messages: Message[], agentConfig: { model: string; maxTokens: number; temperature: number }) => Promise<ModelResponse>;

function createModelClient(config: ForgeConfig, opts: RunOptions, router: ModelRouter): ModelClientFn {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
  const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;

  return async (messages, agentConfig) => {
    const decision = router.selectModel('coder'); // Will be overridden per-agent by pipeline
    const model = agentConfig.model;

    if (model.startsWith('claude') && anthropic) {
      opts.onEvent({ agent: 'router', message: `Routing to Anthropic: ${model}`, level: 'info' });
      const startedAt = Date.now();
      const response = await anthropic.messages.create({
        model,
        max_tokens: agentConfig.maxTokens,
        temperature: agentConfig.temperature,
        messages: messages
          .filter(m => m.role !== 'tool')
          .map(m => ({
            role: m.role === 'system' ? 'user' as const : m.role === 'assistant' ? 'assistant' as const : 'user' as const,
            content: m.content,
          })),
      });

      const textBlock = response.content.find(b => b.type === 'text');
      const result = {
        content: textBlock?.text ?? '',
        toolCalls: [],
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
      await tracePrismLLM({
        traceId: model,
        agentId: agentConfig.type,
        agentName: agentConfig.name,
        model,
        inputMessages: messages.map(m => ({ role: m.role, content: m.content })),
        output: textBlock?.text ?? '',
        latencyMs: Date.now() - startedAt,
        tokenCountInput: response.usage.input_tokens,
        tokenCountOutput: response.usage.output_tokens,
        metadata: {
          provider: 'anthropic',
          tool_calls: 0,
        },
      }).catch(() => undefined);
      return result;
    }

    if (openai) {
      opts.onEvent({ agent: 'router', message: `Routing to OpenAI: ${model}`, level: 'info' });
      const startedAt = Date.now();
      const response = await openai.chat.completions.create({
        model,
        max_tokens: agentConfig.maxTokens,
        temperature: agentConfig.temperature,
        messages: messages.map(m => ({
          role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      });

      const result = {
        content: response.choices[0]?.message?.content ?? '',
        toolCalls: response.choices[0]?.message?.tool_calls?.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        })) ?? [],
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
      await tracePrismLLM({
        traceId: model,
        agentId: agentConfig.type,
        agentName: agentConfig.name,
        model,
        inputMessages: messages.map(m => ({ role: m.role, content: m.content })),
        output: response.choices[0]?.message?.content ?? '',
        latencyMs: Date.now() - startedAt,
        tokenCountInput: response.usage?.prompt_tokens ?? 0,
        tokenCountOutput: response.usage?.completion_tokens ?? 0,
        metadata: {
          provider: 'openai',
          tool_calls: response.choices[0]?.message?.tool_calls?.length ?? 0,
        },
      }).catch(() => undefined);
      return result;
    }

    throw new Error(
      `No API key configured for model "${model}". Set ANTHROPIC_API_KEY or OPENAI_API_KEY.`
    );
  };
}
