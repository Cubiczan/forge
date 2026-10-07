# Design

## Provider

`BedrockRuntimeClient` is constructed with `{ region }` only. Region resolution is `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1`.

Requests use `ConverseCommand`:

- system prompts become `system` text blocks
- user and assistant text become conversation messages
- assistant `toolCalls` become `toolUse` blocks
- consecutive tool results become one user message of `toolResult` blocks
- agent tools become `toolConfig.tools[].toolSpec`, with `toolChoice: { auto: {} }`

Nova tool schemas stay at the top-level object fields `type`, `properties`, and `required`.

## Defaults

| Agent | Model |
| --- | --- |
| planner, coder, reviewer | `us.amazon.nova-pro-v1:0` |
| deployer, verifier | `us.amazon.nova-lite-v1:0` |

`forge.yaml` overrides still win. A Claude model id throws instead of calling Anthropic.

## OpenAI

GPT and o-series ids remain an explicit opt-in through `OPENAI_API_KEY`. They are not in the default weight table, so a fresh project does not need an OpenAI key.

## Anthropic

The SDK is removed from `@forge/runtime` and `@forge/cli`. There is no opt-in Claude path, because the previous call site did not implement tool use and the billing goal is to leave Claude entirely.
