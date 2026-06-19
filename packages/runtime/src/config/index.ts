import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ForgeConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Zod schema — mirrors the ForgeConfig TypeScript interface
// ---------------------------------------------------------------------------

const AgentConfigSchema = z.object({
  model: z.string(),
  max_tokens: z.number(),
  temperature: z.number(),
  max_review_rounds: z.number().optional(),
});

const ForgeConfigSchema = z.object({
  name: z.string(),
  language: z.string(),
  agents: z.object({
    planner: AgentConfigSchema,
    coder: AgentConfigSchema,
    reviewer: AgentConfigSchema,
    deployer: AgentConfigSchema,
    verifier: AgentConfigSchema,
  }),
  deploy: z.object({
    target: z.string(),
    config: z.record(z.string(), z.string()),
  }),
  runtime: z.object({
    max_pipeline_duration_ms: z.number(),
    max_agent_tokens: z.number(),
    max_shell_commands: z.number(),
    allowed_shell_commands: z.array(z.string()),
  }),
  spacetime: z
    .object({
      host: z.string(),
      database: z.string(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate `forge.yaml` from the given project directory.
 *
 * @throws {Error} if the file is missing, unparsable, or fails Zod validation.
 */
export function loadForgeConfig(projectDir: string): ForgeConfig {
  const configPath = path.join(projectDir, 'forge.yaml');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    throw new Error(
      `forge.yaml not found at ${configPath}. Copy forge.yaml.example to forge.yaml and customise it.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    throw new Error('forge.yaml contains invalid YAML.');
  }

  const result = ForgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    throw new Error(`Invalid forge.yaml: ${details}`);
  }

  return result.data;
}

/**
 * Resolve the path to the shipped example config file.
 * Useful for scaffolding new projects.
 */
export function getExampleConfigPath(): string {
  return path.resolve(__dirname, '../../../forge.yaml.example');
}