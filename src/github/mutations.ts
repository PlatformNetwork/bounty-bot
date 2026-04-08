/**
 * GitHub mutation helpers for verdict publishing.
 *
 * Posts rich Greptile-style review comments with summary, confidence,
 * validation checklist table, and flowchart on GitHub issues.
 */

import { TARGET_REPO } from "../config.js";
import { logger } from "../logger.js";
import { checkIdempotencyKey, setIdempotencyKey } from "../redis.js";
import { addLabels, removeLabel, postComment, closeIssue } from "./client.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseTargetRepo(): { owner: string; repo: string } {
  const parts = TARGET_REPO.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid TARGET_REPO format: "${TARGET_REPO}" — expected "owner/repo"`,
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

const VERDICT_LABELS = ["valid", "invalid", "duplicate", "ide"];

/* ------------------------------------------------------------------ */
/*  Comment builder                                                    */
/* ------------------------------------------------------------------ */

interface CommentData {
  verdict: "valid" | "invalid" | "duplicate";
  rationale: string;
  evidence?: Record<string, unknown>;
  checklist?: string[];
  duplicateOf?: number;
  spamScore?: number;
  mediaCheck?: { hasMedia: boolean; accessible: boolean };
}

function buildRichComment(issueNumber: number, data: CommentData): string {
  const { verdict, rationale, evidence, checklist, duplicateOf, spamScore, mediaCheck } = data;

  const verdictUpper = verdict.charAt(0).toUpperCase() + verdict.slice(1);
  const emoji = verdict === "valid" ? "✅" : verdict === "invalid" ? "❌" : "🔁";

  // Confidence from spam/media signals
  let confidence: number;
  let confidenceText: string;
  if (verdict === "valid") {
    confidence = 4;
    confidenceText = "All validation checks passed. This submission meets the bounty requirements.";
  } else if (verdict === "duplicate") {
    confidence = 5;
    confidenceText = `High confidence — this issue substantially overlaps with #${duplicateOf}.`;
  } else {
    confidence = spamScore && spamScore > 0.7 ? 5 : 4;
    confidenceText = spamScore && spamScore > 0.7
      ? "High confidence — multiple spam indicators triggered."
      : "This issue does not meet the minimum requirements for a valid bounty submission.";
  }

  // Build checks table
  const checks: Array<{ check: string; status: string; detail: string }> = [];

  if (mediaCheck) {
    checks.push({
      check: "Media Evidence",
      status: mediaCheck.hasMedia && mediaCheck.accessible ? "✅ Pass" : "❌ Fail",
      detail: !mediaCheck.hasMedia
        ? "No screenshot or video attached"
        : !mediaCheck.accessible
          ? "Media URLs are not publicly accessible"
          : "Evidence found and accessible",
    });
  }

  if (spamScore !== undefined) {
    checks.push({
      check: "Spam Detection",
      status: spamScore < 0.7 ? "✅ Pass" : "❌ Fail",
      detail: `Score: ${(spamScore * 100).toFixed(0)}% — ${spamScore < 0.3 ? "no spam signals" : spamScore < 0.7 ? "borderline, consulted LLM" : "template or auto-generated content detected"}`,
    });
  }

  if (duplicateOf !== undefined) {
    checks.push({
      check: "Duplicate Detection",
      status: "❌ Duplicate",
      detail: `Matches existing issue #${duplicateOf}`,
    });
  } else {
    checks.push({
      check: "Duplicate Detection",
      status: "✅ Pass",
      detail: "No significant overlap with existing issues",
    });
  }

  const codeVerify = (evidence as Record<string, unknown>)?.codeVerification as Record<string, unknown> | undefined;
  if (codeVerify) {
    const plausible = codeVerify.plausible as boolean | undefined;
    const conf = codeVerify.confidence as number | undefined;
    const ssValid = codeVerify.screenshotValid as boolean | undefined;
    const reasoning = (codeVerify.reasoning as string) ?? "";
    checks.push({
      check: "Code Verification",
      status: plausible ? "✅ Pass" : "❌ Fail",
      detail: `${plausible ? "Bug confirmed in source code" : "Bug not found in source code"} (confidence: ${conf ? (conf * 100).toFixed(0) : "?"}%)${ssValid === false ? " — screenshots invalid" : ""}${reasoning ? ` — ${reasoning.slice(0, 80)}` : ""}`,
    });
  }

  const editFraud = (evidence as Record<string, unknown>)?.editHistory as Record<string, unknown> | undefined;
  if (editFraud) {
    const fraudScore = editFraud.fraudScore as number | undefined;
    checks.push({
      check: "Edit History",
      status: fraudScore && fraudScore > 0.5 ? "⚠️ Suspicious" : "✅ Pass",
      detail: fraudScore
        ? `Fraud score: ${(fraudScore * 100).toFixed(0)}% — ${fraudScore > 0.5 ? "significant post-submission edits detected" : "normal edit pattern"}`
        : "No suspicious edits",
    });
  }

  checks.push({
    check: "LLM Evaluation",
    status: verdict === "valid" ? "✅ Pass" : "❌ Fail",
    detail: rationale.length > 120 ? rationale.slice(0, 120) + "..." : rationale,
  });

  // Assemble comment
  let md = `<!-- bounty-bot-verdict -->\n`;
  md += `<h3>${emoji} Validation Summary — Issue #${issueNumber}</h3>\n\n`;
  md += `${rationale}\n\n`;

  if (verdict === "duplicate" && duplicateOf) {
    md += `> **Duplicate of #${duplicateOf}** — the original issue takes precedence.\n\n`;
  }

  md += `<h3>Confidence Score: ${confidence}/5</h3>\n\n`;
  md += `- ${confidenceText}\n\n`;

  md += `<h3>Validation Checks</h3>\n\n`;
  md += `| Check | Status | Detail |\n|-------|--------|--------|\n`;
  for (const c of checks) {
    md += `| ${c.check} | ${c.status} | ${c.detail} |\n`;
  }
  md += "\n";

  if (checklist && checklist.length > 0) {
    md += `<h3>Action Items</h3>\n\n`;
    for (const item of checklist) {
      md += `- [ ] ${item}\n`;
    }
    md += "\n";
  }

  // Flowchart for the validation pipeline
  md += `<details><summary><h3>Validation Pipeline</h3></summary>\n\n`;
  md += "```mermaid\n";
  md += `%%{init: {'theme': 'neutral'}}%%\n`;
  md += `flowchart TD\n`;
  md += `    A["Issue #${issueNumber}"] --> B{"Media Check"}\n`;

  if (mediaCheck && (!mediaCheck.hasMedia || !mediaCheck.accessible)) {
    md += `    B -->|"${!mediaCheck.hasMedia ? "No media" : "Not accessible"}"| Z["❌ Invalid"]\n`;
    md += `    style Z fill:#ff6b6b,color:#fff\n`;
  } else {
    md += `    B -->|"✅ Found"| C{"Spam Check"}\n`;
    if (spamScore && spamScore >= 0.7) {
      md += `    C -->|"Score: ${(spamScore * 100).toFixed(0)}%"| Z["❌ Invalid"]\n`;
      md += `    style Z fill:#ff6b6b,color:#fff\n`;
    } else {
      md += `    C -->|"✅ Clean"| D{"Duplicate Check"}\n`;
      if (duplicateOf) {
        md += `    D -->|"Matches #${duplicateOf}"| Z["🔁 Duplicate"]\n`;
        md += `    style Z fill:#ffa94d,color:#fff\n`;
      } else {
        md += `    D -->|"✅ Unique"| CV{"Code Verify"}\n`;
        md += `    CV -->|"${codeVerify?.plausible ? "✅ Confirmed" : "❌ Not found"}"| E{"Edit History"}\n`;
        md += `    E -->|"✅ Normal"| F{"LLM Evaluation"}\n`;
        if (verdict === "valid") {
          md += `    F -->|"✅ Valid"| G["✅ Approved"]\n`;
          md += `    style G fill:#51cf66,color:#fff\n`;
        } else {
          md += `    F -->|"❌ Failed"| Z["❌ Invalid"]\n`;
          md += `    style Z fill:#ff6b6b,color:#fff\n`;
        }
      }
    }
  }

  md += "```\n</details>\n\n";

  if (evidence) {
    md += `<details><summary><h3>Raw Evidence</h3></summary>\n\n`;
    md += "```json\n";
    md += JSON.stringify(evidence, null, 2);
    md += "\n```\n</details>\n\n";
  }

  md += `<sub>Validated by Atlas • ${new Date().toISOString().slice(0, 10)}</sub>\n`;

  return md;
}

