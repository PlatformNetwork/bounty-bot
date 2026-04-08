import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../github/client.js", () => ({
  getIssue: vi.fn(),
  GitHubApiError: class GitHubApiError extends Error {
    statusCode: number;
    endpoint: string;
    constructor(message: string, statusCode: number, endpoint: string) {
      super(message);
      this.name = "GitHubApiError";
      this.statusCode = statusCode;
      this.endpoint = endpoint;
    }
  },
}));

vi.mock("./media.js", () => ({
  validateMedia: vi.fn(),
}));

vi.mock("../detection/spam.js", () => ({
  analyzeSpam: vi.fn(),
  isSpam: vi.fn(),
}));

vi.mock("../detection/duplicate.js", () => ({
  findDuplicates: vi.fn(),
}));

vi.mock("../detection/edit-history.js", () => ({
  analyzeEditHistory: vi.fn(),
}));

vi.mock("../detection/code-verify.js", () => ({
  verifyCodePlausibility: vi.fn(),
}));

vi.mock("../detection/llm-scorer.js", () => ({
  scoreSpamLikelihood: vi.fn(),
  scoreIssueValidity: vi.fn(),
}));

vi.mock("../rules/index.js", () => ({
  evaluateRules: vi.fn(),
  formatRulesForPrompt: vi.fn(),
}));

import { runValidationPipeline } from "./pipeline.js";
import { getIssue, GitHubApiError } from "../github/client.js";
import { validateMedia } from "./media.js";
import { analyzeSpam, isSpam } from "../detection/spam.js";
import { findDuplicates } from "../detection/duplicate.js";
import { analyzeEditHistory } from "../detection/edit-history.js";
import { verifyCodePlausibility } from "../detection/code-verify.js";
import { scoreIssueValidity } from "../detection/llm-scorer.js";
import { evaluateRules, formatRulesForPrompt } from "../rules/index.js";

