use std::net::SocketAddr;
use tracing_subscriber::EnvFilter;

use forge_orchestrator::container::InMemoryContainerManager;
use forge_orchestrator::server::OrchestratorService;

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

    // Use in-memory manager for dev; replace with Docker manager for production
    let container_manager = InMemoryContainerManager::new();
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