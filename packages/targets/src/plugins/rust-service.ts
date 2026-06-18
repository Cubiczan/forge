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
 * Builds a Rust project into a Docker image and deploys it.
 * Supports cargo build locally or Docker-based builds.
 */
export class RustServiceTarget implements DeployTarget {
  readonly name = 'rust-service';
  readonly description = 'Build and deploy Rust services as Docker containers';

  validateConfig(config: Record<string, unknown>): void {
    if (!config.registry && !config.image_prefix) {
      // Not an error — will use defaults
    }
  }

  async build(context: BuildContext): Promise<BuildResult> {
    const start = Date.now();
    context.onProgress('Checking Cargo.toml...');

    const cargoPath = path.join(context.projectDir, 'Cargo.toml');
    if (!(await fileExists(cargoPath))) {
      return {
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: 'No Cargo.toml found in project directory',
      };
    }

    // Parse crate name from Cargo.toml
    const crateName = await parseCrateName(cargoPath);
    context.onProgress(`Building Rust crate: ${crateName}`);

    // Run cargo build in release mode
    try {
      context.onProgress('Running cargo build --release...');
      const { stdout, stderr } = await execAsync('cargo build --release', {
        cwd: context.projectDir,
        timeout: 600000, // 10 min
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
    const { config, buildResult, deploymentId } = context;

    if (!buildResult.success || !buildResult.artifactPath) {
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
    const imageName = `${registry}/${imagePrefix}app:${deploymentId}`;

    context.onProgress(`Building Docker image: ${imageName}`);

    // Check for Dockerfile
    const dockerfilePath = path.join(context.projectDir, 'Dockerfile');
    if (!(await fileExists(dockerfilePath))) {
      // Generate a minimal Dockerfile for the Rust binary
      context.onProgress('No Dockerfile found, generating one...');
      await generateDockerfile(context.projectDir, buildResult.artifactPath);
    }

    // Build Docker image
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

async function parseCrateName(cargoPath: string): Promise<string> {
  const content = await fs.readFile(cargoPath, 'utf-8');
  const match = content.match(/name\s*=\s*"([^"]+)"/);
  return match ? match[1] : 'app';
}

async function generateDockerfile(projectDir: string, _binaryPath: string): Promise<void> {
  const dockerfile = `FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY target/release/app /app/app
RUN chmod +x /app/app
EXPOSE 8080
CMD ["/app/app"]
`;
  await fs.writeFile(path.join(projectDir, 'Dockerfile'), dockerfile);
}