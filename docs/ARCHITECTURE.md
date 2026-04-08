# Architecture

## Module Graph

```mermaid
graph TB
    subgraph Entrypoints
        IDX[index.ts<br/>Express app]
        WH[api/webhooks.ts<br/>GitHub webhook]
    end

    subgraph API Layer
        MW[api/middleware.ts<br/>HMAC auth]
        RQ[api/requeue.ts<br/>Requeue + force-release]
        ST[api/status.ts<br/>Status + dead-letter]
    end

    subgraph Validation
        INT[validation/intake.ts<br/>Normalize + filter]
        PIPE[validation/pipeline.ts<br/>Orchestrator]
        MED[validation/media.ts<br/>URL + HEAD checks]
        VER[validation/verdict.ts<br/>Publish verdict]
        POL[validation/poller.ts<br/>Missed webhooks]
    end

    subgraph Detection
        SP[detection/spam.ts<br/>Template + burst + parity]
        DUP[detection/duplicate.ts<br/>Jaccard + cosine hybrid]
        EH[detection/edit-history.ts<br/>Fraud detection]
        EMB[detection/embeddings.ts<br/>Qwen3 via OpenRouter]
        LLM[detection/llm-scorer.ts<br/>Gemini 3.1 Pro]
    end

    subgraph Queue
        PROC[queue/processor.ts<br/>Retry loop]
        DL[queue/dead-letter.ts<br/>Dead-letter mgmt]
        RR[queue/requeue-recovery.ts<br/>Resolve requeues]
    end

    subgraph Infrastructure
        CFG[config.ts]
        DB[db/schema.ts + index.ts<br/>SQLite]
        RD[redis.ts<br/>Locking + idempotency]
        GHC[github/client.ts<br/>Fetch-based]
        GHM[github/mutations.ts<br/>Labels + comments]
        HMAC[hmac.ts<br/>HMAC-SHA256]
        WC[webhook-client.ts<br/>Atlas callbacks]
        LOG[logger.ts]
        HS[health-server.ts]
    end

    IDX --> MW --> RQ & ST
    IDX --> WH
    IDX --> HS
    WH --> INT
    POL --> INT
    RQ --> PROC
    INT --> DB & RD
    PROC --> PIPE
    PIPE --> MED & SP & DUP & EH & LLM
    DUP --> EMB
    SP --> GHC
    EH --> GHC
    PIPE --> GHC
    PIPE --> VER
    VER --> GHM & DB & WC
    PROC --> DL
    DL --> DB & WC
    RR --> DB & WC
    WC --> HMAC
```

