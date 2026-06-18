use std::collections::HashMap;
use std::time::Duration;

use crate::container::{
    BuildResult, ContainerInfo, ContainerManager, ContainerStatus, ExecResult, PushResult,
    ResourceUsage,
};
use crate::error::OrchestratorError;
use serde::{Deserialize, Serialize};

/// Configuration for the Superserve API client.
#[derive(Debug, Clone)]
pub struct SuperserveConfig {
    /// API key for authenticating with the Superserve API.
    pub api_key: String,
    /// Base URL of the Superserve API (e.g. "https://api.superserve.io/v1").
    pub base_url: String,
    /// Default memory allocation for new VMs in megabytes.
    pub default_memory_mb: u32,
    /// Default number of vCPUs for new VMs.
    pub default_vcpus: u32,
}

impl Default for SuperserveConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: "https://api.superserve.io/v1".to_string(),
            default_memory_mb: 512,
            default_vcpus: 2,
        }
    }
}

impl SuperserveConfig {
    pub fn from_env() -> Result<Self, OrchestratorError> {
        Ok(Self {
            api_key: std::env::var("SUPERSERVE_API_KEY")
                .map_err(|_| OrchestratorError::SuperserveApi(
                    "SUPERSERVE_API_KEY environment variable not set".into(),
                ))?,
            base_url: std::env::var("SUPERSERVE_BASE_URL")
                .unwrap_or_else(|_| "https://api.superserve.io/v1".to_string()),
            default_memory_mb: std::env::var("SUPERSERVE_DEFAULT_MEMORY_MB")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(512),
            default_vcpus: std::env::var("SUPERSERVE_DEFAULT_VCPUS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(2),
        })
    }
}

/// Superserve-based container (VM) manager.
///
/// Implements the `ContainerManager` trait by mapping container operations
/// to Superserve Firecracker micro-VM API calls.
pub struct SuperserveManager {
    config: SuperserveConfig,
    http: reqwest::Client,
}

impl SuperserveManager {
    pub fn new(config: SuperserveConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("Failed to build reqwest client"),
        }
    }

    /// Construct from environment variables (SUPERSERVE_API_KEY, etc.).
    pub fn from_env() -> Result<Self, OrchestratorError> {
        Ok(Self::new(SuperserveConfig::from_env()?))
    }

    /// Return a reference to the configuration.
    pub fn config(&self) -> &SuperserveConfig {
        &self.config
    }

    // -- Helpers -------------------------------------------------------------

    fn auth_headers(&self) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", self.config.api_key)
                .parse()
                .expect("Bearer token should parse"),
        );
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            "application/json"
                .parse()
                .expect("content type should parse"),
        );
        headers
    }

    /// Convert a Superserve VM status string into a `ContainerStatus`.
    fn map_status(vm_status: &str, exit_code: Option<i32>) -> ContainerStatus {
        match vm_status {
            "running" => ContainerStatus::Running,
            "stopped" | "terminated" => {
                ContainerStatus::Exited { exit_code: exit_code.unwrap_or(0) }
            }
            _ => ContainerStatus::Dead,
        }
    }
}

// =========================================================================
// ContainerManager implementation
// =========================================================================

