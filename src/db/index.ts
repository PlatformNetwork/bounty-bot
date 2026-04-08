/**
 * SQLite persistence layer for bounty-bot.
 *
 * Uses synchronous better-sqlite3 for deterministic, single-connection
 * access with WAL mode enabled for concurrent read performance.
 *
 * All public functions are re-exported from the package barrel so that
 * consumers can `import { upsertBounty } from './db/index.js'`.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { logger } from "../logger.js";
import { SQLITE_PATH } from "../config.js";
import { CREATE_TABLES, CREATE_INDEXES, MIGRATIONS } from "./schema.js";

/* ------------------------------------------------------------------ */
/*  Singleton instance                                                 */
/* ------------------------------------------------------------------ */

let db: DatabaseType | null = null;

/** Return the current ISO 8601 timestamp. */
function now(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/*  Initialisation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Initialise the SQLite database, create all tables/indexes, and
 * run forward-compatible migrations.
 *
 * Safe to call multiple times — subsequent calls return the existing
 * instance.
 */
export function initBountyDb(): DatabaseType {
  if (db) return db;

  logger.info({ path: SQLITE_PATH }, "Opening SQLite database");

  db = new Database(SQLITE_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create tables
  for (const sql of CREATE_TABLES) {
    db.exec(sql);
  }

  // Create indexes
  for (const sql of CREATE_INDEXES) {
    db.exec(sql);
  }

  // Run forward-compatible migrations (ignore "duplicate column" errors)
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate column name")) {
        // Expected when column already exists – skip silently
        continue;
      }
      logger.warn({ err: msg, migration }, "Migration failed");
      throw err;
    }
  }

  logger.info("SQLite schema initialised");
  return db;
}

/**
 * Return the active database instance.
 *
 * @throws {Error} if `initBountyDb()` has not been called yet.
 */
export function getBountyDb(): DatabaseType {
  if (!db) {
    throw new Error("Database not initialised – call initBountyDb() first");
  }
  return db;
}

/* ------------------------------------------------------------------ */
/*  Type helpers                                                       */
/* ------------------------------------------------------------------ */

/** Shape accepted by `upsertBounty`. */
export interface BountyData {
  issue_number: number;
  workspace_id?: string;
  repo?: string;
  title?: string;
  body?: string;
  author?: string;
  created_at?: string;
  status?: string;
  verdict?: string;
  labels?: string;
  locked_by?: string;
  locked_at?: string;
  lock_expires_at?: string;
  retry_count?: number;
  max_retries?: number;
}

/** Row returned when querying the `bounties` table. */
export interface BountyRow {
  issue_number: number;
  workspace_id: string | null;
  repo: string | null;
  title: string | null;
  body: string | null;
  author: string | null;
  created_at: string | null;
  status: string;
  verdict: string | null;
  labels: string | null;
  locked_by: string | null;
  locked_at: string | null;
  lock_expires_at: string | null;
  retry_count: number;
  max_retries: number;
  updated_at: string | null;
}

/** Shape accepted by `insertValidationResult`. */
export interface ValidationResultData {
  issue_number: number;
  workspace_id?: string;
  verdict: string;
  rationale?: string;
  evidence?: string;
  spam_score?: number;
  duplicate_of?: number;
  media_check?: string;
}

/** Row returned when querying the `validation_results` table. */
export interface ValidationResultRow {
  id: number;
  issue_number: number;
  workspace_id: string | null;
  verdict: string;
  rationale: string | null;
  evidence: string | null;
  spam_score: number | null;
  duplicate_of: number | null;
  media_check: string | null;
  created_at: string | null;
}

/** Shape accepted by `insertRequeueRecord`. */
export interface RequeueRecordData {
  issue_number: number;
  requester_id?: string;
  requester_context?: string;
}

/** Row returned when querying the `requeue_records` table. */
export interface RequeueRecordRow {
  id: number;
  issue_number: number;
  requester_id: string | null;
  requester_context: string | null;
  status: string;
  requeued_at: string | null;
  completed_at: string | null;
  callback_sent: number;
}

/** Shape accepted by `insertSpamAnalysis`. */
export interface SpamAnalysisData {
  issue_number: number;
  template_score?: number;
  burst_score?: number;
  parity_score?: number;
  overall_score?: number;
  details?: string;
}

/** Shape accepted by `upsertEmbedding`. */
export interface EmbeddingData {
  issue_number: number;
  title_fingerprint?: string;
  body_fingerprint?: string;
  embedding_vector?: Buffer;
}

/** Row returned when querying the `embeddings` table. */
export interface EmbeddingRow {
  id: number;
  issue_number: number;
  title_fingerprint: string | null;
  body_fingerprint: string | null;
  embedding_vector: Buffer | null;
  created_at: string | null;
}

