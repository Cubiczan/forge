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

/**
 * Rust Service deploy target.
 *
 * Builds a Rust project locally via cargo, then deploys into a
 * Superserve Firecracker microVM.
 */
export class RustServiceTarget implements DeployTarget {
  readonly name = 'rust-service';
  readonly description = 'Build Rust services and deploy to Superserve Firecracker microVMs';

  /** Map of deploymentId → sandbox ID for health checks and rollback */
  private sandboxIds = new Map<string, string>();
  private apiKey = '';
  private readonly apiBase = 'https://api.superserve.ai';

  validateConfig(config: Record<string, unknown>): void {
    if (!config.api_key || typeof config.api_key !== 'string') {
      throw new Error('rust-service target requires a string "api_key" in deployment config');
    }
  }

  async build(context: BuildContext): Promise<BuildResult> {
    const start = Date.now();
    context.onProgress('Checking Cargo.toml...');

    const cargoPath = path.join(context.projectDir, 'Cargo.toml');
    try {
      await fs.access(cargoPath);
    } catch {
      return {
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: 'No Cargo.toml found in project directory',
      };
    }

    const crateName = await parseCrateName(cargoPath);
    context.onProgress(`Building Rust crate: ${crateName}`);

    try {
      context.onProgress('Running cargo build --release...');
      const { stdout, stderr } = await execAsync('cargo build --release', {
        cwd: context.projectDir,
        timeout: 600000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const binaryPath = path.join(context.projectDir, 'target', 'release', crateName);
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

  async deploy(context: DeployContext): Promise<DeployResult> {
    const { projectDir, config, buildResult, deploymentId, onProgress } = context;
    this.apiKey = config.api_key as string;

    if (!buildResult.success || !buildResult.artifactPath) {
      return {
        success: false,
        deploymentId,
        output: '',
        error: 'Cannot deploy — build was not successful',
      };
    }

    const start = Date.now();

    try {
      // Create a Superserve sandbox for this deployment
      onProgress('Creating Superserve Firecracker microVM...');
      const sandbox = await this.apiRequest<{ id: string }>('POST', '/sandboxes', { name: `forge-rust-${deploymentId}` });
      const sandboxId = sandbox.id;
      this.sandboxIds.set(deploymentId, sandboxId);
      onProgress(`Sandbox created: ${sandboxId}`);

      // Upload project files to the sandbox
      onProgress('Uploading project files...');
      await this.uploadProjectFiles(sandboxId, projectDir);

      // Build inside the sandbox
      onProgress('Building Rust service inside microVM...');
      const buildRes = await this.apiRequest<{ stdout: string; stderr: string; exit_code: number }>(
        'POST', `/sandboxes/${sandboxId}/exec`, { command: 'cd /app && cargo build --release 2>&1' }
      );
      if (buildRes.exit_code !== 0) {
        throw new Error(`Cargo build in sandbox failed: ${buildRes.stderr || buildRes.stdout}`);
      }

      // Start the binary
      onProgress('Starting Rust service in microVM...');
      await this.apiRequest('POST', `/sandboxes/${sandboxId}/exec`, {
        command: 'cd /app && nohup ./target/release/app > /tmp/service.log 2>&1 &',
      });

      return {
        success: true,
        deploymentId,
        url: `sandbox://${sandboxId}`,
        healthCheckUrl: `sandbox://${sandboxId}/health`,
        version: 'rust',
        output: `Deployed to Superserve sandbox ${sandboxId}`,
      };
    } catch (error) {
      return {
        success: false,
        deploymentId,
        output: '',
        error: error instanceof Error ? error.message : 'Deployment failed',
      };
    }
  }

  async rollback(deploymentId: string, _config: Record<string, unknown>): Promise<RollbackResult> {
    const sandboxId = this.sandboxIds.get(deploymentId);
    if (!sandboxId) {
      return {
        success: true,
        output: `No active sandbox for deployment "${deploymentId}" — nothing to roll back`,
      };
    }

    try {
      await this.apiRequest('DELETE', `/sandboxes/${sandboxId}`);
      this.sandboxIds.delete(deploymentId);
      return {
        success: true,
        previousVersion: 'destroyed',
        output: `Destroyed Superserve sandbox ${sandboxId}`,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Rollback failed',
      };
    }
  }

  async healthCheck(deployment: DeployResult): Promise<HealthCheckResult> {
    const sandboxId = this.sandboxIds.get(deployment.deploymentId);
    if (!sandboxId) {
      return { healthy: false, error: `No sandbox for deployment "${deployment.deploymentId}"` };
    }

    try {
      const start = Date.now();
      const result = await this.apiRequest<{ stdout: string; exit_code: number }>(
        'POST', `/sandboxes/${sandboxId}/exec`,
        { command: 'curl -sf http://localhost:8080/health 2>/dev/null && echo "OK"' }
      );

      if (result.exit_code === 0) {
        return { healthy: true, statusCode: 200, responseTimeMs: Date.now() - start, output: result.stdout.trim() };
      }

      // Fallback: check process
      const ps = await this.apiRequest<{ stdout: string; exit_code: number }>(
        'POST', `/sandboxes/${sandboxId}/exec`,
        { command: 'pgrep -f "target/release" > /dev/null 2>&1 && echo "running" || echo "stopped"' }
      );
      const running = ps.stdout.trim() === 'running';
      return {
        healthy: running,
        responseTimeMs: Date.now() - start,
        output: running ? 'Service process running' : 'Service not running',
        error: running ? undefined : 'Service process not running',
      };
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : 'Health check failed' };
    }
  }

  // -----------------------------------------------------------------------
  // Superserve API helpers
  // -----------------------------------------------------------------------

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey };
  }

  private async apiRequest<T>(method: string, endpoint: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.apiBase}${endpoint}`;
    const init: RequestInit = { method, headers: this.headers() };
    if (body) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown');
      throw new Error(`Superserve ${method} ${endpoint} → ${res.status}: ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : (undefined as unknown as T);
  }

  private async uploadProjectFiles(sandboxId: string, projectDir: string): Promise<void> {
    const SKIP = new Set(['node_modules', '.git', 'target', '__pycache__', '.venv']);
    const collect = async (dir: string): Promise<string[]> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await collect(full)));
        else out.push(full);
      }
      return out;
    };

    const files = await collect(projectDir);
    await this.apiRequest('POST', `/sandboxes/${sandboxId}/exec`, { command: 'mkdir -p /app' });

    for (const file of files) {
      const rel = path.relative(projectDir, file);
      const content = await fs.readFile(file, 'utf-8');
      const sandboxPath = `/app/${rel}`;
      await this.apiRequest('POST', `/sandboxes/${sandboxId}/exec`, {
        command: `mkdir -p ${path.dirname(sandboxPath)}`,
      });
      await this.apiRequest('POST', `/sandboxes/${sandboxId}/files`, {
        path: sandboxPath,
        content,
      });
    }
  }
}

async function parseCrateName(cargoPath: string): Promise<string> {
  const content = await fs.readFile(cargoPath, 'utf-8');
  const match = content.match(/name\s*=\s*"([^"]+)"/);
  return match ? match[1] : 'app';
}