/**
 * Dead letter management.
 *
 * Handles moving failed bounties to the dead-letter queue, including
 * DB updates, webhook notifications, and audit logging.
 */

import { logger } from "../logger.js";
import {
  insertDeadLetter,
  updateBountyStatus,
  insertAuditLog,
} from "../db/index.js";
import { sendWebhookCallback, buildWebhookPayload } from "../webhook-client.js";

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Move a bounty to the dead-letter queue.
 *
 * 1. Insert into dead_letter table
 * 2. Update bounty status to 'dead_lettered'
 * 3. Send validation.failed webhook to Atlas
 * 4. Log to audit trail
 *
 * @param issueNumber - GitHub issue number
 * @param failureCause - Reason for failure
 * @param metadata - Optional additional metadata
 */
export async function moveToDeadLetter(
  issueNumber: number,
  failureCause: string,
  metadata?: object,
): Promise<void> {
  logger.info({ issueNumber, failureCause }, "Moving bounty to dead letter");

  // 1. Insert dead-letter record
  insertDeadLetter({
    bounty_id: issueNumber,
    failure_cause: failureCause,
    last_attempt: new Date().toISOString(),
    metadata: metadata ? JSON.stringify(metadata) : undefined,
  });

  // 2. Update bounty status
  updateBountyStatus(issueNumber, "dead_lettered");

  // 3. Send validation.failed webhook to Atlas
  const webhookPayload = buildWebhookPayload("validation.failed", {
    issue_number: issueNumber,
    failure_cause: failureCause,
    timestamp: new Date().toISOString(),
  });

  const webhookResult = await sendWebhookCallback(webhookPayload);
  if (!webhookResult.success) {
    logger.warn(
      { issueNumber, error: webhookResult.error },
      "Dead letter: webhook callback to Atlas failed (non-fatal)",
    );
  }

  // 4. Audit log
  insertAuditLog({
    action: "bounty.dead_lettered",
    actor: "bounty-bot",
    details: JSON.stringify({
      issue_number: issueNumber,
      failure_cause: failureCause,
    }),
    github_ref: `#${issueNumber}`,
  });

  logger.info({ issueNumber }, "Bounty moved to dead letter");
}
