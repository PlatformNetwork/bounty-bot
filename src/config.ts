/**
 * Configuration constants for bounty-bot service.
 * All port allocations, paths, and integration settings defined here
 * for single-source-of-truth.
 */

import path from "path";

/** Bounty-bot API port (primary) */
export const DEFAULT_API_PORT = 3235;

/** Bounty-bot internal service ports */
export const INTERNAL_PORT_START = 3236;
export const INTERNAL_PORT_END = 3239;

/** Full port range for bounty-bot (3235-3239) */
export const PORT_RANGE_START = 3235;
export const PORT_RANGE_END = 3239;

/** SQLite data directory */
export const DATA_DIR = process.env.DATA_DIR || "./data";

/** SQLite database file path */
export const SQLITE_PATH =
  process.env.SQLITE_PATH || path.join(DATA_DIR, "bounty-bot.db");

/** Service name for logging and health */
export const SERVICE_NAME = "bounty-bot";

/**
 * Atlas webhook URL for sending callbacks (validation.completed, etc.).
 * Required for cross-service communication.
 */
export const ATLAS_WEBHOOK_URL =
  process.env.ATLAS_WEBHOOK_URL || "http://localhost:3230/webhooks";

/**
 * Target GitHub repository for bounty validation (owner/repo format).
 */
export const TARGET_REPO =
  process.env.TARGET_REPO || "PlatformNetwork/bounty-challenge";

/**
 * Maximum webhook callback retry attempts before giving up.
 */
export const WEBHOOK_MAX_RETRIES = parseInt(
  process.env.WEBHOOK_MAX_RETRIES || "3",
  10,
);

/**
 * Delay between webhook callback retries (milliseconds).
 */
export const WEBHOOK_RETRY_DELAY_MS = parseInt(
  process.env.WEBHOOK_RETRY_DELAY_MS || "1000",
  10,
);

/** Redis connection URL. */
export const REDIS_URL = process.env.REDIS_URL || "redis://localhost:3231";

/** HMAC shared secret for inter-service authentication. */
export const HMAC_SECRET = process.env.INTER_SERVICE_HMAC_SECRET || "";

/**
 * GitHub personal access token for API requests.
 * Never log this value.
 */
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

/**
 * GitHub webhook secret for verifying X-Hub-Signature-256 headers.
 * Never log this value.
 */
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

/**
 * Poller interval in milliseconds for checking missed webhooks.
 */
export const POLLER_INTERVAL = parseInt(
  process.env.POLLER_INTERVAL || "60000",
  10,
);

/**
 * Maximum retry attempts for queue processing before dead-lettering.
 */
export const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);

/**
 * Minimum issue number to process (skip older issues).
 */
export const ISSUE_FLOOR = parseInt(process.env.ISSUE_FLOOR || "41000", 10);

/**
 * Spam score threshold — issues scoring at or above this are flagged as spam.
 */
export const SPAM_THRESHOLD = parseFloat(process.env.SPAM_THRESHOLD || "0.7");

/**
 * Duplicate similarity threshold — issues scoring at or above this
 * against an older issue are flagged as duplicates.
 */
export const DUPLICATE_THRESHOLD = parseFloat(
  process.env.DUPLICATE_THRESHOLD || "0.75",
);

/**
 * Maximum age (ms) of an issue eligible for requeue (default 24h).
 */
export const REQUEUE_MAX_AGE_MS = parseInt(
  process.env.REQUEUE_MAX_AGE_MS || "86400000",
  10,
);

/**
 * OpenRouter API key for LLM-assisted scoring and embeddings.
 * Never log this value.
 */
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

/**
 * OpenRouter base URL (OpenAI-compatible API).
 */
export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

/**
 * Embedding model used for semantic duplicate detection.
 * Qwen3 Embedding 8B via OpenRouter for high-quality multilingual embeddings.
 */
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || "qwen/qwen3-embedding-8b";

/**
 * LLM model used for issue evaluation, validity and spam scoring.
 * Gemini 3.1 Pro Preview Custom Tools via OpenRouter — optimized for
 * function calling reliability (prevents bash tool overuse, selects
 * deliver_verdict tool correctly).
 */
export const LLM_SCORING_MODEL =
  process.env.LLM_SCORING_MODEL || "google/gemini-3.1-pro-preview-customtools";

/** URL of the target product repo to verify bugs against. */
export const CORTEX_REPO_URL =
  process.env.CORTEX_REPO_URL || "https://github.com/CortexLM/cortex";

/** Local clone directory for the target product repo. */
export const CORTEX_REPO_DIR =
  process.env.CORTEX_REPO_DIR || "./data/cortex-repo";

/** Max agentic iterations for code verification. */
export const CODE_VERIFY_MAX_ITERATIONS = parseInt(
  process.env.CODE_VERIFY_MAX_ITERATIONS || "50",
  10,
);

/** Number of issues to process concurrently in the queue. */
export const QUEUE_CONCURRENCY = parseInt(
  process.env.QUEUE_CONCURRENCY || "5",
  10,
);

/** Queue processor poll interval in milliseconds. */
export const QUEUE_INTERVAL = parseInt(
  process.env.QUEUE_INTERVAL || "2000",
  10,
);