/* ------------------------------------------------------------------ */
/*  Verdict mutations                                                  */
/* ------------------------------------------------------------------ */

export async function applyValidVerdict(
  issueNumber: number,
  rationale: string,
  evidence?: object,
): Promise<void> {
  const { owner, repo } = parseTargetRepo();
  const idempotencyKey = `verdict:valid:${issueNumber}`;

  const existing = await checkIdempotencyKey(idempotencyKey);
  if (existing) {
    logger.info({ issueNumber }, "Valid verdict already applied (idempotent skip)");
    return;
  }

  await addLabels(owner, repo, issueNumber, ["ide", "valid"]);

  const body = buildRichComment(issueNumber, {
    verdict: "valid",
    rationale,
    evidence: evidence as Record<string, unknown>,
    mediaCheck: (evidence as Record<string, unknown>)?.media as { hasMedia: boolean; accessible: boolean } | undefined,
    spamScore: ((evidence as Record<string, unknown>)?.spam as Record<string, unknown>)?.overallScore as number | undefined,
  });

  await postComment(owner, repo, issueNumber, body);
  await setIdempotencyKey(idempotencyKey, new Date().toISOString(), 86400);

  logger.info({ issueNumber }, "Applied valid verdict");
}

export async function applyInvalidVerdict(
  issueNumber: number,
  rationale: string,
  checklist?: string[],
  evidence?: object,
  spamScore?: number,
  mediaCheck?: { hasMedia: boolean; accessible: boolean },
): Promise<void> {
  const { owner, repo } = parseTargetRepo();
  const idempotencyKey = `verdict:invalid:${issueNumber}`;

  const existing = await checkIdempotencyKey(idempotencyKey);
  if (existing) {
    logger.info({ issueNumber }, "Invalid verdict already applied (idempotent skip)");
    return;
  }

  await addLabels(owner, repo, issueNumber, ["invalid"]);

  const body = buildRichComment(issueNumber, {
    verdict: "invalid",
    rationale,
    checklist,
    evidence: evidence as Record<string, unknown>,
    spamScore,
    mediaCheck,
  });

  await postComment(owner, repo, issueNumber, body);
  await closeIssue(owner, repo, issueNumber);
  await setIdempotencyKey(idempotencyKey, new Date().toISOString(), 86400);

  logger.info({ issueNumber }, "Applied invalid verdict");
}

