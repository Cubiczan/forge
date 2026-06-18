#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import fs from 'fs';
import { runPipeline } from './commands/run.js';
import { runReview } from './commands/review.js';
import { runDeploy } from './commands/deploy.js';
import { showStatus } from './commands/status.js';
import { initProject } from './commands/init.js';

const program = new Command();

program
  .name('forge')
  .description('Forge — self-improving agent system for production deployment')
  .version('0.1.0');

// forge init
program
  .command('init')
  .description('Initialize a new Forge project in the current directory')
  .option('-n, --name <name>', 'Project name', 'my-forge-project')
  .option('-l, --language <language>', 'Primary language (rust | python | node)', 'rust')
  .action(async (opts) => {
    try {
      await initProject(opts);
      console.log(chalk.green('✓ Project initialized. Edit forge.yaml to configure.'));
    } catch (err) {
      console.error(chalk.red(`✗ ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

// forge run
program
  .command('run')
  .description('Run the full agent pipeline (plan → code → review → deploy → verify)')
  .argument('[request]', 'The deployment request or task description')
  .option('-c, --config <path>', 'Path to forge.yaml', 'forge.yaml')
  .option('--dry-run', 'Plan and code without deploying', false)
  .option('-v, --verbose', 'Verbose output', false)
  .action(async (request, opts) => {
    if (!request) {
      console.error(chalk.red('Error: A request description is required.'));
      console.log('Usage: forge run "Deploy the auth service to staging"');
      process.exit(1);
    }

    const spinner = ora('Starting Forge pipeline...').start();

    try {
      const result = await runPipeline(request, {
        configPath: opts.config,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
        onEvent: (event) => {
          if (opts.verbose) {
            spinner.stop();
            console.log(chalk.dim(`[${event.agent}] ${event.message}`));
            spinner.start();
          } else {
            spinner.text = event.message;
          }
        },
      });

      spinner.stop();

      if (result.success) {
        console.log(chalk.green('\n✓ Pipeline completed successfully'));
        console.log(chalk.dim(`  Pipeline ID: ${result.pipelineId}`));
        console.log(chalk.dim(`  Agents: ${result.agentRuns.length} runs`));
        console.log(chalk.dim(`  Duration: ${formatDuration(result.totalMs)}`));

        if (result.deploymentId) {
          console.log(chalk.dim(`  Deployment: ${result.deploymentId}`));
        }
      } else {
        console.log(chalk.red('\n✗ Pipeline failed'));
        for (const error of result.errors) {
          console.log(chalk.red(`  • [${error.agent}] ${error.message}`));
        }
        process.exit(1);
      }
    } catch (err) {
      spinner.stop();
      console.error(chalk.red(`\n✗ ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

// forge review
program
  .command('review')
  .description('Run only the code review agent on current changes')
  .option('-c, --config <path>', 'Path to forge.yaml', 'forge.yaml')
  .option('--rounds <n>', 'Max review rounds', '3')
  .action(async (opts) => {
    const spinner = ora('Running code review...').start();

    try {
      const result = await runReview({
        configPath: opts.config,
        maxRounds: parseInt(opts.rounds, 10),
        onEvent: (event) => {
          spinner.text = event.message;
        },
      });

      spinner.stop();

      if (result.approved) {
        console.log(chalk.green('✓ Code review passed'));
      } else {
        console.log(chalk.yellow('✗ Code review found issues:'));
        for (const issue of result.issues) {
          const color = issue.severity === 'error' ? chalk.red : issue.severity === 'warning' ? chalk.yellow : chalk.gray;
          console.log(`  ${color(`[${issue.severity.toUpperCase()}]`)} ${issue.file}${issue.line ? `:${issue.line}` : ''}: ${issue.message}`);
          if (issue.suggestion) {
            console.log(chalk.dim(`    → ${issue.suggestion}`));
          }
        }
        process.exit(1);
      }
    } catch (err) {
      spinner.stop();
      console.error(chalk.red(`✗ ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

// forge deploy
program
  .command('deploy')
  .description('Deploy current project to the configured target')
  .option('-c, --config <path>', 'Path to forge.yaml', 'forge.yaml')
  .option('--target <target>', 'Override deploy target')
  .option('--no-verify', 'Skip post-deploy verification', false)
  .action(async (opts) => {
    const spinner = ora('Deploying...').start();

    try {
      const result = await runDeploy({
        configPath: opts.config,
        targetOverride: opts.target,
        skipVerify: opts.noVerify,
        onEvent: (event) => {
          spinner.text = event.message;
        },
      });

      spinner.stop();

      if (result.success) {
        console.log(chalk.green('✓ Deployment successful'));
        console.log(chalk.dim(`  Deployment ID: ${result.deploymentId}`));
        console.log(chalk.dim(`  Target: ${result.target}`));
        if (result.healthCheckUrl) {
          console.log(chalk.dim(`  Health: ${result.healthCheckUrl}`));
        }
      } else {
        console.log(chalk.red('✗ Deployment failed'));
        console.log(chalk.red(`  ${result.error}`));
        if (result.rolledBack) {
          console.log(chalk.yellow('  Rolled back to previous version'));
        }
        process.exit(1);
      }
    } catch (err) {
      spinner.stop();
      console.error(chalk.red(`✗ ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

// forge status
program
  .command('status')
  .description('Show current project status and recent pipeline runs')
  .option('-c, --config <path>', 'Path to forge.yaml', 'forge.yaml')
  .option('--json', 'Output as JSON', false)
  .action(async (opts) => {
    try {
      const status = await showStatus({
        configPath: opts.config,
        json: opts.json,
      });

      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(chalk.bold('Forge Project Status'));
        console.log(chalk.dim('─'.repeat(40)));
        console.log(`  Name:     ${chalk.cyan(status.projectName)}`);
        console.log(`  Language: ${status.language}`);
        console.log(`  Target:   ${status.deployTarget}`);
        console.log('');

        if (status.recentRuns.length > 0) {
          console.log(chalk.bold('Recent Pipeline Runs:'));
          for (const run of status.recentRuns.slice(0, 5)) {
            const icon = run.success ? chalk.green('✓') : chalk.red('✗');
            console.log(`  ${icon} ${run.pipelineId} — ${formatDuration(run.durationMs)} — ${run.agentCount} agents`);
          }
        } else {
          console.log(chalk.dim('  No pipeline runs yet. Use "forge run" to start.'));
        }

        console.log('');
        console.log(chalk.bold('Feedback Stats:'));
        console.log(`  Total Runs:     ${status.stats.totalRuns}`);
        console.log(`  Success Rate:   ${chalk.green(`${(status.stats.successRate * 100).toFixed(1)}%`)}`);
        console.log(`  Deployments:    ${status.stats.totalDeployments}`);
      }
    } catch (err) {
      console.error(chalk.red(`✗ ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

program.parse();

// --- Helpers ---

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

export type PipelineEvent = {
  agent: string;
  message: string;
  level: 'info' | 'warn' | 'error';
};