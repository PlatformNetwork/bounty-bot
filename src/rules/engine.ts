/**
 * Rule evaluation engine.
 *
 * Handles two kinds of rules:
 *   - Code rules  — programmatic checks, produce pass/fail results
 *   - LLM rules   — natural-language instructions injected into the prompt
 *
 * The pipeline calls evaluateRules() which runs code rules AND
 * collects applicable LLM instructions. The report contains both.
 */

import { logger } from "../logger.js";
import { getCodeRules, getCodeRulesByCategory, getLLMRules } from "./loader.js";
import type {
  CodeRule,
  LLMRulePriority,
  RuleContext,
  RuleResult,
  RuleEvaluationReport,
  RuleCategory,
} from "./types.js";

const PRIORITY_ORDER: Record<LLMRulePriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Evaluate all code rules and collect applicable LLM rules.
 */
export async function evaluateRules(
  ctx: RuleContext,
): Promise<RuleEvaluationReport> {
  // --- Code rules ---
  const codeRules = getCodeRules().filter((r) => r.enabled !== false);
  const passed: RuleResult[] = [];
  const failed: RuleResult[] = [];

  for (const rule of codeRules) {
    const result = await evaluateSingle(rule, ctx);
    if (result.passed) {
      passed.push(result);
    } else {
      failed.push(result);
    }
  }

  const hasReject = failed.some((r) => r.severity === "reject");
  const penaltyScore = failed
    .filter((r) => r.severity === "penalize")
    .reduce((sum, r) => sum + r.weight, 0);

  // --- LLM rules ---
  const llmRules = getLLMRules().filter((r) => r.enabled !== false);
  const applicableLLM = llmRules
    .filter((r) => !r.condition || r.condition(ctx))
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  const llmInstructions = applicableLLM.map((r) => r.instruction);

  const summary = buildSummary(failed, codeRules.length, applicableLLM.length);

  logger.info(
    {
      codeTotal: codeRules.length,
      codePassed: passed.length,
      codeFailed: failed.length,
      llmTotal: llmRules.length,
      llmApplicable: applicableLLM.length,
      hasReject,
      penaltyScore: penaltyScore.toFixed(2),
    },
    "Rule evaluation complete",
  );

  return {
    codeResults: { passed, failed },
    llmInstructions,
    totalCodeRules: codeRules.length,
    totalLLMRules: applicableLLM.length,
    hasReject,
    hasFailed: failed.length > 0,
    penaltyScore,
    summary,
  };
}

/**
 * Evaluate code rules for a specific category only.
 */
export async function evaluateCategory(
  category: RuleCategory,
  ctx: RuleContext,
): Promise<RuleResult[]> {
  const rules = getCodeRulesByCategory(category);
  const results: RuleResult[] = [];
  for (const rule of rules) {
    results.push(await evaluateSingle(rule, ctx));
  }
  return results;
}

/**
 * Format the full rule report for inclusion in the LLM prompt.
 *
 * Output has two sections:
 *   1. Code rule results (pass/fail from programmatic checks)
 *   2. LLM instructions (natural-language rules the model must follow)
 */
export function formatRulesForPrompt(report: RuleEvaluationReport): string {
  const sections: string[] = [];

  // --- Code rule results ---
  const { passed, failed } = report.codeResults;
  if (report.totalCodeRules > 0) {
    sections.push("## Code Rule Results");
    sections.push(
      `${passed.length}/${report.totalCodeRules} programmatic checks passed.`,
    );
    sections.push("");

    if (failed.length > 0) {
      sections.push("### Failed Checks");
      for (const r of failed) {
        sections.push(
          `- [${r.severity.toUpperCase()}] ${r.ruleId}: ${r.message}`,
        );
      }
      sections.push("");
    }

    if (passed.length > 0 && passed.length <= 8) {
      sections.push("### Passed Checks");
      for (const r of passed) {
        sections.push(`- [OK] ${r.ruleId}`);
      }
      sections.push("");
    } else if (passed.length > 8) {
      sections.push(`### Passed Checks (${passed.length} total)`);
      for (const r of passed.slice(0, 4)) {
        sections.push(`- [OK] ${r.ruleId}`);
      }
      sections.push(`- ... and ${passed.length - 4} more`);
      sections.push("");
    }

    if (report.hasReject) {
      sections.push(
        "**IMPORTANT:** One or more REJECT checks failed. The issue MUST be marked INVALID.",
      );
      sections.push("");
    }
  }

  // --- LLM instructions ---
  if (report.llmInstructions.length > 0) {
    sections.push("## Evaluation Instructions");
    sections.push("You MUST follow these rules when making your verdict:");
    sections.push("");
    for (let i = 0; i < report.llmInstructions.length; i++) {
      sections.push(`${i + 1}. ${report.llmInstructions[i]}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Internal                                                           */
/* ------------------------------------------------------------------ */

async function evaluateSingle(
  rule: CodeRule,
  ctx: RuleContext,
): Promise<RuleResult> {
  try {
    const ok = await rule.evaluate(ctx);
    return {
      ruleId: rule.id,
      category: rule.category,
      severity: rule.severity,
      passed: ok,
      message: ok
        ? rule.description
        : (rule.failureMessage ??
          `Rule ${rule.id} failed: ${rule.description}`),
      weight: rule.weight ?? 1.0,
    };
  } catch (err) {
    logger.warn(
      { err, ruleId: rule.id },
      "Code rule threw — treating as failed",
    );
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
  failed: RuleResult[],
  totalCode: number,
  totalLLM: number,
): string {
  const parts: string[] = [];
  if (totalCode > 0) {
    if (failed.length === 0) {
      parts.push(`All ${totalCode} code rules passed.`);
    } else {
      const rejects = failed.filter((r) => r.severity === "reject").length;
      const penalties = failed.filter((r) => r.severity === "penalize").length;
      const flags = failed.filter((r) => r.severity === "flag").length;
      parts.push(`${failed.length}/${totalCode} code rules failed`);
      if (rejects > 0) parts.push(`${rejects} REJECT`);
      if (penalties > 0) parts.push(`${penalties} PENALIZE`);
      if (flags > 0) parts.push(`${flags} FLAG`);
    }
  }
  if (totalLLM > 0) {
    parts.push(`${totalLLM} LLM instructions active`);
  }
  return parts.join(" | ") || "No rules configured.";
}
