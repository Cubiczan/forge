# Delta for llm-provider

## ADDED Requirements

### Requirement: Default provider is Amazon Bedrock

The runtime SHALL call Amazon Bedrock with the Converse API for agent model ids that are not explicit OpenAI model ids. The Bedrock client SHALL be constructed with a region and without hard-coded credentials, so the AWS SDK default credential chain applies. The default region SHALL be `us-east-1` when `AWS_REGION` and `AWS_DEFAULT_REGION` are unset.

#### Scenario: Nova model call

- **WHEN** an agent model id is `us.amazon.nova-pro-v1:0` or `us.amazon.nova-lite-v1:0`
- **THEN** the runtime sends a Bedrock `Converse` request for that model id in the resolved region

#### Scenario: No embedded credentials

- **WHEN** the Bedrock client is created
- **THEN** the client config contains only the region

### Requirement: Default models are Amazon Nova

Planner, coder, and reviewer SHALL default to `us.amazon.nova-pro-v1:0`. Deployer and verifier SHALL default to `us.amazon.nova-lite-v1:0`. Shipped `forge.yaml.example`, `forge init` fallback config, router defaults, and the default pipeline SHALL use those model ids. No shipped default SHALL name a Claude or Anthropic model.

#### Scenario: Router without overrides

- **WHEN** a model router is constructed without a forge.yaml override
- **THEN** every task type selects provider `bedrock` and an `us.amazon.nova-*` model id

### Requirement: Converse tool use

When an agent has tools, the Converse request SHALL include `toolConfig` with each tool's name, description, and a top-level JSON schema (`type`, `properties`, `required`). Tool results from a previous turn SHALL be sent as `toolResult` blocks on a user message that follows the assistant `toolUse` turn. The agent tool loop SHALL record the assistant tool-call message before appending tool results.

#### Scenario: Tool call round trip

- **WHEN** the model returns a `toolUse` block and the tool executor succeeds
- **THEN** the next Converse request includes that `toolUse` followed by a `toolResult` with the same tool use id

### Requirement: Anthropic is not a provider

The runtime SHALL NOT depend on `@anthropic-ai/sdk`. A model id that names Claude or Anthropic SHALL fail with an error that tells the caller to use an Amazon Nova model id.

#### Scenario: Legacy Claude model id

- **WHEN** an agent model id starts with `claude` or contains `anthropic`
- **THEN** model selection fails and no Anthropic API request is made

### Requirement: OpenAI is explicit opt-in

An agent model id that is a GPT or o-series id SHALL be sent to OpenAI only when `OPENAI_API_KEY` is set. The default router and example config SHALL NOT select an OpenAI model.

#### Scenario: GPT model without a key

- **WHEN** the model id is `gpt-4o` and `OPENAI_API_KEY` is unset
- **THEN** the call fails and tells the caller to set `OPENAI_API_KEY`
