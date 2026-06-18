import { BaseAgent, type Message } from './base.js';
import type {
  AgentConfig,
  PipelineContext,
  CodeOutput,
  FileChange,
  PlanOutput,
  ReviewOutput,
} from '../types/index.js';

export class CoderAgent extends BaseAgent {
  constructor(config: AgentConfig) {
    super(config);
  }

  buildMessages(context: PipelineContext): Message[] {
    const messages: Message[] = [];

    // System prompt
    messages.push({
      role: 'system',
      content: this.config.systemPrompt || CODER_SYSTEM_PROMPT,
    });

    // ---- Build the user message from pipeline state -----------------------

    let userContent = `## User Request\n${context.userRequest}\n\n`;

    // Include the plan if available
    if (context.plan) {
      const plan = context.plan as PlanOutput;
      userContent += `## Plan\n${plan.approach}\n\n`;
      userContent += `### Tasks\n${plan.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n`;
      userContent += `### Files to Modify\n${plan.filesToModify.join(', ')}\n\n`;
      userContent += `### Files to Create\n${plan.filesToCreate.join(', ')}\n\n`;
    }

    // If we are looping after a failed review, include the review feedback
    const reviewResult = context.reviewResult as ReviewOutput | undefined;
    if (reviewResult && !reviewResult.approved) {
      userContent += `## Review Feedback (Round ${reviewResult.round})\n`;
      userContent +=
        'The reviewer found issues that must be fixed:\n\n';

      for (const issue of reviewResult.issues) {
        userContent += `- **[${issue.severity.toUpperCase()}]** ${issue.file}${issue.line ? `:${issue.line}` : ''}: ${issue.message}\n`;
        if (issue.suggestion) {
          userContent += `  Suggestion: ${issue.suggestion}\n`;
        }
      }

      const hasErrors = reviewResult.issues.some(
        (i) => i.severity === 'error',
      );
      userContent += `\nPlease fix all ${hasErrors ? 'errors' : 'issues'} and provide the updated files.\n\n`;
    }

    // Summarise previous code changes (useful in later review-loop rounds)
    if (context.codeChanges) {
      userContent += `## Previous Changes\n`;
      for (const change of context.codeChanges.filesChanged) {
        userContent += `- ${change.action}: ${change.path}\n`;
      }
      userContent += `\n`;
    }

    // ---- Output format instructions ----------------------------------------
    userContent += `
## Output Format
Respond with a JSON object:
\`\`\`json
{
  "files": [
    {
      "path": "src/main.rs",
      "action": "create" | "modify" | "delete",
      "content": "// file content here"
    }
  ],
  "summary": "Description of what was changed and why"
}
\`\`\`
`;

    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  parseResponse(raw: string): CodeOutput {
    try {
      const jsonStr = this.extractJson(raw);
      const parsed = JSON.parse(jsonStr);

      const files: FileChange[] = (parsed.files || []).map(
        (f: Record<string, unknown>) => ({
          path: f.path as string,
          action: f.action as 'create' | 'modify' | 'delete',
          content: f.content as string | undefined,
          diff: f.diff as string | undefined,
        }),
      );

      return {
        filesChanged: files,
        summary: parsed.summary || 'Code changes applied',
      };
    } catch {
      return {
        filesChanged: [],
        summary: raw,
      };
    }
  }

  // -- private helpers ------------------------------------------------------

  /**
   * Pull the first JSON blob out of a response that may be wrapped in
   * a markdown code fence.
   */
  private extractJson(raw: string): string {
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();

    // Try to find a raw JSON object without fences
    const objectMatch = raw.match(/\{[\s\S]*\}/);
    if (objectMatch) return objectMatch[0];

    return raw;
  }
}

const CODER_SYSTEM_PROMPT = `You are an expert software engineer working within the Forge agent pipeline. Your job is to write and modify production-quality code based on the plan and requirements provided.

Rules:
1. Write clean, idiomatic code for the target language
2. Include proper error handling
3. Follow existing code patterns in the project
4. Always explain what you're changing and why
5. If previous review feedback is provided, address ALL issues
6. Output your changes as structured JSON with the files array
7. For file modifications, include the FULL file content (not just diffs) unless the file is too large
8. Think about edge cases and production readiness

You have access to tools: file_read, file_write, shell_exec, search. Use them to explore the codebase, run tests, and verify your changes.`;