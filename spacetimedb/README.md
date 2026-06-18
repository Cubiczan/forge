# forge-spacetime

SpacetimeDB module for the Forge self-improving agent system. This Rust crate defines the persistent schema (tables + reducers) that back the Forge feedback flywheel.

## Schema

### Tables

| Table | Purpose | Key Indexes |
|---|---|---|
| `agent_runs` | Every agent execution in a pipeline | `pipeline_id`, `agent_name`, `status` |
| `deployments` | Deployment lifecycle | `pipeline_id`, `status` |
| `feedback` | Feedback entries (auto, manual, monitoring, user) | `deployment_id`, `agent_run_id` |
| `agent_versions` | Agent config versioning for the self-improvement loop | `agent_name`, `version`, `is_active` |
| `routing_weights` | Model routing weights updated by the feedback flywheel | `agent_type` |

### Reducers

| Reducer | Description |
|---|---|
| `record_agent_run` | Insert an agent run record |
| `record_deployment` | Insert a deployment record |
| `submit_feedback` | Record feedback and auto-update routing weights |
| `update_routing_weight` | Manually set a routing weight |
| `get_agent_stats` | Aggregate stats for an agent type |
| `get_pipeline_runs` | Get all runs for a pipeline |
| `get_deployment_feedback` | Get feedback for a deployment |

## Build

Requires a Rust toolchain with the `wasm32-unknown-unknown` target:

```sh
# Install the target (once)
rustup target add wasm32-unknown-unknown

# Build the module
cargo build --target wasm32-unknown-unknown --release

# The output Wasm file is at:
# target/wasm32-unknown-unknown/release/forge_spacetime.wasm
```

## Publish to SpacetimeDB

```sh
# Make sure you're logged in
spacetime login

# Publish (creates or updates the database)
spacetime publish \
  --module-path target/wasm32-unknown-unknown/release/forge_spacetime.wasm \
  --database-name forge-prod

# If this is the first publish, note the database identity in your forge.yaml:
# spacetime:
#   host: https://spacetimedb.com
#   db_name: forge-prod
```

## Development

### Local SpacetimeDB

For local development, run a SpacetimeDB local instance:

```sh
# Install the CLI (already done if you're reading this)
# Log in
spacetime login

# Publish to a local/test database
spacetime publish \
  --module-path target/wasm32-unknown-unknown/release/forge_spacetime.wasm \
  --database-name forge-dev
```

### Running Tests

```sh
cargo test
```

### TypeScript Client

The TypeScript client lives in `packages/runtime/src/spacetime/` and provides a drop-in replacement for the in-memory `FeedbackStore`:

```typescript
import { createSpacetimeFeedbackStore } from '@forge/runtime';

const store = createSpacetimeFeedbackStore({
  host: 'https://spacetimedb.com',
  db_name: 'forge-prod',
});

await store.connect();

// Same API as FeedbackStore:
store.recordAgentRun(run);
store.recordDeployment(deployment);
const entry = await store.submitFeedback({ ... });
const feedback = store.getFeedbackForDeployment('deploy-1');
const rate = store.getSuccessRate('coder');
const stats = store.getStats();
```

The client automatically falls back to in-memory storage when SpacetimeDB is unreachable, so existing code works without modification.

## Architecture

```
┌─────────────┐    ┌──────────────────┐    ┌──────────────┐
│  Forge CLI  │───▶│  SpacetimeFeedback│───▶│  SpacetimeDB  │
│  / Runtime  │    │     Store        │    │   Cloud       │
└─────────────┘    └──────────────────┘    └──────────────┘
                          │
                          ▼ (fallback)
                   ┌──────────────┐
                   │ In-Memory    │
                   │ FeedbackStore│
                   └──────────────┘
```

## SpacetimeConfig in forge.yaml

```yaml
spacetime:
  host: https://spacetimedb.com
  db_name: forge-prod
```

When `spacetime` is not configured, the runtime uses the in-memory `FeedbackStore` by default.