impl ContainerManager for SuperserveManager {
    async fn create_container(
        &self,
        pipeline_id: &str,
        agent_name: &str,
        image: &str,
        env: &[String],
        labels: HashMap<String, String>,
        _timeout: Duration,
        _mounts: &[(String, String, bool)],
    ) -> Result<ContainerInfo, String> {
        let vm_name = format!("forge-{}-{}", agent_name, &now_ms().to_string()[now_ms().to_string().len().saturating_sub(6)..]);

        // Build the environment map from the flat `KEY=VALUE` strings.
        let mut env_map: HashMap<String, String> = HashMap::new();
        for e in env {
            if let Some((k, v)) = e.split_once('=') {
                env_map.insert(k.to_string(), v.to_string());
            }
        }

        let mut metadata = HashMap::new();
        metadata.insert("pipeline_id".to_string(), pipeline_id.to_string());
        metadata.insert("agent_name".to_string(), agent_name.to_string());
        for (k, v) in &labels {
            metadata.insert(format!("label_{}", k), v.clone());
        }

        let body = CreateVmRequest {
            name: vm_name.clone(),
            image: image.to_string(),
            env: env_map,
            memory_mb: self.config.default_memory_mb,
            vcpus: self.config.default_vcpus,
            metadata,
        };

        let response = self
            .http
            .post(format!("{}/vms", self.config.base_url))
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Superserve API request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Superserve API returned {}: {}",
                status, body_text
            ));
        }

        let vm: VmResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Superserve VM response: {}", e))?;

        let now = now_ms();
        Ok(ContainerInfo {
            id: vm.id.clone(),
            name: vm_name,
            image: image.to_string(),
            status: ContainerStatus::Running,
            exit_code: None,
            created_at: now,
            finished_at: None,
            labels,
        })
    }

    async fn exec_command(
        &self,
        container_id: &str,
        command: &[String],
        timeout: Duration,
        working_dir: Option<&str>,
    ) -> Result<ExecResult, String> {
        let body = ExecRequest {
            command: command.to_vec(),
            working_dir: working_dir.map(|s| s.to_string()),
            timeout_secs: timeout.as_secs() as u32,
        };

        let response = self
            .http
            .post(format!("{}/vms/{}/exec", self.config.base_url, container_id))
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Superserve exec request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            return Err(format!("Superserve exec returned {}: {}", status, body_text));
        }

        let result: ExecResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Superserve exec response: {}", e))?;

        Ok(ExecResult {
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            duration_ms: result.duration_ms,
        })
    }

    async fn destroy_container(&self, container_id: &str, _force: bool) -> Result<bool, String> {
        let response = self
            .http
            .delete(format!("{}/vms/{}", self.config.base_url, container_id))
            .headers(self.auth_headers())
            .send()
            .await
            .map_err(|e| format!("Superserve destroy request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            return Err(format!("Superserve destroy returned {}: {}", status, body_text));
        }

        Ok(true)
    }

    async fn get_container_status(&self, container_id: &str) -> Result<ContainerInfo, String> {
        let response = self
            .http
            .get(format!("{}/vms/{}", self.config.base_url, container_id))
            .headers(self.auth_headers())
            .send()
            .await
            .map_err(|e| format!("Superserve status request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            return Err(format!("Superserve status returned {}: {}", status, body_text));
        }

        let vm: VmResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Superserve VM response: {}", e))?;

        // Extract pipeline_id / agent_name from metadata if present.
        let labels: HashMap<String, String> = vm
            .metadata
            .iter()
            .filter_map(|(k, v)| {
                k.strip_prefix("label_").map(|key| (key.to_string(), v.clone()))
            })
            .collect();

        Ok(ContainerInfo {
            id: vm.id,
            name: vm.name,
            image: vm.image,
            status: Self::map_status(&vm.status, vm.exit_code),
            exit_code: vm.exit_code,
            created_at: vm.created_at.unwrap_or(0),
            finished_at: vm.finished_at,
            labels,
        })
    }

    /// Superserve uses pre-built VM images. Building is a no-op that returns
    /// a synthetic image ID. To create a new image, create a snapshot from a
    /// running VM via `POST /vms/{id}/snapshot`.
    async fn build_image(
        &self,
        _dockerfile_path: &str,
        _context_path: &str,
        tag: &str,
        _build_args: HashMap<String, String>,
    ) -> Result<BuildResult, String> {
        tracing::info!(
            tag = %tag,
            "Superserve uses pre-built images; build_image is a no-op"
        );
        Ok(BuildResult {
            success: true,
            image_id: format!("superserve:{}", tag),
            duration_ms: 0,
        })
    }

    /// Superserve does not have a Docker-style push. Images are pre-registered
    /// or created via snapshots. This is a no-op that returns success.
    async fn push_image(
        &self,
        image_tag: &str,
        _registry: &str,
        _username: &str,
        _password: &str,
    ) -> Result<PushResult, String> {
        tracing::info!(
            tag = %image_tag,
            "Superserve does not support Docker-style push; push_image is a no-op"
        );
        Ok(PushResult {
            success: true,
            digest: format!("superserve:{}", image_tag),
        })
    }

    async fn get_resource_usage(&self, container_id: &str) -> Result<ResourceUsage, String> {
        let response = self
            .http
            .get(format!("{}/vms/{}/metrics", self.config.base_url, container_id))
            .headers(self.auth_headers())
            .send()
            .await
            .map_err(|e| format!("Superserve metrics request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            return Err(format!("Superserve metrics returned {}: {}", status, body_text));
        }

        let metrics: VmMetrics = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Superserve metrics response: {}", e))?;

        Ok(ResourceUsage {
            cpu_usage_ns: metrics.cpu_usage_ns,
            memory_usage_bytes: metrics.memory_usage_bytes,
            memory_limit_bytes: metrics.memory_limit_bytes,
            network_rx_bytes: metrics.network_rx_bytes,
            network_tx_bytes: metrics.network_tx_bytes,
        })
    }
}

// =========================================================================
// Request / Response types
// =========================================================================

#[derive(Serialize)]
struct CreateVmRequest {
    name: String,
    image: String,
    env: HashMap<String, String>,
    memory_mb: u32,
    vcpus: u32,
    metadata: HashMap<String, String>,
}

#[derive(Deserialize, Debug)]
struct VmResponse {
    id: String,
    name: String,
    image: String,
    status: String,
    exit_code: Option<i32>,
    ip_address: Option<String>,
    created_at: Option<u64>,
    finished_at: Option<u64>,
    metadata: HashMap<String, String>,
}

#[derive(Serialize)]
struct ExecRequest {
    command: Vec<String>,
    working_dir: Option<String>,
    timeout_secs: u32,
}

#[derive(Deserialize, Debug)]
struct ExecResponse {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u64,
}

#[derive(Deserialize, Debug)]
struct VmMetrics {
    cpu_usage_ns: u64,
    memory_usage_bytes: u64,
    memory_limit_bytes: u64,
    network_rx_bytes: u64,
    network_tx_bytes: u64,
}

// =========================================================================
// Utilities
// =========================================================================

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}