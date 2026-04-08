/**
 * Spam rules — patterns that indicate fraudulent or low-quality submissions.
 *
 * Category: spam
 * Evaluated after the spam scoring phase.
 */

import type { Rule } from '../../src/rules/types.js';

const rules: Rule[] = [
  {
    id: 'spam.high-score-reject',
    description: 'Reject issues with spam score above 0.85',
    category: 'spam',
    severity: 'reject',
    failureMessage: 'Issue has a very high spam score (> 0.85), indicating template-farmed or automated content.',
    evaluate: (ctx) => ctx.spamScore < 0.85,
  },
  {
    id: 'spam.generic-title',
    description: 'Title should not be a generic/template title',
    category: 'spam',
    severity: 'penalize',
    weight: 0.4,
    failureMessage: 'Issue title appears to be generic or template-generated.',
    evaluate: (ctx) => {
      const generic = [
        'bug found', 'bug report', 'issue found', 'error found',
        'problem found', 'bug', 'error', 'issue', 'problem',
        'found a bug', 'found an issue', 'found error',
      ];
      return !generic.includes(ctx.title.trim().toLowerCase());
    },
  },
  {
    id: 'spam.body-is-title-repeat',
    description: 'Body should not be a simple repetition of the title',
    category: 'spam',
    severity: 'penalize',
    weight: 0.5,
    failureMessage: 'Issue body is essentially a copy of the title with no additional detail.',
    evaluate: (ctx) => {
      const titleNorm = ctx.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const bodyNorm = ctx.body.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (bodyNorm.length === 0) return false;
      return titleNorm !== bodyNorm && !bodyNorm.startsWith(titleNorm);
    },
  },
  {
    id: 'spam.no-ai-filler',
    description: 'Body should not contain obvious AI-generated filler phrases',
    category: 'spam',
    severity: 'flag',
    failureMessage: 'Issue body contains phrases typical of AI-generated filler content.',
    evaluate: (ctx) => {
      const aiPhrases = [
        'as an ai', 'i cannot', 'delve into', 'it is important to note',
        'in conclusion,', 'furthermore,', 'in summary,',
        'this comprehensive', 'it\'s worth noting',
      ];
      const lower = ctx.body.toLowerCase();
      return !aiPhrases.some((p) => lower.includes(p));
    },
  },
];

export default rules;
