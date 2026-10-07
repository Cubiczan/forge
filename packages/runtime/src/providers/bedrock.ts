import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ContentBlock,
  type Message as BedrockMessage,
  type SystemContentBlock,
  type Tool,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import type { Message, ModelResponse, ToolCall } from '../agents/base.js';
import type { AgentConfig, ToolDefinition } from '../types/index.js';
import { resolveBedrockRegion } from './models.js';

/**
 * Minimal send surface so tests can substitute a fake client.
 * The real client is `BedrockRuntimeClient` from `@aws-sdk/client-bedrock-runtime`.
 */
export interface BedrockConverseTransport {
  send(command: ConverseCommand): Promise<ConverseCommandOutput>;
}

/**
 * Client options for Bedrock. Only the region is set.
 * Credentials are intentionally omitted so the SDK uses the default
 * credential provider chain (environment, shared config, SSO, or task role).
 */
export function bedrockClientConfig(region?: string): { region: string } {
  return { region: region?.trim() || resolveBedrockRegion() };
}

export function createBedrockRuntimeClient(region?: string): BedrockRuntimeClient {
  return new BedrockRuntimeClient(bedrockClientConfig(region));
}

export function buildConverseCommandInput(
  messages: Message[],
  config: AgentConfig,
): ConverseCommandInput {
  const { system, conversation } = toBedrockConversation(messages);
  const toolConfig = toToolConfig(config.tools);

  const input: ConverseCommandInput = {
    modelId: config.model,
    messages: conversation,
    inferenceConfig: {
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    },
  };

  if (system.length > 0) input.system = system;
  if (toolConfig) input.toolConfig = toolConfig;
  return input;
}

export function parseConverseResponse(response: ConverseCommandOutput): ModelResponse {
  const blocks = response.output?.message?.content ?? [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of blocks) {
    if (typeof block.text === 'string' && block.text.length > 0) {
      textParts.push(block.text);
    }
    const toolUse = block.toolUse;
    if (toolUse?.name && toolUse.toolUseId) {
      toolCalls.push({
        id: toolUse.toolUseId,
        name: toolUse.name,
        arguments: asArguments(toolUse.input),
      });
    }
  }

  return {
    content: textParts.join('\n'),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    },
  };
}

export async function invokeBedrock(
  messages: Message[],
  config: AgentConfig,
  client: BedrockConverseTransport,
  region: string,
): Promise<ModelResponse> {
  const input = buildConverseCommandInput(messages, config);
  try {
    const response = await client.send(new ConverseCommand(input));
    return parseConverseResponse(response);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Amazon Bedrock Converse call failed for model "${config.model}" (region ${region}). ` +
        `Credentials are read from the standard AWS credential chain. ${detail}`,
    );
  }
}

function toBedrockConversation(messages: Message[]): {
  system: SystemContentBlock[];
  conversation: BedrockMessage[];
} {
  const system: SystemContentBlock[] = [];
  const conversation: BedrockMessage[] = [];

  const push = (role: 'user' | 'assistant', blocks: ContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = conversation[conversation.length - 1];
    if (last?.role === role && last.content) {
      last.content.push(...blocks);
      return;
    }
    conversation.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) system.push({ text: message.content });
      continue;
    }

    if (message.role === 'user') {
      push('user', [{ text: message.content }]);
      continue;
    }

    if (message.role === 'assistant') {
      const blocks: ContentBlock[] = [];
      if (message.content.trim()) blocks.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          toolUse: {
            toolUseId: call.id,
            name: call.name,
            input: call.arguments as DocumentType,
          },
        });
      }
      push('assistant', blocks);
      continue;
    }

    const text = message.content.trim() ? message.content : message.toolStatus === 'error' ? 'Tool failed' : '(no output)';
    push('user', [
      {
        toolResult: {
          toolUseId: message.toolCallId ?? 'unknown',
          content: [{ text }],
          status: message.toolStatus === 'error' ? 'error' : 'success',
        },
      },
    ]);
  }

  return { system, conversation };
}

/**
 * Nova's tool schema accepts a top-level object with `type`, `properties`,
 * and `required` only.
 */
function toToolConfig(tools: ToolDefinition[]): ToolConfiguration | undefined {
  if (tools.length === 0) return undefined;

  const specs: Tool[] = tools.map((tool) => {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];
    for (const [name, param] of Object.entries(tool.parameters)) {
      properties[name] = { type: param.type, description: param.description };
      if (param.required) required.push(name);
    }

    const json: Record<string, unknown> = {
      type: 'object',
      properties,
    };
    if (required.length > 0) json.required = required;

    return {
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: { json: json as DocumentType },
      },
    };
  });

  return {
    tools: specs,
    toolChoice: { auto: {} },
  };
}

function asArguments(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { ...(input as Record<string, unknown>) };
  }
  return {};
}
