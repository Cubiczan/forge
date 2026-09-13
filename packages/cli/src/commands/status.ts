interface StatusOptions {
  configPath: string;
  json: boolean;
}

interface ProjectStatus {
  projectName: string;
  language: string;
  deployTarget: string;
  recentRuns: {
    pipelineId: string;
    success: boolean;
    durationMs: number;
    agentCount: number;
    timestamp: number;
  }[];
  stats: {
    totalRuns: number;
    totalDeployments: number;
    successRate: number;
    totalFeedback: number;
  };
}

export async function showStatus(opts: StatusOptions): Promise<ProjectStatus> {
  // In a real implementation, this would query SpacetimeDB for recent pipeline runs,
  // deployment history, and feedback stats. For now, read from local state or defaults.

  let projectName = 'unknown';
  let language = 'unknown';
  let deployTarget = 'unknown';

  try {
    const fs = require('fs');
    const { parse } = require('yaml');
    const pathMod = require('path') as typeof import('path');
    const baseDir = process.cwd();
    const requested = String(opts.configPath ?? '');
    if (requested.includes('\0')) {
      throw new Error('Invalid path');
    }
    const configPath = pathMod.resolve(baseDir, requested);
    const relative = pathMod.relative(baseDir, configPath);
    if (
      relative === '..' ||
      relative.startsWith(`..${pathMod.sep}`) ||
      pathMod.isAbsolute(relative)
    ) {
      throw new Error(`Path escapes allowed directory: ${requested}`);
    }
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = parse(raw);
      projectName = config.name || 'unknown';
      language = config.language || 'unknown';
      deployTarget = config.deploy?.target || 'unknown';
    }
  } catch {
    // Config not found, use defaults
  }

  return {
    projectName,
    language,
    deployTarget,
    recentRuns: [],
    stats: {
      totalRuns: 0,
      totalDeployments: 0,
      successRate: 0,
      totalFeedback: 0,
    },
  };
}