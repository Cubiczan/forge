/**
 * Forge Deploy Target Plugin System
 *
 * Each target plugin implements the DeployTarget interface and handles
 * the specifics of deploying to a particular environment (Rust service,
 * Python API, Docker, Kubernetes, etc.).
 */

export interface DeployTarget {
  /** Unique target identifier */
  readonly name: string;

  /** Human-readable description */
  readonly description: string;

  /**
   * Validate that the deployment config has all required fields.
   * Throws with a descriptive message if invalid.
   */
  validateConfig(config: Record<string, unknown>): void;

  /**
   * Build the project artifacts for deployment.
   * Returns build output and the path to the built artifact.
   */
  build(context: BuildContext): Promise<BuildResult>;

  /**
   * Deploy the built artifact to the target environment.
   * Returns deployment metadata including health check URL.
   */
  deploy(context: DeployContext): Promise<DeployResult>;

  /**
   * Roll back a deployment to its previous state.
   */
  rollback(deploymentId: string, config: Record<string, unknown>): Promise<RollbackResult>;

  /**
   * Run a health check against a deployed service.
   */
  healthCheck(deployment: DeployResult): Promise<HealthCheckResult>;
}

export interface BuildContext {
  /** Working directory of the project */
  projectDir: string;
  /** Deployment configuration from forge.yaml */
  config: Record<string, unknown>;
  /** Files changed in this deployment */
  changedFiles: { path: string; action: 'create' | 'modify' | 'delete' }[];
  /** Callback for build progress events */
  onProgress: (message: string) => void;
}

export interface BuildResult {
  success: boolean;
  artifactPath?: string;
  imageTag?: string;
  output: string;
  durationMs: number;
  error?: string;
}

export interface DeployContext {
  /** Working directory */
  projectDir: string;
  /** Deployment configuration */
  config: Record<string, unknown>;
  /** Build result from the build step */
  buildResult: BuildResult;
  /** Deployment ID */
  deploymentId: string;
  /** Callback for deploy progress events */
  onProgress: (message: string) => void;
}

export interface DeployResult {
  success: boolean;
  deploymentId: string;
  url?: string;
  healthCheckUrl?: string;
  version?: string;
  output: string;
  error?: string;
}

export interface RollbackResult {
  success: boolean;
  previousVersion?: string;
  output: string;
  error?: string;
}

export interface HealthCheckResult {
  healthy: boolean;
  statusCode?: number;
  responseTimeMs?: number;
  output?: string;
  error?: string;
}

// ============================================================
// Registry
// ============================================================

const registry = new Map<string, () => DeployTarget>();

/**
 * Register a deploy target plugin.
 */
export function registerTarget(name: string, factory: () => DeployTarget): void {
  if (registry.has(name)) {
    throw new Error(`Deploy target "${name}" is already registered`);
  }
  registry.set(name, factory);
}

/**
 * Get a registered deploy target by name.
 */
export function getTarget(name: string): DeployTarget {
  const factory = registry.get(name);
  if (!factory) {
    const available = Array.from(registry.keys()).join(', ');
    throw new Error(
      `Unknown deploy target: "${name}". Available: ${available}`
    );
  }
  return factory();
}

/**
 * List all registered deploy targets.
 */
export function listTargets(): { name: string; description: string }[] {
  return Array.from(registry.entries()).map(([name, factory]) => ({
    name,
    description: factory().description,
  }));
}