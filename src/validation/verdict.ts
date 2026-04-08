/**
 * Unified verdict engine.
 *
 * Orchestrates verdict publishing: calls the appropriate GitHub
 * mutation, stores the validation result in the database, sends
 * a webhook callback to Atlas, and logs to the audit trail.
 */

import { logger } from '../logger.js';
import { insertValidationResult, insertAuditLog, updateBountyStatus } from '../db/index.js';
import { sendWebhookCallback, buildWebhookPayload } from '../webhook-client.js';
import {
  applyValidVerdict,
  applyInvalidVerdict,
  applyDuplicateVerdict,
} from '../github/mutations.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface VerdictResult {
  verdict: 'valid' | 'invalid' | 'duplicate';
  rationale: string;
  evidence?: object;
  checklist?: string[];
  duplicateOf?: number;
  spamScore?: number;
  mediaCheck?: {
    hasMedia: boolean;
    accessible: boolean;
  };
}

/* ------------------------------------------------------------------ */
/*  Comment formatting                                                 */
/* ------------------------------------------------------------------ */

/**
 * Format a VerdictResult into a structured markdown comment.
 */
export function formatVerdictComment(result: VerdictResult): string {
  const sections: string[] = [];

  // Verdict header
  const emoji =
    result.verdict === 'valid'
      ? '✅'
      : result.verdict === 'invalid'
        ? '❌'
        : '🔁';
  sections.push(`## ${emoji} Verdict: ${result.verdict.charAt(0).toUpperCase() + result.verdict.slice(1)}`);

  // Rationale
  sections.push(`### Rationale\n\n${result.rationale}`);

  // Evidence
  if (result.evidence) {
    sections.push(
      `### Evidence\n\n<details>\n<summary>Details</summary>\n\n\`\`\`json\n${JSON.stringify(result.evidence, null, 2)}\n\`\`\`\n\n</details>`,
    );
  }

  // Checklist
  if (result.checklist && result.checklist.length > 0) {
    const items = result.checklist.map((c) => `- [ ] ${c}`).join('\n');
    sections.push(`### Checklist\n\n${items}`);
  }

  // Duplicate reference
  if (result.duplicateOf !== undefined) {
    sections.push(`### Duplicate\n\nDuplicate of #${result.duplicateOf}`);
  }

  // Media check
  if (result.mediaCheck) {
    const status = result.mediaCheck.hasMedia
      ? result.mediaCheck.accessible
        ? '✅ Media found and accessible'
        : '⚠️ Media found but not accessible'
      : 'ℹ️ No media attached';
    sections.push(`### Media Check\n\n${status}`);
  }

  // Spam score
  if (result.spamScore !== undefined) {
    sections.push(`### Spam Score\n\n${result.spamScore}/100`);
  }

  return sections.join('\n\n');
}

/* ------------------------------------------------------------------ */
/*  Verdict publisher                                                  */
/* ------------------------------------------------------------------ */

/**
 * Publish a verdict for an issue.
 *
 * 1. Apply the appropriate GitHub mutations (labels, comment, close)
 * 2. Store the validation result in the database
 * 3. Send a webhook callback to Atlas
 * 4. Write an audit log entry
 */
export async function publishVerdict(
  issueNumber: number,
  result: VerdictResult,
  workspaceId?: string,
): Promise<void> {
  logger.info(
    { issueNumber, verdict: result.verdict },
    'Publishing verdict',
  );

  // 1. Apply GitHub mutations
  switch (result.verdict) {
    case 'valid':
      await applyValidVerdict(issueNumber, result.rationale, result.evidence);
      break;
    case 'invalid':
      await applyInvalidVerdict(issueNumber, result.rationale, result.checklist);
      break;
    case 'duplicate':
      if (result.duplicateOf === undefined) {
        throw new Error(
          `Duplicate verdict for #${issueNumber} missing duplicateOf field`,
        );
      }
      await applyDuplicateVerdict(
        issueNumber,
        result.duplicateOf,
        result.rationale,
      );
      break;
  }

  // 2. Store validation result in DB
  insertValidationResult({
    issue_number: issueNumber,
    workspace_id: workspaceId,
    verdict: result.verdict,
    rationale: result.rationale,
    evidence: result.evidence ? JSON.stringify(result.evidence) : undefined,
    spam_score: result.spamScore,
    duplicate_of: result.duplicateOf,
    media_check: result.mediaCheck
      ? JSON.stringify(result.mediaCheck)
      : undefined,
  });

  // 3. Update bounty status in DB
  updateBountyStatus(issueNumber, 'completed', result.verdict);

  // 4. Send webhook callback to Atlas
  const webhookPayload = buildWebhookPayload('validation.completed', {
    issue_number: issueNumber,
    verdict: result.verdict,
    rationale: result.rationale,
    workspace_id: workspaceId ?? null,
    timestamp: new Date().toISOString(),
  });

  const webhookResult = await sendWebhookCallback(webhookPayload);
  if (!webhookResult.success) {
    logger.warn(
      { issueNumber, error: webhookResult.error },
      'Webhook callback to Atlas failed (non-fatal)',
    );
  }

  // 5. Audit log
  insertAuditLog({
    workspace_id: workspaceId,
    action: `verdict.${result.verdict}`,
    actor: 'bounty-bot',
    details: JSON.stringify({
      issue_number: issueNumber,
      verdict: result.verdict,
      rationale: result.rationale,
    }),
    github_ref: `#${issueNumber}`,
  });

  logger.info(
    { issueNumber, verdict: result.verdict },
    'Verdict published successfully',
  );
}
