/**
 * Force-release endpoint handler.
 *
 * Force-release performs NO GitHub mutations — only Redis + DB cleanup.
 */

import { logger } from "../logger.js";
import { unlockBounty, insertAuditLog } from "../db/index.js";
import { getRedis } from "../redis.js";

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
