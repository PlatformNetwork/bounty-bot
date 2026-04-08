/**
 * Rule evaluation engine.
 *
 * Evaluates all loaded rules against an issue context and produces
 * an aggregated report. The pipeline uses this report to override
 * or adjust verdicts, and the LLM prompt includes rule results
 * so the model accounts for them in its reasoning.
 */

import { logger } from '../logger.js';
import { getRules, getRulesByCategory } from './loader.js';
import type {
  Rule,
  RuleContext,
  RuleResult,
  RuleEvaluationReport,
  RuleCategory,
} from './types.js';

/**
 * Evaluate all enabled rules against an issue.
 */
export async function evaluateRules(
  ctx: RuleContext,
): Promise<RuleEvaluationReport> {
  const rules = getRules().filter((r) => r.enabled !== false);

  if (rules.length === 0) {
    return {
      passed: [],
      failed: [],
      totalRules: 0,
      hasReject: false,
      hasFailed: false,
      penaltyScore: 0,
      summary: 'No rules configured.',
    };
  }

  const passed: RuleResult[] = [];
  const failed: RuleResult[] = [];

  for (const rule of rules) {
    const result = await evaluateSingle(rule, ctx);
    if (result.passed) {
      passed.push(result);
    } else {
      failed.push(result);
    }
  }

  const hasReject = failed.some((r) => r.severity === 'reject');
  const penaltyScore = failed
    .filter((r) => r.severity === 'penalize')
    .reduce((sum, r) => sum + r.weight, 0);

  const summary = buildSummary(passed, failed, rules.length);

  logger.info(
    {
      total: rules.length,
      passed: passed.length,
      failed: failed.length,
      hasReject,
      penaltyScore: penaltyScore.toFixed(2),
    },
    'Rule evaluation complete',
  );

  return {
    passed,
    failed,
    totalRules: rules.length,
    hasReject,
    hasFailed: failed.length > 0,
    penaltyScore,
    summary,
  };
}

/**
 * Evaluate rules for a specific category only.
 */
export async function evaluateCategory(
  category: RuleCategory,
  ctx: RuleContext,
): Promise<RuleResult[]> {
  const rules = getRulesByCategory(category);
  const results: RuleResult[] = [];
  for (const rule of rules) {
    results.push(await evaluateSingle(rule, ctx));
  }
  return results;
}

/**
 * Format rule results for inclusion in an LLM prompt.
 * The LLM uses this to factor rules into its reasoning.
 */
export function formatRulesForPrompt(report: RuleEvaluationReport): string {
  if (report.totalRules === 0) return '';

  const lines: string[] = [
    '## Rule Evaluation Results',
    `${report.passed.length}/${report.totalRules} rules passed.`,
    '',
  ];

  if (report.failed.length > 0) {
    lines.push('### Failed Rules');
    for (const r of report.failed) {
      const severity = r.severity.toUpperCase();
      lines.push(`- [${severity}] ${r.ruleId}: ${r.message}`);
    }
    lines.push('');
  }

  if (report.passed.length > 0 && report.passed.length <= 10) {
    lines.push('### Passed Rules');
    for (const r of report.passed) {
      lines.push(`- [OK] ${r.ruleId}`);
    }
    lines.push('');
  } else if (report.passed.length > 10) {
    lines.push(`### Passed Rules (${report.passed.length} total — showing first 5)`);
    for (const r of report.passed.slice(0, 5)) {
      lines.push(`- [OK] ${r.ruleId}`);
    }
    lines.push(`- ... and ${report.passed.length - 5} more`);
    lines.push('');
  }

  if (report.hasReject) {
    lines.push(
      '**IMPORTANT:** One or more REJECT rules failed. The issue should be marked INVALID unless there is extraordinary justification.',
    );
  }

  return lines.join('\n');
}

async function evaluateSingle(
  rule: Rule,
  ctx: RuleContext,
): Promise<RuleResult> {
  try {
    const passed = await rule.evaluate(ctx);
    return {
      ruleId: rule.id,
      category: rule.category,
      severity: rule.severity,
      passed,
      message: passed
        ? rule.description
        : (rule.failureMessage ?? `Rule ${rule.id} failed: ${rule.description}`),
      weight: rule.weight ?? 1.0,
    };
  } catch (err) {
    logger.warn({ err, ruleId: rule.id }, 'Rule evaluation threw — treating as failed');
    return {
      ruleId: rule.id,
      category: rule.category,
      severity: rule.severity,
      passed: false,
      message: `Rule ${rule.id} threw an error during evaluation`,
      weight: rule.weight ?? 1.0,
    };
  }
}

function buildSummary(
  _passed: RuleResult[],
  failed: RuleResult[],
  total: number,
): string {
  if (failed.length === 0) {
    return `All ${total} rules passed.`;
  }
  const rejects = failed.filter((r) => r.severity === 'reject');
  const penalties = failed.filter((r) => r.severity === 'penalize');
  const flags = failed.filter((r) => r.severity === 'flag');
  const parts: string[] = [`${failed.length}/${total} rules failed.`];
  if (rejects.length > 0) parts.push(`${rejects.length} REJECT`);
  if (penalties.length > 0) parts.push(`${penalties.length} PENALIZE`);
  if (flags.length > 0) parts.push(`${flags.length} FLAG`);
  return parts.join(' | ');
}