describe("validation/pipeline", () => {
  const mockIssue = {
    number: 42001,
    title: "Bug Report",
    body: "Detailed bug description with evidence",
    state: "open",
    user: { login: "alice" },
    labels: [],
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    html_url: "https://github.com/org/repo/issues/42001",
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks: all checks pass
    vi.mocked(getIssue).mockResolvedValue(mockIssue);
    vi.mocked(validateMedia).mockResolvedValue({
      hasMedia: true,
      accessible: true,
      urls: ["https://example.com/img.png"],
      evidence: ["1 URL(s) accessible"],
    });
    vi.mocked(analyzeSpam).mockResolvedValue({
      templateScore: 0.1,
      burstScore: 0.0,
      parityScore: 0.1,
      overallScore: 0.1,
      details: "low spam",
    });
    vi.mocked(isSpam).mockReturnValue(false);
    vi.mocked(findDuplicates).mockResolvedValue({
      isDuplicate: false,
      similarity: 0.1,
    });
    vi.mocked(analyzeEditHistory).mockResolvedValue({
      suspicious: false,
      fraudScore: 0.0,
      edits: [],
      details: "No edits",
    });
    vi.mocked(verifyCodePlausibility).mockResolvedValue({
      plausible: true,
      confidence: 0.9,
      reasoning: "Bug confirmed in source code.",
      screenshotValid: true,
      screenshotReasoning: "Screenshot shows real CLI output.",
    });
    vi.mocked(scoreIssueValidity).mockResolvedValue({
      score: 0.8,
      reasoning: "Valid bug report.",
    });
    vi.mocked(evaluateRules).mockResolvedValue({
      codeResults: { passed: [], failed: [] },
      llmInstructions: [],
      totalCodeRules: 0,
      totalLLMRules: 0,
      hasReject: false,
      hasFailed: false,
      penaltyScore: 0,
      summary: "0/0 rules",
    });
    vi.mocked(formatRulesForPrompt).mockReturnValue("");
  });

  it("all checks pass -> verdict valid", async () => {
    const result = await runValidationPipeline(42001, "ws-1");
    expect(result.verdict).toBe("valid");
    expect(result.rationale).toContain("All validation checks passed");
  });

  it("no media -> verdict invalid", async () => {
    vi.mocked(validateMedia).mockResolvedValue({
      hasMedia: false,
      accessible: false,
      urls: [],
      evidence: ["No media URLs found"],
    });

    const result = await runValidationPipeline(42001, "ws-1");
    expect(result.verdict).toBe("invalid");
    expect(result.rationale).toContain("Media validation failed");
  });

  it("spam detected -> verdict invalid with spam details", async () => {
    vi.mocked(isSpam).mockReturnValue(true);
    vi.mocked(analyzeSpam).mockResolvedValue({
      templateScore: 0.8,
      burstScore: 0.9,
      parityScore: 0.7,
      overallScore: 0.85,
      details: "High spam score",
    });

    const result = await runValidationPipeline(42001, "ws-1");
    expect(result.verdict).toBe("invalid");
    expect(result.rationale).toContain("spam");
    expect(result.spamScore).toBeGreaterThan(0.5);
  });

  it("duplicate found -> verdict duplicate with originalIssue", async () => {
    vi.mocked(findDuplicates).mockResolvedValue({
      isDuplicate: true,
      originalIssue: 41999,
      similarity: 0.85,
    });

    const result = await runValidationPipeline(42001, "ws-1");
    expect(result.verdict).toBe("duplicate");
    expect(result.duplicateOf).toBe(41999);
    expect(result.rationale).toContain("#41999");
  });

  it("suspicious edits -> verdict invalid", async () => {
    vi.mocked(analyzeEditHistory).mockResolvedValue({
      suspicious: true,
      fraudScore: 0.8,
      edits: [{ field: "title", editedAt: "2025-01-01", suspicious: true }],
      details: "Rapid edits detected",
    });

    const result = await runValidationPipeline(42001, "ws-1");
    expect(result.verdict).toBe("invalid");
    expect(result.rationale).toContain("Suspicious edit history");
  });

  it("code verification fails -> verdict invalid", async () => {
    vi.mocked(verifyCodePlausibility).mockResolvedValue({
      plausible: false,
      confidence: 0.9,
      reasoning: "Command not found in Cortex source code.",
      screenshotValid: false,
      screenshotReasoning: "Screenshot shows VS Code editor, not CLI output.",
    });

    const result = await runValidationPipeline(42001, "ws-1");
    expect(result.verdict).toBe("invalid");
    expect(result.rationale).toContain("Code verification failed");
  });

  it("code verification: screenshot shows code -> verdict invalid", async () => {
    vi.mocked(verifyCodePlausibility).mockResolvedValue({
      plausible: false,
      confidence: 0.85,
      reasoning: "Bug may exist but screenshot shows source code, not user experience.",
      screenshotValid: false,
      screenshotReasoning: "Screenshot is VS Code showing Rust source files.",
    });

    const result = await runValidationPipeline(42001, "ws-1");
    expect(result.verdict).toBe("invalid");
    expect(result.rationale).toContain("Code verification failed");
  });

  it("GitHub 404 -> verdict invalid with github_404 evidence", async () => {
    const error = new GitHubApiError(
      "Not Found",
      404,
      "/repos/org/repo/issues/42001",
    );
    vi.mocked(getIssue).mockRejectedValue(error);

    const result = await runValidationPipeline(42001, "ws-1");
    expect(result.verdict).toBe("invalid");
    expect(result.evidence).toEqual(
      expect.objectContaining({ error: "github_404" }),
    );
  });

  it("GitHub other error -> throws", async () => {
    vi.mocked(getIssue).mockRejectedValue(new Error("Internal Server Error"));

    await expect(runValidationPipeline(42001, "ws-1")).rejects.toThrow(
      "Internal Server Error",
    );
  });
});
