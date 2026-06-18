use std::fmt;
use tonic::{Code, Status};

#[derive(Debug)]
pub enum OrchestratorError {
    ContainerNotFound(String),
    ContainerAlreadyExists(String),
    ContainerStartFailed(String),
    ExecFailed(String),
    BuildFailed(String),
    PushFailed(String),
    Timeout(String),
    DockerApi(String),
    SuperserveApi(String),
    Internal(String),
}

impl fmt::Display for OrchestratorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OrchestratorError::ContainerNotFound(id) => {
                write!(f, "Container not found: {}", id)
            }
            OrchestratorError::ContainerAlreadyExists(id) => {
                write!(f, "Container already exists: {}", id)
            }
            OrchestratorError::ContainerStartFailed(msg) => {
                write!(f, "Container failed to start: {}", msg)
            }
            OrchestratorError::ExecFailed(msg) => {
                write!(f, "Exec command failed: {}", msg)
            }
            OrchestratorError::BuildFailed(msg) => {
                write!(f, "Build failed: {}", msg)
            }
            OrchestratorError::PushFailed(msg) => {
                write!(f, "Push failed: {}", msg)
            }
            OrchestratorError::Timeout(msg) => {
                write!(f, "Timeout: {}", msg)
            }
            OrchestratorError::DockerApi(msg) => {
                write!(f, "Docker API error: {}", msg)
            }
            OrchestratorError::SuperserveApi(msg) => {
                write!(f, "Superserve API error: {}", msg)
            }
            OrchestratorError::Internal(msg) => {
                write!(f, "Internal error: {}", msg)
            }
        }
    }
}

impl std::error::Error for OrchestratorError {}

impl From<OrchestratorError> for Status {
    fn from(err: OrchestratorError) -> Self {
        let code = match &err {
            OrchestratorError::ContainerNotFound(_) => Code::NotFound,
            OrchestratorError::ContainerAlreadyExists(_) => Code::AlreadyExists,
            OrchestratorError::SuperserveApi(_) => Code::Unavailable,
            OrchestratorError::Timeout(_) => Code::DeadlineExceeded,
            _ => Code::Internal,
        };
        Status::new(code, err.to_string())
    }
}