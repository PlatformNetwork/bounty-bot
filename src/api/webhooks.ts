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
import { GITHUB_WEBHOOK_SECRET } from "../config.js";
import { logger } from "../logger.js";
import {
  normalizeIssue,
  shouldProcess,
  processIntake,
} from "../validation/intake.js";

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
