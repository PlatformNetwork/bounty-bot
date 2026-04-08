/**
 * LLM evaluation rules — core instructions for how the model should judge issues.
 *
 * These are injected into the system prompt as numbered instructions.
 * The model MUST follow them when calling deliver_verdict.
 */

import type { LLMRule } from '../../src/rules/types.js';

const rules: LLMRule[] = [
  {
    id: 'llm.eval.evidence-first',
    description: 'Prioritize evidence over narrative',
    category: 'evaluation',
    priority: 'critical',
    instruction:
      'Always prioritize concrete evidence (screenshots, videos, URLs) over the quality of the written description. ' +
      'A poorly written report with clear visual proof of a bug is VALID. ' +
      'A beautifully written report with no evidence is INVALID.',
  },
  {
    id: 'llm.eval.reproducibility',
    description: 'Require reproducibility path',
    category: 'evaluation',
    priority: 'critical',
    instruction:
      'A valid bug report must contain enough information for an engineer to reproduce the issue. ' +
      'If the steps to reproduce are missing or impossibly vague ("it just broke"), the issue is INVALID.',
  },
  {
    id: 'llm.eval.older-wins',
    description: 'Older issue takes precedence in duplicates',
    category: 'evaluation',
    priority: 'high',
    instruction:
      'When similar issues exist, the OLDER issue (lower issue number) always takes precedence. ' +
      'The newer submission is the duplicate, never the other way around.',
  },
  {
    id: 'llm.eval.confidence-calibration',
    description: 'Calibrate confidence scores',
    category: 'evaluation',
    priority: 'high',
    instruction:
      'Confidence scores must be calibrated: use 0.9+ only when evidence is unambiguous and complete. ' +
      'Use 0.5-0.7 when the issue is borderline. Use below 0.5 when you are genuinely uncertain. ' +
      'Never default to 0.5 — commit to a direction.',
  },
  {
    id: 'llm.eval.no-benefit-of-doubt',
    description: 'No benefit of the doubt',
    category: 'evaluation',
    priority: 'high',
    instruction:
      'Do not give the benefit of the doubt. Missing evidence means INVALID. ' +
      'Unclear reproduction steps means INVALID. Inaccessible media means INVALID. ' +
      'The burden of proof is on the submitter.',
  },
];

export default rules;
