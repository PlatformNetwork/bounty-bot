/**
 * Issue intake and normalization.
 *
 * Normalizes raw GitHub issue payloads into a consistent shape,
 * applies filtering rules (issue floor, terminal labels, DB status),
 * and manages the intake pipeline with Redis locking and idempotency.
 */

import { ISSUE_FLOOR, TARGET_REPO } from "../config.js";
import { logger } from "../logger.js";
import { getBounty, upsertBounty, isUserBlacklisted } from "../db/index.js";
import {
  acquireLock,
  releaseLock,
  setIdempotencyKey,
  checkIdempotencyKey,
} from "../redis.js";
import { enqueue } from "../queue/processor.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface NormalizedIssue {
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  labels: string[];
  mediaUrls: string[];
  repo: string;
}

export interface ProcessResult {
  process: boolean;
  reason?: string;
}

export interface IntakeResult {
  queued: boolean;
  reason?: string;
}

/* ------------------------------------------------------------------ */
/*  Media URL extraction                                               */
/* ------------------------------------------------------------------ */

const MEDIA_URL_PATTERN =
  /https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp|mp4|mov|webm|svg)/gi;

const GITHUB_MEDIA_PATTERN =
  /https:\/\/(?:user-images\.githubusercontent\.com|github\.com\/[^/]+\/[^/]+\/assets)\/[^\s)]+/gi;

/**
 * Extract media URLs from issue body text.
 */
function extractMediaUrls(body: string): string[] {
  const urls = new Set<string>();

  const directMatches = body.match(MEDIA_URL_PATTERN) ?? [];
  for (const url of directMatches) {
    urls.add(url);
  }

  const ghMatches = body.match(GITHUB_MEDIA_PATTERN) ?? [];
  for (const url of ghMatches) {
    urls.add(url);
  }

  return [...urls];
}

/* ------------------------------------------------------------------ */
/*  Normalization                                                      */
/* ------------------------------------------------------------------ */

/**
 * Normalize a raw GitHub issue webhook or API payload into a consistent shape.
 */
export function normalizeIssue(
  payload: Record<string, unknown>,
): NormalizedIssue {
  const issue = (payload.issue ?? payload) as Record<string, unknown>;
  const user = issue.user as Record<string, unknown> | null;
  const labels = issue.labels as Array<Record<string, unknown>> | undefined;
  const body = (issue.body as string) ?? "";

  return {
    issueNumber: issue.number as number,
    title: (issue.title as string) ?? "",
    body,
    author: (user?.login as string) ?? "unknown",
    createdAt: (issue.created_at as string) ?? new Date().toISOString(),
    labels: (labels ?? []).map((l) => (l.name as string) ?? ""),
    mediaUrls: extractMediaUrls(body),
    repo: TARGET_REPO,
  };
}

/* ------------------------------------------------------------------ */
/*  Filtering                                                          */
/* ------------------------------------------------------------------ */

/** Labels that indicate an issue is in a terminal state. */
const TERMINAL_LABELS = new Set(["valid", "invalid", "duplicate"]);

/** DB statuses that indicate an issue is in a terminal state. */
const TERMINAL_STATUSES = new Set(["completed", "dead_lettered"]);

/**
 * Determine whether an issue should be processed.
 *
 * Skips issues that are below the issue floor, already have terminal
 * labels, or are already in a terminal DB state.
 */
export function shouldProcess(issue: NormalizedIssue): ProcessResult {
  if (issue.issueNumber < ISSUE_FLOOR) {
    return {
      process: false,
      reason: `Issue #${issue.issueNumber} below floor (${ISSUE_FLOOR})`,
    };
  }

  if (isUserBlacklisted(issue.author)) {
    return {
      process: false,
      reason: `Author "${issue.author}" is blacklisted`,
    };
  }

  for (const label of issue.labels) {
    if (TERMINAL_LABELS.has(label.toLowerCase())) {
      return {
        process: false,
        reason: `Issue #${issue.issueNumber} has terminal label "${label}"`,
      };
    }
  }

  const existing = getBounty(issue.issueNumber);
  if (existing && TERMINAL_STATUSES.has(existing.status)) {
    return {
      process: false,
      reason: `Issue #${issue.issueNumber} already in terminal status "${existing.status}"`,
    };
  }

  return { process: true };
}

/* ------------------------------------------------------------------ */
/*  Intake pipeline                                                    */
/* ------------------------------------------------------------------ */

const LOCK_TTL_SECONDS = 60;
const LOCK_OWNER = "intake";

/**
 * Process an issue through the intake pipeline.
 *
 * Acquires a Redis lock, checks idempotency, and upserts the bounty
 * into the database. Returns whether the issue was queued for processing.
 */
export async function processIntake(
  issue: NormalizedIssue,
): Promise<IntakeResult> {
  const lockKey = `lock:bounty:${issue.issueNumber}`;
  const idempotencyKey = `intake:${issue.issueNumber}`;

  const locked = await acquireLock(lockKey, LOCK_OWNER, LOCK_TTL_SECONDS);
  if (!locked) {
    logger.info(
      { issueNumber: issue.issueNumber },
      "Intake: could not acquire lock (already being processed)",
    );
    return { queued: false, reason: "Lock held by another process" };
  }

  try {
    const existing = await checkIdempotencyKey(idempotencyKey);
    if (existing) {
      logger.info(
        { issueNumber: issue.issueNumber },
        "Intake: idempotency key exists (already ingested)",
      );
      return { queued: false, reason: "Already ingested (idempotency)" };
    }

    upsertBounty({
      issue_number: issue.issueNumber,
      repo: issue.repo,
      title: issue.title,
      body: issue.body,
      author: issue.author,
      created_at: issue.createdAt,
      labels: issue.labels.join(","),
      status: "pending",
    });

    await setIdempotencyKey(idempotencyKey, new Date().toISOString(), 3600);

    // Push into the in-memory processing queue
    enqueue({
      issueNumber: issue.issueNumber,
      workspaceId: `ws-${issue.issueNumber}`,
      retryCount: 0,
      addedAt: new Date().toISOString(),
    });

    logger.info(
      { issueNumber: issue.issueNumber },
      "Intake: issue queued for validation",
    );

    return { queued: true };
  } finally {
    await releaseLock(lockKey, LOCK_OWNER);
  }
}
