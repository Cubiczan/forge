<p align="center">
  <img src="docs/images/forge-hero.png" alt="Forge Dashboard — Overview Tab" width="800">
</p>

<h1 align="center">Forge</h1>

<p align="center">
  <strong>Self-Improving Agent System for Production Deployment</strong><br>
  Multi-agent pipeline with a feedback flywheel that continuously improves from deployment outcomes.
</p>

<p align="center">
  <a href="#architecture">Architecture</a> &middot;
  <a href="#dashboard">Dashboard</a> &middot;
  <a href="#getting-started">Getting Started</a> &middot;
  <a href="#packages">Packages</a> &middot;
  <a href="#roadmap">Roadmap</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Rust-1.75+-DEA584?logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white" alt="Next.js">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License">
</p>

---

## What is Forge?

Forge is an open-source, self-improving agent system that deploys production software. It combines a **multi-agent pipeline** (Planner → Coder ⇄ Reviewer → Deployer → Verifier) with a **Feedback Flywheel** that continuously improves every component based on real deployment outcomes.

Inspired by [Factory.ai](https://factory.ai) but built with a fundamentally different architecture: **Forge closes the feedback loop.** Every deployment outcome feeds back to improve agent prompts, routing weights, and validation criteria — turning one-shot deployments into a compounding quality flywheel.

### Key Differentiator vs Factory.ai

| Dimension | Factory.ai | Forge |
|-----------|-----------|-------|
| Pipeline | Fixed linear pipeline | DAG-based with conditional routing |
| Learning | Static prompts, manual tuning | Automatic prompt/routing improvement from feedback |
| Validation | Pre-defined rules | Evolving validation criteria shaped by outcomes |
| Data store | Proprietary | SpacetimeDB (real-time, native Rust+TS SDKs) |
| Architecture | Monolithic | Turborepo monorepo, Rust orchestrator, TS runtime |
| Durability | Standard execution | Workflow SDK step/replay for crash recovery |

---

## Architecture

Forge is structured as a layered system with six distinct layers, each responsible for a clear concern:

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

### Pipeline Flow

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
│  Coder   │ ←→  │ Reviewer  │   Loop up to 3× if review fails
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

### Monorepo Structure

```
forge/
├── packages/
│   ├── runtime/          # TypeScript — Agent execution, pipeline DAG, model router, tools, feedback
│   ├── orchestrator/     # Rust — Container lifecycle management via gRPC
│   ├── cli/              # TypeScript — forge CLI (run, review, deploy, status, init)
│   ├── targets/          # TypeScript — Deploy target plugins (rust-service, python-api)
│   └── web/              # TypeScript — Next.js 16 dashboard (planned)
├── docs/
│   └── images/           # Screenshots and diagrams
├── Cargo.toml            # Rust workspace root
├── forge.yaml.example    # Project configuration template
├── turbo.json            # Turborepo pipeline config
├── docker-compose.yaml   # Local dev environment (SpacetimeDB, orchestrator, runtime)
├── package.json          # Root package.json (workspace)
├── tsconfig.base.json    # Shared TypeScript config
├── SCOPE.md              # Detailed scope and design document
└── README.md             # This file
```

---

## Dashboard

The Forge web dashboard provides real-time visibility into every aspect of the agent system. Built with Next.js 16, Tailwind CSS v4, shadcn/ui, and Recharts — featuring a dark theme with emerald primary and amber accent colors.

### Overview Tab

The main dashboard shows KPI cards for total pipeline runs, success rate, active agents, and average latency. Below, a bar chart tracks daily pipeline run volume and an area chart shows latency trends over the past 7 days. Agent health progress bars and a recent runs table complete the view.

<p align="center">
  <img src="docs/images/forge-overview.png" alt="Overview Tab" width="800">
</p>

### Pipelines Tab

An interactive SVG DAG visualization shows the pipeline flow from Planner through the Coder ⇄ Reviewer loop to Deployer and Verifier, with animated flow lines and a dashed feedback loop path. A searchable run history table shows every pipeline execution with status, latency, and timing.

<p align="center">
  <img src="docs/images/forge-pipelines.png" alt="Pipelines Tab" width="800">
</p>

### Agents Tab

Individual agent cards display per-agent metrics including success rate progress bars, total runs, average latency, and token consumption (in/out). Each agent type has a distinct color: Planner (cyan), Coder (emerald), Reviewer (violet), Deployer (amber), Verifier (rose).

<p align="center">
  <img src="docs/images/forge-agents.png" alt="Agents Tab" width="800">
</p>

### Feedback Tab

The feedback flywheel visualization includes a grouped bar chart comparing Anthropic vs OpenAI routing weights across task types, a success rate trend area chart, routing details table, and a recent feedback feed with color-coded outcome indicators.

<p align="center">
  <img src="docs/images/forge-feedback.png" alt="Feedback Tab" width="800">
</p>

### Deployments Tab

Three deployment target type cards (Rust Service, Python API, Docker) are shown with KPI summaries. A deployment history table tracks every deployment with status, commit SHA, and timing. A rollback alert card highlights recent rollbacks with reasons.

<p align="center">
  <img src="docs/images/forge-deployments.png" alt="Deployments Tab" width="800">
</p>

---

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | TypeScript 5.7, Node.js 22 | Agent execution, pipeline engine, model routing |
| Orchestrator | Rust (tokio, tonic 0.12, prost 0.13) | Container lifecycle via gRPC |
| CLI | TypeScript, Commander.js | User-facing command-line interface |
| Deploy Targets | TypeScript, plugin system | Pluggable deployment backends |
| Web Dashboard | Next.js 16, Tailwind CSS v4, shadcn/ui, Recharts | Real-time monitoring and control |
| State/Feedback | SpacetimeDB (planned) | Real-time persistence with Rust+TS SDKs |
| Container Orch | Docker SDK (planned) | Build, push, and manage containers |
| Pipeline | Custom DAG engine | Topological sort, conditional edges |
| Durability | Workflow SDK (planned) | Step/replay for crash recovery |
| Build System | Turborepo, tsup | Monorepo build orchestration |
| Config | YAML + Zod validation | Project configuration |

---

## Packages

### `@forge/runtime` (~2,500 LOC)

The core engine. Contains the agent base class, all five agent implementations (Planner, Coder, Reviewer, Deployer, Verifier), the DAG-based pipeline engine with conditional routing, the model router with weighted selection and self-tuning, a plugin-based tool executor, and the in-memory feedback store.

**Key exports:**
- `PipelineEngine` — DAG-based pipeline execution with Coder ⇄ Reviewer loop
- `ModelRouter` — Multi-provider routing (Anthropic, OpenAI) with per-task weights
- `BaseAgent` → `PlannerAgent`, `CoderAgent`, `ReviewerAgent`, `DeployerAgent`, `VerifierAgent`
- `ToolExecutorImpl` — Built-in tools: `file_read`, `file_write`, `shell_exec`, `search`, `http_check`
- `FeedbackStore` — In-memory feedback collection (SpacetimeDB-ready interface)
- `DurablePipeline` — Workflow SDK wrapper for crash-resilient execution (scaffold)
- `loadForgeConfig` — YAML config loader with Zod validation

### `forge-orchestrator` (~800 LOC, Rust)

The Rust orchestrator provides container lifecycle management through a gRPC service. It defines a `ContainerManager` trait for abstraction, ships with an in-memory mock implementation, and exposes 8 RPCs: CreateContainer, ExecCommand, StreamCommand, DestroyContainer, GetContainerStatus, BuildImage, PushImage, and GetResourceUsage.

**Key components:**
- `OrchestratorService<M: ContainerManager>` — Generic gRPC service implementation
- `ContainerManager` trait — Pluggable backend (InMemory, Docker planned)
- `proto/orchestrator.proto` — Full gRPC service definition with streaming support
- `error.rs` — Typed error enum with gRPC status code mapping

### `@forge/cli` (~726 LOC)

Command-line interface built with Commander.js. Provides `forge init` (project scaffolding — functional), `forge run` (pipeline execution — partially functional), and placeholder commands for `review`, `deploy`, and `status`.

**Commands:**
- `forge init` — Creates project structure with `forge.yaml` config ✅
- `forge run` — Executes the full pipeline with model routing ⚠️
- `forge review` — Standalone code review (placeholder)
- `forge deploy` — Deploy to target (placeholder)
- `forge status` — Show project status (placeholder)

### `@forge/targets` (~562 LOC)

Plugin-based deployment target system. Ships with two target plugins and a registry pattern for extensibility.

**Included targets:**
- `RustServiceTarget` — Cargo build → Dockerfile generation → Docker image build
- `PythonApiTarget` — pip install → pytest → Dockerfile generation → Docker image build

Both targets implement the `DeployTarget` interface with `validate()`, `build()`, `deploy()`, `rollback()`, and `healthCheck()` methods. Currently, `deploy()` only builds Docker images (registry push is stubbed), and `rollback()` returns a placeholder success.

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 22.0.0
- **Bun** ≥ 1.2.0 (package manager)
- **Rust** ≥ 1.75 (for orchestrator)
- **Docker** (for deployment targets)

### Installation

```bash
# Clone the repository
git clone https://github.com/icohangar-ops/forge.git
cd forge

# Install dependencies
bun install

# Build all packages
bun run build

# Build the Rust orchestrator
cargo build --release -p forge-orchestrator
```

### Quick Start

```bash
# Initialize a new Forge project
bun run --filter @forge/cli dev -- init my-project

# Run the pipeline
cd my-project
bun run --filter @forge/cli dev -- run "Add rate limiting to the API gateway"
```

### Configuration

Create a `forge.yaml` in your project root (or use `forge init` to generate one):

```yaml
name: my-project
language: rust

agents:
  planner:
    model: claude-sonnet-4-20250514
    max_tokens: 4096
    temperature: 0.2
  coder:
    model: claude-sonnet-4-20250514
    max_tokens: 8192
    temperature: 0.2
  reviewer:
    model: gpt-4o
    max_tokens: 4096
    temperature: 0.1
    max_review_rounds: 3
  deployer:
    model: claude-sonnet-4-20250514
    max_tokens: 4096
    temperature: 0.1
  verifier:
    model: claude-sonnet-4-20250514
    max_tokens: 4096
    temperature: 0.1

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

### Environment Variables

| Variable | Description | Default |
|----------|------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude models | — |
| `OPENAI_API_KEY` | OpenAI API key for GPT models | — |
| `FORGE_NO_DURABLE` | Set to `1` to skip Workflow SDK durability | — |
| `RUST_LOG` | Rust logging level for orchestrator | `info` |

---

## Current Status

### What Works

- **Type system** — Comprehensive TypeScript types for the entire system
- **Agent framework** — BaseAgent with tool-use loop, all 5 agent implementations
- **Pipeline engine** — DAG execution with conditional routing and Coder ⇄ Reviewer loop
- **Model router** — Weighted multi-provider routing with self-tuning from feedback
- **Config system** — YAML + Zod validation with `forge init` scaffolding
- **Tool executor** — Plugin architecture with file, shell, search, and HTTP tools
- **Feedback store** — In-memory collection with aggregation (DB-swap ready interface)
- **Rust orchestrator** — gRPC service with in-memory mock container manager
- **CLI** — `forge init` and `forge run` commands
- **Deploy targets** — Rust service and Python API plugins (build phase)
- **Web dashboard** — 5-tab monitoring dashboard with charts, DAG, and tables

### Known Limitations (Phase 1)

- **SpacetimeDB integration** — Not yet implemented; feedback store is in-memory only
- **Docker container manager** — Only in-memory mock exists; no real container orchestration
- **Workflow SDK durability** — DurablePipeline is a scaffold; the `workflow` package needs real implementation
- **CLI commands** — `review`, `deploy`, and `status` are placeholders
- **Security** — Shell command allowlist needs hardening against injection attacks
- **No tests** — Test infrastructure is configured but no test files exist yet
- **No CI/CD** — No GitHub Actions or automated workflows

---

## Roadmap

### Phase 1: Core Runtime ✅ (Current)
- [x] Architecture & scope document
- [x] Agent base class + all 5 agents
- [x] Model Router (multi-provider, per-task, self-tuning weights)
- [x] Pipeline Engine (DAG execution, conditional edges, Coder ⇄ Reviewer loop)
- [x] Tool executor (file_read, file_write, shell_exec, search, http_check)
- [x] Feedback store (in-memory, SpacetimeDB-ready interface)
- [x] Config loader (forge.yaml with Zod validation)
- [x] Workflow SDK integration scaffold (durable pipeline with step/replay)
- [x] CLI scaffold (forge init, run, review, deploy, status)
- [x] Deploy target plugins (rust-service, python-api)
- [x] Rust orchestrator (gRPC, container trait, in-memory impl)
- [x] Web dashboard (Next.js 16, 5 tabs, SVG DAG, charts)

### Phase 2: Validation & Real Deployment
- [ ] Docker `ContainerManager` implementation for the orchestrator
- [ ] SpacetimeDB module with schema and reducers
- [ ] Real deploy + registry push in target plugins
- [ ] Automatic rollback on verification failure
- [ ] Functional `forge deploy` and `forge status` CLI commands

### Phase 3: Monitoring & Feedback
- [ ] SpacetimeDB reducer for routing weight auto-tuning
- [ ] Real-time dashboard subscriptions via SpacetimeDB
- [ ] Deployment history and outcome tracking
- [ ] Alerting on success rate degradation

### Phase 4: Self-Improvement
- [ ] Prompt versioning and A/B testing
- [ ] Automatic prompt tuning from feedback patterns
- [ ] Agent prompt promotion/demotion based on outcomes
- [ ] Quality score dashboards

### Phase 5: Multi-Agent & Scale
- [ ] Custom agent registration (user-defined agents)
- [ ] Parallel agent execution in pipeline
- [ ] Kubernetes-native deployment target
- [ ] SaaS multi-tenancy
- [ ] Team collaboration features

---

## Development

### Monorepo Commands

```bash
# Build all packages
bun run build

# Development mode (watch)
bun run dev

# Lint all packages
bun run lint

# Run tests
bun run test

# Clean all build artifacts
bun run clean
```

### Building the Rust Orchestrator

```bash
# Debug build
cargo build -p forge-orchestrator

# Release build
cargo build --release -p forge-orchestrator

# Run the gRPC server
cargo run -p forge-orchestrator --bin server

# Run with logging
RUST_LOG=debug cargo run -p forge-orchestrator --bin server
```

### Project Configuration

The `turbo.json` defines the build pipeline with persistent task caching. Each package has its own `tsconfig.json` extending the base configuration. The Rust workspace is configured in the root `Cargo.toml`.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

Please read `SCOPE.md` for the full architectural vision and design decisions before contributing.

---

## MAPS Integration

<p align="center">
  <img src="https://img.shields.io/badge/Built%20with-MAPS%20%7C%20Multi-Agent%20Pipeline%20Skills-blue" alt="MAPS" />
</p>

Forge's multi-agent pipeline architecture maps directly to the [MAPS framework](https://mojoaistudio.com/maps/) (Multi-Agent Pipeline Skills) for structured agent system development.

### M Layer (Multi-Agent System) — Phase Mapping

| MAPS Phase | Forge Component |
|------------|-----------------|
| **M0 Foundation** | `forge.yaml` project config — intent, runtime constraints, model bindings |
| **M1 System Shape** | Multi-Agent track — Planner → Coder ⇄ Reviewer → Deployer → Verifier |
| **M2 Roster** | 5 specialized agents defined in `@forge/runtime` |
| **M3 Contracts** | DAG pipeline edges, Coder ⇄ Reviewer loop contract (max 3 rounds) |
| **M4 Coordination** | DAG-based conditional routing via topological sort |
| **M5 Agent Buildout** | Each agent extends `BaseAgent` with versioned prompts, tools, model bindings |
| **M6 Capabilities** | Tool executor plugin system (file, shell, search, HTTP) |
| **M7 Orchestration** | `PipelineEngine` DAG execution with conditional edges |
| **M8 Experience** | Next.js 16 dashboard (5 tabs: Overview, Pipelines, Agents, Feedback, Deployments) |
| **M9 Evaluate** | Verifier agent health checks + smoke tests |
| **M10 Deploy** | Deploy target plugins (Rust Service, Python API, Docker) |
| **M11 Improve** | Feedback Flywheel — outcome analysis → prompt tuning → weight adjustment |

### APS Layer (Per-Agent Pipeline)

Each Forge agent follows the MAPS APS lifecycle:

```
A1 Define ─▶ A2 Design ─▶ A3 Build ─▶ A4 Equip ─▶ A5 Evaluate ─▶ A6 Deploy ─▶ A7 Observe ─▶ A8 Improve
```

- **Define (A1)**: Agent brief — role, model binding, temperature, max tokens in `forge.yaml`
- **Design (A2)**: Agent interface via `BaseAgent` — tool set, prompt template, routing profile
- **Build (A3)**: Implementation in `@forge/runtime` with typed inputs/outputs
- **Equip (A4)**: Tool executor assignment, model router weights, capability map
- **Evaluate (A5)**: Reviewer agent with Coder ⇄ Reviewer loop (max 3 rounds), Verifier smoke tests
- **Deploy (A6)**: Deploy target plugin execution (Docker image build, registry push)
- **Observe (A7)**: Dashboard monitoring — per-agent success rate, latency, token consumption
- **Improve (A8)**: Feedback Flywheel — routing weight auto-tuning, prompt versioning from outcomes

### Recommended MAPS Skills

| Skill | Use Case |
|-------|----------|
| `/foundation` | Initialize Forge project with MAPS M0 preflight |
| `/shape` | Validate Multi-Agent track decision |
| `/define-agent` | Brief new custom agents for Phase 5 (user-defined agents) |
| `/build-agent++` | Incremental agent development with TDD for new agent types |
| `/equip-agent` | Capability mapping for tool permissions and model bindings |
| `/evaluate-agent++` | LangSmith/Phoenix tracing for agent eval suites |
| `/observe-agent` | Dashboard + trace integration for production monitoring |
| `/improve-agent` | Improvement backlog driven by flywheel outcomes |

---

## License

MIT

---

## Credit

Forge draws architectural inspiration from [Factory.ai](https://factory.ai)'s pioneering work on AI-powered software deployment. We extend their vision by making the system self-improving through a closed feedback loop — every deployment makes the next one better.