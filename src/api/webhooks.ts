/**
 * GitHub webhook endpoint.
 *
 * Receives GitHub webhook events, validates the X-Hub-Signature-256
 * signature, and routes issue events through the intake pipeline.
 *
 * NOTE: This router does NOT use HMAC middleware — GitHub has its own
 * signature scheme using GITHUB_WEBHOOK_SECRET.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { Router, type Request, type Response } from "express";
import { GITHUB_WEBHOOK_SECRET, TARGET_REPO } from "../config.js";
import { logger } from "../logger.js";
import {
  normalizeIssue,
  shouldProcess,
  processIntake,
} from "../validation/intake.js";
import {
  blacklistUser,
  unblacklistUser,
  isUserBlacklisted,
  insertAuditLog,
} from "../db/index.js";
import { postComment } from "../github/client.js";

export const webhookRouter = Router();

/* ------------------------------------------------------------------ */
/*  Signature verification                                             */
/* ------------------------------------------------------------------ */

/**
 * Verify the X-Hub-Signature-256 header from GitHub.
 *
 * @param payload - Raw request body as string
 * @param signatureHeader - Value of X-Hub-Signature-256 header
 * @returns true if signature is valid
 */
function verifyGitHubSignature(
  payload: string,
  signatureHeader: string,
): boolean {
  if (!GITHUB_WEBHOOK_SECRET) {
    // If no secret configured, skip verification (dev mode)
    logger.warn(
      "GitHub webhook secret not configured — skipping signature verification",
    );
    return true;
  }

  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const signature = signatureHeader.slice(7);
  const expected = createHmac("sha256", GITHUB_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");

  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");

  if (sigBuf.length !== expBuf.length) return false;

  return timingSafeEqual(sigBuf, expBuf);
}

/* ------------------------------------------------------------------ */
/*  Webhook handler                                                    */
/* ------------------------------------------------------------------ */

webhookRouter.post("/github", (req: Request, res: Response): void => {
  const event = req.headers["x-github-event"] as string | undefined;
  const signatureHeader = req.headers["x-hub-signature-256"] as
    | string
    | undefined;
  const deliveryId = req.headers["x-github-delivery"] as string | undefined;

  logger.info({ event, deliveryId }, "GitHub webhook received");

  // Verify signature
  const rawBody = JSON.stringify(req.body);
  if (signatureHeader && !verifyGitHubSignature(rawBody, signatureHeader)) {
    logger.warn({ deliveryId }, "GitHub webhook: invalid signature");
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  // Handle issue_comment events for bot commands (!ban-reply, !unban-reply)
  if (event === "issue_comment") {
    const action = (req.body as Record<string, unknown>).action as string | undefined;
    if (action !== "created") {
      res.status(200).json({ status: "ignored", action });
      return;
    }

    const comment = (req.body as Record<string, unknown>).comment as Record<string, unknown> | undefined;
    const commentBody = (comment?.body as string) ?? "";
    const commentUser = (comment?.user as Record<string, unknown>)?.login as string | undefined;
    const issue = (req.body as Record<string, unknown>).issue as Record<string, unknown> | undefined;
    const issueNumber = issue?.number as number | undefined;

    handleBotCommands(commentBody, commentUser ?? "unknown", issueNumber)
      .then((handled) => {
        if (!handled) {
          logger.debug({ commentUser, issueNumber }, "GitHub webhook: comment has no bot command");
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, issueNumber, commentUser }, "GitHub webhook: bot command failed");
      });

    res.status(200).json({ status: "accepted", event: "issue_comment" });
    return;
  }

  // Only handle 'issues' events
  if (event !== "issues") {
    logger.info({ event }, "GitHub webhook: ignoring non-issues event");
    res.status(200).json({ status: "ignored", event });
    return;
  }

  const action = (req.body as Record<string, unknown>).action as
    | string
    | undefined;

  // Only handle 'opened' action
  if (action !== "opened") {
    logger.info({ action }, "GitHub webhook: ignoring non-opened action");
    res.status(200).json({ status: "ignored", action });
    return;
  }

  // Normalize and check eligibility
  const normalized = normalizeIssue(req.body as Record<string, unknown>);
  const check = shouldProcess(normalized);

  if (!check.process) {
    logger.info(
      { issueNumber: normalized.issueNumber, reason: check.reason },
      "GitHub webhook: issue skipped",
    );
    res.status(200).json({ status: "skipped", reason: check.reason });
    return;
  }

  // Process intake asynchronously — respond immediately with 202
  processIntake(normalized)
    .then((result) => {
      logger.info(
        { issueNumber: normalized.issueNumber, queued: result.queued },
        "GitHub webhook: intake complete",
      );
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { issueNumber: normalized.issueNumber, err: msg },
        "GitHub webhook: intake failed",
      );
    });

  res.status(202).json({
    status: "accepted",
    issueNumber: normalized.issueNumber,
  });
});

