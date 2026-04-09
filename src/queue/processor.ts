/**
 * Queue processor with retry logic.
 *
 * Processes pending bounties from the database with distributed locking,
 * retry management, and dead-letter handling for exhausted retries.
 */

import { MAX_RETRIES, QUEUE_CONCURRENCY, QUEUE_INTERVAL } from "../config.js";
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
import { acquireLock, releaseLock, flushKeysByPattern } from "../redis.js";
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
 * Process a single queue entry — lock, validate, publish verdict.
 */
async function processOne(entry: QueueEntry): Promise<void> {
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
    lockBounty(entry.issueNumber, LOCK_OWNER, LOCK_TTL_SECONDS * 1000);
    updateBountyStatus(entry.issueNumber, "in_progress");

    logger.info(
      { issueNumber: entry.issueNumber, retry: entry.retryCount },
      "Queue: processing bounty",
    );

    const verdictResult = await runValidationPipeline(
      entry.issueNumber,
      entry.workspaceId,
    );

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
      await moveToDeadLetter(entry.issueNumber, msg, {
        retry_count: nextRetry,
        last_error: msg,
      });

      logger.warn(
        { issueNumber: entry.issueNumber, retries: nextRetry },
        "Queue: bounty dead-lettered after max retries",
      );
    } else {
      queue.push({ ...entry, retryCount: nextRetry });

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
 * Process up to QUEUE_CONCURRENCY items in parallel.
 */
export async function processQueue(): Promise<void> {
  if (queue.length === 0) return;

  const batch = queue.splice(0, Math.min(QUEUE_CONCURRENCY, queue.length));

  logger.info(
    { batchSize: batch.length, remaining: queue.length },
    "Queue: processing batch",
  );

  await Promise.allSettled(batch.map((entry) => processOne(entry)));
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
 * Recover pending AND stuck in_progress bounties from the database
 * into the in-memory queue. Called once at startup to handle issues
 * that were pending or mid-flight when the bot restarted.
 * Sorts by issue_number ASC so oldest issues are processed first.
 */
export function recoverPendingFromDb(): void {
  const pending = getPendingBounties();
  const inProgress = getInProgressBounties();
  const allRecoverable = [...pending, ...inProgress].sort(
    (a, b) => a.issue_number - b.issue_number,
  );
  const existingNumbers = new Set(queue.map((e) => e.issueNumber));
  let recovered = 0;

  for (const bounty of allRecoverable) {
    if (!existingNumbers.has(bounty.issue_number)) {
      // Reset in_progress back to pending so it can be re-processed
      if (bounty.status === "in_progress") {
        updateBountyStatus(bounty.issue_number, "pending");
      }
      queue.push({
        issueNumber: bounty.issue_number,
        workspaceId: `ws-${bounty.issue_number}`,
        retryCount: bounty.retry_count ?? 0,
        addedAt: new Date().toISOString(),
      });
      recovered++;
    }
  }

  if (recovered > 0) {
    logger.info(
      { recovered, queueLength: queue.length },
      "Queue processor: recovered pending/in-progress bounties from DB",
    );
  }
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

  const interval = intervalMs ?? QUEUE_INTERVAL;
  logger.info({ intervalMs: interval, concurrency: QUEUE_CONCURRENCY }, "Queue processor: starting");

  // Flush stale locks from previous run before recovering bounties
  flushKeysByPattern("lock:queue:*")
    .then((count) => {
      if (count > 0) logger.info({ count }, "Queue processor: flushed stale queue locks");
    })
    .catch(() => {});
  flushKeysByPattern("lock:bounty:*")
    .then((count) => {
      if (count > 0) logger.info({ count }, "Queue processor: flushed stale bounty locks");
    })
    .catch(() => {});

  // Recover any pending bounties from DB
  recoverPendingFromDb();

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
