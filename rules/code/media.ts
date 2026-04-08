/**
 * Media rules — evidence requirements for bounty issues.
 *
 * Category: media
 * Evaluated after the media check phase.
 */

import type { Rule } from '../../src/rules/types.js';

const rules: Rule[] = [
  {
    id: 'media.require-evidence',
    description: 'Issue must include at least one screenshot or video URL',
    category: 'media',
    severity: 'require',
    failureMessage: 'No media evidence found. Attach a screenshot or video showing the bug.',
    evaluate: (ctx) => ctx.mediaUrls.length > 0,
  },
  {
    id: 'media.must-be-accessible',
    description: 'All media URLs must be publicly accessible (HTTP 200)',
    category: 'media',
    severity: 'require',
    failureMessage: 'Media URLs are not accessible. Ensure images/videos are publicly viewable.',
    evaluate: (ctx) => {
      if (ctx.mediaUrls.length === 0) return true;
      return ctx.mediaAccessible;
    },
  },
  {
    id: 'media.no-placeholder-urls',
    description: 'Media URLs should not be placeholder or example URLs',
    category: 'media',
    severity: 'reject',
    failureMessage: 'Detected placeholder/example media URLs instead of real evidence.',
    evaluate: (ctx) => {
      const placeholders = ['example.com', 'placeholder', 'lorem', 'test.png', 'screenshot.png'];
      return !ctx.mediaUrls.some((url) =>
        placeholders.some((p) => url.toLowerCase().includes(p)),
      );
    },
  },
];

export default rules;
