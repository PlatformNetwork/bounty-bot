/**
 * Webhook callback client for bounty-bot → Atlas communication.
 *
 * Sends HMAC-signed HTTP POST requests to Atlas with event payloads.
 * Used for async completion notifications (validation.completed,
 * validation.failed, autonomy.deployed).
 *
 * HMAC signing deferred to the both-hmac-auth feature; this module
 * provides the transport and retry infrastructure.
 */

import { logger } from "./logger.js";
import {
  ATLAS_WEBHOOK_URL,
  WEBHOOK_MAX_RETRIES,
  WEBHOOK_RETRY_DELAY_MS,
} from "./config.js";
import { buildSignedHeaders } from "./hmac.js";

/** Supported webhook event types sent from bounty-bot to Atlas. */
export type WebhookEventType =
  | "validation.completed"
  | "validation.failed"
  | "autonomy.deployed";

/** Payload shape for webhook callbacks. */
export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

/** Result of a webhook delivery attempt. */
export interface WebhookResult {
  success: boolean;
  statusCode?: number;
  attempts: number;
  error?: string;
}

/**
 * Build a webhook payload with current timestamp.
 */
export function buildWebhookPayload(
  event: WebhookEventType,
  data: Record<string, unknown>,
): WebhookPayload {
  return {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a webhook callback to Atlas with retry logic.
 *
 * Uses native fetch (Node 18+) for HTTP transport.
 * All requests are signed with HMAC for inter-service authentication.
 *
 * @param payload - The webhook payload to send
 * @param url - Override target URL (defaults to ATLAS_WEBHOOK_URL)
 * @returns Result indicating success/failure and attempt count
 */
export async function sendWebhookCallback(
  payload: WebhookPayload,
  url?: string,
): Promise<WebhookResult> {
  const targetUrl = url || ATLAS_WEBHOOK_URL;
  const body = JSON.stringify(payload);
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
    try {
      logger.info(
        { event: payload.event, attempt, url: targetUrl },
        "Sending webhook callback",
      );

      const signedHeaders = buildSignedHeaders(body);
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          ...signedHeaders,
          "X-Webhook-Event": payload.event,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        logger.info(
          { event: payload.event, statusCode: response.status, attempt },
          "Webhook callback delivered",
        );
        return {
          success: true,
          statusCode: response.status,
          attempts: attempt,
        };
      }

      // Non-retryable client errors (4xx except 429)
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        lastError = `HTTP ${response.status}: ${response.statusText}`;
        logger.warn(
          { event: payload.event, statusCode: response.status, attempt },
          "Webhook callback rejected (non-retryable)",
        );
        return {
          success: false,
          statusCode: response.status,
          attempts: attempt,
          error: lastError,
        };
      }

      // Retryable error (5xx or 429)
      lastError = `HTTP ${response.status}: ${response.statusText}`;
      logger.warn(
        { event: payload.event, statusCode: response.status, attempt },
        "Webhook callback failed (retryable)",
      );
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : "Unknown fetch error";
      logger.warn(
        { event: payload.event, attempt, err: lastError },
        "Webhook callback error",
      );
    }

    // Wait before retry (exponential backoff)
    if (attempt < WEBHOOK_MAX_RETRIES) {
      const delay = WEBHOOK_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  logger.error(
    { event: payload.event, attempts: WEBHOOK_MAX_RETRIES, error: lastError },
    "Webhook callback exhausted retries",
  );

  return {
    success: false,
    attempts: WEBHOOK_MAX_RETRIES,
    error: lastError,
  };
}