/* ------------------------------------------------------------------ */
/*  Bot commands (!ban-reply, !unban-reply)                            */
/* ------------------------------------------------------------------ */

/** Repo collaborators / admins allowed to use bot commands. */
const ALLOWED_COMMAND_USERS = new Set(
  (process.env.BOT_ADMIN_USERS || "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean),
);

/**
 * Check if a user is allowed to run bot commands.
 * Falls back to checking GitHub collaborator status if not in env list.
 */
async function isCommandAllowed(username: string): Promise<boolean> {
  if (ALLOWED_COMMAND_USERS.has(username.toLowerCase())) return true;

  // Check if user is a repo collaborator via GitHub API
  const parts = TARGET_REPO.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

  try {
    const { checkCollaborator } = await import("../github/client.js");
    return await checkCollaborator(parts[0], parts[1], username);
  } catch {
    return false;
  }
}

const BAN_REPLY_PATTERN = /^!ban-reply\s+@?(\S+)/i;
const UNBAN_REPLY_PATTERN = /^!unban-reply\s+@?(\S+)/i;

/**
 * Handle bot commands in issue comments.
 * Returns true if a command was recognized and processed.
 */
async function handleBotCommands(
  commentBody: string,
  commentAuthor: string,
  issueNumber?: number,
): Promise<boolean> {
  const banMatch = commentBody.match(BAN_REPLY_PATTERN);
  const unbanMatch = commentBody.match(UNBAN_REPLY_PATTERN);

  if (!banMatch && !unbanMatch) return false;

  const allowed = await isCommandAllowed(commentAuthor);
  if (!allowed) {
    logger.warn(
      { commentAuthor, issueNumber },
      "Bot command: unauthorized user attempted command",
    );
    if (issueNumber) {
      const parts = TARGET_REPO.split("/");
      if (parts.length === 2 && parts[0] && parts[1]) {
        await postComment(parts[0], parts[1], issueNumber,
          `@${commentAuthor} You are not authorized to use bot commands.`,
        ).catch(() => {});
      }
    }
    return true;
  }

  const parts = TARGET_REPO.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [owner, repo] = parts;

  if (banMatch) {
    const targetUser = banMatch[1].toLowerCase();
    if (isUserBlacklisted(targetUser)) {
      logger.info({ targetUser, commentAuthor }, "Bot command: user already blacklisted");
      if (issueNumber) {
        await postComment(owner, repo, issueNumber,
          `\`${targetUser}\` is already blacklisted.`,
        ).catch(() => {});
      }
      return true;
    }

    blacklistUser(targetUser, commentAuthor, `Banned via !ban-reply by ${commentAuthor}`);
    insertAuditLog({
      action: "user.blacklisted",
      actor: commentAuthor,
      details: JSON.stringify({ target: targetUser, issueNumber }),
      github_ref: issueNumber ? `#${issueNumber}` : undefined,
    });

    logger.info({ targetUser, bannedBy: commentAuthor, issueNumber }, "Bot command: user blacklisted");

    if (issueNumber) {
      await postComment(owner, repo, issueNumber,
        `@${targetUser} has been blacklisted. The bot will no longer process their submissions.`,
      ).catch(() => {});
    }
    return true;
  }

  if (unbanMatch) {
    const targetUser = unbanMatch[1].toLowerCase();
    const removed = unblacklistUser(targetUser);

    if (!removed) {
      if (issueNumber) {
        await postComment(owner, repo, issueNumber,
          `\`${targetUser}\` is not in the blacklist.`,
        ).catch(() => {});
      }
      return true;
    }

    insertAuditLog({
      action: "user.unblacklisted",
      actor: commentAuthor,
      details: JSON.stringify({ target: targetUser, issueNumber }),
      github_ref: issueNumber ? `#${issueNumber}` : undefined,
    });

    logger.info({ targetUser, unbannedBy: commentAuthor, issueNumber }, "Bot command: user unblacklisted");

    if (issueNumber) {
      await postComment(owner, repo, issueNumber,
        `@${targetUser} has been removed from the blacklist.`,
      ).catch(() => {});
    }
    return true;
  }

  return false;
}
