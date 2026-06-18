//! Forge SpacetimeDB Module
//!
//! Persistent storage layer for the Forge self-improving agent system.
//!
//! ## Tables
//! - `agent_runs`  — every agent execution within a pipeline
//! - `deployments` — deployment lifecycle tracking
//! - `feedback`    — feedback entries driving the self-improvement flywheel
//! - `agent_versions` — agent config versioning
//! - `routing_weights` — model routing weights updated by feedback

use spacetimedb::{ReducerContext, SpacetimeType, Table};

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

/// Every agent execution within a pipeline.
#[spacetimedb::table(name = "agent_runs", accessor = agent_runs)]
pub struct AgentRuns {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[index(btree)]
    pub run_id: String,

    #[index(btree)]
    pub pipeline_id: String,

    #[index(btree)]
    pub agent_name: String,

    pub agent_version: String,
    pub model_provider: String,
    pub model_id: String,
    pub input_summary: String,
    pub output_summary: String,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub latency_ms: u32,

    #[index(btree)]
    pub status: String,

    pub error_message: Option<String>,
    pub started_at: i64,
    pub completed_at: Option<i64>,
}

/// Deployment lifecycle tracking.
#[spacetimedb::table(name = "deployments", accessor = deployments)]
pub struct Deployments {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[index(btree)]
    pub deployment_id: String,

    #[index(btree)]
    pub pipeline_id: String,

    pub target_type: String,
    pub target_config_json: String,

    #[index(btree)]
    pub status: String,

    pub commit_sha: Option<String>,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub health_check_url: Option<String>,
    pub rollback_reason: Option<String>,
}

/// Feedback entries — core signal for the self-improvement flywheel.
#[spacetimedb::table(name = "feedback", accessor = feedback)]
pub struct Feedback {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[index(btree)]
    pub deployment_id: String,

    #[index(btree)]
    pub agent_run_id: String,

    pub feedback_type: String,
    pub outcome: String,
    pub score: f64,
    pub signal_data_json: String,
    pub created_at: i64,
}

/// Agent config versioning for the self-improvement loop.
#[spacetimedb::table(name = "agent_versions", accessor = agent_versions)]
pub struct AgentVersions {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[index(btree)]
    pub agent_name: String,

    #[index(btree)]
    pub version: String,

    pub config_json: String,
    pub created_at: i64,

    #[index(btree)]
    pub is_active: bool,
}

/// Model routing weights updated by the feedback flywheel.
#[spacetimedb::table(name = "routing_weights", accessor = routing_weights)]
pub struct RoutingWeights {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[index(btree)]
    pub agent_type: String,