/** Shape accepted by `insertDeadLetter`. */
export interface DeadLetterData {
  bounty_id: number;
  failure_cause?: string;
  last_attempt?: string;
  metadata?: string;
  retry_count?: number;
}

/** Row returned when querying the `dead_letter` table. */
export interface DeadLetterRow {
  id: number;
  bounty_id: number;
  failure_cause: string | null;
  last_attempt: string | null;
  metadata: string | null;
  retry_count: number | null;
  created_at: string | null;
}

/** Shape accepted by `insertAuditLog`. */
export interface AuditLogData {
  workspace_id?: string;
  action: string;
  actor?: string;
  details?: string;
  github_ref?: string;
  discord_ref?: string;
}

/* ------------------------------------------------------------------ */
/*  Bounty CRUD                                                        */
/* ------------------------------------------------------------------ */

/**
 * Insert a new bounty or update an existing one (keyed on issue_number).
 */
export function upsertBounty(data: BountyData): void {
  const d = getBountyDb();
  const ts = now();

  const stmt = d.prepare(`
    INSERT INTO bounties (
      issue_number, workspace_id, repo, title, body, author,
      created_at, status, verdict, labels, locked_by, locked_at,
      lock_expires_at, retry_count, max_retries, updated_at
    ) VALUES (
      @issue_number, @workspace_id, @repo, @title, @body, @author,
      @created_at, @status, @verdict, @labels, @locked_by, @locked_at,
      @lock_expires_at, @retry_count, @max_retries, @updated_at
    )
    ON CONFLICT(issue_number) DO UPDATE SET
      workspace_id    = COALESCE(@workspace_id,    workspace_id),
      repo            = COALESCE(@repo,            repo),
      title           = COALESCE(@title,           title),
      body            = COALESCE(@body,            body),
      author          = COALESCE(@author,          author),
      status          = COALESCE(@status,          status),
      verdict         = COALESCE(@verdict,         verdict),
      labels          = COALESCE(@labels,          labels),
      locked_by       = COALESCE(@locked_by,       locked_by),
      locked_at       = COALESCE(@locked_at,       locked_at),
      lock_expires_at = COALESCE(@lock_expires_at, lock_expires_at),
      retry_count     = COALESCE(@retry_count,     retry_count),
      max_retries     = COALESCE(@max_retries,     max_retries),
      updated_at      = @updated_at
  `);

  stmt.run({
    issue_number: data.issue_number,
    workspace_id: data.workspace_id ?? null,
    repo: data.repo ?? null,
    title: data.title ?? null,
    body: data.body ?? null,
    author: data.author ?? null,
    created_at: data.created_at ?? ts,
    status: data.status ?? "pending",
    verdict: data.verdict ?? null,
    labels: data.labels ?? null,
    locked_by: data.locked_by ?? null,
    locked_at: data.locked_at ?? null,
    lock_expires_at: data.lock_expires_at ?? null,
    retry_count: data.retry_count ?? 0,
    max_retries: data.max_retries ?? 3,
    updated_at: ts,
  });
}

/**
 * Retrieve a bounty by its GitHub issue number.
 */
export function getBounty(issueNumber: number): BountyRow | undefined {
  const d = getBountyDb();
  return d
    .prepare("SELECT * FROM bounties WHERE issue_number = ?")
    .get(issueNumber) as BountyRow | undefined;
}

/**
 * Retrieve a bounty by its workspace ID.
 */
export function getBountyByWorkspace(
  workspaceId: string,
): BountyRow | undefined {
  const d = getBountyDb();
  return d
    .prepare("SELECT * FROM bounties WHERE workspace_id = ?")
    .get(workspaceId) as BountyRow | undefined;
}

/**
 * Update the status (and optionally the verdict) of a bounty.
 */
export function updateBountyStatus(
  issueNumber: number,
  status: string,
  verdict?: string,
): void {
  const d = getBountyDb();
  const ts = now();

  if (verdict !== undefined) {
    d.prepare(
      "UPDATE bounties SET status = ?, verdict = ?, updated_at = ? WHERE issue_number = ?",
    ).run(status, verdict, ts, issueNumber);
  } else {
    d.prepare(
      "UPDATE bounties SET status = ?, updated_at = ? WHERE issue_number = ?",
    ).run(status, ts, issueNumber);
  }
}

/**
 * Acquire a processing lock on a bounty.
 *
 * @param issueNumber - Target bounty
 * @param lockedBy    - Identifier of the lock owner
 * @param ttlMs       - Lock time-to-live in milliseconds
 */
