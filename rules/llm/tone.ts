/**
 * LLM tone rules — how the model should phrase its responses.
 */

import type { LLMRule } from '../../src/rules/types.js';

const rules: LLMRule[] = [
  {
    id: 'llm.tone.professional',
    description: 'Maintain professional tone',
    category: 'tone',
    priority: 'normal',
    instruction:
      'Write your reasoning and recap in a professional, neutral tone. ' +
      'Do not be sarcastic, condescending, or emotional. State facts.',
  },
  {
    id: 'llm.tone.no-sympathy',
    description: 'No sympathy verdicts',
    category: 'tone',
    priority: 'high',
    instruction:
      'Never soften a verdict out of sympathy. "I can see you tried hard but..." is not acceptable. ' +
      'If the submission does not meet criteria, it is INVALID regardless of apparent effort.',
  },
  {
    id: 'llm.tone.concise-recap',
    description: 'Keep recap concise',
    category: 'tone',
    priority: 'normal',
    instruction:
      'The recap field must be 2-3 sentences maximum. It will be posted as a public comment. ' +
      'No bullet points in recap — use flowing prose.',
  },
];

export default rules;
