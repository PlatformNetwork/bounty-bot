/**
 * Rule type definitions.
 *
 * Two kinds of rules:
 *   - Code rules (rules/code/)  — programmatic checks executed by the engine
 *   - LLM rules  (rules/llm/)   — text instructions injected into the LLM prompt
 */

/** Categories that rules can belong to. */
export type RuleCategory =
  | "validity"
  | "spam"
  | "duplicate"
  | "media"
  | "edit-history"
  | "scoring"
  | "content";

/** Severity determines how a rule violation affects the verdict. */
export type RuleSeverity =
  | "reject" // Immediately invalidate
  | "penalize" // Add to spam/penalty score
  | "flag" // Warn but don't change verdict
  | "require"; // Must pass or issue is invalid

/* ------------------------------------------------------------------ */
/*  Code Rules — executed programmatically in the pipeline             */
/* ------------------------------------------------------------------ */

/** A code rule with an evaluate function. Loaded from rules/code/. */
export interface CodeRule {
  /** Unique rule identifier (e.g. "code.media.require-screenshot"). */
  id: string;

  /** Human-readable description shown in verdicts and logs. */
  description: string;

  /** Rule category — determines when in the pipeline it's evaluated. */
  category: RuleCategory;

  /** How violations affect the verdict. */
  severity: RuleSeverity;

  /** Weight for scoring rules (0.0-1.0). Default: 1.0. */
  weight?: number;

  /** Whether this rule is currently active. Default: true. */
  enabled?: boolean;

  /**
   * Evaluate the rule against an issue context.
   * Return true if the rule PASSES, false if it FAILS (violation).
   */
  evaluate: (ctx: RuleContext) => boolean | Promise<boolean>;

  /** Message to include in rationale when the rule fails. */
  failureMessage?: string;
}

/* ------------------------------------------------------------------ */
/*  LLM Rules — text instructions injected into the LLM prompt        */
/* ------------------------------------------------------------------ */

/** Priority for ordering LLM rules in the prompt. */
export type LLMRulePriority = "critical" | "high" | "normal" | "low";

/** An LLM rule is a natural-language instruction for the model. Loaded from rules/llm/. */
export interface LLMRule {
  /** Unique rule identifier (e.g. "llm.tone.no-sympathy"). */
  id: string;

  /** Short label shown in logs and API responses. */
  description: string;

  /** Category for grouping in the prompt. */
  category: RuleCategory | "evaluation" | "tone" | "output-format";

  /** Priority determines ordering: critical rules appear first. */
  priority: LLMRulePriority;

  /** Whether this rule is currently active. Default: true. */
  enabled?: boolean;

  /**
   * The actual instruction text injected into the system prompt.
   * Written in natural language addressed to the LLM.
   */
  instruction: string;

  /**
   * Optional condition: if provided, the rule is only injected when
   * the condition returns true for the given context.
   */
  condition?: (ctx: RuleContext) => boolean;
}

/* ------------------------------------------------------------------ */
/*  Backwards compatibility — Rule is an alias for CodeRule            */
/* ------------------------------------------------------------------ */

export type Rule = CodeRule;

/* ------------------------------------------------------------------ */
/*  Shared types                                                       */
/* ------------------------------------------------------------------ */

/** Context passed to rule evaluation functions. */
export interface RuleContext {
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  mediaUrls: string[];
  mediaAccessible: boolean;
  spamScore: number;
  duplicateScore: number;
  editFraudScore: number;
  labels: string[];
}

/** Result of evaluating a single code rule. */
export interface RuleResult {
  ruleId: string;
  category: RuleCategory;
  severity: RuleSeverity;
  passed: boolean;
  message: string;
  weight: number;
}

/** Aggregated results from evaluating all rules. */
export interface RuleEvaluationReport {
  codeResults: {
    passed: RuleResult[];
    failed: RuleResult[];
  };
  llmInstructions: string[];
  totalCodeRules: number;
  totalLLMRules: number;
  hasReject: boolean;
  hasFailed: boolean;
  penaltyScore: number;
  summary: string;
}
