/**
 * Backfill script: fetch the N most recent issues from GitHub
 * and index them into the bounties + embeddings tables.
 *
 * Usage:
 *   npx tsx scripts/backfill-issues.ts [--count 2000]
 *
 * This is independent of the validation pipeline — it indexes
 * ALL issues (regardless of labels/status) so that duplicate
 * detection has a complete corpus to compare against.
 */

import { parseArgs } from "util";

import { initBountyDb, upsertBounty, upsertEmbedding, getEmbedding } from "../src/db/index.js";
import { listRecentIssues, type GitHubIssue } from "../src/github/client.js";
import { generateFingerprint } from "../src/detection/duplicate.js";
import { computeEmbedding, isEmbeddingAvailable } from "../src/detection/embeddings.js";
import { TARGET_REPO, ISSUE_FLOOR } from "../src/config.js";
import { logger } from "../src/logger.js";

const { values } = parseArgs({
  options: {
    count: { type: "string", default: "2000" },
    "skip-embeddings": { type: "boolean", default: false },
  },
  strict: false,
});

const TARGET_COUNT = parseInt(values.count as string, 10) || 2000;
const SKIP_EMBEDDINGS = values["skip-embeddings"] as boolean;

async function fetchAllIssues(owner: string, repo: string, count: number): Promise<GitHubIssue[]> {
  const maxPages = Math.ceil(count / 100);
  const all: GitHubIssue[] = [];

  for (let page = 1; page <= maxPages; page++) {
    logger.info({ page, maxPages, fetched: all.length }, "Backfill: fetching page");

    const batch = await listRecentIssues(owner, repo, undefined, page, "created");
    const issues = batch.filter((i) => !("pull_request" in i));
    all.push(...issues);

    if (batch.length < 100) break;
    if (all.length >= count) break;

    // Small delay to respect rate limits
    await new Promise((r) => setTimeout(r, 200));
  }

  return all.slice(0, count);
}

async function main(): Promise<void> {
  const parts = TARGET_REPO.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    logger.error("Invalid TARGET_REPO format");
    process.exit(1);
  }
  const [owner, repo] = parts;

  logger.info({ target: TARGET_REPO, count: TARGET_COUNT, issueFloor: ISSUE_FLOOR }, "Backfill: starting");

  // Init DB (runs migrations including ALTER TABLE embeddings ADD COLUMN title)
  initBountyDb();

  const embeddingAvailable = !SKIP_EMBEDDINGS && isEmbeddingAvailable();
  if (!embeddingAvailable) {
    logger.info("Backfill: semantic embeddings disabled (no API key or --skip-embeddings)");
  }

  // Fetch issues
  const issues = await fetchAllIssues(owner, repo, TARGET_COUNT);
  logger.info({ fetched: issues.length }, "Backfill: issues fetched from GitHub");

  let indexed = 0;
  let skipped = 0;
  let embeddingsComputed = 0;

  for (const issue of issues) {
    if (issue.number < ISSUE_FLOOR) {
      skipped++;
      continue;
    }

    const title = issue.title ?? "";
    const body = issue.body ?? "";
    const author = issue.user?.login ?? "unknown";
    const labels = issue.labels.map((l) => l.name).join(",");

    // Upsert bounty (index-only — status stays as-is or defaults to "indexed")
    upsertBounty({
      issue_number: issue.number,
      repo: TARGET_REPO,
      title,
      body,
      author,
      created_at: issue.created_at,
      labels,
      status: "indexed",
    });

    // Upsert embedding for duplicate detection corpus
    const existing = getEmbedding(issue.number);
    const combinedText = title + " " + body;

    if (!existing || !existing.body_fingerprint) {
      let embeddingVector: Buffer | undefined;

      if (embeddingAvailable && combinedText.trim().length > 10) {
        try {
          const vector = await computeEmbedding(combinedText);
          if (vector.length > 0) {
            embeddingVector = Buffer.from(JSON.stringify(vector), "utf-8");
            embeddingsComputed++;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ issueNumber: issue.number, err: msg }, "Backfill: embedding failed");
        }
      }

      upsertEmbedding({
        issue_number: issue.number,
        title,
        title_fingerprint: generateFingerprint(title),
        body_fingerprint: combinedText,
        embedding_vector: embeddingVector,
      });
    }

    indexed++;

    if (indexed % 100 === 0) {
      logger.info({ indexed, total: issues.length, embeddingsComputed }, "Backfill: progress");
    }
  }

  logger.info(
    { indexed, skipped, embeddingsComputed, total: issues.length },
    "Backfill: complete",
  );
}

main().catch((err) => {
  logger.error({ err }, "Backfill: fatal error");
  process.exit(1);
});
