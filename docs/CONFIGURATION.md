# Configuration

All configuration is via environment variables. No config files are read except the `rules/` directory for validation rules.

## Required

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub personal access token for API requests |
| `GITHUB_WEBHOOK_SECRET` | Secret for verifying GitHub webhook signatures |
| `INTER_SERVICE_HMAC_SECRET` | Shared HMAC secret for Atlas <-> bounty-bot auth |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM scoring and embeddings |

## Service

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3235` | API listen port |
| `DATA_DIR` | `./data` | SQLite data directory |
| `SQLITE_PATH` | `<DATA_DIR>/bounty-bot.db` | Database file path |
| `REDIS_URL` | `redis://localhost:3231` | Redis connection URL |

## GitHub

| Variable | Default | Description |
|---|---|---|
| `TARGET_REPO` | `PlatformNetwork/bounty-challenge` | Repository to validate (owner/repo) |
| `ISSUE_FLOOR` | `41000` | Minimum issue number to process |
| `POLLER_INTERVAL` | `60000` | Missed-webhook poller interval (ms) |

## Atlas Integration

| Variable | Default | Description |
|---|---|---|
| `ATLAS_WEBHOOK_URL` | `http://localhost:3230/webhooks` | Atlas callback endpoint |
| `WEBHOOK_MAX_RETRIES` | `3` | Callback retry attempts |
| `WEBHOOK_RETRY_DELAY_MS` | `1000` | Base retry delay (ms) |

## Detection Thresholds

| Variable | Default | Description |
|---|---|---|
| `SPAM_THRESHOLD` | `0.7` | Spam score threshold (0-1) |
| `DUPLICATE_THRESHOLD` | `0.75` | Duplicate similarity threshold (0-1) |
| `REQUEUE_MAX_AGE_MS` | `86400000` | Max issue age for requeue (24h) |
| `MAX_RETRIES` | `3` | Queue retries before dead-lettering |

## LLM Models

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter API endpoint |
| `LLM_SCORING_MODEL` | `google/gemini-3.1-pro-preview-customtools` | Issue evaluation model |
| `EMBEDDING_MODEL` | `qwen/qwen3-embedding-8b` | Semantic embedding model |

## Example .env

```env
# Required
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_WEBHOOK_SECRET=webhook-secret-from-github
INTER_SERVICE_HMAC_SECRET=shared-secret-with-atlas
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxx

# Service
PORT=3235
DATA_DIR=./data
REDIS_URL=redis://localhost:6379

# GitHub
TARGET_REPO=PlatformNetwork/bounty-challenge
ISSUE_FLOOR=41000

# Atlas
ATLAS_WEBHOOK_URL=http://localhost:3230/webhooks

# Thresholds (optional — defaults are tuned)
SPAM_THRESHOLD=0.7
DUPLICATE_THRESHOLD=0.75
```
