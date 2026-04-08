/**
 * Bounty-bot: GitHub bounty validation service.
 * Controlled by Atlas via REST API with HMAC authentication.
 *
 * Port allocation: 3235 (API), 3236-3239 (internal services).
 */

import express from "express";
import fs from "fs";
import path from "path";

import { logger } from "./logger.js";
import { DATA_DIR, SERVICE_NAME, TARGET_REPO } from "./config.js";
import { checkPortConflicts, getApiPort } from "./port-check.js";
import {
  mountHealthRoutes,
  setReady,
  registerReadinessCheck,
} from "./health-server.js";
import { initBountyDb, getBounty, getLatestValidation } from "./db/index.js";
import { hmacAuthMiddleware } from "./api/middleware.js";
import { webhookRouter } from "./api/webhooks.js";
import { initRedis, disconnectRedis } from "./redis.js";
import {
  normalizeIssue,
  shouldProcess,
  processIntake,
} from "./validation/intake.js";
import { startPoller, stopPoller } from "./validation/poller.js";
import { startQueueProcessor, stopQueueProcessor } from "./queue/processor.js";
import {
  startRequeueRecovery,
  stopRequeueRecovery,
} from "./queue/requeue-recovery.js";
import { getIssue } from "./github/client.js";
import { handleRequeue, handleForceRelease } from "./api/requeue.js";
import flagRouter from "./api/flag.js";
import {
  getProcessingStatus,
  getDeadLetterList,
  recoverDeadLetterItem,
} from "./api/status.js";
import { loadRules } from "./rules/index.js";

/**
 * Ensure the data directory exists for SQLite persistence.
 */
function ensureDataDir(): void {
  const dataDir = path.resolve(DATA_DIR);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    logger.info({ dataDir }, "Created data directory");
  }
}

/**
 * Create and configure the Express application.
 */
