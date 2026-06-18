import { BaseAgent, type Message } from './base.js';
import type { AgentConfig, PipelineContext, CodeOutput } from '../types/index.js';

export class DeployerAgent extends BaseAgent {
  constructor(config: AgentConfig) {
    super(config);
  }

  buildMessages(context: PipelineContext): Message[] {
    const messages: Message[] = [];

    messages.push({
      role: 'system',
      content: this.config.systemPrompt || DEPLOYER_SYSTEM_PROMPT,
    });

    const deployTarget = (context.metadata.deployTarget as string) || 'unknown';

    let userContent = `## Deployment Request\n\n`;
    userContent += `Target: ${deployTarget}\n\n`;

    if (context.codeChanges) {
      const code = context.codeChanges as CodeOutput;
      userContent += `### Changes to Deploy\n${code.summary}\n\n`;
      userContent += `### Files\n`;
      for (const change of code.filesChanged) {
        userContent += `- ${change.action}: ${change.path}\n`;
      }
    } else {
      userContent += `### No code changes found in context.\n\n`;
    }

    userContent += `
## Instructions
Plan the deployment steps. You have access to: shell_exec, file_read.
Output a JSON object with the deployment plan:
\`\`\`json
{
  "steps": ["step1", "step2"],
  "summary": "What will be deployed"
}
\`\`\`
`;

    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  parseResponse(raw: string): { steps: string[]; summary: string } {
    try {
      const jsonStr = this.extractJson(raw);
      const parsed = JSON.parse(jsonStr);

      return {
        steps: Array.isArray(parsed.steps) ? parsed.steps.map(String) : [],
        summary: String(parsed.summary || 'Deployment planned'),
      };
    } catch {
      return { steps: [], summary: raw };
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

const DEPLOYER_SYSTEM_PROMPT = `You are a deployment specialist in the Forge agent pipeline. Your job is to plan and execute the deployment of code changes to the target environment.

Forge deploys services as Firecracker micro-VMs via the Superserve API (not Docker). Each service runs in its own lightweight VM with strong isolation and millisecond startup.

You have access to shell_exec and file_read tools. Use them to:
1. Build the project (e.g. cargo build --release)
2. Package the artifact for the Superserve VM image
3. Deploy to the target via the Superserve API (POST /v1/vms)
4. Verify the deployment succeeded (poll VM status, health check)

Always include rollback steps (destroy VM, recreate previous version) in case of failure. Be careful with production deployments.`;