import { BaseAgent, type Message } from './base.js';
import type {
  AgentConfig,
  PipelineContext,
  VerificationOutput,
  VerificationCheck,
} from '../types/index.js';

export class VerifierAgent extends BaseAgent {
  constructor(config: AgentConfig) {
    super(config);
  }

  buildMessages(context: PipelineContext): Message[] {
    const messages: Message[] = [];

    messages.push({
      role: 'system',
      content: this.config.systemPrompt || VERIFIER_SYSTEM_PROMPT,
    });

    let userContent = `## Post-Deployment Verification\n\n`;

    if (context.deploymentResult) {
      const dep = context.deploymentResult;
      userContent += `Deployment ID: ${dep.id}\n`;
      userContent += `Target: ${dep.targetType}\n`;
      userContent += `Status: ${dep.status}\n`;
      if (dep.healthCheckUrl) {
        userContent += `Health Check URL: ${dep.healthCheckUrl}\n`;
      }
    }

    userContent += `
## Instructions
Run verification checks using http_check and shell_exec tools.
Output a JSON object:
\`\`\`json
{
  "passed": true | false,
  "checks": [
    {"name": "Health Check", "passed": true, "output": "200 OK", "durationMs": 150}
  ],
  "summary": "Overall verification result"
}
\`\`\`
`;

    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  parseResponse(raw: string): VerificationOutput {
    try {
      const jsonStr = this.extractJson(raw);
      const parsed = JSON.parse(jsonStr);

      const checks: VerificationCheck[] = (parsed.checks || []).map(
        (c: Record<string, unknown>) => ({
          name: String(c.name ?? 'unnamed'),
          passed: Boolean(c.passed),
          output: String(c.output ?? ''),
          durationMs: Number(c.durationMs ?? 0),
        }),
      );

      // Overall pass requires explicit `passed: true` AND every check to pass
      const overall =
        parsed.passed !== false &&
        checks.length > 0 &&
        checks.every((c) => c.passed);

      return {
        passed: overall,
        checks,
        summary: String(parsed.summary || 'Verification completed'),
      };
    } catch {
      return {
        passed: false,
        checks: [],
        summary: raw,
      };
    }
  }

  // -- private helpers ------------------------------------------------------

  private extractJson(raw: string): string {
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();

    const objectMatch = raw.match(/\{[\s\S]*\}/);
    if (objectMatch) return objectMatch[0];

    return raw;
  }
}

const VERIFIER_SYSTEM_PROMPT = `You are a verification specialist in the Forge agent pipeline. After deployment, your job is to verify everything is working correctly.

Run these checks:
1. Health check endpoint (if available)
2. Basic functionality smoke test
3. Error handling verification
4. Performance baseline check

Use http_check and shell_exec tools. If any check fails, report it clearly so the system can trigger a rollback.`;