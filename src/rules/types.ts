/**
 * Rule type definitions.
 *
 * Rules are loaded from rules/*.ts files at startup.
 * Each file exports a default array of Rule objects.
 */

/** Categories that rules can belong to. */
export type RuleCategory =
  | 'validity'
  | 'spam'
  | 'duplicate'
  | 'media'
  | 'edit-history'
  | 'scoring'
  | 'content';

/** Severity determines how a rule violation affects the verdict. */
export type RuleSeverity =
  | 'reject'    // Immediately invalidate
  | 'penalize'  // Add to spam/penalty score
  | 'flag'      // Warn but don't change verdict
  | 'require';  // Must pass or issue is invalid

/** A single validation rule. */
export interface Rule {
  /** Unique rule identifier (e.g. "media.require-screenshot"). */
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

/** Result of evaluating a single rule. */
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
  passed: RuleResult[];
  failed: RuleResult[];
  totalRules: number;
  hasReject: boolean;
  hasFailed: boolean;
  penaltyScore: number;
  summary: string;
}
