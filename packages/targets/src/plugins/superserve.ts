import { promises as fs } from 'fs';
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

// ============================================================
// Superserve API types
// ============================================================

const SUPERSEEVE_API_BASE = 'https://api.superserve.ai';

interface Sandbox {
  id: string;
  name: string;
  snapshot_id: string;
  vcpu_count: number;
  memory_mib: number;
  timeout_seconds: number;
  status: string;
  created_at: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

type ProjectType = 'rust' | 'python';

// ============================================================
// Superserve Target Plugin
// ============================================================

/**
 * Superserve deploy target.
 *
 * Replaces Docker-based rust-service and python-api targets with
 * Firecracker microVM sandboxes via the Superserve API.
 *
 * Detects Rust (Cargo.toml) and Python (requirements.txt / pyproject.toml)
 * projects, builds inside an ephemeral sandbox, then deploys to a
 * long-running sandbox.
 */
export class SuperserveTarget implements DeployTarget {
  readonly name = 'superserve';
  readonly description = 'Build and deploy using Superserve Firecracker microVMs';

  /** Map of deploymentId → sandbox ID for health checks and rollback */
  private sandboxIds = new Map<string, string>();

  /** Cached API key — set from config on every public method entry */
  private apiKey = '';

  // ----------------------------------------------------------
  // DeployTarget interface
  // ----------------------------------------------------------

  validateConfig(config: Record<string, unknown>): void {
    if (!config.api_key || typeof config.api_key !== 'string') {
      throw new Error(
        'Superserve target requires a string "api_key" in deployment config'
      );
    }
  }

  async build(context: BuildContext): Promise<BuildResult> {
    const start = Date.now();
    const { projectDir, config, onProgress } = context;

    this.apiKey = config.api_key as string;

    // 1. Detect project type
    onProgress('Detecting project type...');
    const projectType = await detectProjectType(projectDir);

    if (!projectType) {
      return {
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error:
          'No supported project files found (need Cargo.toml, requirements.txt, or pyproject.toml)',
      };
    }

    onProgress(`Detected ${projectType} project`);

    // 2. Create an ephemeral build sandbox
    const buildSandboxName = `forge-build-${Date.now()}`;
    let sandbox: Sandbox | null = null;

    try {
      onProgress('Creating Superserve build sandbox...');
      sandbox = await this.createSandbox(buildSandboxName);
      onProgress(`Build sandbox created: ${sandbox.id}`);

      // 3. Upload project files
      onProgress('Uploading project files to sandbox...');
      await this.uploadProjectFiles(sandbox.id, projectDir);
      const fileCount = await countProjectFiles(projectDir);
      onProgress(`Uploaded ${fileCount} file(s)`);

      // 4. Run the build command
      const buildCommand =
        projectType === 'rust'
          ? 'cd /app && cargo build --release 2>&1'
          : 'cd /app && pip install -r requirements.txt 2>&1 || pip install -e . 2>&1';

      onProgress(`Running: ${buildCommand}`);
      const result = await this.execInSandbox(sandbox.id, buildCommand);

      if (result.exit_code !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
        return {
          success: false,
          output,
          durationMs: Date.now() - start,
          error: `Build failed (exit ${result.exit_code}): ${result.stderr || result.stdout}`,
        };
      }

      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      return {
        success: true,
        artifactPath: projectType, // carry the detected type to deploy()
        output: output || 'Build succeeded',
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : 'Build failed',
      };
    } finally {
      // Always tear down the build sandbox
      if (sandbox) {
        try {
          onProgress('Cleaning up build sandbox...');
          await this.destroySandbox(sandbox.id);
        } catch {
          // Best-effort cleanup — never throw from finally
        }
      }
    }
  }