## Sequence Diagram — Webhook to Verdict

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant WH as Webhook Router
    participant INT as Intake
    participant RD as Redis
    participant DB as SQLite
    participant Q as Queue Processor
    participant PIPE as Pipeline
    participant MED as Media Check
    participant SP as Spam Detector
    participant DUP as Duplicate Detector
    participant EH as Edit History
    participant LLM as LLM Scorer
    participant VER as Verdict Engine
    participant ATL as Atlas

    GH->>WH: POST /api/v1/webhooks/github (issues.opened)
    WH->>WH: Verify X-Hub-Signature-256
    WH->>INT: normalizeIssue + shouldProcess
    INT->>INT: Filter (issue ≥ #41000, no terminal labels)
    INT->>RD: acquireLock(bounty:{n})
    INT->>RD: checkIdempotencyKey
    INT->>DB: upsertBounty(pending)
    INT->>RD: setIdempotencyKey
    INT->>RD: releaseLock
    WH-->>GH: 202 Accepted

    Note over Q: Queue processor loop (5 s interval)
    Q->>RD: acquireLock(queue:{n})
    Q->>DB: lockBounty → in_progress
    Q->>PIPE: runValidationPipeline(n)

    PIPE->>GH: getIssue(n)
    PIPE->>MED: validateMedia(body)
    MED->>MED: extractURLs + HEAD requests
    MED-->>PIPE: hasMedia, accessible

    PIPE->>SP: analyzeSpam(issue)
    SP->>GH: listRecentIssues (2 h window)
    SP->>SP: template + burst + parity scores
    SP-->>PIPE: overallScore

    alt Borderline spam (0.3–0.7)
        PIPE->>LLM: scoreSpamLikelihood
        LLM-->>PIPE: blended score
    end

    PIPE->>DUP: findDuplicates(issue)
    DUP->>DB: getAllEmbeddings
    DUP->>DUP: Jaccard similarity
    opt Embeddings available
        DUP->>DUP: cosine similarity → hybrid 0.4J + 0.6C
    end
    DUP->>DB: upsertEmbedding
    DUP-->>PIPE: isDuplicate, similarity

    PIPE->>EH: analyzeEditHistory(n)
    EH->>GH: getIssueEvents(n)
    EH->>EH: rapid edits, title renames, body edits
    EH-->>PIPE: fraudScore

    PIPE->>LLM: scoreIssueValidity (final gate)
    LLM->>LLM: Gemini deliver_verdict function call
    LLM-->>PIPE: score, reasoning

    PIPE-->>Q: VerdictResult
    Q->>VER: publishVerdict(n, result)
    VER->>GH: applyVerdict (labels + comment + close/reopen)
    VER->>DB: insertValidationResult
    VER->>DB: updateBountyStatus(completed)
    VER->>ATL: webhook callback (validation.completed)
    VER->>DB: insertAuditLog

    Q->>DB: unlockBounty
    Q->>RD: releaseLock
```

## Database Schema

Bounty-bot uses **SQLite** (via `better-sqlite3`) with 8 tables:

### bounties

Primary tracking table — one row per GitHub issue under validation.

| Column | Type | Notes |
|---|---|---|
| `issue_number` | INTEGER PK | GitHub issue number |
| `workspace_id` | TEXT UNIQUE | External workspace reference |
| `repo` | TEXT | owner/repo |
| `title` | TEXT | Issue title |
| `body` | TEXT | Issue body |
| `author` | TEXT | GitHub login |
| `created_at` | TEXT | ISO timestamp |
| `status` | TEXT | `pending` → `in_progress` → `completed` / `dead_lettered` |
| `verdict` | TEXT | `valid` / `invalid` / `duplicate` |
| `labels` | TEXT | Comma-separated label names |
| `locked_by` | TEXT | Lock owner identifier |
| `locked_at` | TEXT | Lock acquisition time |
| `lock_expires_at` | TEXT | Lock expiry time |
| `retry_count` | INTEGER | Current retry attempt |
| `max_retries` | INTEGER | Configured max (default 3) |
| `updated_at` | TEXT | Last modification |

### validation_results

Verdicts produced by the validation pipeline.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `issue_number` | INTEGER FK | → bounties |
| `workspace_id` | TEXT | |
| `verdict` | TEXT | `valid` / `invalid` / `duplicate` |
| `rationale` | TEXT | Human-readable explanation |
| `evidence` | TEXT | JSON blob |
| `spam_score` | REAL | 0–1 |
| `duplicate_of` | INTEGER | Original issue number |
| `media_check` | TEXT | JSON blob |
| `created_at` | TEXT | |

### spam_analysis

Per-issue spam scoring breakdown.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `issue_number` | INTEGER | |
| `template_score` | REAL | Jaccard similarity to author's recent issues |
| `burst_score` | REAL | Submission frequency score |
| `parity_score` | REAL | Content quality score |
| `overall_score` | REAL | Weighted combination |
| `details` | TEXT | Human-readable breakdown |
| `created_at` | TEXT | |

### embeddings

Vector fingerprints for duplicate detection.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `issue_number` | INTEGER UNIQUE | |
| `title_fingerprint` | TEXT | SHA-256 of title n-grams |
| `body_fingerprint` | TEXT | Combined title+body text |
| `embedding_vector` | BLOB | JSON-encoded float array (Qwen3) |
| `created_at` | TEXT | |

### requeue_records

Manual or automated re-validation requests.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `issue_number` | INTEGER FK | → bounties |
| `requester_id` | TEXT | Who requested the requeue |
| `requester_context` | TEXT | JSON context |
| `status` | TEXT | `pending` → `completed` |
| `requeued_at` | TEXT | |
| `completed_at` | TEXT | |
| `callback_sent` | INTEGER | 0/1 |

### dead_letter

Bounties that exhausted all retry attempts.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `bounty_id` | INTEGER | Issue number |
| `failure_cause` | TEXT | Error message |
| `last_attempt` | TEXT | |
| `metadata` | TEXT | JSON blob |
| `retry_count` | INTEGER | |
| `created_at` | TEXT | |

### delivery_log

Digest delivery de-duplication (workspace + window).

### audit_log

Immutable action trail — every verdict, requeue, dead-letter, and force-release is logged.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `workspace_id` | TEXT | |
| `action` | TEXT | e.g. `verdict.valid`, `bounty.requeued` |
| `actor` | TEXT | `bounty-bot`, requester ID, or `system` |
| `details` | TEXT | JSON blob |
| `github_ref` | TEXT | e.g. `#41234` |
| `discord_ref` | TEXT | |
| `created_at` | TEXT | |

## Queue System

Bounty-bot uses an **in-memory queue** backed by Redis distributed locking and SQLite persistence:

1. **Intake** normalises and filters the issue, acquires a Redis lock, checks idempotency, and upserts into `bounties` with status `pending`.
2. **Queue Processor** runs on a 5-second interval. It shifts an entry from the in-memory queue, acquires a Redis lock (`lock:queue:{n}`), locks the bounty row in SQLite, and runs the full validation pipeline.
3. **Retries** — on pipeline failure, the entry is re-enqueued with an incremented `retryCount`. After `MAX_RETRIES` (default 3), the issue moves to the **dead-letter** queue.
4. **Dead Letter** — inserts into the `dead_letter` table, updates bounty status to `dead_lettered`, sends a `validation.failed` webhook to Atlas, and logs to the audit trail. Dead-lettered items can be manually recovered via the REST API.
5. **Requeue Recovery** — a 30-second interval scheduler checks pending requeue records. When the underlying bounty reaches a terminal status (`completed` or `dead_lettered`), it marks the requeue record as completed and sends a `validation.completed` callback to Atlas.
6. **Poller** — runs on a configurable interval (default 60 s) to catch issues that were opened while the webhook endpoint was unreachable. Fetches recent issues from the GitHub API and passes them through the intake pipeline.
