import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_PATH = ":memory:";
});

import {
  initBountyDb,
  closeBountyDb,
  upsertBounty,
  getBounty,
  getBountyByWorkspace,
  updateBountyStatus,
  lockBounty,
  unlockBounty,
  getPendingBounties,
  getInProgressBounties,
  insertValidationResult,
  getLatestValidation,
  insertSpamAnalysis,
  upsertEmbedding,
  getEmbedding,
  getAllEmbeddings,
  insertDeadLetter,
  getDeadLetterItems,
  insertAuditLog,
  logDelivery,
  hasDelivered,
} from "./index.js";

describe("db/index", () => {
  beforeEach(() => {
    initBountyDb();
  });

  afterEach(() => {
    closeBountyDb();
  });

  /* ---------------------------------------------------------------- */
  /*  Bounty CRUD                                                      */
  /* ---------------------------------------------------------------- */

  describe("bounty CRUD", () => {
    it("upsertBounty inserts a new bounty", () => {
      upsertBounty({ issue_number: 42001, title: "Test", status: "pending" });
      const row = getBounty(42001);
      expect(row).toBeDefined();
      expect(row!.issue_number).toBe(42001);
      expect(row!.title).toBe("Test");
      expect(row!.status).toBe("pending");
    });

    it("upsertBounty updates existing bounty on conflict", () => {
      upsertBounty({ issue_number: 42001, title: "First", status: "pending" });
      upsertBounty({
        issue_number: 42001,
        title: "Updated",
        status: "in_progress",
      });
      const row = getBounty(42001);
      expect(row!.title).toBe("Updated");
      expect(row!.status).toBe("in_progress");
    });

    it("getBounty returns undefined for non-existent issue", () => {
      expect(getBounty(99999)).toBeUndefined();
    });

    it("getBountyByWorkspace retrieves by workspace_id", () => {
      upsertBounty({
        issue_number: 42001,
        workspace_id: "ws-123",
        title: "WS Test",
      });
      const row = getBountyByWorkspace("ws-123");
      expect(row).toBeDefined();
      expect(row!.issue_number).toBe(42001);
    });

    it("getBountyByWorkspace returns undefined for unknown workspace", () => {
      expect(getBountyByWorkspace("ws-unknown")).toBeUndefined();
    });

    it("updateBountyStatus changes status", () => {
      upsertBounty({ issue_number: 42001, status: "pending" });
      updateBountyStatus(42001, "completed");
      expect(getBounty(42001)!.status).toBe("completed");
    });

    it("updateBountyStatus changes status and verdict", () => {
      upsertBounty({ issue_number: 42001, status: "pending" });
      updateBountyStatus(42001, "completed", "valid");
      const row = getBounty(42001);
      expect(row!.status).toBe("completed");
      expect(row!.verdict).toBe("valid");
    });

    it("lockBounty sets lock fields", () => {
      upsertBounty({ issue_number: 42001 });
      lockBounty(42001, "worker-1", 60000);
      const row = getBounty(42001);
      expect(row!.locked_by).toBe("worker-1");
      expect(row!.locked_at).toBeDefined();
      expect(row!.lock_expires_at).toBeDefined();
    });

    it("unlockBounty clears lock fields", () => {
      upsertBounty({ issue_number: 42001 });
      lockBounty(42001, "worker-1", 60000);
      unlockBounty(42001);
      const row = getBounty(42001);
      expect(row!.locked_by).toBeNull();
      expect(row!.locked_at).toBeNull();
      expect(row!.lock_expires_at).toBeNull();
    });

    it("upsertBounty sets default retry_count and max_retries", () => {
      upsertBounty({ issue_number: 42001 });
      const row = getBounty(42001);
      expect(row!.retry_count).toBe(0);
      expect(row!.max_retries).toBe(3);
    });

    it("upsertBounty stores all optional fields", () => {
      upsertBounty({
        issue_number: 42001,
        workspace_id: "ws-1",
        repo: "owner/repo",
        title: "Title",
        body: "Body text",
        author: "alice",
        created_at: "2025-01-01T00:00:00Z",
        status: "pending",
        verdict: "valid",
        labels: "bug,enhancement",
      });
      const row = getBounty(42001)!;
      expect(row.workspace_id).toBe("ws-1");
      expect(row.repo).toBe("owner/repo");
      expect(row.body).toBe("Body text");
      expect(row.author).toBe("alice");
      expect(row.labels).toBe("bug,enhancement");
      expect(row.verdict).toBe("valid");
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Pending / In-progress queries                                    */
  /* ---------------------------------------------------------------- */

  describe("status queries", () => {
    it("getPendingBounties returns only pending bounties", () => {
      upsertBounty({ issue_number: 42001, status: "pending" });
      upsertBounty({ issue_number: 42002, status: "in_progress" });
      upsertBounty({ issue_number: 42003, status: "pending" });
      const pending = getPendingBounties();
      expect(pending).toHaveLength(2);
      expect(pending.map((b) => b.issue_number).sort()).toEqual([42001, 42003]);
    });

    it("getInProgressBounties returns only in_progress bounties", () => {
      upsertBounty({ issue_number: 42001, status: "pending" });
      upsertBounty({ issue_number: 42002, status: "in_progress" });
      const inProgress = getInProgressBounties();
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].issue_number).toBe(42002);
    });

    it("getPendingBounties returns empty array when none exist", () => {
      expect(getPendingBounties()).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Validation results                                               */
  /* ---------------------------------------------------------------- */

  describe("validation results", () => {
    beforeEach(() => {
      upsertBounty({ issue_number: 42001 });
    });

    it("insertValidationResult stores a result", () => {
      insertValidationResult({
        issue_number: 42001,
        verdict: "valid",
        rationale: "All checks passed",
      });
      const row = getLatestValidation(42001);
      expect(row).toBeDefined();
      expect(row!.verdict).toBe("valid");
      expect(row!.rationale).toBe("All checks passed");
    });

    it("getLatestValidation returns the most recent result", () => {
      insertValidationResult({ issue_number: 42001, verdict: "invalid" });
      insertValidationResult({ issue_number: 42001, verdict: "valid" });
      const row = getLatestValidation(42001);
      expect(row!.verdict).toBe("valid");
    });

    it("getLatestValidation returns undefined for no results", () => {
      expect(getLatestValidation(99999)).toBeUndefined();
    });

    it("insertValidationResult stores optional fields", () => {
      insertValidationResult({
        issue_number: 42001,
        verdict: "duplicate",
        evidence: '{"test":true}',
        spam_score: 0.42,
        duplicate_of: 41999,
        media_check: "passed",
      });
      const row = getLatestValidation(42001)!;
      expect(row.spam_score).toBeCloseTo(0.42);
      expect(row.duplicate_of).toBe(41999);
      expect(row.media_check).toBe("passed");
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Requeue records                                                  */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /*  Spam analysis                                                    */
  /* ---------------------------------------------------------------- */

  describe("spam analysis", () => {
    it("insertSpamAnalysis stores a record without throwing", () => {
      expect(() =>
        insertSpamAnalysis({
          issue_number: 42001,
          template_score: 0.1,
          burst_score: 0.2,
          parity_score: 0.3,
          overall_score: 0.6,
          details: "test details",
        }),
      ).not.toThrow();
    });

    it("insertSpamAnalysis stores minimal data", () => {
      expect(() => insertSpamAnalysis({ issue_number: 42001 })).not.toThrow();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Embeddings                                                       */
  /* ---------------------------------------------------------------- */

  describe("embeddings", () => {
    it("upsertEmbedding inserts a new embedding", () => {
      upsertEmbedding({
        issue_number: 42001,
        title_fingerprint: "abc123",
        body_fingerprint: "def456",
      });
      const row = getEmbedding(42001);
      expect(row).toBeDefined();
      expect(row!.title_fingerprint).toBe("abc123");
      expect(row!.body_fingerprint).toBe("def456");
    });

    it("upsertEmbedding updates on conflict", () => {
      upsertEmbedding({ issue_number: 42001, title_fingerprint: "first" });
      upsertEmbedding({ issue_number: 42001, title_fingerprint: "second" });
      const row = getEmbedding(42001);
      expect(row!.title_fingerprint).toBe("second");
    });

    it("getEmbedding returns undefined for non-existent issue", () => {
      expect(getEmbedding(99999)).toBeUndefined();
    });

    it("getAllEmbeddings returns all stored embeddings", () => {
      upsertEmbedding({ issue_number: 42001, title_fingerprint: "a" });
      upsertEmbedding({ issue_number: 42002, title_fingerprint: "b" });
      upsertEmbedding({ issue_number: 42003, title_fingerprint: "c" });
      const all = getAllEmbeddings();
      expect(all).toHaveLength(3);
    });

    it("getAllEmbeddings returns empty array when no embeddings exist", () => {
      expect(getAllEmbeddings()).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Dead letter                                                      */
  /* ---------------------------------------------------------------- */

  describe("dead letter", () => {
    it("insertDeadLetter stores a dead-letter entry", () => {
      insertDeadLetter({
        bounty_id: 42001,
        failure_cause: "timeout",
        retry_count: 3,
      });
      const items = getDeadLetterItems();
      expect(items).toHaveLength(1);
      expect(items[0].bounty_id).toBe(42001);
      expect(items[0].failure_cause).toBe("timeout");
      expect(items[0].retry_count).toBe(3);
    });

    it("getDeadLetterItems returns items in descending order", () => {
      insertDeadLetter({ bounty_id: 42001, failure_cause: "first" });
      insertDeadLetter({ bounty_id: 42002, failure_cause: "second" });
      const items = getDeadLetterItems();
      expect(items).toHaveLength(2);
      expect(items[0].bounty_id).toBe(42002); // most recent first
    });

    it("getDeadLetterItems returns empty array when empty", () => {
      expect(getDeadLetterItems()).toHaveLength(0);
    });

    it("insertDeadLetter stores metadata", () => {
      insertDeadLetter({
        bounty_id: 42001,
        metadata: '{"key":"value"}',
        last_attempt: "2025-01-01T00:00:00Z",
      });
      const items = getDeadLetterItems();
      expect(items[0].metadata).toBe('{"key":"value"}');
      expect(items[0].last_attempt).toBe("2025-01-01T00:00:00Z");
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Audit log                                                        */
  /* ---------------------------------------------------------------- */

  describe("audit log", () => {
    it("insertAuditLog stores an entry without throwing", () => {
      expect(() =>
        insertAuditLog({
          action: "bounty.created",
          actor: "system",
          details: "test",
          github_ref: "#42001",
        }),
      ).not.toThrow();
    });

    it("insertAuditLog stores with workspace_id and discord_ref", () => {
      expect(() =>
        insertAuditLog({
          workspace_id: "ws-1",
          action: "bounty.validated",
          actor: "bot",
          discord_ref: "channel-123",
        }),
      ).not.toThrow();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Delivery log                                                     */
  /* ---------------------------------------------------------------- */

  describe("delivery log", () => {
    it("logDelivery records a delivery", () => {
      logDelivery("ws-1", "2025-01-01");
      expect(hasDelivered("ws-1", "2025-01-01")).toBe(true);
    });

    it("hasDelivered returns false for unknown delivery", () => {
      expect(hasDelivered("ws-unknown", "2025-01-01")).toBe(false);
    });

    it("logDelivery enforces uniqueness (IGNORE on duplicate)", () => {
      logDelivery("ws-1", "2025-01-01");
      expect(() => logDelivery("ws-1", "2025-01-01")).not.toThrow();
      expect(hasDelivered("ws-1", "2025-01-01")).toBe(true);
    });

    it("different windows are tracked separately", () => {
      logDelivery("ws-1", "window-a");
      logDelivery("ws-1", "window-b");
      expect(hasDelivered("ws-1", "window-a")).toBe(true);
      expect(hasDelivered("ws-1", "window-b")).toBe(true);
      expect(hasDelivered("ws-1", "window-c")).toBe(false);
    });

    it("different workspaces are tracked separately", () => {
      logDelivery("ws-1", "window-a");
      expect(hasDelivered("ws-1", "window-a")).toBe(true);
      expect(hasDelivered("ws-2", "window-a")).toBe(false);
    });
  });
});
