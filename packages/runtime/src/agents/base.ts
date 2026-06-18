import type { AgentConfig, AgentRun, PipelineContext } from '../types/index.js';

// ---------------------------------------------------------------------------
// Wire-format types shared across all agents
// ---------------------------------------------------------------------------

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ToolExecutor {
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/** Function signature that the pipeline injects to call the actual LLM. */
export type ModelClientFn = (
  messages: Message[],
  config: AgentConfig,
) => Promise<ModelResponse>;

// ---------------------------------------------------------------------------
// BaseAgent
// ---------------------------------------------------------------------------

/**
 * Abstract base class for every agent in the Forge pipeline.
 *
 * Subclasses must implement:
 *  - `buildMessages(context)`  — construct the LLM conversation from pipeline state
 *  - `parseResponse(raw)`      — turn the raw LLM reply into a typed output
 *
 * The `execute()` method orchestrates the full lifecycle:
 *  1. Build messages from the current pipeline context
 *  2. Call the model (with an optional tool-use loop)
 *  3. Record timing, token usage, and status into an `AgentRun`
 *  4. Surface the raw response via `getLastResponse()` so the pipeline engine
 *     can feed it into `parseResponse()` and store structured results
 */
export abstract class BaseAgent {
  protected config: AgentConfig;

  /** Stores the raw LLM output from the most recent `execute()` call. */
  private lastRawResponse: string = '';

  constructor(config: AgentConfig) {
    this.config = config;
  }

  // -- abstract interface ---------------------------------------------------

  /** Build the full message array (system + user + history) for the LLM call. */
  abstract buildMessages(context: PipelineContext): Message[];

  /** Parse the raw LLM output string into a strongly-typed result. */
  abstract parseResponse(raw: string): unknown;

  // -- public API -----------------------------------------------------------

  /**
   * Run the agent against the current pipeline context.
   *
   * Returns a fully-populated `AgentRun` record (never throws).
   * After this returns, call `getLastResponse()` to retrieve the raw model
   * output for structured parsing by the pipeline engine.
   */
  async execute(
    context: PipelineContext,
    modelClient: ModelClientFn,
    tools: ToolExecutor,
  ): Promise<AgentRun> {
    const id = this.generateId();
    const startedAt = Date.now();

    const run: AgentRun = {
      id,
      pipelineId: context.pipelineId,
      agentName: this.config.name,
      agentVersion: '1.0.0',
      modelProvider: this.inferProvider(this.config.model),
      modelId: this.config.model,
      inputSummary: '',
      outputSummary: '',
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      status: 'running',
      startedAt,
    };

    try {
      const messages = this.buildMessages(context);
      run.inputSummary = this.summarizeInput(messages);

      // ---- tool-use loop ---------------------------------------------------
      let continueLoop = true;
      let maxIterations = 10; // safety bound
      let finalResponse: ModelResponse | null = null;

      while (continueLoop && maxIterations > 0) {
        maxIterations--;

        finalResponse = await modelClient(messages, this.config);

        if (finalResponse.toolCalls && finalResponse.toolCalls.length > 0) {
          for (const toolCall of finalResponse.toolCalls) {
            const result = await tools.execute(toolCall.name, toolCall.arguments);
            messages.push({
              role: 'tool',
              content: result.success
                ? result.output
                : `Error: ${result.error}`,
              toolCallId: toolCall.id,
            });
          }
          // Loop again so the model can process tool results
        } else {
          continueLoop = false;
        }
      }

      // ---- populate run fields ---------------------------------------------
      const completedAt = Date.now();
      this.lastRawResponse = finalResponse?.content ?? '';
      run.completedAt = completedAt;
      run.latencyMs = completedAt - startedAt;
      run.tokensIn =
        finalResponse?.usage?.inputTokens ??
        this.estimateTokens(JSON.stringify(messages));
      run.tokensOut =
        finalResponse?.usage?.outputTokens ??
        this.estimateTokens(this.lastRawResponse);
      run.outputSummary = this.summarizeOutput(this.lastRawResponse);
      run.status = 'success';

      return run;
    } catch (error) {
      const completedAt = Date.now();
      this.lastRawResponse = '';
      run.completedAt = completedAt;
      run.latencyMs = completedAt - startedAt;
      run.status = 'error';
      run.errorMessage =
        error instanceof Error ? error.message : String(error);
      return run;
    }
  }

  /**
   * Retrieve the raw LLM output from the most recent `execute()` call.
   * The pipeline engine feeds this into `parseResponse()` to obtain
   * structured results (CodeOutput, ReviewOutput, etc.).
   */
  getLastResponse(): string {
    return this.lastRawResponse;
  }

  // -- private helpers ------------------------------------------------------

  private inferProvider(model: string): 'anthropic' | 'openai' {
    if (model.startsWith('claude') || model.includes('anthropic')) {
      return 'anthropic';
    }
    return 'openai';
  }

  private generateId(): string {
    return `${this.config.type}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  /** Rough token estimate: ~4 chars per token. */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private summarizeInput(messages: Message[]): string {
    const userParts = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    return userParts.join(' ').slice(0, 500);
  }

  private summarizeOutput(output: string): string {
    return output.slice(0, 1000);
  }
}