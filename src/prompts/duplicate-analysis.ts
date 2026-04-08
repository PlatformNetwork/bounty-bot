/**
 * Prompt for focused duplicate analysis when semantic similarity is high.
 *
 * Used by: duplicate.ts when hybrid score exceeds threshold
 * Model: Gemini 3.1 Pro Preview Custom Tools (or same as evaluation)
 * Max tokens: 600
 */

import { EVALUATOR_IDENTITY } from './identity.js';

export const DUPLICATE_ANALYSIS_PROMPT = {
  id: 'bounty.duplicate-analysis',
  model: 'gemini-3.1-pro-preview-customtools',
  maxTokens: 600,
  temperature: 0.1,

  system: `${EVALUATOR_IDENTITY}

---

## Current Task

You are comparing two bug reports to determine if the newer one is a duplicate of the older one.

### Rules
- Same bug on the same page/feature = DUPLICATE
- Same page but different bugs = NOT DUPLICATE
- Similar symptoms but different root causes = NOT DUPLICATE
- The OLDER issue (lower issue number) always takes precedence

### Output
Respond with a JSON object (no markdown fencing):
{
  "isDuplicate": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explanation"
}`,

  buildUserMessage(ctx: {
    newIssue: { number: number; title: string; body: string };
    oldIssue: { number: number; title: string; body: string };
    lexicalSimilarity: number;
    semanticSimilarity: number;
  }): string {
    return [
      `## Newer issue (candidate duplicate)`,
      `**#${ctx.newIssue.number}:** ${ctx.newIssue.title}`,
      ctx.newIssue.body.slice(0, 500),
      '',
      `## Older issue (original)`,
      `**#${ctx.oldIssue.number}:** ${ctx.oldIssue.title}`,
      ctx.oldIssue.body.slice(0, 500),
      '',
      `## Pre-computed similarity`,
      `Lexical (Jaccard): ${(ctx.lexicalSimilarity * 100).toFixed(0)}%`,
      `Semantic (cosine): ${(ctx.semanticSimilarity * 100).toFixed(0)}%`,
    ].join('\n');
  },
};
