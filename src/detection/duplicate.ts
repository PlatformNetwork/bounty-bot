/**
 * Duplicate detection with lexical fingerprinting.
 *
 * Generates word-level n-gram fingerprints for issue text, then
 * computes Jaccard similarity against existing embeddings to
 * detect duplicate submissions.
 */

import { createHash } from "crypto";

import OpenAI from "openai";

import { logger } from "../logger.js";
import { upsertEmbedding, getAllEmbeddings, getBounty } from "../db/index.js";
import {
  ISSUE_FLOOR,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  LLM_SCORING_MODEL,
} from "../config.js";
import {
  computeEmbedding,
  cosineSimilarity,
  isEmbeddingAvailable,
} from "./embeddings.js";
import { DUPLICATE_ANALYSIS_PROMPT } from "../prompts/duplicate-analysis.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

/** Similarity threshold above which an issue is flagged as duplicate (without LLM). */
export const DUPLICATE_THRESHOLD = parseFloat(
  process.env.DUPLICATE_THRESHOLD || "0.75",
);

/** Pre-filter threshold: candidates above this are sent to LLM for verification. */
const LLM_PREFILTER_THRESHOLD = 0.55;

/** Max candidates to verify with LLM per issue. */
const LLM_MAX_CANDIDATES = 1;

/** Minimum LLM confidence to confirm a duplicate. */
const LLM_CONFIRM_CONFIDENCE = 0.7;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SimilarIssue {
  issueNumber: number;
  title: string;
  similarity: number;
}

export interface DuplicateResult {
  isDuplicate: boolean;
  originalIssue?: number;
  similarity: number;
  topSimilar: SimilarIssue[];
}

/* ------------------------------------------------------------------ */
/*  Stop words (common English)                                        */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "their",
  "what",
  "which",
  "who",
  "whom",
  "when",
  "where",
  "how",
  "not",
  "no",
  "nor",
  "if",
  "then",
  "than",
  "so",
  "as",
  "up",
  "out",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "same",
  "each",
  "every",
  "all",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "only",
  "own",
  "just",
  "also",
  "very",
  "too",
]);

/* ------------------------------------------------------------------ */
/*  Text processing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Normalize text: lowercase, remove punctuation, remove stop words.
 * Returns an array of meaningful words.
 */
function normalizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Generate word n-grams (2-grams and 3-grams) from a word list.
 */
function generateNgrams(words: string[]): Set<string> {
  const ngrams = new Set<string>();

  for (let i = 0; i < words.length - 1; i++) {
    ngrams.add(`${words[i]}_${words[i + 1]}`);
  }

  for (let i = 0; i < words.length - 2; i++) {
    ngrams.add(`${words[i]}_${words[i + 1]}_${words[i + 2]}`);
  }

  return ngrams;
}

/* ------------------------------------------------------------------ */
/*  Fingerprinting                                                     */
/* ------------------------------------------------------------------ */

/**
 * Generate a deterministic fingerprint from text.
 *
 * 1. Normalize: lowercase, remove punctuation, remove stop words
 * 2. Generate 2-grams and 3-grams
 * 3. Sort and hash the n-gram set
 *
 * @param text - Raw text to fingerprint
 * @returns Hex SHA-256 hash of sorted n-grams
 */
export function generateFingerprint(text: string): string {
  const words = normalizeText(text);
  const ngrams = generateNgrams(words);
  const sorted = [...ngrams].sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex");
}

/* ------------------------------------------------------------------ */
/*  Similarity                                                         */
/* ------------------------------------------------------------------ */

/**
 * Compute Jaccard similarity between two issue texts.
 *
 * Uses word-level sets from the original body text (not fingerprints)
 * for fine-grained comparison.
 *
 * @param _fp1 - Fingerprint of first text (unused, kept for API compat)
 * @param _fp2 - Fingerprint of second text (unused, kept for API compat)
 * @param body1 - First issue body text
 * @param body2 - Second issue body text
 * @returns Jaccard similarity score 0–1
 */
