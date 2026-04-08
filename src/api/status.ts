/**
 * Status and dead-letter endpoint handlers.
 *
 * Provides processing status for individual issues, lists dead-letter
 * items, and supports recovery of dead-lettered bounties.
 */

import { logger } from "../logger.js";
import {
  getBounty,
  getLatestValidation,
  getDeadLetterItems,
} from "../db/index.js";
import { getQueuePosition, enqueue } from "../queue/processor.js";
import type { DeadLetterRow } from "../db/index.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ProcessingStatus {
  status: string;
  retryCount: number;
  queuePosition?: number;
  verdict?: string | null;
  lastUpdated: string | null;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Get the current processing status for an issue.
 *
 * @param issueNumber - GitHub issue number
 * @returns Processing status or null if not found
 */
export function getProcessingStatus(
  issueNumber: number,
): ProcessingStatus | null {
  const bounty = getBounty(issueNumber);
  if (!bounty) return null;

  const validation = getLatestValidation(issueNumber);
  const queuePos = getQueuePosition(issueNumber);

  return {
    status: bounty.status,
    retryCount: bounty.retry_count,
    queuePosition: queuePos > 0 ? queuePos : undefined,
    verdict: validation?.verdict ?? bounty.verdict,
    lastUpdated: bounty.updated_at,
  };
}

/**
 * Get all dead-letter items.
 *
 * @returns Array of dead-letter rows
 */
export function getDeadLetterList(): DeadLetterRow[] {
  return getDeadLetterItems();
}

/**
 * Recover a dead-lettered item by re-enqueuing it.
 *
 * @param id - Dead-letter record ID (bounty_id / issueNumber)
 * @returns Success/failure with optional error message
 */
export function recoverDeadLetterItem(id: number): {
  success: boolean;
  error?: string;
} {
  // Find the dead-letter item — id here is the bounty_id (issueNumber)
  const items = getDeadLetterItems();
  const item = items.find((i) => i.id === id);

  if (!item) {
    return {
      success: false,
      error: `Dead-letter item with id ${id} not found`,
    };
  }

  const bounty = getBounty(item.bounty_id);
  if (!bounty) {
    return {
      success: false,
      error: `Bounty for dead-letter item ${id} not found`,
    };
  }

  // Re-enqueue
  enqueue({
    issueNumber: item.bounty_id,
    workspaceId: bounty.workspace_id ?? "",
    retryCount: 0,
    addedAt: new Date().toISOString(),
  });

  logger.info(
    { deadLetterId: id, issueNumber: item.bounty_id },
    "Dead-letter item recovered and re-enqueued",
  );

  return { success: true };
}
