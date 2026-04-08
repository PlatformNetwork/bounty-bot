/**
 * GitHub mutation helpers for verdict publishing.
 *
 * Applies labels, posts structured comments, and closes/reopens issues
 * based on validation verdicts. All mutations use idempotency keys to
 * prevent duplicate operations.
 */

import { TARGET_REPO } from '../config.js';
import { logger } from '../logger.js';
import { checkIdempotencyKey, setIdempotencyKey } from '../redis.js';
import {
  addLabels,
  removeLabel,
  postComment,
  closeIssue,
} from './client.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Parse owner/repo from TARGET_REPO config. */
function parseTargetRepo(): { owner: string; repo: string } {
  const parts = TARGET_REPO.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid TARGET_REPO format: "${TARGET_REPO}" — expected "owner/repo"`,
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

/** Terminal verdict labels that should be cleared before applying a new verdict. */
const VERDICT_LABELS = ['valid', 'invalid', 'duplicate', 'ide'];

/* ------------------------------------------------------------------ */
/*  Verdict mutations                                                  */
/* ------------------------------------------------------------------ */

/**
 * Apply a "valid" verdict to an issue.
 *
 * - Adds labels: ide, valid
 * - Posts verdict comment with rationale
 * - Leaves issue open
 * - Skips if comment already posted (idempotency)
 */
export async function applyValidVerdict(
  issueNumber: number,
  rationale: string,
  evidence?: object,
): Promise<void> {
  const { owner, repo } = parseTargetRepo();
  const idempotencyKey = `verdict:valid:${issueNumber}`;

  const existing = await checkIdempotencyKey(idempotencyKey);
  if (existing) {
    logger.info(
      { issueNumber },
      'Valid verdict already applied (idempotent skip)',
    );
    return;
  }

  await addLabels(owner, repo, issueNumber, ['ide', 'valid']);

  let body = `## ✅ Verdict: Valid\n\n**Rationale:** ${rationale}`;
  if (evidence) {
    body += `\n\n<details>\n<summary>Evidence</summary>\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n\n</details>`;
  }

  await postComment(owner, repo, issueNumber, body);
  await setIdempotencyKey(idempotencyKey, new Date().toISOString(), 86400);

  logger.info({ issueNumber }, 'Applied valid verdict');
}

/**
 * Apply an "invalid" verdict to an issue.
 *
 * - Adds label: invalid
 * - Posts structured checklist comment
 * - Closes the issue
 */
export async function applyInvalidVerdict(
  issueNumber: number,
  rationale: string,
  checklist?: string[],
): Promise<void> {
  const { owner, repo } = parseTargetRepo();
  const idempotencyKey = `verdict:invalid:${issueNumber}`;

  const existing = await checkIdempotencyKey(idempotencyKey);
  if (existing) {
    logger.info(
      { issueNumber },
      'Invalid verdict already applied (idempotent skip)',
    );
    return;
  }

  await addLabels(owner, repo, issueNumber, ['invalid']);

  let body = `## ❌ Verdict: Invalid\n\n**Rationale:** ${rationale}`;
  if (checklist && checklist.length > 0) {
    body += '\n\n**Checklist:**\n';
    for (const item of checklist) {
      body += `- [ ] ${item}\n`;
    }
  }

  await postComment(owner, repo, issueNumber, body);
  await closeIssue(owner, repo, issueNumber);
  await setIdempotencyKey(idempotencyKey, new Date().toISOString(), 86400);

  logger.info({ issueNumber }, 'Applied invalid verdict');
}

/**
 * Apply a "duplicate" verdict to an issue.
 *
 * - Adds label: duplicate
 * - Posts comment linking to original issue
 * - Closes the issue
 */
export async function applyDuplicateVerdict(
  issueNumber: number,
  originalIssueNumber: number,
  rationale: string,
): Promise<void> {
  const { owner, repo } = parseTargetRepo();
  const idempotencyKey = `verdict:duplicate:${issueNumber}`;

  const existing = await checkIdempotencyKey(idempotencyKey);
  if (existing) {
    logger.info(
      { issueNumber },
      'Duplicate verdict already applied (idempotent skip)',
    );
    return;
  }

  await addLabels(owner, repo, issueNumber, ['duplicate']);

  const body =
    `## 🔁 Verdict: Duplicate\n\n` +
    `Duplicate of #${originalIssueNumber}\n\n` +
    `**Rationale:** ${rationale}`;

  await postComment(owner, repo, issueNumber, body);
  await closeIssue(owner, repo, issueNumber);
  await setIdempotencyKey(idempotencyKey, new Date().toISOString(), 86400);

  logger.info({ issueNumber, originalIssueNumber }, 'Applied duplicate verdict');
}

/**
 * Clear all verdict-related labels from an issue.
 *
 * Removes: valid, invalid, duplicate, ide
 */
export async function clearVerdictLabels(issueNumber: number): Promise<void> {
  const { owner, repo } = parseTargetRepo();

  for (const label of VERDICT_LABELS) {
    await removeLabel(owner, repo, issueNumber, label);
  }

  logger.info({ issueNumber }, 'Cleared verdict labels');
}
