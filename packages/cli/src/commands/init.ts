import fs from 'fs';
import path from 'path';

/**
 * Initialize a new Forge project by copying the example config.
 */
export async function initProject(opts: { name: string; language: string }): Promise<void> {
  const cwd = process.cwd();
  const configPath = path.join(cwd, 'forge.yaml');
  const agentsDir = path.join(cwd, '.forge/agents');

  // Check if already initialized
  if (fs.existsSync(configPath)) {
    throw new Error('forge.yaml already exists in this directory');
  }

  // Create .forge/agents directory structure
  fs.mkdirSync(path.join(agentsDir, 'coder'), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, 'reviewer'), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, 'planner'), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, 'deployer'), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, 'verifier'), { recursive: true });

  // Create default prompt files
  const defaultPrompts: Record<string, string> = {
    coder: `You are an expert ${opts.language} engineer. Write clean, production-quality code.
Follow existing project patterns. Handle errors properly. Include tests when appropriate.`,
    reviewer: `Review code changes for correctness, security, and quality.
Block on errors. Warn on performance and style issues.`,
    planner: `Decompose deployment requests into clear, ordered implementation steps.
Specify which files to create and modify.`,
    deployer: `Plan and execute deployments to the configured target.
Include rollback steps. Be careful with production.`,
    verifier: `Run post-deployment verification: health checks, smoke tests, and functionality tests.`,
  };

  for (const [agent, prompt] of Object.entries(defaultPrompts)) {
    fs.writeFileSync(path.join(agentsDir, agent, 'prompt.md'), prompt);
  }

  // Generate forge.yaml from the example
  const examplePath = findExampleConfig();
  if (examplePath) {
    let content = fs.readFileSync(examplePath, 'utf-8');
    content = content.replace('name: my-project', `name: ${opts.name}`);
    content = content.replace('language: rust', `language: ${opts.language}`);
    fs.writeFileSync(configPath, content);
  } else {
    // Fallback: write a minimal config
    const minimal = `name: ${opts.name}
language: ${opts.language}

agents:
  coder:
    model: claude-sonnet-4-20250514
    max_tokens: 8192
    temperature: 0.2
  reviewer:
    model: gpt-4o
    max_tokens: 4096
    temperature: 0.1
    max_review_rounds: 3
  planner:
    model: claude-sonnet-4-20250514
    max_tokens: 4096
    temperature: 0.2
  deployer:
    model: claude-sonnet-4-20250514
    max_tokens: 4096
    temperature: 0.1
  verifier:
    model: claude-sonnet-4-20250514
    max_tokens: 4096
    temperature: 0.1

deploy:
  target: docker
  config: {}

runtime:
  max_pipeline_duration_ms: 600000
  max_agent_tokens: 16384
  max_shell_commands: 50
  allowed_shell_commands:
    - cargo
    - rustc
    - docker
    - kubectl
    - npm
    - bun
    - python3
    - git
`;
    fs.writeFileSync(configPath, minimal);
  }
}

function findExampleConfig(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'forge.yaml.example');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}