export function computeSimilarity(
  _fp1: string,
  _fp2: string,
  body1: string,
  body2: string,
): number {
  const words1 = new Set(normalizeText(body1));
  const words2 = new Set(normalizeText(body2));

  if (words1.size === 0 && words2.size === 0) return 0;

  let intersection = 0;
  for (const word of words1) {
    if (words2.has(word)) intersection++;
  }

  const union = words1.size + words2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/* ------------------------------------------------------------------ */
/*  LLM duplicate verification                                        */
/* ------------------------------------------------------------------ */

interface LLMDuplicateVerdict {
  isDuplicate: boolean;
  confidence: number;
  reasoning: string;
}

/**
 * Parse the LLM duplicate analysis response into a structured verdict.
 * Handles JSON (raw, fenced, with trailing commas), and plain text fallback.
 */
function parseDuplicateResponse(content: string): Record<string, unknown> | null {
  // Strategy 1: extract JSON from markdown fencing or raw content
  const fencedMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const rawMatch = content.match(/\{[\s\S]*\}/);
  const candidates = [fencedMatch?.[1], rawMatch?.[0]].filter(Boolean) as string[];

  for (const candidate of candidates) {
    // Try direct parse
    try {
      return JSON.parse(candidate);
    } catch {
      // Try cleaning: remove trailing commas before } and control chars
    }

    // Try cleaning the JSON
    try {
      const cleaned = candidate
        .replace(/,\s*\}/g, "}")       // trailing commas
        .replace(/,\s*\]/g, "]")       // trailing commas in arrays
        .replace(/[\x00-\x1f]/g, " "); // control characters → spaces
      return JSON.parse(cleaned);
    } catch {
      // Still failed
    }
  }

  // Strategy 2: regex extraction of individual fields
  const isDupMatch = content.match(/"isDuplicate"\s*:\s*(true|false)/i);
  const confMatch = content.match(/"confidence"\s*:\s*([\d.]+)/);
  const reasonMatch = content.match(/"reasoning"\s*:\s*"([^"]{0,300})"/);

  if (isDupMatch) {
    return {
      isDuplicate: isDupMatch[1].toLowerCase() === "true",
      confidence: confMatch ? parseFloat(confMatch[1]) : 0.75,
      reasoning: reasonMatch?.[1] ?? content.slice(0, 200),
    };
  }

  // Strategy 3: plain text inference
  const lower = content.toLowerCase();
  const isDup = lower.includes("is a duplicate") || lower.includes("\"isduplicate\": true") || lower.includes("\"isduplicate\":true");
  const notDup = lower.includes("not a duplicate") || lower.includes("not duplicate") || lower.includes("\"isduplicate\": false") || lower.includes("\"isduplicate\":false");

  if (isDup || notDup) {
    return {
      isDuplicate: isDup && !notDup,
      confidence: isDup && !notDup ? 0.85 : 0.8,
      reasoning: content.slice(0, 200),
    };
  }

  return null;
}

let llmClient: OpenAI | null = null;

function getLLMClient(): OpenAI {
  if (!llmClient) {
    llmClient = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
    });
  }
  return llmClient;
}

/**
 * Ask the LLM to verify whether two issues are truly duplicates.
 *
 * Uses the DUPLICATE_ANALYSIS_PROMPT to compare the new issue against
 * an older candidate, taking into account pre-computed similarity scores.
 *
 * Returns a conservative "not duplicate" if the LLM is unavailable.
 */
async function verifyDuplicateWithLLM(
  newIssue: { number: number; title: string; body: string },
  oldIssue: { number: number; title: string; body: string },
  lexicalSimilarity: number,
  semanticSimilarity: number,
): Promise<LLMDuplicateVerdict> {
  if (!OPENROUTER_API_KEY) {
    return { isDuplicate: false, confidence: 0, reasoning: "LLM unavailable (no API key)" };
  }

  const userMessage = DUPLICATE_ANALYSIS_PROMPT.buildUserMessage({
    newIssue,
    oldIssue,
    lexicalSimilarity,
    semanticSimilarity,
  });

  try {
    const response = await getLLMClient().chat.completions.create({
      model: LLM_SCORING_MODEL,
      messages: [
        { role: "system", content: DUPLICATE_ANALYSIS_PROMPT.system },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
      max_tokens: DUPLICATE_ANALYSIS_PROMPT.maxTokens,
    }, { timeout: 30_000 });

    const content = response.choices[0]?.message?.content ?? "";

    // Parse JSON from LLM response with multiple strategies
    const parsed = parseDuplicateResponse(content);

    if (!parsed) {
      logger.warn(
        { newIssue: newIssue.number, oldIssue: oldIssue.number, content: content.slice(0, 200) },
        "Duplicate LLM: no parseable response",
      );
      return { isDuplicate: false, confidence: 0, reasoning: "LLM returned no structured response" };
    }
    const verdict: LLMDuplicateVerdict = {
      isDuplicate: parsed.isDuplicate === true,
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };

    logger.info(
      {
        newIssue: newIssue.number,
        oldIssue: oldIssue.number,
        isDuplicate: verdict.isDuplicate,
        confidence: verdict.confidence.toFixed(2),
        reasoning: verdict.reasoning.slice(0, 80),
      },
      "Duplicate LLM: verification complete",
    );

    return verdict;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { newIssue: newIssue.number, oldIssue: oldIssue.number, err: msg },
      "Duplicate LLM: verification failed",
    );
    return { isDuplicate: false, confidence: 0, reasoning: `LLM error: ${msg}` };
  }
}

