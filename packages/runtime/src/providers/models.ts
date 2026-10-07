import type { AgentType, ModelProvider } from '../types/index.js';

/** Cross-region inference profile for Amazon Nova Pro on Bedrock. */
export const NOVA_PRO_MODEL_ID = 'us.amazon.nova-pro-v1:0';

/** Cross-region inference profile for Amazon Nova Lite on Bedrock. */
export const NOVA_LITE_MODEL_ID = 'us.amazon.nova-lite-v1:0';

/** Default Bedrock region when AWS_REGION and AWS_DEFAULT_REGION are unset. */
export const DEFAULT_BEDROCK_REGION = 'us-east-1';

const LIGHTWEIGHT_AGENTS = new Set<AgentType>(['deployer', 'verifier']);

/**
 * Nova Pro is the default model. Deployer and verifier are operational
 * checks, so they use Nova Lite.
 */
export function defaultModelForAgent(type: AgentType): string {
  return LIGHTWEIGHT_AGENTS.has(type) ? NOVA_LITE_MODEL_ID : NOVA_PRO_MODEL_ID;
}

export function resolveBedrockRegion(): string {
  const region = (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_BEDROCK_REGION).trim();
  return region || DEFAULT_BEDROCK_REGION;
}

export function providerLabel(provider: ModelProvider): string {
  switch (provider) {
    case 'bedrock':
      return 'Amazon Bedrock';
    case 'openai':
      return 'OpenAI';
  }
}

/**
 * Map a model id to a provider.
 *
 * Amazon Nova on Bedrock is the default. OpenAI is selected only for explicit
 * GPT / o-series model ids. Anthropic Claude ids are rejected.
 */
export function inferModelProvider(model: string): ModelProvider {
  const id = model.trim().toLowerCase();

  if (id.startsWith('claude') || id.includes('anthropic')) {
    throw new Error(
      `Model "${model}" is an Anthropic Claude model. ` +
        `Set the agent model to ${NOVA_PRO_MODEL_ID} (Amazon Nova Pro on Bedrock) ` +
        `or to an OpenAI model id with OPENAI_API_KEY.`,
    );
  }

  if (isOpenAiModel(id)) return 'openai';
  return 'bedrock';
}

function isOpenAiModel(id: string): boolean {
  return (
    id.startsWith('gpt-') ||
    id.startsWith('gpt4') ||
    id.startsWith('chatgpt') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4') ||
    id.includes('openai/')
  );
}
