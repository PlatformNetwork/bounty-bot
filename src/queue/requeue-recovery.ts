/**
 * Requeue recovery scheduler.
 *
 * Periodically checks pending requeue records and resolves them
 * when the underlying bounty has reached a terminal status.
 * Sends webhook callbacks to Atlas for completed requeues.
 */

import { logger } from "../logger.js";
import {
  getPendingRequeues,
  markRequeueCompleted,
  getBounty,
} from "../db/index.js";
import { sendWebhookCallback, buildWebhookPayload } from "../webhook-client.js";
import { getLatestValidation } from "../db/index.js";

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let recoveryTimer: ReturnType<typeof setInterval> | null = null;

/** Terminal bounty statuses that indicate the requeue has been fully processed. */
const TERMINAL_STATUSES = new Set(["completed", "dead_lettered"]);

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Check all pending requeue records and resolve those whose bounties
 * have reached a terminal status.
 */
export async function checkCompletedRequeues(): Promise<void> {
  const pending = getPendingRequeues();
  if (pending.length === 0) return;

  logger.info(
    { count: pending.length },
    "Requeue recovery: checking pending requeues",
  );

  for (const record of pending) {
    try {
      const bounty = getBounty(record.issue_number);
      if (!bounty) {
        logger.warn(
          { requeueId: record.id, issueNumber: record.issue_number },
          "Requeue recovery: bounty not found for requeue record",
        );
        continue;
      }

      if (!TERMINAL_STATUSES.has(bounty.status)) {
        continue;
      }

      // Bounty reached terminal status — resolve the requeue record
      const completedAt = new Date().toISOString();
      markRequeueCompleted(record.id, completedAt);

      logger.info(
        {
          requeueId: record.id,
          issueNumber: record.issue_number,
          status: bounty.status,
        },
        "Requeue recovery: requeue resolved",
      );

      // Fetch latest validation for the webhook payload
      const validation = getLatestValidation(record.issue_number);

      // Send webhook callback to Atlas
      const payload = buildWebhookPayload("validation.completed", {
        issue_number: record.issue_number,
        verdict: validation?.verdict ?? bounty.verdict ?? "unknown",
        rationale: validation?.rationale ?? null,
        workspace_id: bounty.workspace_id ?? null,
        requester_id: record.requester_id,
        requester_context: record.requester_context,
        requeue_id: record.id,
        completed_at: completedAt,
      });

      const result = await sendWebhookCallback(payload);
      if (!result.success) {
        logger.warn(
          { requeueId: record.id, error: result.error },
          "Requeue recovery: webhook callback failed (non-fatal)",
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { requeueId: record.id, issueNumber: record.issue_number, err: msg },
        "Requeue recovery: failed to process record",
      );
    }
  }
}

/**
 * Start the periodic requeue recovery check.
 *
 * @param intervalMs - Check interval in milliseconds (default 30000)
 */
export function startRequeueRecovery(intervalMs = 30000): void {
  if (recoveryTimer) {
    logger.warn("Requeue recovery: already running");
    return;
  }

  logger.info({ intervalMs }, "Requeue recovery: starting");

  recoveryTimer = setInterval(() => {
    checkCompletedRequeues().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Requeue recovery: iteration failed");
    });
  }, intervalMs);
}

/**
 * Stop the periodic requeue recovery check.
 */
export function stopRequeueRecovery(): void {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
    logger.info("Requeue recovery: stopped");
  }
}
