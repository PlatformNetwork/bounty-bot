/**
 * Queue processor with retry logic.
 *
 * Processes pending bounties from the database with distributed locking,
 * retry management, and dead-letter handling for exhausted retries.
 */

import { MAX_RETRIES } from "../config.js";
import { logger } from "../logger.js";
import {
  getPendingBounties,
  getInProgressBounties,
  updateBountyStatus,
  lockBounty,
  unlockBounty,
  insertRequeueRecord,
  getDeadLetterItems,
} from "../db/index.js";
import { acquireLock, releaseLock } from "../redis.js";
import { runValidationPipeline } from "../validation/pipeline.js";
import { publishVerdict } from "../validation/verdict.js";
import { moveToDeadLetter } from "./dead-letter.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface QueueEntry {
  issueNumber: number;
  workspaceId: string;
  retryCount: number;
  addedAt: string;
}

export interface QueueStatus {
  pending: number;
  inProgress: number;
  completed: number;
  deadLettered: number;
}

/* ------------------------------------------------------------------ */
/*  In-memory queue                                                    */
/* ------------------------------------------------------------------ */

const queue: QueueEntry[] = [];

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let processorTimer: ReturnType<typeof setInterval> | null = null;
const LOCK_OWNER = "queue-processor";
const LOCK_TTL_SECONDS = 300;

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Add an entry to the processing queue.
 */
export function enqueue(entry: QueueEntry): void {
  queue.push(entry);
  logger.info(
    { issueNumber: entry.issueNumber, queueLength: queue.length },
    "Queue: entry added",
  );
}

/**
 * Process the next item in the queue.
 *
 * Acquires a distributed lock, runs the validation pipeline
 * (placeholder for Phase 4 expansion), and handles retries/dead-lettering.
 */
export async function processQueue(): Promise<void> {
  const entry = queue.shift();
  if (!entry) return;

  const lockKey = `lock:queue:${entry.issueNumber}`;
  const locked = await acquireLock(lockKey, LOCK_OWNER, LOCK_TTL_SECONDS);

  if (!locked) {
    logger.info(
      { issueNumber: entry.issueNumber },
      "Queue: could not acquire lock — re-enqueuing",
    );
    queue.push(entry);
    return;
  }

  try {
    // Lock bounty in DB
    lockBounty(entry.issueNumber, LOCK_OWNER, LOCK_TTL_SECONDS * 1000);
    updateBountyStatus(entry.issueNumber, "in_progress");

    logger.info(
      { issueNumber: entry.issueNumber, retry: entry.retryCount },
      "Queue: processing bounty",
    );

    // Run the full validation pipeline
    const verdictResult = await runValidationPipeline(
      entry.issueNumber,
      entry.workspaceId,
    );

    // Publish the verdict (GitHub mutations, DB, webhook, audit)
    await publishVerdict(entry.issueNumber, verdictResult, entry.workspaceId);

    logger.info(
      { issueNumber: entry.issueNumber, verdict: verdictResult.verdict },
      "Queue: processing complete",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { issueNumber: entry.issueNumber, err: msg },
      "Queue: processing failed",
    );

    const nextRetry = entry.retryCount + 1;

    if (nextRetry >= MAX_RETRIES) {
      // Dead-letter the bounty via dead-letter manager
      await moveToDeadLetter(entry.issueNumber, msg, {
        retry_count: nextRetry,
        last_error: msg,
      });

      logger.warn(
        { issueNumber: entry.issueNumber, retries: nextRetry },
        "Queue: bounty dead-lettered after max retries",
      );
    } else {
      // Requeue with incremented retry count
      queue.push({
        ...entry,
        retryCount: nextRetry,
      });

      insertRequeueRecord({
        issue_number: entry.issueNumber,
        requester_id: LOCK_OWNER,
        requester_context: `Retry ${nextRetry}/${MAX_RETRIES}: ${msg}`,
      });

      logger.info(
        { issueNumber: entry.issueNumber, retry: nextRetry },
        "Queue: bounty re-enqueued for retry",
      );
    }
  } finally {
    unlockBounty(entry.issueNumber);
    await releaseLock(lockKey, LOCK_OWNER);
  }
}

/**
 * Get current queue status including DB counts.
 */
export function getQueueStatus(): QueueStatus {
  const pending = getPendingBounties().length;
  const inProgress = getInProgressBounties().length;
  const deadLettered = getDeadLetterItems().length;

  return {
    pending: pending + queue.length,
    inProgress,
    completed: 0, // Counted from DB if needed
    deadLettered,
  };
}

/**
 * Get the queue position for a specific issue number.
 * Returns -1 if not in queue.
 */
export function getQueuePosition(issueNumber: number): number {
  const idx = queue.findIndex((e) => e.issueNumber === issueNumber);
  return idx === -1 ? -1 : idx + 1;
}

/**
 * Start the queue processing loop.
 *
 * @param intervalMs - Processing interval in milliseconds (default 5000)
 */
export function startQueueProcessor(intervalMs?: number): void {
  if (processorTimer) {
    logger.warn("Queue processor: already running");
    return;
  }

  const interval = intervalMs ?? 5000;
  logger.info({ intervalMs: interval }, "Queue processor: starting");

  processorTimer = setInterval(() => {
    processQueue().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Queue processor: iteration failed");
    });
  }, interval);
}

/**
 * Stop the queue processing loop.
 */
export function stopQueueProcessor(): void {
  if (processorTimer) {
    clearInterval(processorTimer);
    processorTimer = null;
    logger.info("Queue processor: stopped");
  }
}
