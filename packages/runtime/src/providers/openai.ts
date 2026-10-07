import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { Message, ModelResponse, ToolCall } from '../agents/base.js';
import type { AgentConfig, ToolDefinition } from '../types/index.js';

/**
 * Opt-in OpenAI chat completions. Used only when an agent model id is an
 * explicit GPT / o-series id and OPENAI_API_KEY is set.
 */
export async function invokeOpenAI(
  messages: Message[],
  config: AgentConfig,
  client: OpenAI,
): Promise<ModelResponse> {
  const tools = toOpenAiTools(config.tools);
  const response = await client.chat.completions.create({
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    messages: toOpenAiMessages(messages),
    ...(tools.length > 0 ? { tools } : {}),
  });

  const message = response.choices[0]?.message;
  const toolCalls = parseToolCalls(message?.tool_calls);

  return {
    content: message?.content ?? '',
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

function toOpenAiMessages(messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.toolCalls && message.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: message.content });
      }
      continue;
    }
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      });
      continue;
    }
    out.push({ role: 'user', content: message.content });
  }
  return out;
}

function toOpenAiTools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, param] of Object.entries(tool.parameters)) {
      properties[name] = { type: param.type, description: param.description };
      if (param.required) required.push(name);
    }
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          required,
        },
      },
    };
  });
}

function parseToolCalls(
  toolCalls: OpenAI.Chat.ChatCompletionMessage['tool_calls'] | undefined,
): ToolCall[] {
  if (!toolCalls) return [];
  const parsed: ToolCall[] = [];
  for (const call of toolCalls) {
    if (call.type !== 'function') continue;
    parsed.push({
      id: call.id,
      name: call.function.name,
      arguments: parseArguments(call.function.arguments),
    });
  }
  return parsed;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Leave arguments empty when the model returns malformed JSON.
  }
  return {};
}
