/**
 * Content quality rules — structural and content quality checks.
 *
 * Category: content
 * Evaluated alongside validity rules.
 */

import type { Rule } from '../../src/rules/types.js';

const rules: Rule[] = [
  {
    id: 'content.no-profanity',
    description: 'Issue should not contain excessive profanity or abusive language',
    category: 'content',
    severity: 'flag',
    failureMessage: 'Issue contains potentially abusive language.',
    evaluate: (ctx) => {
      const profanity = ['fuck', 'shit', 'damn', 'idiot', 'stupid'];
      const lower = (ctx.title + ' ' + ctx.body).toLowerCase();
      const count = profanity.reduce(
        (acc, word) => acc + (lower.split(word).length - 1),
        0,
      );
      return count < 3;
    },
  },
  {
    id: 'content.reasonable-length',
    description: 'Issue body should not exceed 15000 characters (possible spam dump)',
    category: 'content',
    severity: 'flag',
    failureMessage: 'Issue body is excessively long (> 15000 chars), which may indicate pasted logs or spam.',
    evaluate: (ctx) => ctx.body.length <= 15000,
  },
  {
    id: 'content.has-context',
    description: 'Issue should mention the affected page, component, or URL',
    category: 'content',
    severity: 'penalize',
    weight: 0.2,
    failureMessage: 'Issue does not reference a specific page, URL, or component where the bug occurs.',
    evaluate: (ctx) => {
      const lower = ctx.body.toLowerCase();
      const hasUrl = /https?:\/\//.test(ctx.body);
      const hasPage = /page|screen|component|section|tab|modal|button|form|menu/.test(lower);
      const hasRoute = /\/[a-z]/.test(ctx.body);
      return hasUrl || hasPage || hasRoute;
    },
  },
];

export default rules;
