/**
 * Scoring adjustment rules — modify the final score based on heuristics.
 *
 * Category: scoring
 * These apply penalty weights that the engine sums into penaltyScore.
 */

import type { Rule } from '../src/rules/types.js';

const rules: Rule[] = [
  {
    id: 'scoring.duplicate-threshold',
    description: 'Penalize issues with moderate duplicate similarity (0.5-0.75)',
    category: 'scoring',
    severity: 'penalize',
    weight: 0.3,
    failureMessage: 'Issue has moderate similarity to existing issues, suggesting partial overlap.',
    evaluate: (ctx) => ctx.duplicateScore < 0.5,
  },
  {
    id: 'scoring.suspicious-edits',
    description: 'Penalize issues with concerning edit history (fraud score > 0.3)',
    category: 'scoring',
    severity: 'penalize',
    weight: 0.25,
    failureMessage: 'Issue has a concerning edit history pattern.',
    evaluate: (ctx) => ctx.editFraudScore < 0.3,
  },
];

export default rules;
