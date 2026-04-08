import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_PATH = ":memory:";
  process.env.ISSUE_FLOOR = "41000";
});

import { initBountyDb, closeBountyDb, upsertEmbedding } from "../db/index.js";
import {
  generateFingerprint,
  computeSimilarity,
  findDuplicates,
  DUPLICATE_THRESHOLD,
} from "./duplicate.js";

describe("detection/duplicate", () => {
  beforeEach(() => {
    initBountyDb();
  });

  afterEach(() => {
    closeBountyDb();
  });

  describe("generateFingerprint", () => {
    it("is deterministic (same input = same output)", () => {
      const text = "This is a test sentence for fingerprinting";
      expect(generateFingerprint(text)).toBe(generateFingerprint(text));
    });

    it("different input = different output", () => {
      const a = generateFingerprint(
        "The quick brown fox jumps over the lazy dog",
      );
      const b = generateFingerprint(
        "A completely different sentence about cats and mice",
      );
      expect(a).not.toBe(b);
    });

    it("returns a 64-char hex string (SHA-256)", () => {
      const fp = generateFingerprint("test content");
      expect(fp).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("computeSimilarity", () => {
    it("identical text = 1.0", () => {
      const text =
        "Login page crashes when entering special characters in password field";
      const sim = computeSimilarity("", "", text, text);
      expect(sim).toBe(1.0);
    });

    it("completely different text = low score", () => {
      const text1 =
        "Login page crashes when entering special characters password field rendering";
      const text2 =
        "Database migration script timeout kubernetes deployment configuration orchestration";
      const sim = computeSimilarity("", "", text1, text2);
      expect(sim).toBeLessThan(0.3);
    });

    it("empty texts return 0", () => {
      expect(computeSimilarity("", "", "", "")).toBe(0);
    });
  });

  describe("findDuplicates", () => {
    it("no existing embeddings -> not duplicate", async () => {
      const result = await findDuplicates({
        issueNumber: 42001,
        title: "Test issue",
        body: "This is a test issue body",
      });
      expect(result.isDuplicate).toBe(false);
      expect(result.similarity).toBe(0);
    });

    it("similar older issue -> duplicate detected", async () => {
      const olderText =
        "Login page crashes when entering special characters in the password field on Chrome browser";
      upsertEmbedding({
        issue_number: 42000,
        title_fingerprint: generateFingerprint("Login crash"),
        body_fingerprint: "Login crash " + olderText,
      });

      const result = await findDuplicates({
        issueNumber: 42001,
        title: "Login crash",
        body: olderText,
      });
      expect(result.isDuplicate).toBe(true);
      expect(result.originalIssue).toBe(42000);
      expect(result.similarity).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    });

    it("similar newer issue (higher number) -> NOT flagged", async () => {
      upsertEmbedding({
        issue_number: 42010,
        title_fingerprint: generateFingerprint("Same bug"),
        body_fingerprint:
          "Same bug Login page crashes when entering special characters",
      });

      const result = await findDuplicates({
        issueNumber: 42005,
        title: "Same bug",
        body: "Login page crashes when entering special characters",
      });
      expect(result.isDuplicate).toBe(false);
    });

    it("issue below ISSUE_FLOOR -> ignored as candidate", async () => {
      upsertEmbedding({
        issue_number: 40000,
        title_fingerprint: generateFingerprint("Old issue"),
        body_fingerprint:
          "Old issue Login page crashes special characters password",
      });

      const result = await findDuplicates({
        issueNumber: 42001,
        title: "Login page crashes",
        body: "Login page crashes special characters password",
      });
      expect(result.originalIssue).not.toBe(40000);
    });

    it("stores embedding for current issue", async () => {
      await findDuplicates({
        issueNumber: 42001,
        title: "Test",
        body: "Test body content",
      });

      const result = await findDuplicates({
        issueNumber: 42002,
        title: "Test",
        body: "Test body content",
      });
      expect(result.similarity).toBeGreaterThan(0);
    });

    it("similarity just below threshold -> not duplicate", async () => {
      upsertEmbedding({
        issue_number: 42000,
        title_fingerprint: generateFingerprint("UI rendering"),
        body_fingerprint:
          "UI rendering CSS layout breaks flexbox container alignment overflow grid",
      });

      const result = await findDuplicates({
        issueNumber: 42001,
        title: "API timeout",
        body: "API timeout database connection pool exhausted retry mechanism backoff strategy",
      });
      expect(result.isDuplicate).toBe(false);
    });
  });
});