/**
 * Resolve the full body text for a candidate issue.
 * Tries body_fingerprint first (stores combined title+body), then bounties table.
 */
function resolveCandidateBody(issueNumber: number, bodyFingerprint: string | null): string {
  if (bodyFingerprint) return bodyFingerprint;
  const bounty = getBounty(issueNumber);
  if (bounty?.body) return (bounty.title ?? "") + " " + bounty.body;
  return "";
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Find duplicates for a given issue against all stored embeddings.
 *
 * Rules:
 * - Only older issues (lower number) can be originals
 * - Only issues with issue_number >= ISSUE_FLOOR are considered
 * - Stores the current issue's embedding after comparison
 * - When semantic embeddings are available, combines Jaccard (0.4)
 *   and cosine similarity (0.6) for a hybrid score
 *
 * @param issue - Issue to check for duplicates
 * @returns DuplicateResult with similarity score and original issue number
 */
export async function findDuplicates(issue: {
  issueNumber: number;
  title: string;
  body: string;
}): Promise<DuplicateResult> {
  const combinedText = issue.title + " " + issue.body;
  const fingerprint = generateFingerprint(combinedText);

  // Get all existing embeddings
  const embeddings = getAllEmbeddings();

  // Compute semantic embedding for the current issue (empty array if unavailable)
  let currentEmbedding: number[] = [];
  if (isEmbeddingAvailable()) {
    currentEmbedding = await computeEmbedding(combinedText);
  }

  // Track top 5 most similar issues
  const TOP_N = 5;
  const scored: { issueNumber: number; title: string; similarity: number }[] = [];

  for (const embedding of embeddings) {
    if (embedding.issue_number >= issue.issueNumber) continue;
    if (embedding.issue_number < ISSUE_FLOOR) continue;

    let candidateText = embedding.body_fingerprint ?? "";
    if (!candidateText) {
      // Fallback: load body from bounties table
      const bounty = getBounty(embedding.issue_number);
      if (bounty?.body) {
        candidateText = (bounty.title ?? "") + " " + bounty.body;
      }
      if (!candidateText) continue;
    }

    const jaccardScore = computeSimilarity(
      fingerprint,
      candidateText,
      combinedText,
      candidateText,
    );

    let finalScore = jaccardScore;

    if (currentEmbedding.length > 0 && embedding.embedding_vector) {
      try {
        const storedVector: number[] = JSON.parse(
          embedding.embedding_vector.toString("utf-8"),
        );
        if (Array.isArray(storedVector) && storedVector.length > 0) {
          const cosineScore = cosineSimilarity(currentEmbedding, storedVector);
          finalScore = 0.4 * jaccardScore + 0.6 * cosineScore;
        }
      } catch {
        // fall back to Jaccard only
      }
    }

    scored.push({
      issueNumber: embedding.issue_number,
      title: embedding.title ?? `#${embedding.issue_number}`,
      similarity: finalScore,
    });
  }

  // Sort by similarity descending, keep top N
  scored.sort((a, b) => b.similarity - a.similarity);
  const topSimilar: SimilarIssue[] = scored.slice(0, TOP_N).filter((s) => s.similarity > 0.15);

  // Store the current issue's embedding (with title for future lookups)
  upsertEmbedding({
    issue_number: issue.issueNumber,
    title: issue.title,
    title_fingerprint: generateFingerprint(issue.title),
    body_fingerprint: combinedText,
    embedding_vector:
      currentEmbedding.length > 0
        ? Buffer.from(JSON.stringify(currentEmbedding), "utf-8")
        : undefined,
  });

  // LLM verification: check top candidates above pre-filter threshold
  const llmCandidates = topSimilar.filter((s) => s.similarity >= LLM_PREFILTER_THRESHOLD);

  if (llmCandidates.length > 0 && OPENROUTER_API_KEY) {
    const toVerify = llmCandidates.slice(0, LLM_MAX_CANDIDATES);

    logger.info(
      {
        issueNumber: issue.issueNumber,
        candidates: toVerify.map((s) => `#${s.issueNumber} (${(s.similarity * 100).toFixed(0)}%)`),
      },
      "Duplicate: sending candidates to LLM for verification",
    );

    // Build a lookup map for candidate bodies from the embeddings we already loaded
    const embeddingMap = new Map(embeddings.map((e) => [e.issue_number, e]));

    for (const candidate of toVerify) {
      const emb = embeddingMap.get(candidate.issueNumber);
      const candidateBody = resolveCandidateBody(
        candidate.issueNumber,
        emb?.body_fingerprint ?? null,
      );

      if (!candidateBody) continue;

      // Extract the original title from the candidate body or embedding
      const candidateTitle = emb?.title ?? candidate.title;

      // Separate body from combined text (title was prepended)
      const candidateBodyOnly = candidateBody.startsWith(candidateTitle)
        ? candidateBody.slice(candidateTitle.length).trim()
        : candidateBody;

      const llmVerdict = await verifyDuplicateWithLLM(
        { number: issue.issueNumber, title: issue.title, body: issue.body },
        { number: candidate.issueNumber, title: candidateTitle, body: candidateBodyOnly.slice(0, 2000) },
        candidate.similarity,
        candidate.similarity, // hybrid score used as semantic proxy
      );

      if (llmVerdict.isDuplicate && llmVerdict.confidence >= LLM_CONFIRM_CONFIDENCE) {
        logger.info(
          {
            issueNumber: issue.issueNumber,
            originalIssue: candidate.issueNumber,
            similarity: candidate.similarity.toFixed(3),
            llmConfidence: llmVerdict.confidence.toFixed(2),
            llmReasoning: llmVerdict.reasoning.slice(0, 100),
          },
          "Duplicate confirmed by LLM",
        );

        return {
          isDuplicate: true,
          originalIssue: candidate.issueNumber,
          similarity: candidate.similarity,
          topSimilar,
        };
      }
    }

    // LLM reviewed candidates but none confirmed as duplicate
    logger.info(
      {
        issueNumber: issue.issueNumber,
        candidates: toVerify.length,
        bestSimilarity: (topSimilar[0]?.similarity ?? 0).toFixed(3),
      },
      "Duplicate: LLM rejected all candidates",
    );

    return {
      isDuplicate: false,
      similarity: topSimilar[0]?.similarity ?? 0,
      topSimilar,
    };
  }

  // Fallback (no LLM key): use raw threshold as before
  const best = topSimilar[0];
  const bestSimilarity = best?.similarity ?? 0;
  const bestCandidate = best?.issueNumber;

  const isDuplicate =
    bestSimilarity >= DUPLICATE_THRESHOLD && bestCandidate !== undefined;

  if (isDuplicate) {
    logger.info(
      {
        issueNumber: issue.issueNumber,
        originalIssue: bestCandidate,
        similarity: bestSimilarity.toFixed(3),
        topSimilar: topSimilar.map((s) => `#${s.issueNumber} (${(s.similarity * 100).toFixed(0)}%)`),
      },
      "Duplicate detected (threshold-only, no LLM)",
    );
  } else {
    logger.info(
      {
        issueNumber: issue.issueNumber,
        bestSimilarity: bestSimilarity.toFixed(3),
        topSimilar: topSimilar.map((s) => `#${s.issueNumber} (${(s.similarity * 100).toFixed(0)}%)`),
      },
      "No duplicate found",
    );
  }

  return {
    isDuplicate,
    originalIssue: isDuplicate ? bestCandidate : undefined,
    similarity: bestSimilarity,
    topSimilar,
  };
}
