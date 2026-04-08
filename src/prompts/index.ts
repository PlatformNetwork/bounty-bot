/**
 * Prompt registry — barrel export for all bounty-bot prompts.
 */

export { EVALUATOR_IDENTITY, EVALUATOR_NAME } from "./identity.js";
export { ISSUE_EVALUATION_PROMPT } from "./issue-evaluation.js";
export { DUPLICATE_ANALYSIS_PROMPT } from "./duplicate-analysis.js";

import { EVALUATOR_IDENTITY } from "./identity.js";

/**
 * Compose a system prompt by prepending the evaluator identity.
 */
export function withIdentity(taskPrompt: string): string {
  return `${EVALUATOR_IDENTITY}\n\n---\n\n## Current Task\n\n${taskPrompt}`;
}
