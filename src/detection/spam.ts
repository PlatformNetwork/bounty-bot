/**
 * Spam and template detection for bounty issues.
 *
 * Combines character-level similarity (Jaccard on word sets), burst
 * detection (submission frequency), and parity scoring (content
 * quality indicators) into an overall spam score.
 */

import { logger } from "../logger.js";
import { insertSpamAnalysis } from "../db/index.js";
import { TARGET_REPO } from "../config.js";
import { listRecentIssues } from "../github/client.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

/** Spam score threshold — issues above this are flagged as spam. */
export const SPAM_THRESHOLD = parseFloat(process.env.SPAM_THRESHOLD || "0.7");

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SpamAnalysisResult {
  templateScore: number;
  burstScore: number;
  parityScore: number;
  overallScore: number;
  details: string;
}

export interface SpamIssueInput {
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Extract a set of lowercase words from a text string. */
function wordSet(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return new Set(words);
}

/** Compute Jaccard similarity between two sets. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Template-like title patterns. */
const TEMPLATE_TITLE_PATTERNS = [
  /^bug\s*report\s*#?\d*$/i,
  /^feature\s*request\s*#?\d*$/i,
  /^issue\s*#?\d+$/i,
  /^test\s*#?\d+$/i,
  /^bounty\s*#?\d+$/i,
  /^untitled$/i,
];

/* ------------------------------------------------------------------ */
/*  Score components                                                   */
/* ------------------------------------------------------------------ */

/**
 * Template score: compare title+body against recent issues from the
 * same author using Jaccard similarity on word sets.
 *
 * Score 0–1 where higher = more template-like.
 */
async function computeTemplateScore(
  issue: SpamIssueInput,
  recentBodies: string[],
): Promise<number> {
  if (recentBodies.length === 0) return 0;

  const issueWords = wordSet(issue.title + " " + issue.body);
  let maxSimilarity = 0;

  for (const body of recentBodies) {
    const candidateWords = wordSet(body);
    const sim = jaccardSimilarity(issueWords, candidateWords);
    if (sim > maxSimilarity) maxSimilarity = sim;
  }

  return maxSimilarity;
}

/**
 * Burst score: count issues from the same author in the last 2 hours.
 *
 * Score: 0 if <=1 recent issue, scales up with count.
 */
function computeBurstScore(recentCount: number): number {
  if (recentCount <= 1) return 0;
  // Scale: 2 issues → 0.3, 3 → 0.5, 5+ → 1.0
  return Math.min(1, (recentCount - 1) * 0.25);
}

/**
 * Parity score: check for low-quality content indicators.
 *
 * - Very short body (< 50 chars)
 * - Template-like title pattern
 * - Missing meaningful details
 *
 * Score 0–1 where higher = more likely spam.
 */
function computeParityScore(issue: SpamIssueInput): number {
  let score = 0;
  const body = issue.body.trim();
  const title = issue.title.trim();

  // Very short body
  if (body.length < 50) {
    score += 0.4;
  } else if (body.length < 100) {
    score += 0.2;
  }

  // Template-like title
  for (const pattern of TEMPLATE_TITLE_PATTERNS) {
    if (pattern.test(title)) {
      score += 0.3;
      break;
    }
  }

  // Title and body are almost identical
  if (title.length > 5 && body.startsWith(title)) {
    score += 0.2;
  }

  // No line breaks or structure in body (flat text blob)
  if (body.length > 50 && !body.includes("\n")) {
    score += 0.1;
  }

  return Math.min(1, score);
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run full spam analysis on an issue.
 *
 * 1. Fetch recent issues from the same author (last 2 hours)
 * 2. Compute template score (Jaccard similarity)
 * 3. Compute burst score (submission frequency)
 * 4. Compute parity score (content quality)
 * 5. Combine into weighted overall score
 * 6. Store result in spam_analysis table
 *
 * @returns SpamAnalysisResult with scores and details
 */
export async function analyzeSpam(
  issue: SpamIssueInput,
): Promise<SpamAnalysisResult> {
  const parts = TARGET_REPO.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid TARGET_REPO format: "${TARGET_REPO}"`);
  }
  const [owner, repo] = parts;

  // Fetch recent issues to compare against
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  let recentIssues: Array<{
    title: string;
    body: string | null;
    user: { login: string } | null;
    number: number;
  }> = [];

  try {
    recentIssues = await listRecentIssues(owner, repo, twoHoursAgo);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "Spam analysis: failed to fetch recent issues");
  }

  // Filter to same author, exclude current issue
  const authorIssues = recentIssues.filter(
    (i) => i.user?.login === issue.author && i.number !== issue.issueNumber,
  );

  const recentBodies = authorIssues.map(
    (i) => (i.title ?? "") + " " + (i.body ?? ""),
  );

  // Compute scores
  const templateScore = await computeTemplateScore(issue, recentBodies);
  const burstScore = computeBurstScore(authorIssues.length + 1); // +1 for current issue
  const parityScore = computeParityScore(issue);

  // Weighted average
  const overallScore =
    0.4 * templateScore + 0.3 * burstScore + 0.3 * parityScore;

  const details = [
    `template=${templateScore.toFixed(2)} (${authorIssues.length} recent issues compared)`,
    `burst=${burstScore.toFixed(2)} (${authorIssues.length + 1} issues in 2h window)`,
    `parity=${parityScore.toFixed(2)}`,
    `overall=${overallScore.toFixed(2)} (threshold=${SPAM_THRESHOLD})`,
  ].join("; ");

  // Persist to DB
  insertSpamAnalysis({
    issue_number: issue.issueNumber,
    template_score: templateScore,
    burst_score: burstScore,
    parity_score: parityScore,
    overall_score: overallScore,
    details,
  });

  logger.info(
    { issueNumber: issue.issueNumber, overallScore: overallScore.toFixed(2) },
    "Spam analysis complete",
  );

  return { templateScore, burstScore, parityScore, overallScore, details };
}

/**
 * Check whether a spam analysis result exceeds the spam threshold.
 */
export function isSpam(result: SpamAnalysisResult): boolean {
  return result.overallScore >= SPAM_THRESHOLD;
}