  async deploy(context: DeployContext): Promise<DeployResult> {
    const { projectDir, config, buildResult, deploymentId, onProgress } = context;

    this.apiKey = config.api_key as string;

    if (!buildResult.success) {
      return {
        success: false,
        deploymentId,
        output: '',
        error: 'Cannot deploy — build was not successful',
      };
    }

    const projectType = buildResult.artifactPath as ProjectType;
    let sandbox: Sandbox | null = null;

    try {
      // 1. Create a deployment sandbox
      onProgress('Creating Superserve deployment sandbox...');
      sandbox = await this.createSandbox(`forge-deploy-${deploymentId}`);
      onProgress(`Deployment sandbox created: ${sandbox.id}`);

      // Remember it for healthCheck() and rollback()
      this.sandboxIds.set(deploymentId, sandbox.id);

      // 2. Upload project files
      onProgress('Uploading project files to deployment sandbox...');
      await this.uploadProjectFiles(sandbox.id, projectDir);

      // 3. Build + start the service inside the deployment sandbox
      if (projectType === 'rust') {
        onProgress('Building Rust service in deployment sandbox...');
        const buildRes = await this.execInSandbox(
          sandbox.id,
          'cd /app && cargo build --release 2>&1'
        );
        if (buildRes.exit_code !== 0) {
          throw new Error(
            `Cargo build failed: ${buildRes.stderr || buildRes.stdout}`
          );
        }

        // Start the binary in the background
        onProgress('Starting Rust service...');
        await this.execInSandbox(
          sandbox.id,
          'cd /app && nohup ./target/release/app > /tmp/service.log 2>&1 &'
        );
      } else {
        onProgress('Installing Python dependencies in deployment sandbox...');
        const installRes = await this.execInSandbox(
          sandbox.id,
          'cd /app && pip install -r requirements.txt 2>&1 || pip install -e . 2>&1'
        );
        if (installRes.exit_code !== 0) {
          throw new Error(
            `pip install failed: ${installRes.stderr || installRes.stdout}`
          );
        }

        // Start with uvicorn in the background
        onProgress('Starting Python API...');
        await this.execInSandbox(
          sandbox.id,
          'cd /app && nohup python -m uvicorn main:app --host 0.0.0.0 --port 8000 > /tmp/service.log 2>&1 &'
        );
      }

      onProgress('Service started in deployment sandbox');

      return {
        success: true,
        deploymentId,
        url: `sandbox://${sandbox.id}`,
        healthCheckUrl: `sandbox://${sandbox.id}/health`,
        version: projectType,
        output: `Deployed to Superserve sandbox ${sandbox.id}`,
      };
    } catch (error) {
      // Tear down on failure
      if (sandbox) {
        try {
          await this.destroySandbox(sandbox.id);
        } catch {
          // best-effort
        }
        this.sandboxIds.delete(deploymentId);
      }

      return {
        success: false,
        deploymentId,
        output: '',
        error: error instanceof Error ? error.message : 'Deployment failed',
      };
    }
  }

  async healthCheck(deployment: DeployResult): Promise<HealthCheckResult> {
    const sandboxId = this.sandboxIds.get(deployment.deploymentId);

    if (!sandboxId) {
      return {
        healthy: false,
        error: `No sandbox found for deployment "${deployment.deploymentId}"`,
      };
    }

    try {
      const start = Date.now();

      // Primary: try curling a health endpoint
      const curlResult = await this.execInSandbox(
        sandboxId,
        'curl -sf http://localhost:8000/health 2>/dev/null && echo "OK"'
      );

      if (curlResult.exit_code === 0) {
        return {
          healthy: true,
          statusCode: 200,
          responseTimeMs: Date.now() - start,
          output: curlResult.stdout.trim(),
        };
      }

      // Fallback: check if the service process is alive
      const psResult = await this.execInSandbox(
        sandboxId,
        'pgrep -f "uvicorn|target/release" > /dev/null 2>&1 && echo "running" || echo "stopped"'
      );
      const isRunning = psResult.stdout.trim() === 'running';

      return {
        healthy: isRunning,
        responseTimeMs: Date.now() - start,
        output: isRunning
          ? 'Service process is running (health endpoint unavailable)'
          : 'Service process is not running',
        error: isRunning ? undefined : 'Service process is not running',
      };
    } catch (error) {
      return {
        healthy: false,
        error:
          error instanceof Error ? error.message : 'Health check failed',
      };
    }
  }

