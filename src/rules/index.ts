/**
 * Rules system barrel export.
 */

export type {
  Rule,
  RuleCategory,
  RuleSeverity,
  RuleContext,
  RuleResult,
  RuleEvaluationReport,
} from './types.js';

export { loadRules, reloadRules, getRules, getRulesByCategory } from './loader.js';
export { evaluateRules, evaluateCategory, formatRulesForPrompt } from './engine.js';
