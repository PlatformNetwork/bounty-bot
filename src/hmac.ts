/**
 * HMAC signing and verification for inter-service authentication.
 *
 * Uses HMAC-SHA256 with a shared secret and timestamp to sign request
 * bodies. Provides timing-safe signature comparison and a 5-minute
 * replay window.
 */

import { createHmac, timingSafeEqual } from "crypto";

/** Maximum age of a signed request before it is rejected (5 minutes). */
const MAX_TIMESTAMP_AGE_MS = 300_000;

/**
 * Sign a request body with HMAC-SHA256.
 *
 * @param body - The raw request body string
 * @param secret - HMAC secret (defaults to INTER_SERVICE_HMAC_SECRET env)
 * @returns Object with hex signature and timestamp
 */
export function signRequest(
  body: string,
  secret?: string,
): { signature: string; timestamp: string } {
  const hmacSecret = secret || process.env.INTER_SERVICE_HMAC_SECRET || "";
  const timestamp = Date.now().toString();
  const signature = createHmac("sha256", hmacSecret)
    .update(timestamp + "." + body)
    .digest("hex");
  return { signature, timestamp };
}

/**
 * Verify an HMAC signature against a request body and timestamp.
 *
 * Performs timing-safe comparison and rejects requests older than
 * 5 minutes to prevent replay attacks.
 *
 * @param body - The raw request body string
 * @param signature - The hex signature to verify
 * @param timestamp - The epoch timestamp string from the request
 * @param secret - HMAC secret (defaults to INTER_SERVICE_HMAC_SECRET env)
 * @returns true if the signature is valid and within the time window
 */
export function verifySignature(
  body: string,
  signature: string,
  timestamp: string,
  secret?: string,
): boolean {
  const hmacSecret = secret || process.env.INTER_SERVICE_HMAC_SECRET || "";

  // Check timestamp freshness
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime)) return false;

  const age = Math.abs(Date.now() - requestTime);
  if (age > MAX_TIMESTAMP_AGE_MS) return false;

  // Compute expected signature
  const expected = createHmac("sha256", hmacSecret)
    .update(timestamp + "." + body)
    .digest("hex");

  // Timing-safe comparison
  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");

  if (sigBuf.length !== expBuf.length) return false;

  return timingSafeEqual(sigBuf, expBuf);
}

/**
 * Build signed HTTP headers for an outbound request.
 *
 * @param body - The raw request body string
 * @param secret - HMAC secret (defaults to INTER_SERVICE_HMAC_SECRET env)
 * @returns Headers object with X-Signature, X-Timestamp, and Content-Type
 */
export function buildSignedHeaders(
  body: string,
  secret?: string,
): { "X-Signature": string; "X-Timestamp": string; "Content-Type": string } {
  const { signature, timestamp } = signRequest(body, secret);
  return {
    "X-Signature": `sha256=${signature}`,
    "X-Timestamp": timestamp,
    "Content-Type": "application/json",
  };
}
