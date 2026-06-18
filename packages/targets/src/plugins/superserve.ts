import { exec } from 'child_process';
import { promises as fs } from 'fs/promises';
import { promisify } from 'util';
import path from 'path';
import type {
  DeployTarget,
  BuildContext,
  BuildResult,
  DeployContext,
  DeployResult,
  RollbackResult,
  HealthCheckResult,
} from '../index.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Superserve API types
// ---------------------------------------------------------------------------

interface SuperserveConfig {
  api_key: string;
  base_url: string;
  memory_mb: number;
  vcpus: number;
  image: string;
  env?: Record<string, string>;
  health_path?: string;
  port?: number;
}

interface VmCreateResponse {
  id: string;
  name: string;
  status: string;
  ip_address?: string;
  port?: number;
}

interface VmStatusResponse {
  id: string;
  status: string;
  ip_address?: string;
  exit_code?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function superserveRequest<T>(
  config: SuperserveConfig,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.base_url}${urlPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.api_key}`,
    'Content-Type': 'application/json',
  };

  const init: RequestInit = {
    method,
    headers,
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>');
    throw new Error(`Superserve API ${method} ${urlPath} returned ${response.status}: ${text}`);
  }

  // Some endpoints (DELETE) may return 204 with no body
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json() as Promise<T>;
  }

  return undefined as unknown as T;
}

/**
 * Poll a VM until it reaches the desired status or times out.
 */
async function waitForVmStatus(
  config: SuperserveConfig,
  vmId: string,
  targetStatus: string,
  timeoutMs: number = 60_000,
  initialDelayMs: number = 200,
  maxDelayMs: number = 5_000,
): Promise<VmStatusResponse> {
  const deadline = Date.now() + timeoutMs;
  let delay = initialDelayMs;

  while (Date.now() < deadline) {
    await sleep(delay);

    const vm = await superserveRequest<VmStatusResponse>(
      config,
      'GET',
      `/vms/${vmId}`,
    );

    if (vm.status === targetStatus) {
      return vm;
    }

    // Bail early on terminal failure states
    if (vm.status === 'failed' || vm.status === 'error') {
      throw new Error(`VM ${vmId} entered failed state: ${vm.status}`);
    }

    // Exponential backoff with cap
    delay = Math.min(delay * 1.5, maxDelayMs);
  }

  throw new Error(
    `VM ${vmId} did not reach "${targetStatus}" status within ${timeoutMs}ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the crate name from Cargo.toml.
 */
async function parseCrateName(cargoPath: string): Promise<string> {
  const content = await fs.readFile(cargoPath, 'utf-8');
  const match = content.match(/name\s*=\s*"([^"]+)"/);
  return match ? match[1] : 'app';
}

// ---------------------------------------------------------------------------
// SuperserveTarget
// ---------------------------------------------------------------------------

/**
 * Superserve deploy target.
 *
 * Deploys services as Firecracker micro-VMs via the Superserve API.
 * Builds the project locally (e.g. cargo build --release), then creates
 * a VM on Superserve with the specified image and env configuration.
 */
export class SuperserveTarget implements DeployTarget {
  readonly name = 'superserve';
  readonly description =
    'Deploy services as Firecracker micro-VMs via Superserve';

  // -----------------------------------------------------------------------
  // validateConfig
  // -----------------------------------------------------------------------

  validateConfig(config: Record<string, unknown>): void {
    if (!config.api_key || typeof config.api_key !== 'string') {
      throw new Error(
        'Superserve target requires "api_key" in config (string)',
      );
    }

    if (config.base_url !== undefined && typeof config.base_url !== 'string') {
      throw new Error('config.base_url must be a string if provided');
    }

    if (config.memory_mb !== undefined && typeof config.memory_mb !== 'number') {
      throw new Error('config.memory_mb must be a number if provided');
    }

    if (config.vcpus !== undefined && typeof config.vcpus !== 'number') {
      throw new Error('config.vcpus must be a number if provided');
    }

    if (!config.image || typeof config.image !== 'string') {
      throw new Error(
        'Superserve target requires "image" in config — the pre-built VM image to use',
      );
    }

    if (config.health_path !== undefined && typeof config.health_path !== 'string') {
      throw new Error('config.health_path must be a string if provided');
    }

    if (config.port !== undefined && typeof config.port !== 'number') {
      throw new Error('config.port must be a number if provided');
    }
  }

