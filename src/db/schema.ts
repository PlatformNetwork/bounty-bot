/**
 * SQLite schema definitions for bounty-bot persistence layer.
 *
 * All tables are auto-created on first startup via `initSchema()`.
 * Indexes are added for frequently queried columns to optimise
 * read-heavy validation and digest workflows.
 */

/** SQL statements that create the core tables. */
export const CREATE_TABLES = [
  /* ------------------------------------------------------------------ */
  /*  bounties – one row per GitHub issue under validation               */
  /* ------------------------------------------------------------------ */
  `CREATE TABLE IF NOT EXISTS bounties (
    issue_number    INTEGER PRIMARY KEY,
    workspace_id    TEXT UNIQUE,
    repo            TEXT,
    title           TEXT,
    body            TEXT,
    author          TEXT,
    created_at      TEXT,
    status          TEXT    DEFAULT 'pending',
    verdict         TEXT,
    labels          TEXT,
    locked_by       TEXT,
    locked_at       TEXT,
    lock_expires_at TEXT,
    retry_count     INTEGER DEFAULT 0,
    max_retries     INTEGER DEFAULT 3,
    updated_at      TEXT
  )`,

  /* ------------------------------------------------------------------ */
  /*  validation_results – verdicts produced by the validation pipeline  */
  /* ------------------------------------------------------------------ */
  `CREATE TABLE IF NOT EXISTS validation_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_number    INTEGER,
    workspace_id    TEXT,
    verdict         TEXT    NOT NULL,
    rationale       TEXT,
    evidence        TEXT,
    spam_score      REAL,
    duplicate_of    INTEGER,
    media_check     TEXT,
    created_at      TEXT,
    FOREIGN KEY (issue_number) REFERENCES bounties(issue_number)
  )`,

  /* ------------------------------------------------------------------ */
  /*  requeue_records – manual / automated re-validation requests        */
  /* ------------------------------------------------------------------ */
  `CREATE TABLE IF NOT EXISTS requeue_records (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_number      INTEGER,
    requester_id      TEXT,
    requester_context TEXT,
    status            TEXT    DEFAULT 'pending',
    requeued_at       TEXT,
    completed_at      TEXT,
    callback_sent     INTEGER DEFAULT 0,
    FOREIGN KEY (issue_number) REFERENCES bounties(issue_number)
  )`,

  /* ------------------------------------------------------------------ */
  /*  spam_analysis – per-issue spam scoring breakdown                   */
  /* ------------------------------------------------------------------ */
  `CREATE TABLE IF NOT EXISTS spam_analysis (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_number    INTEGER,
    template_score  REAL,
    burst_score     REAL,
    parity_score    REAL,
    overall_score   REAL,
    details         TEXT,
    created_at      TEXT
  )`,

  /* ------------------------------------------------------------------ */
  /*  embeddings – vector fingerprints for duplicate detection           */
  /* ------------------------------------------------------------------ */
  `CREATE TABLE IF NOT EXISTS embeddings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_number      INTEGER UNIQUE,
    title_fingerprint TEXT,
    body_fingerprint  TEXT,
    embedding_vector  BLOB,
    created_at        TEXT
  )`,

  /* ------------------------------------------------------------------ */
  /*  dead_letter – bounties that exhausted retries                      */
  /* ------------------------------------------------------------------ */
  `CREATE TABLE IF NOT EXISTS dead_letter (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bounty_id       INTEGER,
    failure_cause   TEXT,
    last_attempt    TEXT,
    metadata        TEXT,
    retry_count     INTEGER,
    created_at      TEXT
  )`,

  /* ------------------------------------------------------------------ */
  /*  delivery_log – digest delivery de-duplication                      */
  /* ------------------------------------------------------------------ */
  `CREATE TABLE IF NOT EXISTS delivery_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id    TEXT,
    digest_window   TEXT,
    delivered_at    TEXT,
    UNIQUE(workspace_id, digest_window)
  )`,

  /* ------------------------------------------------------------------ */
  /*  cheater_flags – flagged issues for cheating / abuse                */
  /* ------------------------------------------------------------------ */
  `CREATE TABLE IF NOT EXISTS cheater_flags (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_number    INTEGER,
    reason          TEXT    NOT NULL,
    flagged_by      TEXT,
    flagged_at      TEXT,
    FOREIGN KEY (issue_number) REFERENCES bounties(issue_number)
  )`,

  /* ------------------------------------------------------------------ */
  /*  audit_log – immutable action audit trail                           */
  /* ------------------------------------------------------------------ */
  `CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id    TEXT,
    action          TEXT NOT NULL,
    actor           TEXT,
    details         TEXT,
    github_ref      TEXT,
    discord_ref     TEXT,
    created_at      TEXT
  )`,
] as const;

/** SQL statements that create secondary indexes. */
export const CREATE_INDEXES = [
  // bounties
  "CREATE INDEX IF NOT EXISTS idx_bounties_workspace   ON bounties(workspace_id)",
  "CREATE INDEX IF NOT EXISTS idx_bounties_status      ON bounties(status)",
  "CREATE INDEX IF NOT EXISTS idx_bounties_repo        ON bounties(repo)",

  // validation_results
  "CREATE INDEX IF NOT EXISTS idx_vr_issue             ON validation_results(issue_number)",
  "CREATE INDEX IF NOT EXISTS idx_vr_workspace         ON validation_results(workspace_id)",

  // requeue_records
  "CREATE INDEX IF NOT EXISTS idx_requeue_issue        ON requeue_records(issue_number)",
  "CREATE INDEX IF NOT EXISTS idx_requeue_status       ON requeue_records(status)",

  // spam_analysis
  "CREATE INDEX IF NOT EXISTS idx_spam_issue           ON spam_analysis(issue_number)",

  // cheater_flags
  "CREATE INDEX IF NOT EXISTS idx_cheater_flags_issue  ON cheater_flags(issue_number)",

  // dead_letter
  "CREATE INDEX IF NOT EXISTS idx_dl_bounty            ON dead_letter(bounty_id)",

  // delivery_log
  "CREATE INDEX IF NOT EXISTS idx_delivery_workspace   ON delivery_log(workspace_id)",

  // audit_log
  "CREATE INDEX IF NOT EXISTS idx_audit_workspace      ON audit_log(workspace_id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_action         ON audit_log(action)",
] as const;

/**
 * Forward-compatible migrations.
 *
 * Each entry is an ALTER TABLE wrapped in a try/catch so that
 * columns already present on an existing database are silently
 * skipped (SQLite throws "duplicate column name" which we ignore).
 */
export const MIGRATIONS: string[] = [
  // Example future migration:
  // "ALTER TABLE bounties ADD COLUMN priority INTEGER DEFAULT 0",
];