  async rollback(
    deploymentId: string,
    config: Record<string, unknown>
  ): Promise<RollbackResult> {
    this.apiKey = config.api_key as string;

    const sandboxId = this.sandboxIds.get(deploymentId);

    if (!sandboxId) {
      return {
        success: true,
        output: `No active sandbox found for deployment "${deploymentId}" — nothing to roll back`,
      };
    }

    try {
      await this.destroySandbox(sandboxId);
      this.sandboxIds.delete(deploymentId);

      return {
        success: true,
        previousVersion: 'destroyed',
        output: `Destroyed Superserve sandbox ${sandboxId} for deployment ${deploymentId}`,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error:
          error instanceof Error
            ? error.message
            : 'Failed to destroy sandbox during rollback',
      };
    }
  }

  // ----------------------------------------------------------
  // Superserve API helpers
  // ----------------------------------------------------------

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
    };
  }

  private async apiRequest<T>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${SUPERSEEVE_API_BASE}${endpoint}`;
    const init: RequestInit = {
      method,
      headers: this.headers(),
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Superserve API ${method} ${endpoint} returned ${response.status}: ${text}`
      );
    }

    // Some endpoints (DELETE) may return empty body
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
  }

  private async createSandbox(name: string): Promise<Sandbox> {
    return this.apiRequest<Sandbox>('POST', '/sandboxes', { name });
  }

  private async destroySandbox(sandboxId: string): Promise<void> {
    await this.apiRequest<void>('DELETE', `/sandboxes/${sandboxId}`);
  }

  private async execInSandbox(
    sandboxId: string,
    command: string
  ): Promise<ExecResult> {
    return this.apiRequest<ExecResult>('POST', `/sandboxes/${sandboxId}/exec`, {
      command,
    });
  }

  private async writeFileToSandbox(
    sandboxId: string,
    filePath: string,
    content: string
  ): Promise<void> {
    await this.apiRequest<void>('POST', `/sandboxes/${sandboxId}/files`, {
      path: filePath,
      content,
    });
  }

  // ----------------------------------------------------------
  // File handling
  // ----------------------------------------------------------

  /** Recursively collect all project files, skipping common non-source dirs. */
  private async collectFiles(dir: string): Promise<string[]> {
    const SKIP_DIRS = new Set([
      'node_modules',
      '.git',
      'target',
      '__pycache__',
      '.venv',
      'venv',
      '.mypy_cache',
      '.pytest_cache',
    ]);

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden files/dirs

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        files.push(...(await this.collectFiles(fullPath)));
      } else {
        files.push(fullPath);
      }
    }

    return files;
  }

  /** Upload every file in projectDir into the sandbox at /app/<relative>. */
  private async uploadProjectFiles(
    sandboxId: string,
    projectDir: string
  ): Promise<void> {
    const files = await this.collectFiles(projectDir);

    // Ensure the /app directory exists inside the sandbox
    await this.execInSandbox(sandboxId, 'mkdir -p /app');

    for (const file of files) {
      const relativePath = path.relative(projectDir, file);
      const content = await fs.readFile(file, 'utf-8');
      const sandboxPath = `/app/${relativePath}`;

      // Ensure parent directory exists
      const parentDir = path.dirname(sandboxPath);
      await this.execInSandbox(sandboxId, `mkdir -p ${parentDir}`);

      await this.writeFileToSandbox(sandboxId, sandboxPath, content);
    }
  }
}

// ============================================================
// Shared utilities
// ============================================================

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectProjectType(
  projectDir: string
): Promise<ProjectType | null> {
  if (await fileExists(path.join(projectDir, 'Cargo.toml'))) {
    return 'rust';
  }
  if (
    (await fileExists(path.join(projectDir, 'requirements.txt'))) ||
    (await fileExists(path.join(projectDir, 'pyproject.toml')))
  ) {
    return 'python';
  }
  return null;
}

async function countProjectFiles(projectDir: string): Promise<number> {
  const instance = new SuperserveTarget();
  // We access the private method through the instance — it's the same class.
  // Using a small helper to avoid duplication:
  const files = await (instance as unknown as { collectFiles(d: string): Promise<string[]> }).collectFiles(projectDir);
  return files.length;
}