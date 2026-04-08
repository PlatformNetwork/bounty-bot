/**
 * Duplicate detection with lexical fingerprinting.
 *
 * Generates word-level n-gram fingerprints for issue text, then
 * computes Jaccard similarity against existing embeddings to
 * detect duplicate submissions.
 */

import { createHash } from 'crypto';

import { logger } from '../logger.js';
import { upsertEmbedding, getAllEmbeddings } from '../db/index.js';
import { ISSUE_FLOOR } from '../config.js';
import {
  computeEmbedding,
  cosineSimilarity,
  isEmbeddingAvailable,
} from './embeddings.js';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

/** Similarity threshold above which an issue is flagged as duplicate. */
export const DUPLICATE_THRESHOLD = parseFloat(
  process.env.DUPLICATE_THRESHOLD || '0.75',
);

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DuplicateResult {
  isDuplicate: boolean;
  originalIssue?: number;
  similarity: number;
}

/* ------------------------------------------------------------------ */
/*  Stop words (common English)                                        */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their', 'what',
  'which', 'who', 'whom', 'when', 'where', 'how', 'not', 'no', 'nor',
  'if', 'then', 'than', 'so', 'as', 'up', 'out', 'about', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'same', 'each', 'every', 'all', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'just', 'also', 'very', 'too',
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
    .replace(/[^a-z0-9\s]/g, ' ')
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
  return createHash('sha256').update(sorted.join('|')).digest('hex');
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
  const combinedText = issue.title + ' ' + issue.body;
  const fingerprint = generateFingerprint(combinedText);

  // Get all existing embeddings
  const embeddings = getAllEmbeddings();

  // Compute semantic embedding for the current issue (empty array if unavailable)
  let currentEmbedding: number[] = [];
  if (isEmbeddingAvailable()) {
    currentEmbedding = await computeEmbedding(combinedText);
  }

  let bestSimilarity = 0;
  let bestCandidate: number | undefined;

  for (const embedding of embeddings) {
    // Only older issues can be originals
    if (embedding.issue_number >= issue.issueNumber) continue;

    // Respect ISSUE_FLOOR
    if (embedding.issue_number < ISSUE_FLOOR) continue;

    // We need the body text for comparison — reconstruct from stored fingerprint context
    // Since we store fingerprints, we use word-set comparison on available data
    const candidateText = embedding.body_fingerprint ?? '';

    // If candidate has no stored text, skip meaningful comparison
    if (!candidateText) continue;

    const jaccardScore = computeSimilarity(
      fingerprint,
      candidateText,
      combinedText,
      candidateText,
    );

    let finalScore = jaccardScore;

    // If we have a current embedding and the candidate has a stored embedding vector,
    // compute a hybrid score combining Jaccard and cosine similarity
    if (currentEmbedding.length > 0 && embedding.embedding_vector) {
      try {
        const storedVector: number[] = JSON.parse(
          embedding.embedding_vector.toString('utf-8'),
        );
        if (Array.isArray(storedVector) && storedVector.length > 0) {
          const cosineScore = cosineSimilarity(currentEmbedding, storedVector);
          finalScore = 0.4 * jaccardScore + 0.6 * cosineScore;
        }
      } catch {
        // Stored embedding is invalid — fall back to Jaccard only
      }
    }

    if (finalScore > bestSimilarity) {
      bestSimilarity = finalScore;
      bestCandidate = embedding.issue_number;
    }
  }

  // Store the current issue's embedding (with vector if available)
  upsertEmbedding({
    issue_number: issue.issueNumber,
    title_fingerprint: generateFingerprint(issue.title),
    body_fingerprint: combinedText, // Store combined text for future comparisons
    embedding_vector:
      currentEmbedding.length > 0
        ? Buffer.from(JSON.stringify(currentEmbedding), 'utf-8')
        : undefined,
  });

  const isDuplicate = bestSimilarity >= DUPLICATE_THRESHOLD && bestCandidate !== undefined;

  if (isDuplicate) {
    logger.info(
      {
        issueNumber: issue.issueNumber,
        originalIssue: bestCandidate,
        similarity: bestSimilarity.toFixed(3),
      },
      'Duplicate detected',
    );
  } else {
    logger.info(
      { issueNumber: issue.issueNumber, bestSimilarity: bestSimilarity.toFixed(3) },
      'No duplicate found',
    );
  }

  return {
    isDuplicate,
    originalIssue: isDuplicate ? bestCandidate : undefined,
    similarity: bestSimilarity,
  };
}