export async function applyDuplicateVerdict(
  issueNumber: number,
  originalIssueNumber: number,
  rationale: string,
  evidence?: object,
  spamScore?: number,
  mediaCheck?: { hasMedia: boolean; accessible: boolean },
): Promise<void> {
  const { owner, repo } = parseTargetRepo();
  const idempotencyKey = `verdict:duplicate:${issueNumber}`;

  const existing = await checkIdempotencyKey(idempotencyKey);
  if (existing) {
    logger.info({ issueNumber }, "Duplicate verdict already applied (idempotent skip)");
    return;
  }

  await addLabels(owner, repo, issueNumber, ["duplicate"]);

  const body = buildRichComment(issueNumber, {
    verdict: "duplicate",
    rationale,
    duplicateOf: originalIssueNumber,
    evidence: evidence as Record<string, unknown>,
    spamScore,
    mediaCheck,
  });

  await postComment(owner, repo, issueNumber, body);
  await closeIssue(owner, repo, issueNumber);
  await setIdempotencyKey(idempotencyKey, new Date().toISOString(), 86400);

  logger.info({ issueNumber, originalIssueNumber }, "Applied duplicate verdict");
}

export async function clearVerdictLabels(issueNumber: number): Promise<void> {
  const { owner, repo } = parseTargetRepo();

  for (const label of VERDICT_LABELS) {
    await removeLabel(owner, repo, issueNumber, label);
  }

  logger.info({ issueNumber }, "Cleared verdict labels");
}
