/**
 * Prompt for full issue evaluation with function calling.
 *
 * Used by: llm-scorer.ts evaluateIssue()
 * Model: Gemini 3.1 Pro Preview Custom Tools
 * Max tokens: 1500
 * Tool: deliver_verdict (required, called exactly once)
 */

import { EVALUATOR_IDENTITY } from './identity.js';

export const ISSUE_EVALUATION_PROMPT = {
  id: 'bounty.issue-evaluation',
  model: 'gemini-3.1-pro-preview-customtools',
  maxTokens: 1500,
  temperature: 0.1,

  system: `${EVALUATOR_IDENTITY}

---

## Current Task

Evaluate the following bug bounty issue submission. Analyze it systematically:

### Step 1 — Evidence check
- Are there media URLs? Do they appear to be valid image/video links?
- If media_accessible is listed, trust that assessment.

### Step 2 — Clarity check
- Is the title specific and descriptive?
- Are there clear steps to reproduce?
- Is expected vs actual behavior described?

### Step 3 — Spam check
- Does this look template-farmed? (generic phrasing, copy-paste patterns)
- Is the body suspiciously short or auto-generated?
- Are there burst submission signals?

### Step 4 — Duplicate check
- If similar issues are listed, assess overlap.
- Same page + same bug = duplicate (older issue wins).

### Step 5 — Deliver verdict
Call \`deliver_verdict\` with your reasoning, recap, verdict, and confidence.

Be thorough in reasoning but concise in recap (2-3 sentences max for recap).`,

  buildUserMessage(ctx: {
    title: string;
    body: string;
    mediaUrls: string[];
    mediaAccessible?: boolean;
    similarIssues?: Array<{ number: number; title: string; similarity: number }>;
    spamScore?: number;
    issueNumber?: number;
    author?: string;
  }): string {
    const parts = [
      `# Issue to evaluate`,
      ctx.issueNumber ? `**Number:** #${ctx.issueNumber}` : '',
      `**Title:** ${ctx.title}`,
      ctx.author ? `**Author:** ${ctx.author}` : '',
      '',
      '**Body:**',
      ctx.body || '(empty)',
      '',
      `**Media URLs:** ${ctx.mediaUrls.length > 0 ? ctx.mediaUrls.join(', ') : 'None'}`,
      ctx.mediaAccessible !== undefined
        ? `**Media accessible:** ${ctx.mediaAccessible ? 'Yes' : 'No'}`
        : '',
      ctx.spamScore !== undefined
        ? `**Pre-computed spam score:** ${ctx.spamScore.toFixed(2)} (higher = more likely spam)`
        : '',
    ];

    if (ctx.similarIssues && ctx.similarIssues.length > 0) {
      parts.push('', '## Similar existing issues');
      for (const s of ctx.similarIssues) {
        parts.push(
          `- #${s.number}: "${s.title}" (similarity: ${(s.similarity * 100).toFixed(0)}%)`,
        );
      }
    }

    return parts.filter((line) => line !== undefined).join('\n');
  },
};
