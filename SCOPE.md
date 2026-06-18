# Forge — Self-Improving Agent System for Production Deployment

> Inspired by [Factory.ai](https://factory.ai) but built with a fundamentally different architecture:
> **Forge closes the feedback loop.** Every deployment outcome feeds back to improve agent prompts,
> routing weights, and validation criteria — turning one-shot deployments into a compounding
> quality flywheel.

---

## 1. Vision

Forge is an open-source, self-improving agent system that deploys production software.
It combines a multi-agent pipeline (Planner → Coder → Reviewer → Deployer → Verifier) with a
**Feedback Flywheel** that continuously improves every component based on real deployment outcomes.

### Key Differentiator vs Factory.ai

| Dimension | Factory.ai | Forge |
|-----------|-----------|-------|
| Pipeline | Fixed linear pipeline | DAG-based with conditional routing |
| Learning | Static prompts, manual tuning | Automatic prompt/routing improvement from feedback |
| Validation | Pre-defined rules | Evolving validation criteria shaped by outcomes |
| Data store | Proprietary | SpacetimeDB (real-time, native Rust+TS SDKs) |
| Architecture | Monolithic | Turborepo monorepo, Rust orchestrator, TS runtime |

---

## 2. Architecture

### 2.1 Five Layers

```
┌─────────────────────────────────────────────────────────┐
│                   Web Dashboard (Next.js)                │
│              Real-time status, feedback viz              │
├─────────────────────────────────────────────────────────┤
│                  Feedback Flywheel                        │
│     Outcome analysis → Prompt tuning → Weight adjustment  │
├─────────────────────────────────────────────────────────┤
│                   Pipeline Engine (DAG)                   │
│    Planner → Coder ⇄ Reviewer → Deployer → Verifier      │
├─────────────────────────────────────────────────────────┤
│                    Agent Pool                             │
│  Versioned prompts, tool sets, model bindings, profiles  │
├─────────────────────────────────────────────────────────┤
│              Substrate (Runtime + Routing)                │
│  Model Router │ Tool Executor │ SpacetimeDB │ gRPC       │
├─────────────────────────────────────────────────────────┤
│              Orchestrator (Rust)                          │
│         Container lifecycle via gRPC                      │
├─────────────────────────────────────────────────────────┤
│              Deployment Targets (Plugins)                 │
│       rust-service │ python-api │ docker │ k8s           │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Monorepo Structure

```
forge/
├── packages/
│   ├── runtime/          # TypeScript — Agent execution, pipeline DAG, model router, tools, feedback
│   ├── orchestrator/     # Rust — Container lifecycle management via gRPC
│   ├── cli/              # TypeScript — forge CLI (run, review, deploy, status)
│   ├── targets/          # TypeScript — Deploy target plugins (rust-service, python-api)
│   └── web/              # TypeScript — Next.js SaaS dashboard
├── Cargo.toml            # Rust workspace root
├── forge.yaml.example    # Project configuration template
├── turbo.json            # Turborepo pipeline config
├── docker-compose.yaml   # Local dev environment (SpacetimeDB, orchestrator, runtime)
├── package.json          # Root package.json (workspace)
├── tsconfig.base.json    # Shared TypeScript config
└── SCOPE.md              # This file
```

---

## 3. SpacetimeDB — The Feedback and State Store

### Why SpacetimeDB over Postgres

- **Native Rust + TypeScript SDKs** — no ORM impedance mismatch, the orchestrator (Rust) and
  runtime (TS) both talk to the same database with first-class SDKs
- **Real-time subscriptions** — the web dashboard subscribes to deployment/feedback updates
  without polling or WebSockets boilerplate
- **Module system** — improvement logic (prompt tuning, weight adjustment) runs *where the data
  lives*, reducing round-trips and enabling atomic read-analyze-write cycles
- **Embedded for dev, hosted for prod** — zero-config local development, seamless production
  deployment

### Schema (SpacetimeDB Module)

```rust
// packages/orchestrator/src/spacetime_module/src/lib.rs

// --- Core Tables ---

table AgentRuns {
    id: string,
    pipeline_id: string,
    agent_name: string,
    agent_version: string,
    model_provider: string,
    model_id: string,
    input_summary: string,
    output_summary: string,
    tokens_in: u32,
    tokens_out: u32,
    latency_ms: u64,
    status: string,       // "running" | "success" | "error" | "rejected"
    error_message: Option<string>,
    started_at: u64,      // unix epoch ms
    completed_at: Option<u64>,
}

table Deployments {
    id: string,
    pipeline_id: string,
    target_type: string,
    target_config: string,  // JSON
    status: string,         // "pending" | "building" | "deploying" | "live" | "rolled_back" | "failed"
    commit_sha: Option<string>,
    started_at: u64,
    completed_at: Option<u64>,
    health_check_url: Option<string>,
    rollback_reason: Option<string>,
}

table Feedback {
    id: string,
    deployment_id: string,
    agent_run_id: string,
    feedback_type: string,      // "auto_verify" | "manual_review" | "monitoring_alert" | "user_report"
    outcome: string,            // "success" | "partial" | "failure"
    score: f64,                 // 0.0 – 1.0
    signal_data: string,        // JSON — structured feedback payload
    created_at: u64,
}

table AgentVersions {
    agent_name: string,
    version: string,
    system_prompt_hash: string,
    tool_set_hash: string,
    model_binding: string,
    is_active: bool,
    created_at: u64,
    promoted_by_feedback_id: Option<string>,
}

table RoutingWeights {
    task_type: string,
    provider: string,
    model_id: string,
    weight: f64,
    success_count: u32,
    total_count: u32,
    last_updated_at: u64,
}
```

### Improvement Module (runs inside SpacetimeDB)

The module contains reducers that fire on `Feedback` inserts and automatically:

1. **Update routing weights** — if a model produces failures, its weight decreases; successes increase it
2. **Flag agent prompts for review** — when success rate drops below threshold for an agent version
3. **Track deployment health** — aggregate signals per target type and agent configuration

---

## 4. Pipeline Engine

### Phase 1 DAG

```
User Request
    │
    ▼
┌──────────┐
│ Planner  │  → Decomposes request into tasks, selects agents, builds execution plan
└────┬─────┘
     │
     ▼
┌──────────┐     ┌───────────┐
│  Coder   │ ←→  │ Reviewer  │   Loop up to 3x if review fails
└────┬─────┘     └─────┬─────┘
     │  pass            │ pass
     ▼                  │
┌──────────┐            │
│ Deployer │ ←──────────┘
└────┬─────┘
     │
     ▼
┌──────────┐
│ Verifier │  → Health checks, smoke tests, rollback on failure
└────┬─────┘
     │
     ▼
┌──────────┐
│ Feedback │  → All outcomes recorded, flywheel activated
│  Store   │
└──────────┘
```

### Conditional Routing

- Coder → Reviewer → (fail) → Coder (max 3 iterations, then halt with error)
- Deployer → Verifier → (fail) → automatic rollback → Feedback (failure signal)
- Any agent error → Feedback (error signal) → pipeline may continue or abort based on severity

### Durability via Workflow SDK

The pipeline is **durable by default** using the [Workflow SDK](https://workflow-sdk.dev/) by Vercel.
Each agent execution is a Workflow SDK `step()`, giving these guarantees:

| Scenario | Without Workflow SDK | With Workflow SDK |
|----------|---------------------|-------------------|
| Process crashes during Coder | Restart entire pipeline from scratch | Resume at Coder step (Planner result replayed from event log) |
| Reviewer times out on round 2 of 3 | Re-run all 3 rounds | Resume at round 2 with correct loop state |
| Deploy succeeds but Verifier crashes | Redeploy (wasteful) | Skip deploy, run Verifier only |
| Network blip during LLM call | Unhandled timeout | RetryableError triggers automatic retry |

The `DurablePipeline` class in `packages/runtime/src/durable/index.ts` wraps each agent
execution in a workflow step. The CLI uses it by default (set `FORGE_NO_DURABLE=1` to
opt out). For production SaaS deployment, use `@workflow/next` to wrap API routes.

---

## 5. Model Router

Multi-provider routing with self-tuning weights:

- **Providers**: Anthropic (Claude), OpenAI (GPT-4, o-series)
- **Routing strategy**: Per-task-type routing (planning → Claude Opus, coding → Claude Sonnet, review → GPT-4o, etc.)
- **Self-tuning**: `RoutingWeights` table in SpacetimeDB adjusts based on feedback outcomes
- **Fallback chain**: If primary model fails, automatically falls back to secondary

---

## 6. Agents

Each agent is defined by:

- **System prompt** — versioned, stored in `.forge/agents/{name}/prompt.md`
- **Tool set** — which tools the agent can invoke (file read/write, shell exec, HTTP, etc.)
- **Model binding** — which model/provider to use (can be overridden by router)
- **Feedback profile** — what signals to capture for this agent type

### Built-in Agents (Phase 1)

| Agent | Role | Primary Model | Tools |
|-------|------|--------------|-------|
| Planner | Decompose request, build plan | claude-sonnet-4-20250514 | file_read, search |
| Coder | Write/modify code | claude-sonnet-4-20250514 | file_read, file_write, shell_exec, search |
| Reviewer | Code review, quality gates | gpt-4o | file_read, search |
| Deployer | Build and deploy to target | claude-sonnet-4-20250514 | shell_exec, file_read |
| Verifier | Post-deploy health checks | claude-sonnet-4-20250514 | http_check, shell_exec |

---

## 7. Configuration — forge.yaml

```yaml
name: my-project
language: rust

agents:
  coder:
    model: claude-sonnet-4-20250514
    max_tokens: 8192
    temperature: 0.2
  reviewer:
    model: gpt-4o
    max_tokens: 4096
    temperature: 0.1
    max_review_rounds: 3

deploy:
  target: rust-service
  config:
    registry: ghcr.io
    image_prefix: myorg/

runtime:
  max_pipeline_duration_ms: 600000  # 10 minutes
  max_agent_tokens: 16384
  max_shell_commands: 50
  allowed_shell_commands:
    - cargo
    - rustc
    - docker
    - kubectl
    - npm
    - bun
    - python3
    - git
```

---

## 8. Build Phases

### Phase 1: Core Runtime ✦ (Current)
- [x] Architecture & scope
- [x] Agent base class + all 5 agents (Planner, Coder, Reviewer, Deployer, Verifier)
- [x] Model Router (multi-provider, per-task, self-tuning weights)
- [x] Pipeline Engine (DAG execution, conditional edges, Coder↔Reviewer loop)
- [x] Tool executor (file_read, file_write, shell_exec, search, http_check)
- [x] Feedback store (in-memory, SpacetimeDB-ready interface)
- [x] Config loader (forge.yaml with Zod validation)
- [x] Workflow SDK integration (durable pipeline with step/replay)
- [x] CLI scaffold (forge init, run, review, deploy, status)
- [x] Deploy target plugins (rust-service, python-api)
- [x] Rust orchestrator (gRPC, container trait, in-memory impl)

### Phase 2: Validation + Deploy
- [ ] Deployer agent
- [ ] Verifier agent (health checks, smoke tests)
- [ ] Deploy target plugins (rust-service, python-api)
- [ ] Automatic rollback on verification failure

### Phase 3: Monitoring + Feedback
- [ ] Feedback store (SpacetimeDB reducers)
- [ ] Routing weight auto-tuning
- [ ] Web dashboard (Next.js) — real-time pipeline visualization
- [ ] Deployment history and outcome tracking

### Phase 4: Self-Improvement
- [ ] Prompt versioning and A/B testing
- [ ] Automatic prompt tuning from feedback patterns
- [ ] Agent prompt promotion/demotion based on outcomes
- [ ] Quality score dashboards

### Phase 5: Multi-Agent + Scale
- [ ] Custom agent registration (user-defined agents)
- [ ] Parallel agent execution in pipeline
- [ ] Kubernetes-native deployment target
- [ ] SaaS multi-tenancy
- [ ] Team collaboration features

---

## 9. Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | TypeScript 5, Node.js 22 |
| Orchestrator | Rust (tokio, tonic for gRPC) |
| CLI | TypeScript, commander.js |
| Web Dashboard | Next.js 16, Tailwind CSS, shadcn/ui |
| State/Feedback | SpacetimeDB (Rust + TS SDKs) |
| Container Orch | Docker SDK, future: Kubernetes client |
| Pipeline | Custom DAG engine (topological sort, conditional edges) |
| Durability | [Workflow SDK](https://workflow-sdk.dev/) (step, sleep, hooks, replay) |
| Build System | Turborepo |

---

## 10. Credit

Forge draws architectural inspiration from [Factory.ai](https://factory.ai)'s pioneering work on
AI-powered software deployment. We extend their vision by making the system self-improving through
a closed feedback loop — every deployment makes the next one better.