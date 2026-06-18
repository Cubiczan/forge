import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from '../types/index.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ToolExecutor {
  /** Execute a tool by name with the given arguments. */
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;

  /** Register a new tool definition + handler. */
  register(definition: ToolDefinition): void;

  /** List all registered tool definitions (for LLM schema generation). */
  listTools(): ToolDefinition[];
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ---------------------------------------------------------------------------
// ToolExecutorImpl
// ---------------------------------------------------------------------------

/**
 * In-process tool executor with built-in tools for file I/O, shell execution,
 * code search, and HTTP health checks.
 *
 * Shell commands can be restricted to an allow-list via the constructor.
 */
export class ToolExecutorImpl implements ToolExecutor {
  private tools: Map<string, RegisteredTool> = new Map();
  private allowedCommands: Set<string>;
  private commandCounter = 0;
  private maxCommands: number;

  constructor(opts?: { allowedCommands?: string[]; maxShellCommands?: number }) {
    this.allowedCommands = new Set(opts?.allowedCommands ?? []);
    this.maxCommands = opts?.maxShellCommands ?? 100;
    this.registerDefaults();
  }

  // -- ToolExecutor interface -----------------------------------------------

  register(definition: ToolDefinition): void {
    const handler = this.resolveHandler(definition.handler);
    this.tools.set(definition.name, { definition, handler });
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `Unknown tool: ${name}. Available: ${[...this.tools.keys()].join(', ')}`,
        durationMs: 0,
      };
    }

    const start = Date.now();
    try {
      const result = await tool.handler(args);
      return { ...result, durationMs: Date.now() - start };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      };
    }
  }

  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  // -- Built-in tool registration -------------------------------------------

  private registerDefaults(): void {
    this.register({
      name: 'file_read',
      description: 'Read the contents of a file',
      parameters: {
        path: { type: 'string', description: 'Absolute or relative file path', required: true },
      },
      handler: 'file_read',
    });

    this.register({
      name: 'file_write',
      description: 'Write content to a file (creates parent dirs, creates or overwrites the file)',
      parameters: {
        path: { type: 'string', description: 'Absolute or relative file path', required: true },
        content: { type: 'string', description: 'Content to write', required: true },
      },
      handler: 'file_write',
    });

    this.register({
      name: 'shell_exec',
      description: 'Execute a shell command in the project directory',
      parameters: {
        command: { type: 'string', description: 'Shell command to execute', required: true },
        working_dir: { type: 'string', description: 'Working directory (defaults to cwd)', required: false },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 60000)', required: false, default: 60000 },
      },
      handler: 'shell_exec',
    });

    this.register({
      name: 'search',
      description: 'Search for a pattern in files using ripgrep',
      parameters: {
        pattern: { type: 'string', description: 'Search pattern (regex)', required: true },
        path: { type: 'string', description: 'Directory to search in', required: true },
        file_pattern: { type: 'string', description: 'File glob (e.g. "*.ts")', required: false, default: '*' },
      },
      handler: 'search',
    });

    this.register({
      name: 'http_check',
      description: 'Make an HTTP request and return status + body',
      parameters: {
        url: { type: 'string', description: 'URL to request', required: true },
        method: { type: 'string', description: 'HTTP method (default GET)', required: false, default: 'GET' },
        expected_status: { type: 'number', description: 'Expected status code (default 200)', required: false, default: 200 },
      },
      handler: 'http_check',
    });
  }

  // -- Handler resolution ---------------------------------------------------

  private resolveHandler(key: string): ToolHandler {
    switch (key) {
      // ---- file_read --------------------------------------------------------
      case 'file_read':
        return async (args) => {
          const filePath = path.resolve(String(args.path ?? ''));
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            return { success: true, output: content, durationMs: 0 };
          } catch (error) {
            return {
              success: false,
              output: '',
              error: error instanceof Error ? error.message : String(error),
              durationMs: 0,
            };
          }
        };

      // ---- file_write -------------------------------------------------------
      case 'file_write':
        return async (args) => {
          const filePath = path.resolve(String(args.path ?? ''));
          const content = String(args.content ?? '');
          try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, 'utf-8');
            return {
              success: true,
              output: `Written ${content.length} bytes to ${filePath}`,
              durationMs: 0,
            };
          } catch (error) {
            return {
              success: false,
              output: '',
              error: error instanceof Error ? error.message : String(error),
              durationMs: 0,
            };
          }
        };

      // ---- shell_exec -------------------------------------------------------
      case 'shell_exec':
        return async (args) => {
          const command = String(args.command ?? '');

          // Enforce global command budget
          this.commandCounter++;
          if (this.commandCounter > this.maxCommands) {
            return {
              success: false,
              output: '',
              error: `Shell command budget exhausted (${this.maxCommands})`,
              durationMs: 0,
            };
          }

          // Enforce allow-list (if configured)
          if (this.allowedCommands.size > 0) {
            const baseName = path.basename(command.split(/\s+/)[0]);
            if (!this.allowedCommands.has(baseName)) {
              return {
                success: false,
                output: '',
                error: `Command not allowed: ${baseName}. Allowed: ${[...this.allowedCommands].join(', ')}`,
                durationMs: 0,
              };
            }
          }

          const workingDir = String(args.working_dir ?? process.cwd());
          const timeoutMs = Number(args.timeout_ms ?? 60000);

          try {
            const { stdout, stderr } = await execAsync(command, {
              cwd: workingDir,
              timeout: timeoutMs,
              maxBuffer: 10 * 1024 * 1024, // 10 MB
            });
            return { success: true, output: stdout || stderr, durationMs: 0 };
          } catch (error: unknown) {
            const err = error as {
              stdout?: string;
              stderr?: string;
              message?: string;
            };
            return {
              success: false,
              output: err.stdout || '',
              error: err.stderr || err.message || 'Command failed',
              durationMs: 0,
            };
          }
        };

      // ---- search (ripgrep) -------------------------------------------------
      case 'search':
        return async (args) => {
          const pattern = String(args.pattern ?? '');
          const searchPath = String(args.path ?? '.');
          const filePattern = String(args.file_pattern ?? '*');

          try {
            // Escape double-quotes in the pattern to prevent injection
            const escaped = pattern.replace(/"/g, '\\"');
            let cmd = `rg --no-heading --line-number "${escaped}" "${searchPath}"`;
            if (filePattern !== '*') {
              cmd += ` --glob "${filePattern}"`;
            }

            const { stdout } = await execAsync(cmd, {
              maxBuffer: 10 * 1024 * 1024,
            });
            return { success: true, output: stdout, durationMs: 0 };
          } catch (error: unknown) {
            const err = error as { code?: string; message?: string };
            // rg exits with code 1 when no matches are found
            if (err.code === '1') {
              return { success: true, output: 'No matches found', durationMs: 0 };
            }
            return {
              success: false,
              output: '',
              error: `Search failed: ${err.message || err}`,
              durationMs: 0,
            };
          }
        };

      // ---- http_check -------------------------------------------------------
      case 'http_check':
        return async (args) => {
          const url = String(args.url ?? '');
          const method = String(args.method ?? 'GET').toUpperCase();
          const expectedStatus = Number(args.expected_status ?? 200);

          try {
            const response = await fetch(url, {
              method,
              signal: AbortSignal.timeout(30_000),
            });
            const body = await response.text();
            const passed = response.status === expectedStatus;

            return {
              success: true,
              output: [
                `Status: ${response.status} (expected ${expectedStatus}) ${passed ? '✓' : '✗'}`,
                `Body (first 1000 chars): ${body.slice(0, 1000)}`,
              ].join('\n'),
              durationMs: 0,
            };
          } catch (error) {
            return {
              success: false,
              output: '',
              error: error instanceof Error ? error.message : 'HTTP request failed',
              durationMs: 0,
            };
          }
        };

      // ---- unknown handler --------------------------------------------------
      default:
        return async () => ({
          success: false,
          output: '',
          error: `No handler registered for: ${key}`,
          durationMs: 0,
        });
    }
  }
}