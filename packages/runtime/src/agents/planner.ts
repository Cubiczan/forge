import { BaseAgent, type Message } from './base.js';
import type { AgentConfig, PipelineContext, PlanOutput } from '../types/index.js';

export class PlannerAgent extends BaseAgent {
  constructor(config: AgentConfig) {
    super(config);
  }

  buildMessages(context: PipelineContext): Message[] {
    const messages: Message[] = [];

    messages.push({
      role: 'system',
      content: this.config.systemPrompt || PLANNER_SYSTEM_PROMPT,
    });

    let userContent = `## Task\n${context.userRequest}\n\n`;

    // If the project language is known, hint at it
    if (context.metadata.language) {
      userContent += `**Project language:** ${context.metadata.language}\n\n`;
    }

    userContent += `## Output Format
Respond with a JSON object:
\`\`\`json
{
  "tasks": ["Step 1: ...", "Step 2: ..."],
  "approach": "Overall approach description",
  "filesToModify": ["src/existing.rs"],
  "filesToCreate": ["src/new_module.rs"]
}
\`\`\`
`;

    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  parseResponse(raw: string): PlanOutput {
    try {
      const jsonStr = this.extractJson(raw);
      const parsed = JSON.parse(jsonStr);

      return {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(String) : [],
        approach: String(parsed.approach || ''),
        filesToModify: Array.isArray(parsed.filesToModify)
          ? parsed.filesToModify.map(String)
          : [],
        filesToCreate: Array.isArray(parsed.filesToCreate)
          ? parsed.filesToCreate.map(String)
          : [],
      };
    } catch {
      // Fallback: treat the whole response as the approach
      return {
        tasks: [],
        approach: raw,
        filesToModify: [],
        filesToCreate: [],
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

const PLANNER_SYSTEM_PROMPT = `You are a technical planner in the Forge agent pipeline. Given a user request, decompose it into clear implementation steps.

Your output must include:
1. **tasks**: Ordered list of implementation steps
2. **approach**: High-level description of the strategy
3. **filesToModify**: Existing files that need changes
4. **filesToCreate**: New files that need to be created

Be specific about file paths and what changes are needed. Think about dependencies between steps.
You have access to tools: file_read, search. Use them to understand the existing codebase structure.`;