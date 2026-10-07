# Switch default LLM from Claude to Amazon Nova on Bedrock

## Why

The project owner is stopping Claude spend. AWS promo credits cover Amazon Nova on Bedrock and do not cover Claude.

## What changes

- Add an Amazon Bedrock provider that uses the Converse API, including tool use.
- Make Amazon Nova Pro (`us.amazon.nova-pro-v1:0`) the default model in `us-east-1`.
- Use Amazon Nova Lite (`us.amazon.nova-lite-v1:0`) for the deployer and verifier.
- Read credentials from the standard AWS credential chain. Do not embed keys.
- Remove the `@anthropic-ai/sdk` dependency and the Anthropic call path.
- Keep OpenAI only when an agent model id is an explicit GPT / o-series id.

## Impact

- `packages/runtime` model router, pipeline defaults, and the new provider module
- `packages/cli` `forge run` model client
- `forge.yaml.example`, `forge init`, `docker-compose.yaml`, README, SCOPE