  // -----------------------------------------------------------------------
  // resolveConfig — fills in defaults
  // -----------------------------------------------------------------------

  private resolveConfig(raw: Record<string, unknown>): SuperserveConfig {
    return {
      api_key: raw.api_key as string,
      base_url: (raw.base_url as string) || 'https://api.superserve.io/v1',
      memory_mb: (raw.memory_mb as number) || 512,
      vcpus: (raw.vcpus as number) || 2,
      image: raw.image as string,
      env: (raw.env as Record<string, string>) || {},
      health_path: (raw.health_path as string) || '/health',
      port: (raw.port as number) || 8080,
    };
  }

  // -----------------------------------------------------------------------
  // build
  // -----------------------------------------------------------------------

  async build(context: BuildContext): Promise<BuildResult> {
    const start = Date.now();
    context.onProgress('Checking project structure...');

    const projectDir = context.projectDir;

    // Try Rust project
    const cargoPath = path.join(projectDir, 'Cargo.toml');
    const hasCargo = await fileExists(cargoPath);

    if (hasCargo) {
      return this.buildRust(context, cargoPath, start);
    }

    // Try Python project
    const hasRequirements = await fileExists(path.join(projectDir, 'requirements.txt'));
    const hasPyproject = await fileExists(path.join(projectDir, 'pyproject.toml'));
    const hasSetupPy = await fileExists(path.join(projectDir, 'setup.py'));

    if (hasRequirements || hasPyproject || hasSetupPy) {
      return this.buildPython(context, start);
    }

    return {
      success: false,
      output: '',
      durationMs: Date.now() - start,
      error:
        'No supported project structure found (Cargo.toml, requirements.txt, pyproject.toml, or setup.py)',
    };
  }

