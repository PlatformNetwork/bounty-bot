/**
 * LLM output format rules — constraints on how the model structures its response.
 */

import type { LLMRule } from '../../src/rules/types.js';

const rules: LLMRule[] = [
  {
    id: 'llm.format.must-call-tool',
    description: 'Must call deliver_verdict exactly once',
    category: 'output-format',
    priority: 'critical',
    instruction:
      'You MUST call the deliver_verdict function exactly once. Do not output a JSON object manually. ' +
      'Do not output your verdict in plain text. Use the tool.',
  },
  {
    id: 'llm.format.reasoning-before-verdict',
    description: 'Reasoning must come before verdict',
    category: 'output-format',
    priority: 'high',
    instruction:
      'In the reasoning field, explain your step-by-step analysis BEFORE stating your conclusion. ' +
      'Cover: evidence quality, clarity, spam signals, and duplicate overlap in that order.',
  },
  {
    id: 'llm.format.no-internal-details',
    description: 'Do not expose internal details',
    category: 'output-format',
    priority: 'high',
    instruction:
      'Never mention internal scoring thresholds, rule IDs, detection heuristics, or system architecture ' +
      'in the recap field. The recap is public-facing. Keep reasoning technical but recap user-friendly.',
  },
];

export default rules;
