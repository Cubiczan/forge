import type { Message, ModelClientFn, ModelResponse } from '../agents/base.js';
import type { AgentConfig } from '../types/index.js';
import type { BedrockConverseTransport } from './bedrock.js';
import type OpenAI from 'openai';
import { inferModelProvider, NOVA_PRO_MODEL_ID, providerLabel, resolveBedrockRegion } from './models.js';

export interface CreateModelClientOptions {
  /** Bedrock region. Defaults to AWS_REGION, then AWS_DEFAULT_REGION, then us-east-1. */
  region?: string;
  /**
   * OpenAI key for explicit GPT model ids.
   * Pass an empty string to ignore OPENAI_API_KEY in the environment.
   */
  openaiApiKey?: string;
  bedrockClient?: BedrockConverseTransport;
  openaiClient?: OpenAI;
  onRoute?: (info: { provider: 'bedrock' | 'openai'; model: string }) => void;
}

/**
 * Model client used by the pipeline.
 *
 * Amazon Nova on Bedrock is the default. The Bedrock client is constructed
 * without credentials so the AWS SDK default credential chain applies.
 * OpenAI is used only when the model id is an explicit GPT / o-series id.
 */
export function createModelClient(options: CreateModelClientOptions = {}): ModelClientFn {
  const region = options.region?.trim() || resolveBedrockRegion();
  let bedrock = options.bedrockClient;
  let openai = options.openaiClient;

  return async (messages: Message[], config: AgentConfig): Promise<ModelResponse> => {
    const provider = inferModelProvider(config.model);
    options.onRoute?.({ provider, model: config.model });

    if (provider === 'bedrock') {
      const bedrockModule = await import('./bedrock.js');
      if (!bedrock) {
        bedrock = bedrockModule.createBedrockRuntimeClient(region);
      }
      return bedrockModule.invokeBedrock(messages, config, bedrock, region);
    }

    const key = resolveOpenAiKey(options.openaiApiKey);
    if (!key && !openai) {
      throw new Error(
        `Model "${config.model}" is an OpenAI model. Set OPENAI_API_KEY to use it. ` +
          `The default model is ${NOVA_PRO_MODEL_ID} on ${providerLabel('bedrock')}.`,
      );
    }
    if (!openai) {
      const { default: OpenAIClient } = await import('openai');
      openai = new OpenAIClient({ apiKey: key });
    }
    const { invokeOpenAI } = await import('./openai.js');
    return invokeOpenAI(messages, config, openai);
  };
}

function resolveOpenAiKey(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit.trim();
  return (process.env.OPENAI_API_KEY ?? '').trim();
}
