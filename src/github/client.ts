/**
 * GitHub API client using native fetch.
 *
 * Handles authentication via GITHUB_TOKEN Bearer token, rate limit
 * monitoring, and structured error handling for all GitHub REST API
 * interactions.
 */

import { GITHUB_TOKEN } from "../config.js";
import { logger } from "../logger.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
}

export interface GitHubEvent {
  id: number;
  event: string;
  created_at: string;
  actor: { login: string } | null;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/* ------------------------------------------------------------------ */
/*  Rate limit state                                                   */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_THRESHOLD = 50;
const RATE_LIMIT_PAUSE_MS = 60_000;

let rateLimitRemaining = Infinity;
let rateLimitResetAt = 0;

/**
 * Update rate limit state from response headers.
 */
function updateRateLimit(headers: Headers): void {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");

  if (remaining !== null) {
    rateLimitRemaining = parseInt(remaining, 10);
  }
  if (reset !== null) {
    rateLimitResetAt = parseInt(reset, 10) * 1000;
  }
}

/**
 * Pause if rate limit is critically low.
 */
async function checkRateLimit(): Promise<void> {
  if (rateLimitRemaining > RATE_LIMIT_THRESHOLD) return;

  const waitMs = Math.max(0, rateLimitResetAt - Date.now());
  if (waitMs > 0 && waitMs < RATE_LIMIT_PAUSE_MS * 2) {
    logger.warn(
      { remaining: rateLimitRemaining, waitMs },
      "GitHub rate limit low — pausing",
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/* ------------------------------------------------------------------ */
/*  Core request helper                                                */
/* ------------------------------------------------------------------ */

const GITHUB_API = "https://api.github.com";

/**
 * Make an authenticated request to the GitHub REST API.
 */
async function githubFetch<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  await checkRateLimit();

  const url = `${GITHUB_API}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  updateRateLimit(response.headers);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GitHubApiError(
      `GitHub API ${method} ${path} returned ${response.status}: ${text}`,
      response.status,
      path,
    );
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Get a single issue by number.
 */
export async function getIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  return githubFetch<GitHubIssue>(
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
  );
}

/**
 * Add labels to an issue.
 */
export async function addLabels(
  owner: string,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  await githubFetch<unknown>(
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
    { labels },
  );
}

/**
 * Remove a label from an issue. Silently ignores 404 (label not present).
 */
export async function removeLabel(
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await githubFetch<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    );
  } catch (err: unknown) {
    if (err instanceof GitHubApiError && err.statusCode === 404) {
      // Label was not on the issue — safe to ignore
      return;
    }
    throw err;
  }
}

/**
 * Post a comment on an issue.
 */
export async function postComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<GitHubComment> {
  return githubFetch<GitHubComment>(
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    { body },
  );
}

/**
 * Close an issue.
 */
export async function closeIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await githubFetch<unknown>(
    "PATCH",
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    { state: "closed" },
  );
}

/**
 * Reopen an issue.
 */
export async function reopenIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await githubFetch<unknown>(
    "PATCH",
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    { state: "open" },
  );
}

/**
 * Get timeline events for an issue (edit history, labels, etc.).
 */
export async function getIssueEvents(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubEvent[]> {
  return githubFetch<GitHubEvent[]>(
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}/events`,
  );
}

/**
 * List recent issues for a repository.
 *
 * @param since - ISO 8601 timestamp to filter issues updated after
 * @param page - Page number for pagination (default 1)
 */
export async function listRecentIssues(
  owner: string,
  repo: string,
  since?: string,
  page?: number,
): Promise<GitHubIssue[]> {
  const params = new URLSearchParams({
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: "100",
    page: String(page ?? 1),
  });

  if (since) {
    params.set("since", since);
  }

  return githubFetch<GitHubIssue[]>(
    "GET",
    `/repos/${owner}/${repo}/issues?${params.toString()}`,
  );
}

/**
 * Fetch all recent issues with automatic pagination.
 * Fetches up to 10 pages (1000 issues max).
 */
export async function listAllRecentIssues(
  owner: string,
  repo: string,
  since?: string,
): Promise<GitHubIssue[]> {
  const all: GitHubIssue[] = [];
  const maxPages = 10;

  for (let page = 1; page <= maxPages; page++) {
    const batch = await listRecentIssues(owner, repo, since, page);
    all.push(...batch);
    if (batch.length < 100) break;
  }

  return all;
}
