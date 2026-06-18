use std::collections::HashMap;
use std::time::Duration;

/// Represents a container in the system
#[derive(Debug, Clone)]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: ContainerStatus,
    pub exit_code: Option<i32>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContainerStatus {
    Running,
    Exited { exit_code: i32 },
    Dead,
}

/// Result of executing a command in a container
#[derive(Debug, Clone)]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

/// A stream of output from a command
#[derive(Debug, Clone)]
pub enum CommandOutput {
    Stdout(String),
    Stderr(String),
    Result(ExecResult),
}

/// Resource usage stats for a container
#[derive(Debug, Clone)]
pub struct ResourceUsage {
    pub cpu_usage_ns: u64,
    pub memory_usage_bytes: u64,
    pub memory_limit_bytes: u64,
    pub network_rx_bytes: u64,
    pub network_tx_bytes: u64,
}

/// Result of building an image
#[derive(Debug, Clone)]
pub struct BuildResult {
    pub success: bool,
    pub image_id: String,
    pub duration_ms: u64,
}

/// Result of pushing an image
#[derive(Debug, Clone)]
pub struct PushResult {
    pub success: bool,
    pub digest: String,
}

/// Trait for container/VM operations. Implementations include Superserve (Firecracker microVMs),
/// podman, etc.
#[allow(async_fn_in_trait)]
pub trait ContainerManager: Send + Sync {
    /// Create and start a new container
    async fn create_container(
        &self,
        pipeline_id: &str,
        agent_name: &str,
        image: &str,
        env: &[String],
        labels: HashMap<String, String>,
        timeout: Duration,
        mounts: &[(String, String, bool)], // (source, target, read_only)
    ) -> Result<ContainerInfo, String>;

    /// Execute a command inside a container
    async fn exec_command(
        &self,
        container_id: &str,
        command: &[String],
        timeout: Duration,
        working_dir: Option<&str>,
    ) -> Result<ExecResult, String>;

    /// Stop and remove a container
    async fn destroy_container(&self, container_id: &str, force: bool) -> Result<bool, String>;

    /// Get container status
    async fn get_container_status(&self, container_id: &str) -> Result<ContainerInfo, String>;

    /// Build a project image (stub — Superserve builds in-VM)
    async fn build_image(
        &self,
        dockerfile_path: &str,
        context_path: &str,
        tag: &str,
        build_args: HashMap<String, String>,
    ) -> Result<BuildResult, String>;

    /// Push an image to a registry
    async fn push_image(
        &self,
        image_tag: &str,
        registry: &str,
        username: &str,
        password: &str,
    ) -> Result<PushResult, String>;

    /// Get resource usage for a container
    async fn get_resource_usage(&self, container_id: &str) -> Result<ResourceUsage, String>;
}

/// In-memory ContainerManager for development and testing.
/// In production, use SuperserveManager for Firecracker microVM orchestration.
pub struct InMemoryContainerManager {
    containers: tokio::sync::RwLock<HashMap<String, ContainerInfo>>,
}

impl InMemoryContainerManager {
    pub fn new() -> Self {
        Self {
            containers: tokio::sync::RwLock::new(HashMap::new()),
        }
    }
}

impl Default for InMemoryContainerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ContainerManager for InMemoryContainerManager {
    async fn create_container(
        &self,
        _pipeline_id: &str,
        agent_name: &str,
        image: &str,
        _env: &[String],
        labels: HashMap<String, String>,
        _timeout: Duration,
        _mounts: &[(String, String, bool)],
    ) -> Result<ContainerInfo, String> {
        let id = format!("container-{}-{}", agent_name, uuid_simple());
        let name = format!("forge-{}-{}", agent_name, &id[id.len() - 6..]);
        let now = now_ms();

        let container = ContainerInfo {
            id: id.clone(),
            name: name.clone(),
            image: image.to_string(),
            status: ContainerStatus::Running,
            exit_code: None,
            created_at: now,
            finished_at: None,
            labels,
        };

        self.containers
            .write()
            .await
            .insert(id.clone(), container);
        Ok(self
            .containers
            .read()
            .await
            .get(&id)
            .unwrap()
            .clone())
    }

    async fn exec_command(
        &self,
        container_id: &str,
        command: &[String],
        _timeout: Duration,
        _working_dir: Option<&str>,
    ) -> Result<ExecResult, String> {
        let containers = self.containers.read().await;
        let container = containers
            .get(container_id)
            .ok_or_else(|| format!("Container not found: {}", container_id))?;

        if container.status != ContainerStatus::Running {
            return Err(format!("Container {} is not running", container_id));
        }

        // In-memory simulation: just return the command as if it ran
        let cmd_str = command.join(" ");
        Ok(ExecResult {
            exit_code: 0,
            stdout: format!("[simulated] Executed: {}\n", cmd_str),
            stderr: String::new(),
            duration_ms: 10, // Simulated fast execution
        })
    }

    async fn destroy_container(
        &self,
        container_id: &str,
        force: bool,
    ) -> Result<bool, String> {
        let mut containers = self.containers.write().await;
        if let Some(container) = containers.remove(container_id) {
            tracing::info!(
                container_id = %container_id,
                force = force,
                "Container destroyed"
            );
            Ok(true)
        } else {
            Err(format!("Container not found: {}", container_id))
        }
    }

    async fn get_container_status(&self, container_id: &str) -> Result<ContainerInfo, String> {
        let containers = self.containers.read().await;
        containers
            .get(container_id)
            .cloned()
            .ok_or_else(|| format!("Container not found: {}", container_id))
    }

    async fn build_image(
        &self,
        _dockerfile_path: &str,
        _context_path: &str,
        _tag: &str,
        _build_args: HashMap<String, String>,
    ) -> Result<BuildResult, String> {
        Ok(BuildResult {
            success: true,
            image_id: format!("sha256:{}", uuid_simple()),
            duration_ms: 100,
        })
    }

    async fn push_image(
        &self,
        _image_tag: &str,
        _registry: &str,
        _username: &str,
        _password: &str,
    ) -> Result<PushResult, String> {
        Ok(PushResult {
            success: true,
            digest: format!("sha256:{}", uuid_simple()),
        })
    }

    async fn get_resource_usage(&self, container_id: &str) -> Result<ResourceUsage, String> {
        let containers = self.containers.read().await;
        containers
            .get(container_id)
            .map(|_| ResourceUsage {
                cpu_usage_ns: 1_000_000_000,       // 1 second
                memory_usage_bytes: 128 * 1024 * 1024, // 128MB
                memory_limit_bytes: 512 * 1024 * 1024, // 512MB
                network_rx_bytes: 1024,
                network_tx_bytes: 512,
            })
            .ok_or_else(|| format!("Container not found: {}", container_id))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{:x}", duration.as_nanos())
}