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
import { normalizeIssue, shouldProcess, processIntake } from "./intake.js";

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
 * Fetches recent issues from GitHub, filters through shouldProcess,
 * and passes qualifying issues to processIntake.
 */
export async function pollOnce(): Promise<void> {
  const parts = TARGET_REPO.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    logger.error("Poller: invalid TARGET_REPO format");
    return;
  }
  const [owner, repo] = parts;

  // On first poll, backfill last 24 hours
  if (!lastPollTime) {
    lastPollTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    logger.info({ since: lastPollTime }, "Poller: backfilling last 24h");
  }

  logger.info({ since: lastPollTime }, "Poller: fetching recent issues");

  let issues;
  try {
    issues = await listAllRecentIssues(owner, repo, lastPollTime);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Poller: failed to fetch issues");
    return;
  }

  // Update last poll timestamp for next iteration
  lastPollTime = new Date().toISOString();

  let processed = 0;
  for (const rawIssue of issues) {
    // Skip pull requests (GitHub returns PRs in the issues endpoint)
    if ("pull_request" in rawIssue) continue;

    const normalized = normalizeIssue(
      rawIssue as unknown as Record<string, unknown>,
    );
    const check = shouldProcess(normalized);

    if (!check.process) {
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
    { fetched: issues.length, processed },
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