  private async buildRust(
    context: BuildContext,
    cargoPath: string,
    start: number,
  ): Promise<BuildResult> {
    const crateName = await parseCrateName(cargoPath);
    context.onProgress(`Building Rust crate: ${crateName}`);

    try {
      context.onProgress('Running cargo build --release...');
      const { stdout, stderr } = await execAsync('cargo build --release', {
        cwd: context.projectDir,
        timeout: 600_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const binaryPath = path.join(
        context.projectDir,
        'target',
        'release',
        crateName,
      );

      // Verify binary exists
      if (!(await fileExists(binaryPath))) {
        return {
          success: false,
          output: stdout || stderr,
          durationMs: Date.now() - start,
          error: `Build succeeded but binary not found at ${binaryPath}`,
        };
      }

      context.onProgress(`Binary built: ${binaryPath}`);
      return {
        success: true,
        artifactPath: binaryPath,
        output: stdout || stderr,
        durationMs: Date.now() - start,
      };
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      return {
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: err.stderr || err.message || 'Cargo build failed',
      };
    }
  }

  private async buildPython(
    context: BuildContext,
    start: number,
  ): Promise<BuildResult> {
    context.onProgress('Installing Python dependencies...');
    try {
      const { stdout, stderr } = await execAsync(
        'pip install -r requirements.txt 2>/dev/null || pip install -e ".[dev]" 2>/dev/null || pip install -e .',
        {
          cwd: context.projectDir,
          timeout: 300_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      return {
        success: true,
        artifactPath: context.projectDir,
        output: stdout || stderr || 'Python dependencies installed',
        durationMs: Date.now() - start,
      };
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      return {
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: err.stderr || err.message || 'Python build failed',
      };
    }
  }

  // -----------------------------------------------------------------------
  // deploy
  // -----------------------------------------------------------------------

  async deploy(context: DeployContext): Promise<DeployResult> {
    const { config: rawConfig, buildResult, deploymentId } = context;

    if (!buildResult.success) {
      return {
        success: false,
        deploymentId,
        output: '',
        error: 'Cannot deploy — build was not successful',
      };
    }

    const config = this.resolveConfig(rawConfig);
    const vmName = `forge-${deploymentId}`;
    const start = Date.now();

    context.onProgress(`Creating Superserve VM: ${vmName}`);

    // Merge any env vars from the build/deploy context
    const env = { ...config.env };
    if (buildResult.artifactPath) {
      env['FORGE_ARTIFACT_PATH'] = buildResult.artifactPath;
    }

    try {
      // 1. Create the VM
      const vm = await superserveRequest<VmCreateResponse>(config, 'POST', '/vms', {
        name: vmName,
        image: config.image,
        env,
        memory_mb: config.memory_mb,
        vcpus: config.vcpus,
        metadata: {
          deployment_id: deploymentId,
          deployed_by: 'forge',
        },
      });

      context.onProgress(`VM created: ${vm.id} (status: ${vm.status})`);

      // 2. Poll until running
      context.onProgress('Waiting for VM to reach running state...');
      const runningVm = await waitForVmStatus(config, vm.id, 'running', 60_000);
      context.onProgress(`VM ${vm.id} is running`);

      // 3. Build deployment URL
      const ip = runningVm.ip_address || vm.ip_address;
      const port = vm.port || config.port;
      const deployUrl = ip ? `http://${ip}:${port}` : undefined;
      const healthUrl = ip
        ? `http://${ip}:${port}${config.health_path}`
        : undefined;

      return {
        success: true,
        deploymentId: vm.id,
        url: deployUrl,
        healthCheckUrl: healthUrl,
        output: [
          `VM ${vm.id} deployed successfully`,
          `Status: ${runningVm.status}`,
          deployUrl ? `URL: ${deployUrl}` : '',
          healthUrl ? `Health: ${healthUrl}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        deploymentId,
        output: '',
        error: `Superserve deployment failed: ${message}`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // rollback
  // -----------------------------------------------------------------------

  async rollback(
    deploymentId: string,
    config: Record<string, unknown>,
  ): Promise<RollbackResult> {
    const ssConfig = this.resolveConfig(config);

    try {
      // 1. Destroy the current VM
      await superserveRequest(ssConfig, 'DELETE', `/vms/${deploymentId}`);
      const output = `Destroyed VM ${deploymentId}.`;

      // 2. Recreate with the previous image if available.
      //    SuperserveTarget doesn't track previous images internally —
      //    the caller should pass `previous_image` in config if a specific
      //    rollback target is desired. Otherwise we report success of the
      //    destroy step.
      const previousImage = config.previous_image as string | undefined;
      if (previousImage) {
        const vm = await superserveRequest<VmCreateResponse>(
          ssConfig,
          'POST',
          '/vms',
          {
            name: `forge-rollback-${deploymentId}`,
            image: previousImage,
            env: (config.env as Record<string, string>) || {},
            memory_mb: (config.memory_mb as number) || 512,
            vcpus: (config.vcpus as number) || 2,
            metadata: { deployment_id: deploymentId, rollback: 'true' },
          },
        );

        await waitForVmStatus(ssConfig, vm.id, 'running', 60_000);

        return {
          success: true,
          previousVersion: previousImage,
          output: `${output}\nRecreated VM ${vm.id} with image ${previousImage}.`,
        };
      }

      return {
        success: true,
        output: `${output}\nNo previous_image specified in config; destroy-only rollback.`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `Rollback failed: ${message}`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // healthCheck
  // -----------------------------------------------------------------------

  async healthCheck(deployment: DeployResult): Promise<HealthCheckResult> {
    if (!deployment.deploymentId) {
      return { healthy: false, error: 'No deployment ID available' };
    }

    try {
      const start = Date.now();

      // Attempt the health URL if available (requires config, so we use the
      // healthCheckUrl stored in the DeployResult from the deploy step).
      if (deployment.healthCheckUrl) {
        const response = await fetch(deployment.healthCheckUrl, {
          signal: AbortSignal.timeout(10_000),
        });
        return {
          healthy: response.ok,
          statusCode: response.status,
          responseTimeMs: Date.now() - start,
          output: await response.text().catch(() => ''),
        };
      }

      // Fallback: return healthy if we had a successful deployment with a URL
      // but no explicit health endpoint configured.
      return {
        healthy: deployment.success,
        responseTimeMs: Date.now() - start,
        output: 'No health check URL configured; using deployment success status',
      };
    } catch (error) {
      return {
        healthy: false,
        error:
          error instanceof Error ? error.message : 'Health check failed',
      };
    }
  }
}