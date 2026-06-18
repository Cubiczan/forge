import { BaseAgent, type Message } from './base.js';
import type {
  AgentConfig,
  PipelineContext,
  ReviewOutput,
  ReviewIssue,
  CodeOutput,
  PlanOutput,
} from '../types/index.js';

export class ReviewerAgent extends BaseAgent {
  constructor(config: AgentConfig) {
    super(config);
  }

  buildMessages(context: PipelineContext): Message[] {
    const messages: Message[] = [];

    messages.push({
      role: 'system',
      content: this.config.systemPrompt || REVIEWER_SYSTEM_PROMPT,
    });

    let userContent = `## Code Review Request\n\n`;

    if (context.plan) {
      const plan = context.plan as PlanOutput;
      userContent += `### Original Request\n${context.userRequest}\n\n`;
      userContent += `### Planned Approach\n${plan.approach}\n\n`;
    }

    if (context.codeChanges) {
      const code = context.codeChanges as CodeOutput;
      userContent += `### Changes Summary\n${code.summary}\n\n`;
      userContent += `### Files Changed\n`;
      for (const change of code.filesChanged) {
        userContent += `\n#### ${change.action.toUpperCase()}: ${change.path}\n`;
        if (change.content) {
          userContent += `\`\`\`\n${change.content}\n\`\`\`\n`;
        }
        if (change.diff) {
          userContent += `\`\`\`diff\n${change.diff}\n\`\`\`\n`;
        }
      }
    }

    // Include previous review rounds for context when re-reviewing
    const prevReview = context.reviewResult as ReviewOutput | undefined;
    if (prevReview) {
      userContent += `\n### Previous Review (Round ${prevReview.round})\n`;
      userContent += `Status: ${prevReview.approved ? 'APPROVED' : 'CHANGES REQUESTED'}\n`;
      for (const issue of prevReview.issues) {
        userContent += `- [${issue.severity}] ${issue.file}: ${issue.message}\n`;
      }
      userContent += `\nThis is a re-review after fixes. Check if previous issues are resolved.\n`;
    }

    userContent += `
## Output Format
Respond with a JSON object:
\`\`\`json
{
  "approved": true | false,
  "issues": [
    {
      "severity": "error" | "warning" | "info",
      "file": "path/to/file",
      "line": 42,
      "message": "Description of the issue",
      "suggestion": "How to fix it"
    }
  ],
  "summary": "Overall review summary"
}
\`\`\`
`;

    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  /**
   * Parse the raw LLM response into a ReviewOutput.
   *
   * Note: the `round` field is always set to `1` here. The pipeline engine
   * is responsible for incrementing it on each review loop iteration so
   * that the agent itself does not need access to mutable context.
   */
  parseResponse(raw: string): ReviewOutput {
    try {
      const jsonStr = this.extractJson(raw);
      const parsed = JSON.parse(jsonStr);

      const issues: ReviewIssue[] = (parsed.issues || []).map(
        (i: Record<string, unknown>) => ({
          severity: i.severity as 'error' | 'warning' | 'info',
          file: i.file as string,
          line: i.line as number | undefined,
          message: i.message as string,
          suggestion: i.suggestion as string | undefined,
        }),
      );

      // Block on any error-severity issues regardless of the model's opinion
      const hasErrors = issues.some((i) => i.severity === 'error');
      const approved = parsed.approved === true && !hasErrors;

      return {
        approved,
        issues,
        summary: parsed.summary || 'Review completed',
        round: 1, // pipeline engine will bump this
      };
    } catch {
      return {
        approved: false,
        issues: [
          {
            severity: 'error',
            file: 'unknown',
            message: 'Failed to parse review response',
          },
        ],
        summary: raw,
        round: 1,
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

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer in the Forge agent pipeline. Your job is to thoroughly review code changes for production readiness.

Review criteria:
1. **Correctness**: Does the code do what it's supposed to? Are there logic errors?
2. **Security**: Any vulnerabilities (injection, auth bypass, data exposure)?
3. **Performance**: Are there obvious performance issues (N+1 queries, unnecessary allocations, missing indexes)?
4. **Error Handling**: Are errors properly handled and propagated?
5. **Code Quality**: Is the code clean, readable, and well-structured?
6. **Testing**: Are there appropriate tests? Do they cover edge cases?
7. **Consistency**: Does the code follow the project's existing patterns?

Severity levels:
- **error**: Must fix before deployment (bugs, security issues, missing error handling)
- **warning**: Should fix (performance concerns, style issues, missing docs)
- **info**: Nice to have (minor suggestions, alternative approaches)

Be thorough but fair. Only block on actual problems. Approve if there are no errors, even if there are warnings.`;