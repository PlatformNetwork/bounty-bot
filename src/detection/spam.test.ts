import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies before importing
vi.mock("../github/client.js", () => ({
  listRecentIssues: vi.fn().mockResolvedValue([]),
}));

vi.mock("../db/index.js", () => ({
  insertSpamAnalysis: vi.fn(),
}));

import {
  analyzeSpam,
  isSpam,
  SPAM_THRESHOLD,
  type SpamAnalysisResult,
} from "./spam.js";
import { listRecentIssues } from "../github/client.js";
import { insertSpamAnalysis } from "../db/index.js";

describe("detection/spam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isSpam", () => {
    it("returns true when score >= threshold", () => {
      const result: SpamAnalysisResult = {
        templateScore: 0.8,
        burstScore: 0.8,
        parityScore: 0.8,
        overallScore: SPAM_THRESHOLD,
        details: "test",
      };
      expect(isSpam(result)).toBe(true);
    });

    it("returns false when score < threshold", () => {
      const result: SpamAnalysisResult = {
        templateScore: 0.1,
        burstScore: 0.1,
        parityScore: 0.1,
        overallScore: SPAM_THRESHOLD - 0.01,
        details: "test",
      };
      expect(isSpam(result)).toBe(false);
    });
  });

  describe("analyzeSpam", () => {
    const baseIssue = {
      issueNumber: 42001,
      title: "Legitimate bug report with detailed description",
      body: "This is a detailed bug report with steps to reproduce, expected behavior, and actual behavior. It contains enough content to not trigger short body detection.",
      author: "alice",
      createdAt: new Date().toISOString(),
    };

    it("no recent issues -> low template score", async () => {
      vi.mocked(listRecentIssues).mockResolvedValue([]);
      const result = await analyzeSpam(baseIssue);
      expect(result.templateScore).toBe(0);
      expect(insertSpamAnalysis).toHaveBeenCalledOnce();
    });

    it("many recent issues from same author -> high burst score", async () => {
      const recentIssues = Array.from({ length: 6 }, (_, i) => ({
        number: 42010 + i,
        title: `Issue ${i}`,
        body: `Completely different body ${i} that shares no words`,
        state: "open",
        user: { login: "alice" },
        labels: [] as Array<{ name: string }>,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        html_url: `https://github.com/org/repo/issues/${42010 + i}`,
      }));
      vi.mocked(listRecentIssues).mockResolvedValue(recentIssues);

      const result = await analyzeSpam(baseIssue);
      // 6 issues from same author + 1 current = 7 author issues; burstScore = min(1, 6*0.25) = 1.0
      expect(result.burstScore).toBeGreaterThanOrEqual(0.5);
    });

    it("short body -> higher parity score", async () => {
      vi.mocked(listRecentIssues).mockResolvedValue([]);
      const shortIssue = { ...baseIssue, body: "Short" };
      const result = await analyzeSpam(shortIssue);
      expect(result.parityScore).toBeGreaterThanOrEqual(0.4);
    });

    it("template title -> higher parity score", async () => {
      vi.mocked(listRecentIssues).mockResolvedValue([]);
      const templateIssue = {
        ...baseIssue,
        title: "Bug Report #123",
        body: "This is a detailed bug report with enough content to not trigger the short body parity check for the scoring system.",
      };
      const result = await analyzeSpam(templateIssue);
      expect(result.parityScore).toBeGreaterThanOrEqual(0.3);
    });

    it("stores spam analysis result in DB", async () => {
      vi.mocked(listRecentIssues).mockResolvedValue([]);
      await analyzeSpam(baseIssue);
      expect(insertSpamAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42001,
        }),
      );
    });

    it("handles GitHub API failure gracefully", async () => {
      vi.mocked(listRecentIssues).mockRejectedValue(new Error("API error"));
      const result = await analyzeSpam(baseIssue);
      // Should not throw, template score should be 0
      expect(result.templateScore).toBe(0);
      expect(result.overallScore).toBeDefined();
    });
  });
});
