/**
 * GitHub issue poller for missed webhooks.
 *
 * Periodically fetches recent issues from the GitHub API and runs
 * them through the intake pipeline. This ensures that issues opened
 * while the webhook endpoint was unreachable are still processed.
 */

import { TARGET_REPO, POLLER_INTERVAL } from "../config.js";
import { logger } from "../logger.js";
import { listAllRecentIssues } from "../github/client.js";
import { normalizeIssue, shouldProcess, processIntake, indexIssue } from "./intake.js";

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let lastPollTime: string | undefined;

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Execute a single poll iteration.
 *
 * - First poll (startup): fetches issues CREATED in the last 24h,
 *   sorted by created DESC, max 5 pages (500 issues).
 *   Filters client-side to only include issues created >= cutoff.
 * - Subsequent polls: fetches issues UPDATED since last poll,
 *   max 2 pages (200 issues) to catch recent activity only.
 *
 * Issues are reversed so oldest are queued first (FIFO fairness).
 */
export async function pollOnce(): Promise<void> {
  const parts = TARGET_REPO.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    logger.error("Poller: invalid TARGET_REPO format");
    return;
  }
  const [owner, repo] = parts;

  const isBackfill = !lastPollTime;
  let issues;

  if (isBackfill) {
    // Startup backfill: only issues CREATED in last 24h
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since = cutoff.toISOString();
    logger.info({ since }, "Poller: backfilling issues created in last 24h");

    try {
      // sort=created so GitHub returns newest-created first; max 5 pages
      issues = await listAllRecentIssues(owner, repo, since, 5, "created");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Poller: failed to fetch issues (backfill)");
      return;
    }

    // GitHub `since` filters by updated_at even with sort=created,
    // so we must filter client-side on created_at.
    const cutoffMs = cutoff.getTime();
    issues = issues.filter((issue) => {
      const created = new Date(issue.created_at).getTime();
      return created >= cutoffMs;
    });
  } else {
    // Normal poll: issues updated since last poll, max 2 pages
    logger.info({ since: lastPollTime }, "Poller: fetching recent issues");

    try {
      issues = await listAllRecentIssues(owner, repo, lastPollTime, 2);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Poller: failed to fetch issues");
      return;
    }
  }

  // Update last poll timestamp for next iteration
  lastPollTime = new Date().toISOString();

  // Reverse so oldest issues are queued first (FIFO fairness).
  issues.reverse();

  let processed = 0;
  for (const rawIssue of issues) {
    // Skip pull requests (GitHub returns PRs in the issues endpoint)
    if ("pull_request" in rawIssue) continue;

    const normalized = normalizeIssue(
      rawIssue as unknown as Record<string, unknown>,
    );
    const check = shouldProcess(normalized);

    if (!check.process) {
      // Still index for duplicate detection corpus
      indexIssue(normalized);
      continue;
    }

    try {
      const result = await processIntake(normalized);
      if (result.queued) {
        processed++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { issueNumber: normalized.issueNumber, err: msg },
        "Poller: intake failed for issue",
      );
    }
  }

  logger.info(
    { fetched: issues.length, processed, backfill: isBackfill },
    "Poller: iteration complete",
  );
}

/**
 * Start periodic polling.
 *
 * @param intervalMs - Polling interval in milliseconds (defaults to POLLER_INTERVAL config)
 */
export function startPoller(intervalMs?: number): void {
  if (pollerTimer) {
    logger.warn("Poller: already running");
    return;
  }

  const interval = intervalMs ?? POLLER_INTERVAL;
  logger.info({ intervalMs: interval }, "Poller: starting");

  // Run first poll immediately, then on interval
  pollOnce().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Poller: initial poll failed");
  });

  pollerTimer = setInterval(() => {
    pollOnce().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Poller: poll iteration failed");
    });
  }, interval);
}

/**
 * Stop periodic polling.
 */
export function stopPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    logger.info("Poller: stopped");
  }
}