    pub provider: String,
    pub model_id: String,
    pub weight: f64,
    pub success_rate: f64,
    pub sample_count: u32,
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// Reducer argument types
// ---------------------------------------------------------------------------

#[derive(SpacetimeType)]
pub struct AgentRunInput {
    pub run_id: String,
    pub pipeline_id: String,
    pub agent_name: String,
    pub agent_version: String,
    pub model_provider: String,
    pub model_id: String,
    pub input_summary: String,
    pub output_summary: String,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub latency_ms: u32,
    pub status: String,
    pub error_message: Option<String>,
    pub started_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(SpacetimeType)]
pub struct DeploymentInput {
    pub deployment_id: String,
    pub pipeline_id: String,
    pub target_type: String,
    pub target_config_json: String,
    pub status: String,
    pub commit_sha: Option<String>,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub health_check_url: Option<String>,
    pub rollback_reason: Option<String>,
}

#[derive(SpacetimeType)]
pub struct FeedbackInput {
    pub deployment_id: String,
    pub agent_run_id: String,
    pub feedback_type: String,
    pub outcome: String,
    pub score: f64,
    pub signal_data_json: String,
}

#[derive(SpacetimeType)]
pub struct RoutingWeightInput {
    pub agent_type: String,
    pub provider: String,
    pub model_id: String,
    pub weight: f64,
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn record_agent_run(ctx: &ReducerContext, input: AgentRunInput) {
    ctx.db.agent_runs().insert(AgentRuns {
        id: 0,
        run_id: input.run_id,
        pipeline_id: input.pipeline_id,
        agent_name: input.agent_name,
        agent_version: input.agent_version,
        model_provider: input.model_provider,
        model_id: input.model_id,
        input_summary: input.input_summary,
        output_summary: input.output_summary,
        tokens_in: input.tokens_in,
        tokens_out: input.tokens_out,
        latency_ms: input.latency_ms,
        status: input.status,
        error_message: input.error_message,
        started_at: input.started_at,
        completed_at: input.completed_at,
    });
}

#[spacetimedb::reducer]
pub fn record_deployment(ctx: &ReducerContext, input: DeploymentInput) {
    ctx.db.deployments().insert(Deployments {
        id: 0,
        deployment_id: input.deployment_id,
        pipeline_id: input.pipeline_id,
        target_type: input.target_type,
        target_config_json: input.target_config_json,
        status: input.status,
        commit_sha: input.commit_sha,
        started_at: input.started_at,
        completed_at: input.completed_at,
        health_check_url: input.health_check_url,
        rollback_reason: input.rollback_reason,
    });
}

#[spacetimedb::reducer]
pub fn submit_feedback(ctx: &ReducerContext, input: FeedbackInput) {
    let agent_run = ctx
        .db
        .agent_runs()
        .run_id()
        .filter(&input.agent_run_id)
        .next();

    let now_ms = to_millis(ctx.timestamp);

    ctx.db.feedback().insert(Feedback {
        id: 0,
        deployment_id: input.deployment_id.clone(),
        agent_run_id: input.agent_run_id.clone(),
        feedback_type: input.feedback_type.clone(),
        outcome: input.outcome.clone(),
        score: input.score,
        signal_data_json: input.signal_data_json,
        created_at: now_ms,
    });

    if let Some(run) = agent_run {
        recalculate_weights(
            ctx,
            &run.agent_name,
            &run.model_provider,
            &run.model_id,
            &input.outcome,
        );
    }
}

#[spacetimedb::reducer]
pub fn update_routing_weight(ctx: &ReducerContext, input: RoutingWeightInput) {
    let now_ms = to_millis(ctx.timestamp);

    let existing = ctx
        .db
        .routing_weights()
        .iter()
        .find(|rw| {
            rw.agent_type == input.agent_type
                && rw.provider == input.provider
                && rw.model_id == input.model_id
        });

    if let Some(mut row) = existing {
        row.weight = input.weight;
        row.updated_at = now_ms;
        ctx.db.routing_weights().id().update(row);
    } else {
        ctx.db.routing_weights().insert(RoutingWeights {
            id: 0,
            agent_type: input.agent_type,
            provider: input.provider,
            model_id: input.model_id,
            weight: input.weight,
            success_rate: 0.0,
            sample_count: 0,
            updated_at: now_ms,
        });
    }
}

#[spacetimedb::reducer]
pub fn activate_agent_version(
    ctx: &ReducerContext,
    agent_name: String,
    version: String,
    config_json: String,
) {
    let now_ms = to_millis(ctx.timestamp);

    for mut v in ctx.db.agent_versions().agent_name().filter(&agent_name) {
        if v.is_active {
            v.is_active = false;
            ctx.db.agent_versions().id().update(v);
        }
    }

    let existing = ctx
        .db
        .agent_versions()
        .iter()
        .find(|v| v.agent_name == agent_name && v.version == version);

    if let Some(mut v) = existing {
        v.config_json = config_json;
        v.is_active = true;
        ctx.db.agent_versions().id().update(v);
    } else {
        ctx.db.agent_versions().insert(AgentVersions {
            id: 0,
            agent_name,
            version,
            config_json,
            created_at: now_ms,
            is_active: true,
        });
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn to_millis(ts: spacetimedb::Timestamp) -> i64 {
    ts.to_micros_since_unix_epoch() / 1000
}

fn recalculate_weights(
    ctx: &ReducerContext,
    agent_name: &str,
    model_provider: &str,
    model_id: &str,
    outcome: &str,
) {
    let matching_run_ids: std::collections::HashSet<String> = ctx
        .db
        .agent_runs()
        .iter()
        .filter(|r| {
            r.agent_name == agent_name
                && r.model_provider == model_provider
                && r.model_id == model_id
        })
        .map(|r| r.run_id.clone())
        .collect();

    let mut total_feedback: u32 = 0;
    let mut success_feedback: u32 = 0;

    for fb in ctx.db.feedback().iter() {
        if matching_run_ids.contains(&fb.agent_run_id) {
            total_feedback += 1;
            if fb.outcome == "success" {
                success_feedback += 1;
            }
        }
    }

    let success_rate = if total_feedback > 0 {
        success_feedback as f64 / total_feedback as f64
    } else if outcome == "success" {
        1.0
    } else if outcome == "partial" {
        0.5
    } else {
        0.0
    };

    let weight = success_rate * 100.0;
    let now_ms = to_millis(ctx.timestamp);

    let existing = ctx.db.routing_weights().iter().find(|rw| {
        rw.agent_type == agent_name
            && rw.provider == model_provider
            && rw.model_id == model_id
    });

    if let Some(mut row) = existing {
        row.weight = (row.weight + weight) / 2.0;
        row.success_rate = success_rate;
        row.sample_count = total_feedback;
        row.updated_at = now_ms;
        ctx.db.routing_weights().id().update(row);
    } else {
        ctx.db.routing_weights().insert(RoutingWeights {
            id: 0,
            agent_type: agent_name.to_string(),
            provider: model_provider.to_string(),
            model_id: model_id.to_string(),
            weight,
            success_rate,
            sample_count: total_feedback,
            updated_at: now_ms,
        });
    }
}