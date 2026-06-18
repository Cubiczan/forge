// Re-export plugin system
export { registerTarget, getTarget, listTargets } from '../index.js';
export type {
  DeployTarget,
  BuildContext,
  BuildResult,
  DeployContext,
  DeployResult,
  RollbackResult,
  HealthCheckResult,
} from '../index.js';

// Re-export plugins
export { RustServiceTarget } from './rust-service.js';
export { PythonApiTarget } from './python-api.js';
export { SuperserveTarget } from './superserve.js';