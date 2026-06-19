use std::net::SocketAddr;
use tracing_subscriber::EnvFilter;

use forge_orchestrator::server::OrchestratorService;
use forge_orchestrator::superserve::{SuperserveConfig, SuperserveManager};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let addr: SocketAddr = "0.0.0.0:50051".parse()?;
    tracing::info!("Forge Orchestrator starting on {}", addr);

    // Use Superserve Firecracker microVMs for container orchestration.
    // Set SUPERSEEVE_API_KEY env var or pass directly.
    let api_key = std::env::var("SUPERSEEVE_API_KEY")
        .expect("SUPERSEEVE_API_KEY environment variable required");
    let config = SuperserveConfig {
        api_key,
        base_url: "https://api.superserve.ai".to_string(),
        default_memory_mb: 512,
        default_vcpus: 2,
    };
    // OrchestratorService is generic over the ContainerManager impl, so we pass the
    // concrete SuperserveManager directly (no trait object). The ContainerManager trait
    // uses RPITIT for Send-guaranteed futures, which is not dyn-compatible.
    let container_manager = SuperserveManager::new(config);
    let service = OrchestratorService::new(container_manager).into_server();

    // Add graceful shutdown
    tonic::transport::Server::builder()
        .add_service(service)
        .serve_with_shutdown(addr, shutdown_signal())
        .await?;

    tracing::info!("Forge Orchestrator stopped");
    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install CTRL+C signal handler");
    tracing::info!("Shutdown signal received");
}