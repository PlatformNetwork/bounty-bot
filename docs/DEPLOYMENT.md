# Deployment

## Docker Compose

The provided `docker-compose.yml` runs bounty-bot as a single container with a persistent SQLite volume.

```bash
docker compose up -d
```

### Container Details

| Property | Value |
|---|---|
| Base image | `node:22-slim` |
| Exposed port | `3235` |
| Data volume | `bounty-bot-data` → `/app/data` |
| Memory limit | 1 GB |
| Memory reservation | 256 MB |
| Restart policy | `unless-stopped` |

### Build Dependencies

The Docker image installs `python3`, `make`, `g++`, and `sqlite3` for native module compilation (`better-sqlite3`).

---

## Environment Variables

Pass environment variables via `docker-compose.yml` environment section, a `.env` file, or `-e` flags.

### Required

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT for reading issues and posting comments/labels |
| `INTER_SERVICE_HMAC_SECRET` | Shared secret for HMAC auth between Atlas and bounty-bot |

### Recommended

| Variable | Description |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | Secret for verifying GitHub webhook signatures |
| `OPENROUTER_API_KEY` | OpenRouter key for LLM scoring (Gemini) and embeddings (Qwen3) |
| `REDIS_URL` | Redis connection URL (default: `redis://localhost:3231`) |
| `ATLAS_WEBHOOK_URL` | Atlas callback endpoint (default: `http://localhost:3230/webhooks`) |

### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3235` | API listen port |
| `DATA_DIR` | `./data` | SQLite data directory |
| `TARGET_REPO` | `PlatformNetwork/bounty-challenge` | GitHub repo (owner/repo) |
| `POLLER_INTERVAL` | `60000` | Missed-webhook poller interval (ms) |
| `MAX_RETRIES` | `3` | Queue retry limit |
| `ISSUE_FLOOR` | `41000` | Minimum issue number to process |
| `SPAM_THRESHOLD` | `0.7` | Spam detection threshold |
| `DUPLICATE_THRESHOLD` | `0.75` | Duplicate detection threshold |
| `REQUEUE_MAX_AGE_MS` | `86400000` | Max issue age for requeue (24 h) |
| `EMBEDDING_MODEL` | `qwen/qwen3-embedding-8b` | OpenRouter embedding model |
| `LLM_SCORING_MODEL` | `google/gemini-3.1-pro-preview-customtools` | OpenRouter scoring model |
| `WEBHOOK_MAX_RETRIES` | `3` | Atlas callback retry attempts |
| `WEBHOOK_RETRY_DELAY_MS` | `1000` | Base callback retry delay (ms) |

---

## Redis Configuration

Bounty-bot uses Redis for distributed locking and idempotency keys. Redis is **optional** — the service starts without it but logs a warning.

### Connection

Default: `redis://localhost:3231`

Override with `REDIS_URL`. The Redis instance can be shared or dedicated.

### Usage

| Feature | Key pattern | TTL |
|---|---|---|
| Bounty lock | `lock:bounty:{issue_number}` | 60 s |
| Queue lock | `lock:queue:{issue_number}` | 300 s |
| Idempotency | `intake:{issue_number}` | 1 h |

### Running Redis alongside bounty-bot

If you need a local Redis for development or if your Docker Compose doesn't include one, add a Redis service:

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "3231:6379"
    command: redis-server --port 6379
    networks:
      - bounty-network
```

Then set `REDIS_URL=redis://redis:6379` in the bounty-bot service environment.

---

## Health Checks

### Docker

The Dockerfile includes a built-in health check:

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3235/health || exit 1
```

The `docker-compose.yml` also defines a health check with the same endpoint and a 10-second start period.

### HTTP Endpoints

| Endpoint | Purpose | Healthy |
|---|---|---|
| `GET /health` | Liveness probe | Always 200 |
| `GET /ready` | Readiness probe | 200 when DB + data dir accessible; 503 otherwise |

### Readiness Checks

The readiness probe verifies:
- Data directory (`DATA_DIR`) is readable and writable
- All registered custom checks pass

---

## Atlas Integration

Bounty-bot is designed as a subordinate service controlled by **Atlas**.

### Communication Flow

```
Atlas → bounty-bot:  HMAC-signed REST API calls (trigger, status, requeue)
bounty-bot → Atlas:  HMAC-signed webhook callbacks (validation.completed/failed)
```

### HMAC Shared Secret

Both services must share the same `INTER_SERVICE_HMAC_SECRET`. The signing protocol:

1. Sender computes `HMAC-SHA256(secret, timestamp + "." + body)` → hex digest
2. Sends `X-Signature: sha256=<hex>` and `X-Timestamp: <epoch_ms>` headers
3. Receiver recomputes and compares with timing-safe equality
4. Requests older than 5 minutes are rejected (replay protection)

### Webhook Callbacks

Bounty-bot sends HMAC-signed POST requests to `ATLAS_WEBHOOK_URL` on:

| Event | When |
|---|---|
| `validation.completed` | Verdict published (valid/invalid/duplicate) |
| `validation.failed` | Issue moved to dead-letter queue |

Callbacks include exponential backoff retries (base delay `WEBHOOK_RETRY_DELAY_MS`, up to `WEBHOOK_MAX_RETRIES` attempts).

### GitHub Webhook Setup

Configure a GitHub webhook on the target repository:

1. **Payload URL:** `https://your-domain:3235/api/v1/webhooks/github`
2. **Content type:** `application/json`
3. **Secret:** same value as `GITHUB_WEBHOOK_SECRET`
4. **Events:** select **Issues** only
5. Bounty-bot only processes `issues.opened` events

---

## Port Allocation

Bounty-bot reserves ports **3235–3239**:

| Port | Purpose |
|---|---|
| 3235 | Primary API |
| 3236–3239 | Reserved for internal services |

Atlas uses ports 3230–3234 separately. The service performs port conflict checks on startup and fails fast if any port in its range is already in use.