export function lockBounty(
  issueNumber: number,
  lockedBy: string,
  ttlMs: number,
): void {
  const d = getBountyDb();
  const ts = now();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  d.prepare(
    "UPDATE bounties SET locked_by = ?, locked_at = ?, lock_expires_at = ?, updated_at = ? WHERE issue_number = ?",
  ).run(lockedBy, ts, expiresAt, ts, issueNumber);
}

/**
 * Release the processing lock on a bounty.
 */
export function unlockBounty(issueNumber: number): void {
  const d = getBountyDb();
  const ts = now();

  d.prepare(
    "UPDATE bounties SET locked_by = NULL, locked_at = NULL, lock_expires_at = NULL, updated_at = ? WHERE issue_number = ?",
  ).run(ts, issueNumber);
}

/**
 * Get all bounties with status = 'pending'.
 */
export function getPendingBounties(): BountyRow[] {
  const d = getBountyDb();
  return d
    .prepare("SELECT * FROM bounties WHERE status = 'pending'")
    .all() as BountyRow[];
}

/**
 * Get all bounties with status = 'in_progress'.
 */
export function getInProgressBounties(): BountyRow[] {
  const d = getBountyDb();
  return d
    .prepare("SELECT * FROM bounties WHERE status = 'in_progress'")
    .all() as BountyRow[];
}

/* ------------------------------------------------------------------ */
/*  Validation results                                                 */
/* ------------------------------------------------------------------ */

/**
 * Store a validation result.
 */
