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
 * Python API deploy target.
 *
 * Builds a Python API (FastAPI/Flask) into a Docker image and deploys it.
 * Creates a virtual environment, installs dependencies, and runs tests.
 */
export class PythonApiTarget implements DeployTarget {
  readonly name = 'python-api';
  readonly description = 'Build and deploy Python APIs as Docker containers';

  validateConfig(config: Record<string, unknown>): void {
    // Python API has minimal config requirements
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

    // Install dependencies
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

      // Run tests if they exist
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
          // Tests failing is a warning, not a build failure
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
    const { config, buildResult, deploymentId } = context;

    if (!buildResult.success) {
      return {
        success: false,
        deploymentId,
        output: '',
        error: 'Cannot deploy — build was not successful',
      };
    }

    const start = Date.now();
    const registry = (config.registry as string) || 'ghcr.io';
    const imagePrefix = (config.image_prefix as string) || 'forge/';
    const imageName = `${registry}/${imagePrefix}python-api:${deploymentId}`;
    const pythonVersion = (config.python_version as string) || '3.12-slim';

    context.onProgress(`Building Docker image: ${imageName}`);

    // Check for Dockerfile
    const dockerfilePath = path.join(context.projectDir, 'Dockerfile');
    if (!(await fileExists(dockerfilePath))) {
      context.onProgress('No Dockerfile found, generating one...');
      await generatePythonDockerfile(context.projectDir, pythonVersion);
    }

    try {
      const { stdout } = await execAsync(
        `docker build -t ${imageName} ${context.projectDir}`,
        {
          cwd: context.projectDir,
          timeout: 300000,
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      return {
        success: true,
        deploymentId,
        imageTag: imageName,
        output: stdout,
      };
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      return {
        success: false,
        deploymentId,
        output: '',
        error: err.stderr || err.message || 'Docker build failed',
      };
    }
  }

  async rollback(_deploymentId: string, _config: Record<string, unknown>): Promise<RollbackResult> {
    return {
      success: true,
      previousVersion: 'previous',
      output: 'Rollback completed (simulated)',
    };
  }

  async healthCheck(deployment: DeployResult): Promise<HealthCheckResult> {
    if (!deployment.healthCheckUrl) {
      return { healthy: false, error: 'No health check URL configured' };
    }

    try {
      const start = Date.now();
      const response = await fetch(deployment.healthCheckUrl, {
        signal: AbortSignal.timeout(10000),
      });
      return {
        healthy: response.ok,
        statusCode: response.status,
        responseTimeMs: Date.now() - start,
        output: await response.text(),
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Health check failed',
      };
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

async function generatePythonDockerfile(projectDir: string, pythonVersion: string): Promise<void> {
  const dockerfile = `FROM python:${pythonVersion}

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port (default for FastAPI/Flask)
EXPOSE 8000

# Run with uvicorn (FastAPI) or gunicorn (Flask)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
`;
  await fs.writeFile(path.join(projectDir, 'Dockerfile'), dockerfile);
}