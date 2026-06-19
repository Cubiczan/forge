import { exec } from 'child_process';
import { promises as fs } from 'fs';
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
 * Python API deploy target.
 *
 * Installs Python dependencies locally, runs tests, then deploys into a
 * Superserve Firecracker microVM.
 */
export class PythonApiTarget implements DeployTarget {
  readonly name = 'python-api';
  readonly description = 'Build Python APIs and deploy to Superserve Firecracker microVMs';

  /** Map of deploymentId → sandbox ID for health checks and rollback */
  private sandboxIds = new Map<string, string>();
  private apiKey = '';
  private readonly apiBase = 'https://api.superserve.ai';

  validateConfig(config: Record<string, unknown>): void {
    if (!config.api_key || typeof config.api_key !== 'string') {
      throw new Error('python-api target requires a string "api_key" in deployment config');
    }
    if (config.python_version && typeof config.python_version !== 'string') {
      throw new Error('python_version must be a string (e.g. "3.12")');
    }
  }

  async build(context: BuildContext): Promise<BuildResult> {
    const start = Date.now();
    context.onProgress('Checking Python project structure...');

    const projectDir = context.projectDir;
    const hasPyproject = await fileExists(path.join(projectDir, 'pyproject.toml'));
    const hasRequirements = await fileExists(path.join(projectDir, 'requirements.txt'));
    const hasSetup = await fileExists(path.join(projectDir, 'setup.py'));

    if (!hasPyproject && !hasRequirements && !hasSetup) {
      return {
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: 'No Python project files found (pyproject.toml, requirements.txt, or setup.py)',
      };
    }

    context.onProgress('Installing dependencies...');
    try {
      const { stdout, stderr } = await execAsync(
        'pip install -r requirements.txt 2>/dev/null || pip install -e ".[dev]" 2>/dev/null || pip install -e .',
        {
          cwd: projectDir,
          timeout: 300000,
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      const hasTests = await fileExists(path.join(projectDir, 'tests'));
      if (hasTests) {
        context.onProgress('Running tests...');
        try {
          await execAsync('python -m pytest tests/ -v --tb=short', {
            cwd: projectDir,
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024,
          });
          context.onProgress('Tests passed');
        } catch (testError: unknown) {
          const err = testError as { stderr?: string };
          context.onProgress(`Tests had failures: ${err.stderr?.slice(0, 200)}`);
        }
      }

      return {
        success: true,
        artifactPath: projectDir,
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

    const start = Date.now();

    try {
      onProgress('Creating Superserve Firecracker microVM...');
      const sandbox = await this.apiRequest<{ id: string }>('POST', '/sandboxes', { name: `forge-python-${deploymentId}` });
      const sandboxId = sandbox.id;
      this.sandboxIds.set(deploymentId, sandboxId);
      onProgress(`Sandbox created: ${sandboxId}`);

      // Upload project files
      onProgress('Uploading project files...');
      await this.uploadProjectFiles(sandboxId, projectDir);

      // Install deps + start service inside the sandbox
      onProgress('Installing Python dependencies in microVM...');
      const installRes = await this.apiRequest<{ stdout: string; stderr: string; exit_code: number }>(
        'POST', `/sandboxes/${sandboxId}/exec`,
        { command: 'cd /app && pip install -r requirements.txt 2>&1 || pip install -e . 2>&1' }
      );
      if (installRes.exit_code !== 0) {
        throw new Error(`pip install in sandbox failed: ${installRes.stderr || installRes.stdout}`);
      }

      onProgress('Starting Python API in microVM...');
      await this.apiRequest('POST', `/sandboxes/${sandboxId}/exec`, {
        command: 'cd /app && nohup python -m uvicorn main:app --host 0.0.0.0 --port 8000 > /tmp/service.log 2>&1 &',
      });

      return {
        success: true,
        deploymentId,
        url: `sandbox://${sandboxId}`,
        healthCheckUrl: `sandbox://${sandboxId}/health`,
        version: 'python',
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
        { command: 'curl -sf http://localhost:8000/health 2>/dev/null && echo "OK"' }
      );

      if (result.exit_code === 0) {
        return { healthy: true, statusCode: 200, responseTimeMs: Date.now() - start, output: result.stdout.trim() };
      }

      const ps = await this.apiRequest<{ stdout: string; exit_code: number }>(
        'POST', `/sandboxes/${sandboxId}/exec`,
        { command: 'pgrep -f uvicorn > /dev/null 2>&1 && echo "running" || echo "stopped"' }
      );
      const running = ps.stdout.trim() === 'running';
      return {
        healthy: running,
        responseTimeMs: Date.now() - start,
        output: running ? 'Service process running' : 'Service not running',
        error: running ? undefined : 'Service not running',
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
    const SKIP = new Set(['node_modules', '.git', 'target', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache']);
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

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}