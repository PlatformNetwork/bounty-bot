/**
 * Cheater-flag API routes.
 *
 * Allows Atlas (or other authenticated callers) to flag an issue as
 * suspected cheating and to retrieve existing flags for an issue.
 *
 * Routes:
 *   POST /api/v1/validation/:issue/flag   — create a new flag
 *   GET  /api/v1/validation/:issue/flags  — list flags for an issue
 */

import { Router } from "express";
import { hmacAuthMiddleware } from "./middleware.js";
import { getBountyDb } from "../db/index.js";

const router = Router();

/** Row returned when querying the `cheater_flags` table. */
export interface CheaterFlagRow {
  id: number;
  issue_number: number;
  reason: string;
  flagged_by: string | null;
  flagged_at: string | null;
}

// POST /api/v1/validation/:issue/flag
router.post("/:issue/flag", hmacAuthMiddleware, (req, res) => {
  const issueNumber = parseInt(req.params.issue, 10);
  if (isNaN(issueNumber)) {
    res
      .status(400)
      .json({ error: "bad_request", message: "Invalid issue number" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const reason = body.reason as string | undefined;
  const flaggedBy = (body.flagged_by as string) || "unknown";

  if (!reason) {
    res
      .status(400)
      .json({ error: "bad_request", message: "Reason is required" });
    return;
  }

  const db = getBountyDb();
  const stmt = db.prepare(
    "INSERT INTO cheater_flags (issue_number, reason, flagged_by, flagged_at) VALUES (?, ?, ?, ?)",
  );
  stmt.run(issueNumber, reason, flaggedBy, new Date().toISOString());

  res.json({ status: "flagged", issue_number: issueNumber });
});

// GET /api/v1/validation/:issue/flags
router.get("/:issue/flags", hmacAuthMiddleware, (req, res) => {
  const issueNumber = parseInt(req.params.issue, 10);
  if (isNaN(issueNumber)) {
    res
      .status(400)
      .json({ error: "bad_request", message: "Invalid issue number" });
    return;
  }

  const db = getBountyDb();
  const flags = db
    .prepare("SELECT * FROM cheater_flags WHERE issue_number = ?")
    .all(issueNumber) as CheaterFlagRow[];

  res.json({ issue_number: issueNumber, flags });
});

export default router;
