/**
 * Semantic embeddings via OpenRouter's OpenAI-compatible API.
 *
 * Provides embedding computation and cosine similarity for semantic
 * duplicate detection. Falls back gracefully when no API key is set
 * or when the API is unreachable.
 */

import OpenAI from 'openai';

import { logger } from '../logger.js';
import {
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  EMBEDDING_MODEL,
} from '../config.js';

/* ------------------------------------------------------------------ */
/*  Client singleton                                                   */
/* ------------------------------------------------------------------ */

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
    });
  }
  return client;
}

/* ------------------------------------------------------------------ */
/*  Cosine similarity                                                  */
/* ------------------------------------------------------------------ */

/**
 * Compute cosine similarity between two numeric vectors.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Similarity score 0–1 (0 if vectors are empty or mismatched)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/* ------------------------------------------------------------------ */
/*  Embedding computation                                              */
/* ------------------------------------------------------------------ */

/**
 * Compute a semantic embedding vector for the given text.
 *
 * Returns an empty array when:
 * - No OPENROUTER_API_KEY is configured
 * - The API call fails for any reason
 *
 * @param text - Raw text to embed (truncated to 8 000 chars)
 * @returns Numeric embedding vector, or empty array on failure
 */
export async function computeEmbedding(text: string): Promise<number[]> {
  if (!OPENROUTER_API_KEY) {
    logger.warn('No OPENROUTER_API_KEY set — skipping embedding computation');
    return [];
  }

  try {
    const response = await getClient().embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000), // Limit input length
    });
    return response.data[0]?.embedding ?? [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'Embedding computation failed — falling back');
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Availability check                                                 */
/* ------------------------------------------------------------------ */

/**
 * Check whether embedding computation is available (API key set).
 */
export function isEmbeddingAvailable(): boolean {
  return !!OPENROUTER_API_KEY;
}
