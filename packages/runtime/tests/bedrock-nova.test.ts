import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConverseCommand, type ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { PlannerAgent } from '../src/agents/planner.ts';
import type { Message, ToolExecutor } from '../src/agents/base.ts';
import { createDefaultPipeline } from '../src/pipeline/index.ts';
import {
  buildConverseCommandInput,
  bedrockClientConfig,
  createBedrockRuntimeClient,
  createModelClient,
  invokeBedrock,
  NOVA_LITE_MODEL_ID,
  NOVA_PRO_MODEL_ID,
  resolveAgentTools,
} from '../src/providers/index.ts';
import { ModelRouter } from '../src/router/index.ts';
import { ToolExecutorImpl } from '../src/tools/index.ts';
import type { AgentConfig, ForgeConfig, PipelineContext } from '../src/types/index.ts';

const root = path.resolve(import.meta.dir, '../../..');

const fileReadTool: AgentConfig['tools'][number] = {
  name: 'file_read',
  description: 'Read a file',
  parameters: {
    path: { type: 'string', description: 'Path to read', required: true },
  },
  handler: 'file_read',
};

function agentConfig(model: string, tools: AgentConfig['tools'] = []): AgentConfig {
  return {
    name: 'coder',
    type: 'coder',
    model,
    maxTokens: 256,
    temperature: 0.2,
    systemPrompt: '',
    tools,
  };
}

function conversation(): Message[] {
  return [
    { role: 'system', content: 'You are a coder.' },
    { role: 'user', content: 'Read src/a.ts' },
    {
      role: 'assistant',
      content: 'Reading the file.',
      toolCalls: [{ id: 'tool-1', name: 'file_read', arguments: { path: 'src/a.ts' } }],
    },
    {
      role: 'tool',
      content: 'export const a = 1;\n',
      toolCallId: 'tool-1',
      toolStatus: 'success',
    },
  ];
}