export function createApp(): express.Express {
  const app = express();

  // Body parsing
  app.use(express.json());

  // Mount health/readiness endpoints
  mountHealthRoutes(app);

  // GitHub webhook routes (use GitHub's own signature — NO HMAC middleware)
  app.use("/api/v1/webhooks", webhookRouter);

  // Cheater-flag routes (HMAC auth applied per-route inside the router)
  app.use("/api/v1/validation", flagRouter);

  // API v1 routes with HMAC authentication
  const apiRouter = express.Router();
  apiRouter.use(hmacAuthMiddleware);

  // POST /api/v1/validation/trigger — trigger validation for an issue
  apiRouter.post("/validation/trigger", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const issueNumber = body.issue_number as number | undefined;

    if (!issueNumber || typeof issueNumber !== "number") {
      res
        .status(400)
        .json({
          error: "bad_request",
          message: "issue_number is required (number)",
        });
      return;
    }

    const parts = TARGET_REPO.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      res
        .status(500)
        .json({ error: "config_error", message: "Invalid TARGET_REPO" });
      return;
    }

    getIssue(parts[0], parts[1], issueNumber)
      .then((ghIssue) => {
        const normalized = normalizeIssue(
          ghIssue as unknown as Record<string, unknown>,
        );
        const check = shouldProcess(normalized);

        if (!check.process) {
          res.status(200).json({ status: "skipped", reason: check.reason });
          return;
        }

        return processIntake(normalized).then((result) => {
          res.status(result.queued ? 202 : 200).json({
            status: result.queued ? "queued" : "skipped",
            reason: result.reason,
            issueNumber,
          });
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ issueNumber, err: msg }, "Validation trigger failed");
        res.status(500).json({ error: "trigger_failed", message: msg });
      });
  });

  // GET /api/v1/validation/:issue_number/status — get current bounty status
  apiRouter.get("/validation/:issue_number/status", (req, res) => {
    const issueNumber = parseInt(req.params.issue_number, 10);
    if (isNaN(issueNumber)) {
      res
        .status(400)
        .json({ error: "bad_request", message: "Invalid issue_number" });
      return;
    }

    const status = getProcessingStatus(issueNumber);
    if (!status) {
      res
        .status(404)
        .json({
          error: "not_found",
          message: `No bounty found for issue #${issueNumber}`,
        });
      return;
    }

    // Also fetch full bounty + validation for backward-compatible response
    const bounty = getBounty(issueNumber);
    const validation = getLatestValidation(issueNumber);

    res.status(200).json({
      issueNumber,
      status: status.status,
      retryCount: status.retryCount,
      verdict: status.verdict,
      queuePosition: status.queuePosition ?? null,
      validation: validation
        ? {
            verdict: validation.verdict,
            rationale: validation.rationale,
            spamScore: validation.spam_score,
            duplicateOf: validation.duplicate_of,
            createdAt: validation.created_at,
          }
        : null,
      updatedAt: bounty?.updated_at ?? status.lastUpdated,
    });
  });

  // POST /api/v1/validation/:issue_number/requeue — requeue for re-validation
  apiRouter.post("/validation/:issue_number/requeue", (req, res) => {
    const issueNumber = parseInt(req.params.issue_number, 10);
    if (isNaN(issueNumber)) {
      res
        .status(400)
        .json({ error: "bad_request", message: "Invalid issue_number" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const requesterId = (body.requester_id as string) || "unknown";
    const requesterContext = body.requester_context as object | undefined;

    handleRequeue(issueNumber, requesterId, requesterContext)
      .then((result) => {
        if (result.success) {
          res.status(202).json({ status: "requeued", issueNumber });
        } else {
          res
            .status(422)
            .json({ error: "requeue_rejected", message: result.error });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ issueNumber, err: msg }, "Requeue endpoint failed");
        res.status(500).json({ error: "requeue_failed", message: msg });
      });
  });

  // POST /api/v1/validation/:issue_number/force-release — force-release lock
  apiRouter.post("/validation/:issue_number/force-release", (req, res) => {
    const issueNumber = parseInt(req.params.issue_number, 10);
    if (isNaN(issueNumber)) {
      res
        .status(400)
        .json({ error: "bad_request", message: "Invalid issue_number" });
      return;
    }

    handleForceRelease(issueNumber)
      .then((result) => {
        if (result.success) {
          res.status(200).json({ status: "released", issueNumber });
        } else {
          res
            .status(500)
            .json({ error: "release_failed", message: result.error });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(
          { issueNumber, err: msg },
          "Force-release endpoint failed",
        );
        res.status(500).json({ error: "release_failed", message: msg });
      });
  });

  // GET /api/v1/dead-letter — list dead-letter items
  apiRouter.get("/dead-letter", (_req, res) => {
    const items = getDeadLetterList();
    res.status(200).json({ items });
  });

  // POST /api/v1/dead-letter/:id/recover — recover a dead-letter item
  apiRouter.post("/dead-letter/:id/recover", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid id" });
      return;
    }

    const result = recoverDeadLetterItem(id);
    if (result.success) {
      res.status(202).json({ status: "recovered", id });
    } else {
      res.status(404).json({ error: "not_found", message: result.error });
    }
  });

  // POST /api/v1/rules/reload — hot-reload rules from disk
  apiRouter.post("/rules/reload", (_req, res) => {
    import("./rules/index.js")
      .then((mod) => mod.reloadRules())
      .then((reloaded) => {
        logger.info({ count: reloaded.length }, "Rules hot-reloaded");
        res.status(200).json({
          status: "reloaded",
          count: reloaded.length,
          rules: reloaded.map((r) => ({
            id: r.id,
            category: r.category,
            severity: r.severity,
            enabled: r.enabled !== false,
          })),
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, "Rules reload failed");
        res.status(500).json({ error: "reload_failed", message: msg });
      });
  });

  // GET /api/v1/rules — list loaded rules
  apiRouter.get("/rules", (_req, res) => {
    import("./rules/index.js")
      .then((mod) => {
        const rules = mod.getRules();
        res.status(200).json({
          count: rules.length,
          rules: rules.map((r) => ({
            id: r.id,
            category: r.category,
            severity: r.severity,
            description: r.description,
            enabled: r.enabled !== false,
            weight: r.weight ?? 1.0,
          })),
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: "rules_error", message: msg });
      });
  });

  app.use("/api/v1", apiRouter);

  return app;
}

/**
 * Start the bounty-bot service.
 */
async function main(): Promise<void> {
  logger.info(`Starting ${SERVICE_NAME}...`);

  // Fail fast on port conflicts within bounty-bot allocation (3235-3239)
  await checkPortConflicts();

  // Ensure data directory exists for SQLite
  ensureDataDir();

  // Initialise SQLite database and schema before readiness checks
  initBountyDb();

  // Initialize Redis connection
  try {
    await initRedis();
    logger.info("Redis initialized");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: msg },
      "Redis initialization failed — continuing without Redis",
    );
  }

  const port = getApiPort();
  const app = createApp();

  // Start HTTP server
  const server = app.listen(port, "0.0.0.0", () => {
    logger.info({ port }, `${SERVICE_NAME} API listening`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.fatal(
        { port },
        `Port ${port} already in use - cannot start ${SERVICE_NAME}`,
      );
      process.exit(1);
    }
    logger.fatal({ err, port }, "Server error");
    process.exit(1);
  });

  // Register readiness checks
  registerReadinessCheck(() => {
    // Verify data directory is accessible
    try {
      const dataDir = path.resolve(DATA_DIR);
      fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });

  // Load validation rules from rules/*.ts
  const rules = await loadRules();
  logger.info({ count: rules.length }, "Validation rules loaded");

  // Start background services
  startPoller();
  startQueueProcessor();
  startRequeueRecovery();

  // Mark as ready
  setReady(true);
  logger.info(`${SERVICE_NAME} ready`);

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    setReady(false);
    stopPoller();
    stopQueueProcessor();
    stopRequeueRecovery();
    disconnectRedis().catch(() => {});
    server.close(() => {
      logger.info(`${SERVICE_NAME} shut down`);
      process.exit(0);
    });
    // Force exit after timeout
    setTimeout(() => {
      logger.warn("Forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, `Failed to start ${SERVICE_NAME}`);
    process.exit(1);
  });
}
