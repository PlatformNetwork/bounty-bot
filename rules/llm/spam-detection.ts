/**
 * LLM spam detection rules — instructions for identifying fraudulent submissions.
 */

import type { LLMRule } from '../../src/rules/types.js';

const rules: LLMRule[] = [
  {
    id: 'llm.spam.template-farming',
    description: 'Detect template-farmed submissions',
    category: 'spam',
    priority: 'critical',
    instruction:
      'Be highly suspicious of submissions that follow a rigid template: same structure, same phrasing, ' +
      'with only the page name or URL swapped. These are template-farmed and should be INVALID. ' +
      'Look for: identical sentence structure, placeholder-like descriptions, formulaic "Steps to Reproduce".',
  },
  {
    id: 'llm.spam.ai-generated',
    description: 'Detect AI-generated filler',
    category: 'spam',
    priority: 'high',
    instruction:
      'If the issue body reads like AI-generated boilerplate (phrases like "It is important to note", ' +
      '"Furthermore", "In conclusion", excessive politeness, no specific technical details), ' +
      'treat it as strong evidence of spam. AI-generated issues with no real bug details are INVALID.',
  },
  {
    id: 'llm.spam.screenshot-mismatch',
    description: 'Check screenshot matches description',
    category: 'spam',
    priority: 'high',
    instruction:
      'If the pre-computed media check says media URLs exist, verify the description matches what ' +
      'a screenshot would show. If the description talks about a login page but the context suggests ' +
      'the screenshot is of something unrelated, flag this as suspicious.',
  },
  {
    id: 'llm.spam.burst-awareness',
    description: 'Factor in burst submission signals',
    category: 'spam',
    priority: 'normal',
    instruction:
      'If the pre-computed spam score is above 0.5, pay extra attention to quality signals. ' +
      'A high spam score combined with generic content is strong grounds for INVALID.',
    condition: (ctx) => ctx.spamScore > 0.5,
  },
];

export default rules;
