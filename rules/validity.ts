/**
 * Validity rules — basic requirements for a bounty issue to be considered.
 *
 * Category: validity
 * These are evaluated first in the pipeline.
 */

import type { Rule } from '../src/rules/types.js';

const rules: Rule[] = [
  {
    id: 'validity.min-body-length',
    description: 'Issue body must be at least 50 characters',
    category: 'validity',
    severity: 'reject',
    failureMessage: 'Issue body is too short (< 50 characters). A valid bug report needs a proper description.',
    evaluate: (ctx) => ctx.body.trim().length >= 50,
  },
  {
    id: 'validity.min-title-length',
    description: 'Issue title must be at least 10 characters',
    category: 'validity',
    severity: 'reject',
    failureMessage: 'Issue title is too short (< 10 characters). Use a descriptive title.',
    evaluate: (ctx) => ctx.title.trim().length >= 10,
  },
  {
    id: 'validity.no-empty-body',
    description: 'Issue body must not be empty or only whitespace',
    category: 'validity',
    severity: 'reject',
    failureMessage: 'Issue body is empty. Provide a description with steps to reproduce.',
    evaluate: (ctx) => ctx.body.trim().length > 0,
  },
  {
    id: 'validity.has-steps-or-description',
    description: 'Issue body should contain structured content (steps, expected/actual behavior)',
    category: 'validity',
    severity: 'penalize',
    weight: 0.3,
    failureMessage: 'Issue body lacks structured steps to reproduce or expected/actual behavior description.',
    evaluate: (ctx) => {
      const lower = ctx.body.toLowerCase();
      const hasSteps = /step|reproduce|how to|1\.|2\.|3\.|\d\)/.test(lower);
      const hasBehavior = /expect|actual|should|instead|but|however/.test(lower);
      return hasSteps || hasBehavior;
    },
  },
  {
    id: 'validity.not-a-feature-request',
    description: 'Issue should describe a bug, not a feature request',
    category: 'validity',
    severity: 'flag',
    failureMessage: 'Issue appears to be a feature request rather than a bug report.',
    evaluate: (ctx) => {
      const lower = (ctx.title + ' ' + ctx.body).toLowerCase();
      const featureSignals = ['feature request', 'suggestion', 'it would be nice', 'please add', 'can you add'];
      return !featureSignals.some((s) => lower.includes(s));
    },
  },
];

export default rules;
