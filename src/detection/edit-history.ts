/**
 * Edit history fraud detection.
 *
 * Analyses GitHub issue events to detect suspicious editing patterns
 * such as rapid multiple edits, evidence added after creation, and
 * title changes that may indicate fraud.
 */

import { logger } from "../logger.js";
import { TARGET_REPO } from "../config.js";
import { getIssueEvents } from "../github/client.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface EditEntry {
  field: string;
  editedAt: string;
  suspicious: boolean;
}

export interface EditAnalysis {
  suspicious: boolean;
  fraudScore: number;
  edits: EditEntry[];
  details: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Events that indicate content modifications. */
const EDIT_EVENTS = new Set(["renamed", "edited"]);

/** Time window (ms) for "rapid edit" detection: 5 minutes. */
const RAPID_EDIT_WINDOW_MS = 5 * 60 * 1000;

/** Minimum number of edits in rapid window to flag as suspicious. */
const RAPID_EDIT_THRESHOLD = 3;

/* ------------------------------------------------------------------ */
/*  Analysis helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Parse target repo into owner/repo.
 */
function parseRepo(): { owner: string; repo: string } {
  const parts = TARGET_REPO.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid TARGET_REPO format: "${TARGET_REPO}"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Analyse the edit history of a GitHub issue for fraud indicators.
 *
 * Checks for:
 * - Title renames
 * - Body edits
 * - Multiple edits in short time windows (rapid edits)
 * - Evidence added after initial creation
 *
 * @param owner - Repository owner (unused, uses TARGET_REPO)
 * @param repo - Repository name (unused, uses TARGET_REPO)
 * @param issueNumber - GitHub issue number to analyse
 * @returns EditAnalysis with fraud score and edit details
 */
export async function analyzeEditHistory(
  _owner: string,
  _repo: string,
  issueNumber: number,
): Promise<EditAnalysis> {
  const { owner, repo } = parseRepo();
  const edits: EditEntry[] = [];
  let fraudScore = 0;
  const details: string[] = [];

  let events: Array<{
    event: string;
    created_at: string;
    actor: { login: string } | null;
  }>;

  try {
    events = await getIssueEvents(owner, repo, issueNumber);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { issueNumber, err: msg },
      "Edit history: failed to fetch events",
    );
    return {
      suspicious: false,
      fraudScore: 0,
      edits: [],
      details: `Failed to fetch events: ${msg}`,
    };
  }

  // Collect edit events
  const editEvents: Array<{ event: string; created_at: string }> = [];

  for (const event of events) {
    if (EDIT_EVENTS.has(event.event)) {
      const field = event.event === "renamed" ? "title" : "body";
      const editedAt = event.created_at;

      editEvents.push({ event: event.event, created_at: editedAt });

      edits.push({
        field,
        editedAt,
        suspicious: false, // Will be set below
      });
    }
  }

  if (edits.length === 0) {
    return {
      suspicious: false,
      fraudScore: 0,
      edits: [],
      details: "No edits detected",
    };
  }

  details.push(`${edits.length} edit(s) detected`);

  // Check for rapid edits (multiple edits within RAPID_EDIT_WINDOW_MS)
  const editTimestamps = editEvents
    .map((e) => new Date(e.created_at).getTime())
    .sort((a, b) => a - b);

  let rapidEditCount = 0;
  for (let i = 1; i < editTimestamps.length; i++) {
    if (editTimestamps[i] - editTimestamps[i - 1] < RAPID_EDIT_WINDOW_MS) {
      rapidEditCount++;
    }
  }

  if (rapidEditCount >= RAPID_EDIT_THRESHOLD - 1) {
    fraudScore += 0.4;
    details.push(
      `Rapid edits detected: ${rapidEditCount + 1} edits in quick succession`,
    );

    // Mark rapid edits as suspicious
    for (const edit of edits) {
      edit.suspicious = true;
    }
  }

  // Check for title renames (often indicates content pivoting)
  const titleRenames = edits.filter((e) => e.field === "title");
  if (titleRenames.length > 0) {
    fraudScore += 0.2 * Math.min(titleRenames.length, 3);
    details.push(`${titleRenames.length} title rename(s)`);
    for (const edit of titleRenames) {
      edit.suspicious = true;
    }
  }

  // Check for body edits (may indicate evidence tampering)
  const bodyEdits = edits.filter((e) => e.field === "body");
  if (bodyEdits.length > 2) {
    fraudScore += 0.2;
    details.push(
      `${bodyEdits.length} body edit(s) — possible evidence tampering`,
    );
    for (const edit of bodyEdits) {
      edit.suspicious = true;
    }
  }

  // Cap score at 1.0
  fraudScore = Math.min(1, fraudScore);

  const suspicious = fraudScore > 0.5;

  logger.info(
    { issueNumber, fraudScore: fraudScore.toFixed(2), editCount: edits.length },
    "Edit history analysis complete",
  );

  return {
    suspicious,
    fraudScore,
    edits,
    details: details.join("; "),
  };
}