export function insertValidationResult(data: ValidationResultData): void {
  const d = getBountyDb();
  const ts = now();

  d.prepare(
    `
    INSERT INTO validation_results (
      issue_number, workspace_id, verdict, rationale, evidence,
      spam_score, duplicate_of, media_check, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    data.issue_number,
    data.workspace_id ?? null,
    data.verdict,
    data.rationale ?? null,
    data.evidence ?? null,
    data.spam_score ?? null,
    data.duplicate_of ?? null,
    data.media_check ?? null,
    ts,
  );
}

/**
 * Get the most recent validation result for an issue.
 */
export function getLatestValidation(
  issueNumber: number,
): ValidationResultRow | undefined {
  const d = getBountyDb();
  return d
    .prepare(
      "SELECT * FROM validation_results WHERE issue_number = ? ORDER BY id DESC LIMIT 1",
    )
    .get(issueNumber) as ValidationResultRow | undefined;
}

/* ------------------------------------------------------------------ */
/*  Requeue records                                                    */
/* ------------------------------------------------------------------ */

/**
 * Store a requeue record.
 */
export function insertRequeueRecord(data: RequeueRecordData): void {
  const d = getBountyDb();
  const ts = now();

  d.prepare(
    `
    INSERT INTO requeue_records (
      issue_number, requester_id, requester_context, status, requeued_at
    ) VALUES (?, ?, ?, 'pending', ?)
  `,
  ).run(
    data.issue_number,
    data.requester_id ?? null,
    data.requester_context ?? null,
    ts,
  );
}

/**
 * Get the latest requeue record for an issue.
 */
export function getRequeueRecord(
  issueNumber: number,
): RequeueRecordRow | undefined {
  const d = getBountyDb();
  return d
    .prepare(
      "SELECT * FROM requeue_records WHERE issue_number = ? ORDER BY id DESC LIMIT 1",
    )
    .get(issueNumber) as RequeueRecordRow | undefined;
}

/**
 * Update the status of a requeue record.
 */
export function updateRequeueStatus(id: number, status: string): void {
  const d = getBountyDb();
  const ts = now();

  d.prepare(
    "UPDATE requeue_records SET status = ?, completed_at = ? WHERE id = ?",
  ).run(status, ts, id);
}

/**
 * Get all requeue records with status = 'pending'.
 */
export function getPendingRequeues(): RequeueRecordRow[] {
  const d = getBountyDb();
  return d
    .prepare(
      "SELECT * FROM requeue_records WHERE status = 'pending' ORDER BY id",
    )
    .all() as RequeueRecordRow[];
}

/**
 * Mark a requeue record as completed (resolved) with callback_sent flag.
 */
export function markRequeueCompleted(id: number, completedAt: string): void {
  const d = getBountyDb();
  d.prepare(
    "UPDATE requeue_records SET status = ?, completed_at = ?, callback_sent = 1 WHERE id = ?",
  ).run("resolved", completedAt, id);
}

/* ------------------------------------------------------------------ */
/*  Spam analysis                                                      */
/* ------------------------------------------------------------------ */

/**
 * Store a spam analysis result.
 */
export function insertSpamAnalysis(data: SpamAnalysisData): void {
  const d = getBountyDb();
  const ts = now();

  d.prepare(
    `
    INSERT INTO spam_analysis (
      issue_number, template_score, burst_score, parity_score,
      overall_score, details, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    data.issue_number,
    data.template_score ?? null,
    data.burst_score ?? null,
    data.parity_score ?? null,
    data.overall_score ?? null,
    data.details ?? null,
    ts,
  );
}

/* ------------------------------------------------------------------ */
/*  Embeddings                                                         */
/* ------------------------------------------------------------------ */

/**
 * Insert or update an embedding for an issue.
 */
export function upsertEmbedding(data: EmbeddingData): void {
  const d = getBountyDb();
  const ts = now();

  d.prepare(
    `
    INSERT INTO embeddings (
      issue_number, title_fingerprint, body_fingerprint, embedding_vector, created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(issue_number) DO UPDATE SET
      title_fingerprint = COALESCE(?, title_fingerprint),
      body_fingerprint  = COALESCE(?, body_fingerprint),
      embedding_vector  = COALESCE(?, embedding_vector),
      created_at        = ?
  `,
  ).run(
    data.issue_number,
    data.title_fingerprint ?? null,
    data.body_fingerprint ?? null,
    data.embedding_vector ?? null,
    ts,
    data.title_fingerprint ?? null,
    data.body_fingerprint ?? null,
    data.embedding_vector ?? null,
    ts,
  );
}

/**
 * Get the embedding for a specific issue.
 */
export function getEmbedding(issueNumber: number): EmbeddingRow | undefined {
  const d = getBountyDb();
  return d
    .prepare("SELECT * FROM embeddings WHERE issue_number = ?")
    .get(issueNumber) as EmbeddingRow | undefined;
}

/**
 * Get all embeddings (used for similarity comparison).
 */
export function getAllEmbeddings(): EmbeddingRow[] {
  const d = getBountyDb();
  return d.prepare("SELECT * FROM embeddings").all() as EmbeddingRow[];
}

/* ------------------------------------------------------------------ */
/*  Dead letter queue                                                  */
/* ------------------------------------------------------------------ */

/**
 * Store a dead-letter entry for a bounty that exhausted retries.
 */
export function insertDeadLetter(data: DeadLetterData): void {
  const d = getBountyDb();
  const ts = now();

  d.prepare(
    `
    INSERT INTO dead_letter (
      bounty_id, failure_cause, last_attempt, metadata, retry_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    data.bounty_id,
    data.failure_cause ?? null,
    data.last_attempt ?? null,
    data.metadata ?? null,
    data.retry_count ?? null,
    ts,
  );
}

/**
 * List all dead-letter items.
 */
export function getDeadLetterItems(): DeadLetterRow[] {
  const d = getBountyDb();
  return d
    .prepare("SELECT * FROM dead_letter ORDER BY id DESC")
    .all() as DeadLetterRow[];
}

/* ------------------------------------------------------------------ */
/*  Audit log                                                          */
/* ------------------------------------------------------------------ */

/**
 * Store an immutable audit-log entry.
 */
export function insertAuditLog(data: AuditLogData): void {
  const d = getBountyDb();
  const ts = now();

  d.prepare(
    `
    INSERT INTO audit_log (
      workspace_id, action, actor, details, github_ref, discord_ref, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    data.workspace_id ?? null,
    data.action,
    data.actor ?? null,
    data.details ?? null,
    data.github_ref ?? null,
    data.discord_ref ?? null,
    ts,
  );
}

/* ------------------------------------------------------------------ */
/*  Delivery log (digest de-duplication)                               */
/* ------------------------------------------------------------------ */

/**
 * Record that a digest was delivered for a given workspace + window.
 */
export function logDelivery(workspaceId: string, window: string): void {
  const d = getBountyDb();
  const ts = now();

  d.prepare(
    `
    INSERT OR IGNORE INTO delivery_log (workspace_id, digest_window, delivered_at)
    VALUES (?, ?, ?)
  `,
  ).run(workspaceId, window, ts);
}

/**
 * Check whether a digest has already been delivered for a workspace + window.
 */
export function hasDelivered(workspaceId: string, window: string): boolean {
  const d = getBountyDb();
  const row = d
    .prepare(
      "SELECT 1 FROM delivery_log WHERE workspace_id = ? AND digest_window = ?",
    )
    .get(workspaceId, window);
  return row !== undefined;
}

/* ------------------------------------------------------------------ */
/*  Teardown (for tests)                                               */
/* ------------------------------------------------------------------ */

/**
 * Close the database connection and reset the singleton.
 * Intended for test cleanup only.
 */
export function closeBountyDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
