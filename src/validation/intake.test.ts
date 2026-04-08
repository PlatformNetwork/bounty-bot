import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_PATH = ":memory:";
  process.env.ISSUE_FLOOR = "41000";
});

vi.mock("../redis.js", () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  setIdempotencyKey: vi.fn().mockResolvedValue(undefined),
  checkIdempotencyKey: vi.fn().mockResolvedValue(null),
}));

import { initBountyDb, closeBountyDb, getBounty } from "../db/index.js";
import {
  shouldProcess,
  normalizeIssue,
  processIntake,
  type NormalizedIssue,
} from "./intake.js";
import { acquireLock, checkIdempotencyKey } from "../redis.js";

describe("validation/intake", () => {
  beforeEach(() => {
    initBountyDb();
    vi.clearAllMocks();
    // Reset default mock implementations
    vi.mocked(acquireLock).mockResolvedValue(true);
    vi.mocked(checkIdempotencyKey).mockResolvedValue(null);
  });

  afterEach(() => {
    closeBountyDb();
  });

  function makeIssue(
    overrides: Partial<NormalizedIssue> = {},
  ): NormalizedIssue {
    return {
      issueNumber: 42001,
      title: "Test Issue",
      body: "Test body with content",
      author: "alice",
      createdAt: new Date().toISOString(),
      labels: [],
      mediaUrls: [],
      repo: "PlatformNetwork/bounty-challenge",
      ...overrides,
    };
  }

  describe("shouldProcess", () => {
    it("issue number < 41000 -> rejected", () => {
      const result = shouldProcess(makeIssue({ issueNumber: 40000 }));
      expect(result.process).toBe(false);
      expect(result.reason).toContain("below floor");
    });

    it('has "valid" label -> rejected', () => {
      const result = shouldProcess(makeIssue({ labels: ["valid"] }));
      expect(result.process).toBe(false);
      expect(result.reason).toContain("terminal label");
    });

    it('has "invalid" label -> rejected', () => {
      const result = shouldProcess(makeIssue({ labels: ["invalid"] }));
      expect(result.process).toBe(false);
      expect(result.reason).toContain("terminal label");
    });

    it('has "duplicate" label -> rejected', () => {
      const result = shouldProcess(makeIssue({ labels: ["duplicate"] }));
      expect(result.process).toBe(false);
      expect(result.reason).toContain("terminal label");
    });

    it("normal issue -> allowed", () => {
      const result = shouldProcess(makeIssue());
      expect(result.process).toBe(true);
    });

    it("issue with non-terminal labels -> allowed", () => {
      const result = shouldProcess(
        makeIssue({ labels: ["bug", "priority:high"] }),
      );
      expect(result.process).toBe(true);
    });
  });

  describe("normalizeIssue", () => {
    it("extracts all fields correctly from issue payload", () => {
      const payload = {
        issue: {
          number: 42001,
          title: "Bug Report",
          body: "Found a bug https://example.com/proof.png",
          user: { login: "bob" },
          created_at: "2025-01-01T00:00:00Z",
          labels: [{ name: "bug" }, { name: "bounty" }],
        },
      };

      const normalized = normalizeIssue(payload);
      expect(normalized.issueNumber).toBe(42001);
      expect(normalized.title).toBe("Bug Report");
      expect(normalized.body).toContain("Found a bug");
      expect(normalized.author).toBe("bob");
      expect(normalized.createdAt).toBe("2025-01-01T00:00:00Z");
      expect(normalized.labels).toEqual(["bug", "bounty"]);
      expect(normalized.mediaUrls.length).toBeGreaterThan(0);
    });

    it("handles payload without nested issue", () => {
      const payload = {
        number: 42001,
        title: "Direct",
        body: "No nesting",
        user: { login: "alice" },
        created_at: "2025-01-01T00:00:00Z",
        labels: [],
      };

      const normalized = normalizeIssue(payload);
      expect(normalized.issueNumber).toBe(42001);
      expect(normalized.title).toBe("Direct");
    });

    it("handles missing fields gracefully", () => {
      const payload = { issue: { number: 42001 } };
      const normalized = normalizeIssue(payload as Record<string, unknown>);
      expect(normalized.issueNumber).toBe(42001);
      expect(normalized.body).toBe("");
      expect(normalized.author).toBe("unknown");
    });
  });

  describe("processIntake", () => {
    it("creates bounty in DB on success", async () => {
      const issue = makeIssue();
      const result = await processIntake(issue);
      expect(result.queued).toBe(true);
      const bounty = getBounty(42001);
      expect(bounty).toBeDefined();
      expect(bounty!.status).toBe("pending");
      expect(bounty!.title).toBe("Test Issue");
    });

    it("duplicate detected via idempotency key -> not queued", async () => {
      vi.mocked(checkIdempotencyKey).mockResolvedValue("exists");
      const issue = makeIssue();
      const result = await processIntake(issue);
      expect(result.queued).toBe(false);
      expect(result.reason).toContain("idempotency");
    });

    it("lock not acquired -> not queued", async () => {
      vi.mocked(acquireLock).mockResolvedValue(false);
      const issue = makeIssue();
      const result = await processIntake(issue);
      expect(result.queued).toBe(false);
      expect(result.reason).toContain("Lock");
    });
  });
});
