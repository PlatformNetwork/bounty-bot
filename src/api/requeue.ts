/**
 * Requeue endpoint handlers.
 *
 * Handles manual re-evaluation requests and force-release of locked
 * bounties. Enforces business rules: 24h max age, once per issue,
 * and force-release performs NO GitHub mutations.
 */

import { logger } from "../logger.js";
import {
  getBounty,
  getRequeueRecord,
  insertRequeueRecord,
  updateBountyStatus,
  unlockBounty,
  insertAuditLog,
} from "../db/index.js";
import { reopenIssue, postComment } from "../github/client.js";
import { clearVerdictLabels } from "../github/mutations.js";
import { enqueue } from "../queue/processor.js";
import { getRedis } from "../redis.js";
import { TARGET_REPO } from "../config.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

/** Maximum age (ms) of an issue eligible for requeue (default 24h). */
const REQUEUE_MAX_AGE_MS = parseInt(
  process.env.REQUEUE_MAX_AGE_MS || "86400000",
  10,
);

/* ------------------------------------------------------------------ */
/*  Repo helpers                                                       */
/* ------------------------------------------------------------------ */

function parseRepo(): { owner: string; repo: string } {
  const parts = TARGET_REPO.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid TARGET_REPO format: "${TARGET_REPO}"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/* ------------------------------------------------------------------ */
/*  Requeue handler                                                    */
/* ------------------------------------------------------------------ */

/**
 * Handle a requeue request for an issue.
 *
 * Business rules:
 * - Issue must exist in DB
 * - Issue created_at must be within 24 hours
 * - Issue must not already have been requeued
 *
 * If valid: reopen issue, clear labels, post re-eval comment, create
 * requeue record, enqueue for processing.
 *
 * If invalid: return rejection with reason — NO GitHub mutations.
 *
 * @param issueNumber - GitHub issue number
 * @param requesterId - ID of the requester
 * @param requesterContext - Optional context from the requester
 * @returns Success/failure with optional error message
 */
export async function handleRequeue(
  issueNumber: number,
  requesterId: string,
  requesterContext?: object,
): Promise<{ success: boolean; error?: string }> {
  // Validate: issue exists in DB
  const bounty = getBounty(issueNumber);
  if (!bounty) {
    logger.info({ issueNumber }, "Requeue: issue not found in DB");
    return { success: false, error: `Issue #${issueNumber} not found` };
  }

  // Validate: issue created_at within 24 hours
  if (bounty.created_at) {
    const createdAt = new Date(bounty.created_at).getTime();
    const age = Date.now() - createdAt;
    if (age > REQUEUE_MAX_AGE_MS) {
      logger.info(
        { issueNumber, ageMs: age, maxAgeMs: REQUEUE_MAX_AGE_MS },
        "Requeue: issue too old",
      );
      return {
        success: false,
        error: `Issue #${issueNumber} is older than ${REQUEUE_MAX_AGE_MS / 3600000}h — not eligible for requeue`,
      };
    }
  }

  // Validate: not already requeued
  const existingRequeue = getRequeueRecord(issueNumber);
  if (existingRequeue) {
    logger.info({ issueNumber }, "Requeue: already requeued");
    return {
      success: false,
      error: `Issue #${issueNumber} has already been requeued`,
    };
  }

  // All validations passed — proceed with requeue

  const { owner, repo } = parseRepo();

  try {
    // Reopen issue
    await reopenIssue(owner, repo, issueNumber);

    // Clear verdict labels
    await clearVerdictLabels(issueNumber);

    // Post re-evaluation comment
    await postComment(
      owner,
      repo,
      issueNumber,
      `## 🔄 Re-evaluation Requested\n\nThis issue has been requeued for re-validation by \`${requesterId}\`.\n\nPrevious verdict labels have been cleared.`,
    );

    // Create requeue record
    insertRequeueRecord({
      issue_number: issueNumber,
      requester_id: requesterId,
      requester_context: requesterContext
        ? JSON.stringify(requesterContext)
        : undefined,
    });

    // Reset bounty status
    updateBountyStatus(issueNumber, "pending");

    // Enqueue for processing
    enqueue({
      issueNumber,
      workspaceId: bounty.workspace_id ?? "",
      retryCount: 0,
      addedAt: new Date().toISOString(),
    });

    // Audit log
    insertAuditLog({
      workspace_id: bounty.workspace_id ?? undefined,
      action: "bounty.requeued",
      actor: requesterId,
      details: JSON.stringify({
        issue_number: issueNumber,
        requester_context: requesterContext,
      }),
      github_ref: `#${issueNumber}`,
    });

    logger.info({ issueNumber, requesterId }, "Requeue: success");
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ issueNumber, err: msg }, "Requeue: failed");
    return { success: false, error: msg };
  }
}

/* ------------------------------------------------------------------ */
/*  Force-release handler                                              */
/* ------------------------------------------------------------------ */

/**
 * Force-release a locked bounty.
 *
 * IMPORTANT: NO GitHub API calls. Only Redis + DB cleanup.
 *
 * 1. Clear Redis lock for the bounty
 * 2. Clear locked_by/locked_at in DB
 * 3. Log to audit trail
 *
 * @param issueNumber - GitHub issue number
 * @returns Success/failure
 */
export async function handleForceRelease(
  issueNumber: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Clear Redis lock
    const lockKey = `lock:bounty:${issueNumber}`;
    try {
      const redis = getRedis();
      await redis.del(lockKey);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { issueNumber, err: msg },
        "Force-release: Redis lock clear failed (continuing)",
      );
    }

    // Also clear the queue processing lock
    const queueLockKey = `lock:queue:${issueNumber}`;
    try {
      const redis = getRedis();
      await redis.del(queueLockKey);
    } catch {
      // Non-fatal — Redis may be unavailable
    }

    // Clear DB lock fields
    unlockBounty(issueNumber);

    // Audit log
    insertAuditLog({
      action: "bounty.force_released",
      actor: "system",
      details: JSON.stringify({ issue_number: issueNumber }),
      github_ref: `#${issueNumber}`,
    });

    logger.info({ issueNumber }, "Force-release: success");
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ issueNumber, err: msg }, "Force-release: failed");
    return { success: false, error: msg };
  }
}
