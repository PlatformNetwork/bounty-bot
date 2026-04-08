/**
 * Express middleware for HMAC authentication on inter-service requests.
 *
 * Verifies X-Signature and X-Timestamp headers against the request body
 * using the shared HMAC secret. Returns 401 on failure.
 */

import type { Request, Response, NextFunction } from "express";
import { verifySignature } from "../hmac.js";
import { logger } from "../logger.js";

/**
 * HMAC authentication middleware.
 *
 * Extracts the X-Signature and X-Timestamp headers, serializes the
 * parsed request body back to JSON, and verifies the HMAC signature.
 * Rejects with 401 if signature is missing, expired, or invalid.
 */
export function hmacAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const signatureHeader = req.headers["x-signature"] as string | undefined;
  const timestamp = req.headers["x-timestamp"] as string | undefined;

  if (!signatureHeader || !timestamp) {
    logger.warn("HMAC auth: missing signature or timestamp header");
    res.status(401).json({
      error: "unauthorized",
      message: "Missing authentication headers",
    });
    return;
  }

  // Strip "sha256=" prefix if present
  const signature = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  // Serialize body back to JSON string for verification
  const body = JSON.stringify(req.body);

  if (!verifySignature(body, signature, timestamp)) {
    logger.warn("HMAC auth: signature verification failed");
    res.status(401).json({
      error: "unauthorized",
      message: "Invalid signature",
    });
    return;
  }

  next();
}
