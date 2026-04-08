import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_PATH = ":memory:";
});

vi.mock("../github/client.js", () => ({
  reopenIssue: vi.fn().mockResolvedValue(undefined),
  postComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../github/mutations.js", () => ({
  clearVerdictLabels: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../queue/processor.js", () => ({
  enqueue: vi.fn(),
}));

vi.mock("../redis.js", () => {
  const mockDel = vi.fn().mockResolvedValue(1);
  return {
    getRedis: vi.fn(() => ({ del: mockDel })),
    initRedis: vi.fn(),
    disconnectRedis: vi.fn(),
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    setIdempotencyKey: vi.fn(),
    checkIdempotencyKey: vi.fn(),
    __mockDel: mockDel,
  };
});

import {
  initBountyDb,
  closeBountyDb,
  upsertBounty,
  getBounty,
  getRequeueRecord,
  insertRequeueRecord,
} from "../db/index.js";
import { handleRequeue, handleForceRelease } from "./requeue.js";
import { getRedis } from "../redis.js";

describe("api/requeue", () => {
  beforeEach(() => {
    initBountyDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeBountyDb();
  });

  describe("handleRequeue", () => {
    it("issue not found -> error", async () => {
      const result = await handleRequeue(99999, "user-1");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("too old -> error", async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      upsertBounty({
        issue_number: 42001,
        created_at: oldDate,
        status: "completed",
      });

      const result = await handleRequeue(42001, "user-1");
      expect(result.success).toBe(false);
      expect(result.error).toContain("older than");
    });

    it("already requeued -> error", async () => {
      upsertBounty({
        issue_number: 42001,
        created_at: new Date().toISOString(),
        status: "completed",
      });
      insertRequeueRecord({ issue_number: 42001, requester_id: "user-1" });

      const result = await handleRequeue(42001, "user-2");
      expect(result.success).toBe(false);
      expect(result.error).toContain("already been requeued");
    });

    it("success (all validations pass)", async () => {
      upsertBounty({
        issue_number: 42001,
        created_at: new Date().toISOString(),
        status: "completed",
        workspace_id: "ws-1",
      });

      const result = await handleRequeue(42001, "user-1");
      expect(result.success).toBe(true);

      // Verify bounty status reset to pending
      const bounty = getBounty(42001);
      expect(bounty!.status).toBe("pending");

      // Verify requeue record created
      const requeue = getRequeueRecord(42001);
      expect(requeue).toBeDefined();
      expect(requeue!.requester_id).toBe("user-1");
    });
  });

  describe("handleForceRelease", () => {
    it("clears locks via Redis del", async () => {
      upsertBounty({ issue_number: 42001 });
      const result = await handleForceRelease(42001);
      expect(result.success).toBe(true);

      const redis = getRedis();
      expect(redis.del).toHaveBeenCalled();
    });

    it("clears DB lock fields", async () => {
      upsertBounty({ issue_number: 42001 });
      // The DB lock fields should be cleared after force-release
      const result = await handleForceRelease(42001);
      expect(result.success).toBe(true);

      const bounty = getBounty(42001);
      expect(bounty!.locked_by).toBeNull();
    });

    it("handles Redis failure gracefully", async () => {
      const redis = getRedis();
      vi.mocked(redis.del).mockRejectedValue(new Error("Redis down"));

      upsertBounty({ issue_number: 42001 });
      const result = await handleForceRelease(42001);
      // Should still succeed (Redis failure is non-fatal)
      expect(result.success).toBe(true);
    });
  });
});
