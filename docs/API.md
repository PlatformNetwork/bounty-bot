# API Reference

Bounty-bot exposes a REST API on port **3235** (configurable via `PORT`).

## Authentication

### HMAC Authentication (inter-service)

All `/api/v1/*` endpoints (except the GitHub webhook) require HMAC-SHA256 authentication using a shared secret (`INTER_SERVICE_HMAC_SECRET`).

**Required headers:**

| Header | Format | Description |
|---|---|---|
| `X-Signature` | `sha256=<hex>` | HMAC-SHA256 of `<timestamp>.<body>` |
| `X-Timestamp` | epoch milliseconds string | Request timestamp |

**Signing algorithm:**

```
signature = HMAC-SHA256(secret, timestamp + "." + JSON.stringify(body))
```

Requests older than **5 minutes** are rejected (replay protection).

### GitHub Webhook Signature

`POST /api/v1/webhooks/github` uses GitHub's own `X-Hub-Signature-256` header verified against `GITHUB_WEBHOOK_SECRET`. If no secret is configured, signature verification is skipped (development mode).

---

## Endpoints

### `GET /health`

Liveness probe. Always returns 200.

**Response:**

```json
{
  "status": "ok",
  "service": "bounty-bot",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

### `GET /ready`

Readiness probe. Returns 200 when the service is ready; 503 otherwise.

**Response (ready):**

```json
{
  "status": "ready",
  "service": "bounty-bot",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

**Response (not ready):**

```json
{
  "status": "not_ready",
  "service": "bounty-bot",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

### `POST /api/v1/webhooks/github`

Receives GitHub webhook events. Only processes `issues` events with action `opened`.

**Headers:**

| Header | Required | Description |
|---|---|---|
| `X-GitHub-Event` | yes | Event type (only `issues` is processed) |
| `X-Hub-Signature-256` | recommended | `sha256=<hex>` signature |
| `X-GitHub-Delivery` | no | Delivery UUID for logging |

**Request body:** Raw GitHub webhook payload.

**Responses:**

| Status | Condition | Body |
|---|---|---|
| `202` | Issue accepted for processing | `{ "status": "accepted", "issueNumber": 41234 }` |
| `200` | Event ignored (non-issues or non-opened) | `{ "status": "ignored", "event": "push" }` |
| `200` | Issue skipped (below floor, terminal label) | `{ "status": "skipped", "reason": "..." }` |
| `401` | Invalid signature | `{ "error": "invalid_signature" }` |

---

### `POST /api/v1/validation/trigger`

Trigger validation for a specific issue. Fetches the issue from GitHub, runs intake filtering, and queues it for processing.

**Auth:** HMAC

**Request body:**

```json
{
  "issue_number": 41234
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `issue_number` | number | yes | GitHub issue number |

**Responses:**

| Status | Condition | Body |
|---|---|---|
| `202` | Issue queued for validation | `{ "status": "queued", "issueNumber": 41234 }` |
| `200` | Issue skipped | `{ "status": "skipped", "reason": "...", "issueNumber": 41234 }` |
| `400` | Missing or invalid issue_number | `{ "error": "bad_request", "message": "..." }` |
| `500` | Trigger failed | `{ "error": "trigger_failed", "message": "..." }` |

---

### `GET /api/v1/validation/:issue_number/status`

Get current processing status for an issue.

**Auth:** HMAC

**URL params:** `issue_number` — integer.

**Response (200):**

```json
{
  "issueNumber": 41234,
  "status": "completed",
  "retryCount": 0,
  "verdict": "valid",
  "queuePosition": null,
  "validation": {
    "verdict": "valid",
    "rationale": "All validation checks passed...",
    "spamScore": 0.12,
    "duplicateOf": null,
    "createdAt": "2025-01-01T00:00:00.000Z"
  },
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `status` | string | `pending`, `in_progress`, `completed`, `dead_lettered` |
| `retryCount` | number | Current retry attempt |
| `verdict` | string \| null | `valid`, `invalid`, `duplicate`, or null if pending |
| `queuePosition` | number \| null | Position in queue (null if not queued) |
| `validation` | object \| null | Latest validation result (null if not yet validated) |

**Error responses:**

| Status | Condition | Body |
|---|---|---|
| `400` | Invalid issue_number | `{ "error": "bad_request", "message": "..." }` |
| `404` | Issue not found | `{ "error": "not_found", "message": "..." }` |

---

### `POST /api/v1/validation/:issue_number/requeue`

Request re-validation of an issue. Reopens the GitHub issue, clears verdict labels, posts a re-evaluation comment, and re-enqueues for processing.

**Auth:** HMAC

**Business rules:**
- Issue must exist in the database
- Issue `created_at` must be within 24 hours (`REQUEUE_MAX_AGE_MS`)
- Issue must not have been previously requeued (once per issue)

**Request body:**

```json
{
  "requester_id": "atlas",
  "requester_context": { "reason": "user appeal" }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `requester_id` | string | no | Identifier of the requester (default: `"unknown"`) |
| `requester_context` | object | no | Arbitrary context stored with the requeue record |

**Responses:**

| Status | Condition | Body |
|---|---|---|
| `202` | Requeued successfully | `{ "status": "requeued", "issueNumber": 41234 }` |
| `422` | Rejected (too old, already requeued, not found) | `{ "error": "requeue_rejected", "message": "..." }` |
| `400` | Invalid issue_number | `{ "error": "bad_request", "message": "..." }` |
| `500` | Internal error | `{ "error": "requeue_failed", "message": "..." }` |

---

### `POST /api/v1/validation/:issue_number/force-release`

Force-release a locked bounty. Clears Redis locks and database lock fields. **Does not make any GitHub API calls.**

**Auth:** HMAC

**Request body:** None required.

**Responses:**

| Status | Condition | Body |
|---|---|---|
| `200` | Lock released | `{ "status": "released", "issueNumber": 41234 }` |
| `400` | Invalid issue_number | `{ "error": "bad_request", "message": "..." }` |
| `500` | Release failed | `{ "error": "release_failed", "message": "..." }` |

---

### `GET /api/v1/dead-letter`

List all dead-lettered items.

**Auth:** HMAC

**Response (200):**

```json
{
  "items": [
    {
      "id": 1,
      "bounty_id": 41234,
      "failure_cause": "GitHub API timeout",
      "last_attempt": "2025-01-01T00:00:00.000Z",
      "metadata": "{\"retry_count\":3}",
      "retry_count": 3,
      "created_at": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### `POST /api/v1/dead-letter/:id/recover`

Recover a dead-lettered item by re-enqueuing it with `retryCount: 0`.

**Auth:** HMAC

**URL params:** `id` — dead-letter record ID (integer).

**Responses:**

| Status | Condition | Body |
|---|---|---|
| `202` | Recovered and re-enqueued | `{ "status": "recovered", "id": 1 }` |
| `400` | Invalid id | `{ "error": "bad_request", "message": "..." }` |
| `404` | Dead-letter item not found | `{ "error": "not_found", "message": "..." }` |

---

## Webhook Callbacks (outbound)

Bounty-bot sends HMAC-signed POST requests to `ATLAS_WEBHOOK_URL` on these events:

| Event | Trigger |
|---|---|
| `validation.completed` | Verdict published for an issue |
| `validation.failed` | Issue moved to dead-letter queue |

**Payload shape:**

```json
{
  "event": "validation.completed",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "data": {
    "issue_number": 41234,
    "verdict": "valid",
    "rationale": "...",
    "workspace_id": "ws_abc"
  }
}
```

Callbacks use exponential backoff with `WEBHOOK_MAX_RETRIES` attempts. Non-retryable 4xx errors (except 429) are not retried.
