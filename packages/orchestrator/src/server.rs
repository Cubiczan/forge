use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use crate::container::ContainerManager;

// Import generated types from the proto build
pub mod proto {
    pub mod orchestrator {
        tonic::include_proto!("forge.orchestrator");
    }
}

use proto::orchestrator::{
    orchestrator_server::{Orchestrator, OrchestratorServer},
    BuildImageRequest, BuildOutput, BuildResult as ProtoBuildResult, CommandOutput,
    CommandResult, ContainerStatusRequest, ContainerStatusResponse, CreateContainerRequest,
    CreateContainerResponse, DestroyContainerRequest, DestroyContainerResponse,
    ExecCommandRequest, ExecCommandResponse, PushImageRequest, PushImageResponse,
    ResourceUsageRequest, ResourceUsageResponse,
};

pub struct OrchestratorService<M: ContainerManager> {
    container_manager: M,
}

impl<M: ContainerManager> OrchestratorService<M> {
    pub fn new(container_manager: M) -> Self {
        Self { container_manager }
    }

    pub fn into_server(self) -> OrchestratorServer<Self> {
        OrchestratorServer::new(self)
    }
}

#[tonic::async_trait]
impl<M: ContainerManager + 'static> Orchestrator for OrchestratorService<M> {
    async fn create_container(
        &self,
        request: Request<CreateContainerRequest>,
    ) -> Result<Response<CreateContainerResponse>, Status> {
        let req = request.into_inner();
        let labels: HashMap<String, String> = req.labels;
        let mounts: Vec<(String, String, bool)> = req
            .mounts
            .into_iter()
            .map(|m| (m.source, m.target, m.read_only))
            .collect();
        let env: Vec<String> = req.env;

        let timeout = Duration::from_secs(req.timeout_seconds.max(1) as u64);

        let container = self
            .container_manager
            .create_container(
                &req.pipeline_id,
                &req.agent_name,
                &req.image,
                &env,
                labels,
                timeout,
                &mounts,
            )
            .await
            .map_err(|e| Status::internal(e))?;

        tracing::info!(
            container_id = %container.id,
            agent = %req.agent_name,
            "Container created"
        );

        Ok(Response::new(CreateContainerResponse {
            container_id: container.id,
            container_name: container.name,
        }))
    }

    async fn exec_command(
        &self,
        request: Request<ExecCommandRequest>,
    ) -> Result<Response<ExecCommandResponse>, Status> {
        let req = request.into_inner();
        let command: Vec<String> = req.command;
        let timeout = Duration::from_secs(req.timeout_seconds.max(1) as u64);

        let result = self
            .container_manager
            .exec_command(
                &req.container_id,
                &command,
                timeout,
                req.working_dir.as_deref(),
            )
            .await
            .map_err(|e| Status::internal(e))?;

        tracing::info!(
            container_id = %req.container_id,
            exit_code = result.exit_code,
            duration_ms = result.duration_ms,
            "Command executed"
        );

        Ok(Response::new(ExecCommandResponse {
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            duration_ms: result.duration_ms as i64,
        }))
    }

    type StreamCommandStream = ReceiverStream<Result<CommandOutput, Status>>;

    async fn stream_command(
        &self,
        request: Request<ExecCommandRequest>,
    ) -> Result<Response<Self::StreamCommandStream>, Status> {
        let req = request.into_inner();
        let container_id = req.container_id.clone();
        let command: Vec<String> = req.command;
        let timeout = Duration::from_secs(req.timeout_seconds.max(1) as u64);
        let working_dir = req.working_dir.clone();

        let (tx, rx) = mpsc::channel(4);

        // Execute inline (no spawn needed — we hold &self and the trait uses &self)
        let result = self
            .container_manager
            .exec_command(&container_id, &command, timeout, working_dir.as_deref())
            .await;

        match result {
            Ok(r) => {
                if !r.stdout.is_empty() {
                    let _ = tx
                        .send(Ok(CommandOutput {
                            output: Some(proto::orchestrator::command_output::Output::Stdout(r.stdout)),
                        }))
                        .await;
                }
                if !r.stderr.is_empty() {
                    let _ = tx
                        .send(Ok(CommandOutput {
                            output: Some(proto::orchestrator::command_output::Output::Stderr(r.stderr)),
                        }))
                        .await;
                }
                let _ = tx
                    .send(Ok(CommandOutput {
                        output: Some(proto::orchestrator::command_output::Output::Result(CommandResult {
                            exit_code: r.exit_code,
                            duration_ms: r.duration_ms as i64,
                        })),
                    }))
                    .await;
            }
            Err(e) => {
                let _ = tx.send(Err(Status::internal(e))).await;
            }
        }

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn destroy_container(
        &self,
        request: Request<DestroyContainerRequest>,
    ) -> Result<Response<DestroyContainerResponse>, Status> {
        let req = request.into_inner();
        let success = self
            .container_manager
            .destroy_container(&req.container_id, req.force)
            .await
            .map_err(|e| Status::internal(e))?;

        tracing::info!(container_id = %req.container_id, "Container destroyed");

        Ok(Response::new(DestroyContainerResponse { success }))
    }

    async fn get_container_status(
        &self,
        request: Request<ContainerStatusRequest>,
    ) -> Result<Response<ContainerStatusResponse>, Status> {
        let req = request.into_inner();
        let container = self
            .container_manager
            .get_container_status(&req.container_id)
            .await
            .map_err(|e| Status::not_found(e))?;

        let status_str = match &container.status {
            crate::container::ContainerStatus::Running => "running",
            crate::container::ContainerStatus::Exited { .. } => "exited",
            crate::container::ContainerStatus::Dead => "dead",
        };

        Ok(Response::new(ContainerStatusResponse {
            container_id: container.id,
            status: status_str.to_string(),
            exit_code: container.exit_code.unwrap_or(0),
            created_at: container.created_at as i64,
            finished_at: container.finished_at.unwrap_or(0) as i64,
        }))
    }

    type BuildImageStream = ReceiverStream<Result<BuildOutput, Status>>;

    async fn build_image(
        &self,
        request: Request<BuildImageRequest>,
    ) -> Result<Response<Self::BuildImageStream>, Status> {
        let req = request.into_inner();
        let (tx, rx) = mpsc::channel(4);

        let build_args: HashMap<String, String> = req.build_args;

        let result = self
            .container_manager
            .build_image(
                &req.dockerfile_path,
                &req.context_path,
                &req.tag,
                build_args,
            )
            .await;

        match result {
            Ok(r) => {
                let _ = tx
                    .send(Ok(BuildOutput {
                        output: Some(proto::orchestrator::build_output::Output::Result(ProtoBuildResult {
                            success: r.success,
                            image_id: r.image_id,
                            duration_ms: r.duration_ms as i64,
                        })),
                    }))
                    .await;
            }
            Err(e) => {
                let _ = tx.send(Err(Status::internal(e))).await;
            }
        }

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn push_image(
        &self,
        request: Request<PushImageRequest>,
    ) -> Result<Response<PushImageResponse>, Status> {
        let req = request.into_inner();
        let result = self
            .container_manager
            .push_image(&req.image_tag, &req.registry, &req.username, &req.password)
            .await
            .map_err(|e| Status::internal(e))?;

        Ok(Response::new(PushImageResponse {
            success: result.success,
            digest: result.digest,
        }))
    }

    async fn get_resource_usage(
        &self,
        request: Request<ResourceUsageRequest>,
    ) -> Result<Response<ResourceUsageResponse>, Status> {
        let req = request.into_inner();
        let usage = self
            .container_manager
            .get_resource_usage(&req.container_id)
            .await
            .map_err(|e| Status::internal(e))?;

        Ok(Response::new(ResourceUsageResponse {
            cpu_usage_nanoseconds: usage.cpu_usage_ns as i64,
            memory_usage_bytes: usage.memory_usage_bytes as i64,
            memory_limit_bytes: usage.memory_limit_bytes as i64,
            network_rx_bytes: usage.network_rx_bytes as i64,
            network_tx_bytes: usage.network_tx_bytes as i64,
        }))
    }
}