describe('Amazon Nova on Bedrock', () => {
  const previousRegion = process.env.AWS_REGION;
  const previousDefaultRegion = process.env.AWS_DEFAULT_REGION;

  afterEach(() => {
    if (previousRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previousRegion;
    if (previousDefaultRegion === undefined) delete process.env.AWS_DEFAULT_REGION;
    else process.env.AWS_DEFAULT_REGION = previousDefaultRegion;
  });

  test('client config sets region only and defaults to us-east-1', () => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    expect(bedrockClientConfig()).toEqual({ region: 'us-east-1' });
    expect(Object.keys(bedrockClientConfig())).toEqual(['region']);
    expect(createBedrockRuntimeClient('us-east-1')).toBeTruthy();
  });

  test('Converse input carries Nova tool use and no credentials', () => {
    const input = buildConverseCommandInput(conversation(), agentConfig(NOVA_PRO_MODEL_ID, [fileReadTool]));

    expect(input.modelId).toBe(NOVA_PRO_MODEL_ID);
    expect(input.system).toEqual([{ text: 'You are a coder.' }]);
    expect(input.messages?.[0]).toEqual({
      role: 'user',
      content: [{ text: 'Read src/a.ts' }],
    });
    expect(input.messages?.[1]).toEqual({
      role: 'assistant',
      content: [
        { text: 'Reading the file.' },
        { toolUse: { toolUseId: 'tool-1', name: 'file_read', input: { path: 'src/a.ts' } } },
      ],
    });
    expect(input.messages?.[2]).toEqual({
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: 'tool-1',
            content: [{ text: 'export const a = 1;\n' }],
            status: 'success',
          },
        },
      ],
    });

    const schema = input.toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(input.toolConfig?.tools?.[0]?.toolSpec?.name).toBe('file_read');
    expect(Object.keys(schema).sort()).toEqual(['properties', 'required', 'type']);
    expect(schema.required).toEqual(['path']);
    expect(input.toolConfig?.toolChoice).toEqual({ auto: {} });
    expect(JSON.stringify(input)).not.toMatch(/AKIA|aws_secret_access_key|apiKey/i);
  });

  test('invokeBedrock parses toolUse blocks from Converse', async () => {
    const sent: ConverseCommand[] = [];
    const response: ConverseCommandOutput = {
      stopReason: 'tool_use',
      usage: { inputTokens: 11, outputTokens: 7 },
      output: {
        message: {
          role: 'assistant',
          content: [
            { text: 'reading' },
            { toolUse: { toolUseId: 'tool-1', name: 'file_read', input: { path: 'src/a.ts' } } },
          ],
        },
      },
    };

    const result = await invokeBedrock(
      conversation().slice(0, 2),
      agentConfig(NOVA_PRO_MODEL_ID, [fileReadTool]),
      {
        async send(command) {
          sent.push(command);
          return response;
        },
      },
      'us-east-1',
    );

    expect(sent[0]).toBeInstanceOf(ConverseCommand);
    expect(sent[0].input.modelId).toBe(NOVA_PRO_MODEL_ID);
    expect(result).toEqual({
      content: 'reading',
      toolCalls: [{ id: 'tool-1', name: 'file_read', arguments: { path: 'src/a.ts' } }],
      usage: { inputTokens: 11, outputTokens: 7 },
    });
  });

  test('createModelClient uses Bedrock for Nova and rejects Claude and keyless OpenAI', async () => {
    const calls: string[] = [];
    const client = createModelClient({
      region: 'us-east-1',
      openaiApiKey: '',
      bedrockClient: {
        async send(command) {
          calls.push(command.input.modelId ?? '');
          return {
            output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });

    const nova = await client(
      [{ role: 'user', content: 'hi' }],
      agentConfig(NOVA_LITE_MODEL_ID),
    );
    expect(nova.content).toBe('ok');
    expect(calls).toEqual([NOVA_LITE_MODEL_ID]);

    await expect(
      client([{ role: 'user', content: 'hi' }], agentConfig('claude-sonnet-4-20250514')),
    ).rejects.toThrow(/Claude/);

    await expect(
      client([{ role: 'user', content: 'hi' }], agentConfig('gpt-4o')),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  test('Bedrock errors name the credential chain and region', async () => {
    const error = await invokeBedrock(
      [{ role: 'user', content: 'hi' }],
      agentConfig(NOVA_PRO_MODEL_ID),
      {
        async send() {
          throw new Error('AccessDeniedException');
        },
      },
      'us-east-1',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('region us-east-1');
    expect(message).toContain('standard AWS credential chain');
    expect(message).toContain('AccessDeniedException');
  });
});

describe('default model selection', () => {
  test('router and pipeline default to Nova, with Lite for lightweight agents', () => {
    const router = new ModelRouter();
    expect(router.selectModel('coder')).toMatchObject({
      provider: 'bedrock',
      modelId: NOVA_PRO_MODEL_ID,
    });
    expect(router.selectModel('planner')).toMatchObject({
      provider: 'bedrock',
      modelId: NOVA_PRO_MODEL_ID,
    });
    expect(router.selectModel('reviewer')).toMatchObject({
      provider: 'bedrock',
      modelId: NOVA_PRO_MODEL_ID,
    });
    expect(router.selectModel('deployer')).toMatchObject({
      provider: 'bedrock',
      modelId: NOVA_LITE_MODEL_ID,
    });
    expect(router.selectModel('verifier')).toMatchObject({
      provider: 'bedrock',
      modelId: NOVA_LITE_MODEL_ID,
    });

    const snapshot = router.getRoutingSnapshot();
    for (const routes of Object.values(snapshot)) {
      for (const route of routes) {
        expect(route.provider).toBe('bedrock');
        expect(route.modelId).toMatch(/^us\.amazon\.nova-/);
      }
    }

    const pipeline = createDefaultPipeline('pipe-test');
    for (const node of pipeline.nodes) {
      expect(node.config.model).toMatch(/^us\.amazon\.nova-/);
    }
    expect(pipeline.nodes.find((node) => node.agentType === 'coder')?.config.model).toBe(NOVA_PRO_MODEL_ID);
    expect(pipeline.nodes.find((node) => node.agentType === 'verifier')?.config.model).toBe(NOVA_LITE_MODEL_ID);
  });

  test('a forge.yaml Claude override is rejected', () => {
    const agent = { model: 'claude-sonnet-4-20250514', max_tokens: 128, temperature: 0.2 };
    const config: ForgeConfig = {
      name: 'legacy',
      language: 'rust',
      agents: {
        planner: { ...agent, model: NOVA_PRO_MODEL_ID },
        coder: agent,
        reviewer: { ...agent, model: NOVA_PRO_MODEL_ID },
        deployer: { ...agent, model: NOVA_LITE_MODEL_ID },
        verifier: { ...agent, model: NOVA_LITE_MODEL_ID },
      },
      deploy: { target: 'superserve', config: {} },
      runtime: {
        max_pipeline_duration_ms: 1000,
        max_agent_tokens: 100,
        max_shell_commands: 1,
        allowed_shell_commands: [],
      },
    };

    expect(() => new ModelRouter(config).selectModel('coder')).toThrow(/Claude/);
    expect(new ModelRouter(config).selectModel('verifier').modelId).toBe(NOVA_LITE_MODEL_ID);
  });

  test('agent tool sets are attached for Converse tool use', () => {
    const available = new ToolExecutorImpl().listTools();
    const coder = resolveAgentTools({ type: 'coder', tools: [] }, available).map((tool) => tool.name);
    const verifier = resolveAgentTools({ type: 'verifier', tools: [] }, available).map((tool) => tool.name);
    expect(coder).toEqual(['file_read', 'file_write', 'shell_exec', 'search']);
    expect(verifier).toEqual(['shell_exec', 'http_check']);
    expect(resolveAgentTools({ type: 'coder', tools: [fileReadTool] }, available)).toEqual([fileReadTool]);
  });
});

describe('agent tool loop', () => {
  test('records the assistant tool call before the tool result', async () => {
    const seen: Message[][] = [];
    const executor: ToolExecutor = {
      async execute(name, args) {
        return {
          success: true,
          output: `${name}:${String(args.path)}`,
          durationMs: 1,
        };
      },
    };

    const agent = new PlannerAgent(agentConfig(NOVA_PRO_MODEL_ID));
    const context: PipelineContext = {
      pipelineId: 'pipe',
      userRequest: 'plan the change',
      agentRuns: [],
      errors: [],
      metadata: {},
    };

    const run = await agent.execute(
      context,
      async (messages) => {
        seen.push(messages.map((message) => ({ ...message, toolCalls: message.toolCalls?.map((call) => ({ ...call })) })));
        if (seen.length === 1) {
          return {
            content: 'need the file',
            toolCalls: [{ id: 't1', name: 'file_read', arguments: { path: 'src/a.ts' } }],
          };
        }
        return { content: '{"tasks":["a"],"approach":"b","filesToModify":[],"filesToCreate":[]}' };
      },
      executor,
    );

    expect(run.status).toBe('success');
    expect(run.modelProvider).toBe('bedrock');
    expect(run.modelId).toBe(NOVA_PRO_MODEL_ID);
    expect(seen[1].some((message) => message.role === 'assistant' && message.toolCalls?.[0]?.id === 't1')).toBe(true);
    expect(seen[1].some((message) => message.role === 'tool' && message.toolCallId === 't1' && message.toolStatus === 'success')).toBe(true);
    const assistantIndex = seen[1].findIndex((message) => message.role === 'assistant');
    const toolIndex = seen[1].findIndex((message) => message.role === 'tool');
    expect(assistantIndex).toBeLessThan(toolIndex);
  });
});

describe('shipped defaults', () => {
  test('examples, compose, and package manifests do not default to Claude', () => {
    const example = readFileSync(path.join(root, 'forge.yaml.example'), 'utf8');
    const compose = readFileSync(path.join(root, 'docker-compose.yaml'), 'utf8');
    const initSource = readFileSync(path.join(root, 'packages/cli/src/commands/init.ts'), 'utf8');
    const runtimePkg = JSON.parse(readFileSync(path.join(root, 'packages/runtime/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const cliPkg = JSON.parse(readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };

    for (const text of [example, compose, initSource]) {
      expect(text.toLowerCase()).not.toContain('claude');
      expect(text).not.toContain('ANTHROPIC');
    }
    expect(example).toContain(NOVA_PRO_MODEL_ID);
    expect(example).toContain(NOVA_LITE_MODEL_ID);
    expect(compose).toContain('AWS_REGION=${AWS_REGION:-us-east-1}');
    expect(compose).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
    expect(runtimePkg.dependencies['@anthropic-ai/sdk']).toBeUndefined();
    expect(runtimePkg.dependencies['@aws-sdk/client-bedrock-runtime']).toBeDefined();
    expect(cliPkg.dependencies['@anthropic-ai/sdk']).toBeUndefined();
    expect(cliPkg.dependencies['openai']).toBeUndefined();
  });
});
