/**
 * Rules system barrel export.
 */

export type {
  CodeRule,
  LLMRule,
  Rule,
  RuleCategory,
  RuleSeverity,
  LLMRulePriority,
  RuleContext,
  RuleResult,
  RuleEvaluationReport,
} from "./types.js";

export {
  loadRules,
  reloadRules,
  getRules,
  getRulesByCategory,
  loadCodeRules,
  loadLLMRules,
  getCodeRules,
  getLLMRules,
} from "./loader.js";

export {
  evaluateRules,
  evaluateCategory,
  formatRulesForPrompt,
} from "./engine.js";
