/**
 * Agentic code verification + screenshot analysis.
 *
 * Spawns an LLM agent that:
 * 1. Explores the cloned Cortex repo to verify if the bug is real
 * 2. Analyzes screenshots to verify they show actual user-facing bugs
 *    (not code editors, fabricated images, or unrelated content)
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import {
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  LLM_SCORING_MODEL,
  CORTEX_REPO_URL,
  CORTEX_REPO_DIR,
  CODE_VERIFY_MAX_ITERATIONS,
} from "../config.js";
import { logger } from "../logger.js";
import { collectStream } from "./llm-stream.js";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Repo management                                                    */
/* ------------------------------------------------------------------ */

let repoReady = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export async function ensureRepo(): Promise<void> {
  const dir = path.resolve(CORTEX_REPO_DIR);

  if (fs.existsSync(path.join(dir, ".git"))) {
    try {
      await execFileAsync("git", ["-C", dir, "pull", "--ff-only"], {
        timeout: 30_000,
      });
      logger.info({ dir }, "Code-verify: repo updated");
    } catch (err) {
      logger.warn({ err }, "Code-verify: git pull failed, using cached repo");
    }
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", CORTEX_REPO_URL, dir],
      { timeout: 60_000 },
    );
    logger.info({ dir, url: CORTEX_REPO_URL }, "Code-verify: repo cloned");
  }

  repoReady = true;
}

export function startRepoRefreshLoop(): void {
  if (refreshTimer) return;
  ensureRepo().catch((err) =>
    logger.error({ err }, "Code-verify: initial clone failed"),
  );
  refreshTimer = setInterval(
    () =>
      ensureRepo().catch((err) =>
        logger.error({ err }, "Code-verify: refresh failed"),
      ),
    30 * 60 * 1000,
  );
  refreshTimer.unref();
}

/* ------------------------------------------------------------------ */
/*  Sandboxed tool implementations                                     */
/* ------------------------------------------------------------------ */

const BLOCKED_PATTERNS = [
  /\brm\b/, /\bmv\b/, /\bcp\b/, /\bchmod\b/, /\bchown\b/,
  /\bmkdir\b/, /\btouch\b/, /\btee\b/, /[>|].*>/, /\bsudo\b/,
  /\bdd\b/, /\bmkfs\b/, /\bpip\b/, /\bnpm\b/, /\bcurl\b.*-[oO]/, /\bwget\b/,
];

function isCommandSafe(cmd: string): boolean {
  return !BLOCKED_PATTERNS.some((p) => p.test(cmd));
}

async function toolShell(command: string): Promise<string> {
  if (!isCommandSafe(command)) {
    return "ERROR: Command blocked for safety (read-only access).";
  }
  const dir = path.resolve(CORTEX_REPO_DIR);
  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      ["-c", command],
      { cwd: dir, timeout: 10_000, maxBuffer: 512 * 1024 },
    );
    const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : "")).trim();
    return output.length > 3000
      ? output.slice(0, 1400) + "\n...[truncated]...\n" + output.slice(-1400)
      : output || "(no output)";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `ERROR: ${msg.slice(0, 500)}`;
  }
}

async function toolReadFile(
  filePath: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  const dir = path.resolve(CORTEX_REPO_DIR);
  const resolved = path.resolve(dir, filePath);
  if (!resolved.startsWith(dir)) {
    return "ERROR: Path outside repo directory.";
  }
  try {
    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split("\n");
    const start = offset ?? 0;
    const end = start + (limit ?? 200);
    const slice = lines.slice(start, end);
    const header = `[${resolved.replace(dir + "/", "")} lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}]`;
    return `${header}\n${slice.join("\n")}`;
  } catch {
    return `ERROR: Cannot read file "${filePath}".`;
  }
}

async function toolListDir(dirPath: string): Promise<string> {
  const baseDir = path.resolve(CORTEX_REPO_DIR);
  const resolved = path.resolve(baseDir, dirPath || ".");
  if (!resolved.startsWith(baseDir)) {
    return "ERROR: Path outside repo directory.";
  }
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return entries
      .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
      .join("\n");
  } catch {
    return `ERROR: Cannot list directory "${dirPath}".`;
  }
}

/* ------------------------------------------------------------------ */
/*  Screenshot analysis via LLM vision                                 */
/* ------------------------------------------------------------------ */

const VISION_MODEL = "google/gemini-3.1-pro-preview-customtools";

/**
 * Download an image and return as base64 data URL.
 * Uses GitHub token for private-user-images and github.com/user-attachments.
 * Falls back to unauthenticated fetch for public URLs.
 */
async function downloadImageAsBase64(url: string): Promise<string | null> {
  try {
    const needsAuth =
      url.includes("private-user-images.githubusercontent.com") ||
      url.includes("github.com/user-attachments/") ||
      url.includes("user-images.githubusercontent.com");

    const headers: Record<string, string> = {
      Accept: "image/*,*/*",
    };
    if (needsAuth) {
      const { GITHUB_TOKEN } = await import("../config.js");
      if (GITHUB_TOKEN) {
        headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
      }
    }

    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      logger.debug({ url, status: res.status }, "Image download failed");
      return null;
    }

    const contentType = res.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await res.arrayBuffer());

    // Skip if too large (>5MB)
    if (buffer.length > 5 * 1024 * 1024) {
      logger.debug({ url, size: buffer.length }, "Image too large for vision");
      return null;
    }

    const mimeType = contentType.split(";")[0].trim();
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug({ url, err: msg }, "Image download error");
    return null;
  }
}

const SCREENSHOT_SYSTEM_PROMPT = `You are a strict screenshot verification expert for a bug bounty program.
Your job is to determine if a screenshot shows REAL USER EXPERIENCE evidence of a bug.

## VALID screenshots (must show the USER's perspective):
- A terminal/CLI window showing actual Cortex command execution and its output/error
- The user running a command and seeing unexpected behavior
- An application UI displaying a bug visible to end users
- Real CLI output with a shell prompt, typed command, and result

## INVALID screenshots (REJECT immediately):
- Source code in ANY editor (VS Code, vim, nano, Sublime, IntelliJ, etc.)
- Code diffs, git blame, grep output of source files — these show code, NOT user experience
- GitHub file viewer showing .rs/.py/.ts/.go source files
- Documentation pages, README files, or API docs
- Screenshots of code review tools or pull request diffs
- Fabricated, edited, or AI-generated images
- Screenshots from a different product than Cortex
- Screenshots that only show text someone could have typed (no actual CLI execution visible)
- File explorer or directory listings of source code
- Any screenshot where source code is the PRIMARY content

## Key principle:
The screenshot must prove the USER ENCOUNTERED the bug by showing the ACTUAL ERROR/BEHAVIOR.
Showing where in the source code the bug might be is NOT valid evidence — anyone can read code.
The burden of proof is on the submitter to show they ran the command and saw the problem.

Respond with a JSON object:
{"valid": true/false, "reasoning": "1-2 sentences explaining why", "shows": "brief description of what the screenshot actually shows"}`;

async function toolAnalyzeScreenshot(
  url: string,
  bugDescription: string,
  openai: OpenAI,
): Promise<string> {
  try {
    // Download and convert to base64 (handles private GitHub URLs)
    const base64Url = await downloadImageAsBase64(url);
    if (!base64Url) {
      return JSON.stringify({
        valid: false,
        reasoning: "Could not download the screenshot — URL may be broken or private.",
        shows: "inaccessible",
      });
    }

    const stream = await openai.chat.completions.create({
      model: VISION_MODEL,
      messages: [
        { role: "system", content: SCREENSHOT_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Bug description: ${bugDescription.slice(0, 500)}\n\nAnalyze this screenshot:`,
            },
            {
              type: "image_url",
              image_url: { url: base64Url, detail: "high" },
            },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0,
      stream: true,
    });

    const response = await collectStream(stream);
    const content = response.message.content ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0];
    }
    return JSON.stringify({ valid: true, reasoning: "Could not parse vision response", shows: "unknown" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, url }, "Code-verify: screenshot analysis failed");
    return JSON.stringify({ valid: true, reasoning: `Vision analysis failed: ${msg.slice(0, 100)}`, shows: "unknown" });
  }
}

/* ------------------------------------------------------------------ */
/*  Tool definitions (OpenAI format)                                   */
/* ------------------------------------------------------------------ */

const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Execute a read-only shell command in the Cortex repository (grep, rg, find, wc, head, cat, etc.). Max 10s timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute in the repo root" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the Cortex repository with optional offset and line limit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to repo root" },
          offset: { type: "number", description: "Line to start from (0-based, default 0)" },
          limit: { type: "number", description: "Max lines to read (default 200)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories in a path within the Cortex repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to repo root (default: root)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_screenshot",
      description:
        "Analyze a screenshot URL using vision AI to verify it shows a real user-facing bug (not code in an editor). ALWAYS call this for each screenshot URL in the bug report.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The screenshot URL to analyze" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deliver_code_verdict",
      description:
        "Deliver your final verdict. Call this EXACTLY ONCE when you have analyzed both the code AND the screenshots.",
      parameters: {
        type: "object",
        properties: {
          plausible: { type: "boolean", description: "Is the bug plausible given the code AND are the screenshots valid?" },
          confidence: { type: "number", description: "Confidence 0.0-1.0" },
          reasoning: { type: "string", description: "Explanation (2-5 sentences)" },
          code_evidence: { type: "string", description: "Key code snippets found" },
          screenshot_valid: { type: "boolean", description: "Do the screenshots show valid user-facing evidence?" },
          screenshot_reasoning: { type: "string", description: "Why screenshots are valid or invalid" },
        },
        required: ["plausible", "confidence", "reasoning", "screenshot_valid"],
      },
    },
  },
];

/* ------------------------------------------------------------------ */
/*  Agent loop                                                         */
/* ------------------------------------------------------------------ */

export interface CodeVerifyResult {
  plausible: boolean;
  confidence: number;
  reasoning: string;
  codeEvidence?: string;
  screenshotValid?: boolean;
  screenshotReasoning?: string;
}

const SYSTEM_PROMPT = `You are a strict verification agent for a bug bounty program. You have TWO MANDATORY jobs:

## JOB 1: VERIFY THE CODE (MANDATORY)
You have access to the source code of Cortex, a CLI tool written in Rust.
You MUST explore the codebase to verify if the reported bug is real.

Steps:
1. Identify the command/feature mentioned in the bug report
2. Use shell (grep, rg) to find the relevant source files
3. Use read_file to examine the actual implementation
4. Determine if the described bug behavior is plausible given the code

If you CANNOT find the command, flag, or feature in the code -> plausible=false.
If the code shows the behavior is handled correctly -> plausible=false.
If the code confirms the bug could happen -> continue to screenshot verification.

## JOB 2: VERIFY THE SCREENSHOTS (MANDATORY)
You MUST call analyze_screenshot for EVERY screenshot URL in the bug report.
Screenshots MUST show the REAL USER EXPERIENCE — the user actually running the command and seeing the error.

VALID screenshots: terminal/CLI showing typed command + actual output/error from Cortex.
INVALID screenshots: source code in editors, code diffs, grep of source, documentation, fabricated images.

A screenshot of source code is NEVER valid evidence. It only shows someone read the code, not that they experienced the bug.

## STRATEGY (follow this exact order)
1. Extract ALL screenshot URLs from the bug report
2. Call analyze_screenshot for EACH URL — do this FIRST
3. Search the code: rg/grep for the command name, flag, or feature
4. Read the relevant source files
5. Call deliver_code_verdict EXACTLY ONCE with your findings

## VERDICT RULES
- Bug references a command/flag that doesn't exist in Cortex -> plausible=false
- Code shows the behavior is handled correctly -> plausible=false
- Screenshot shows source code instead of CLI output -> screenshot_valid=false, plausible=false
- Screenshot shows real CLI execution with the described error -> screenshot_valid=true
- Code confirms bug AND screenshots show real user experience -> plausible=true
- BOTH code AND screenshot must pass for plausible=true
- When in doubt, reject. The burden of proof is on the submitter.

## IMPORTANT
- You MUST actually explore the code. Do not guess or assume.
- You MUST call analyze_screenshot for every screenshot. Do not skip.
- You MUST call deliver_code_verdict exactly once at the end.`;

export async function verifyCodePlausibility(
  issueNumber: number,
  title: string,
  body: string,
  mediaUrls?: string[],
): Promise<CodeVerifyResult> {
  if (!repoReady) {
    logger.error("Code-verify: repo not ready — cannot verify");
    return { plausible: false, confidence: 0.9, reasoning: "Source code repo not available. Cannot verify bug." };
  }

  if (!OPENROUTER_API_KEY) {
    logger.error("Code-verify: no API key — cannot verify");
    return { plausible: false, confidence: 0.9, reasoning: "No API key configured. Cannot verify bug." };
  }

  const openai = new OpenAI({
    baseURL: OPENROUTER_BASE_URL,
    apiKey: OPENROUTER_API_KEY,
  });

  // Extract screenshot URLs from body for the agent to analyze
  const screenshotUrls = mediaUrls ?? [];
  const screenshotSection = screenshotUrls.length > 0
    ? `\n\n**Screenshot URLs to analyze:**\n${screenshotUrls.map((u, i) => `${i + 1}. ${u}`).join("\n")}\n\nYou MUST call analyze_screenshot for each URL above.`
    : "\n\n**No screenshots found** — this alone may be reason to mark as invalid.";

  const userMessage = `## Bug Report #${issueNumber}

**Title:** ${title}

**Body:**
${body.slice(0, 4000)}
${screenshotSection}

Verify this bug: explore the code AND analyze all screenshots. Then call deliver_code_verdict.`;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  for (let i = 0; i < CODE_VERIFY_MAX_ITERATIONS; i++) {
    let assembled: Awaited<ReturnType<typeof collectStream>>;
    try {
      const stream = await openai.chat.completions.create({
        model: LLM_SCORING_MODEL,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0,
        max_tokens: 2000,
        stream: true,
      });
      assembled = await collectStream(stream);
    } catch (err) {
      logger.error({ err, issueNumber, iteration: i }, "Code-verify: LLM call failed");
      return { plausible: false, confidence: 0.8, reasoning: "Code verification LLM call failed. Cannot confirm bug." };
    }

    const msg = assembled.message;
    messages.push({
      role: "assistant" as const,
      content: msg.content,
      tool_calls: msg.tool_calls.length > 0 ? msg.tool_calls : undefined,
    });

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        const fnName = tc.function.name;
        let fnArgs: Record<string, unknown>;
        try {
          fnArgs = JSON.parse(tc.function.arguments);
        } catch {
          fnArgs = {};
        }

        logger.debug(
          { issueNumber, tool: fnName, iteration: i },
          "Code-verify: tool call",
        );

        if (fnName === "deliver_code_verdict") {
          const result: CodeVerifyResult = {
            plausible: (fnArgs.plausible as boolean) ?? true,
            confidence: (fnArgs.confidence as number) ?? 0.5,
            reasoning: (fnArgs.reasoning as string) ?? "No reasoning.",
            codeEvidence: fnArgs.code_evidence as string | undefined,
            screenshotValid: fnArgs.screenshot_valid as boolean | undefined,
            screenshotReasoning: fnArgs.screenshot_reasoning as string | undefined,
          };

          logger.info(
            {
              issueNumber,
              plausible: result.plausible,
              confidence: result.confidence,
              screenshotValid: result.screenshotValid,
            },
            "Code-verify: verdict delivered",
          );

          return result;
        }

        let toolResult: string;
        if (fnName === "analyze_screenshot") {
          toolResult = await toolAnalyzeScreenshot(
            fnArgs.url as string,
            `${title}\n${body.slice(0, 500)}`,
            openai,
          );
        } else if (fnName === "shell") {
          toolResult = await toolShell(fnArgs.command as string);
        } else if (fnName === "read_file") {
          toolResult = await toolReadFile(
            fnArgs.path as string,
            fnArgs.offset as number | undefined,
            fnArgs.limit as number | undefined,
          );
        } else if (fnName === "list_dir") {
          toolResult = await toolListDir((fnArgs.path as string) ?? ".");
        } else {
          toolResult = `ERROR: Unknown tool "${fnName}"`;
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
      continue;
    }

    if (!msg.content) {
      messages.push({
        role: "user",
        content: "Continue investigating. Call deliver_code_verdict when ready.",
      });
      continue;
    }

    break;
  }

  logger.warn({ issueNumber }, "Code-verify: agent did not deliver verdict");
  return {
    plausible: false,
    confidence: 0.8,
    reasoning: "Verification agent exhausted iterations without delivering a verdict. Bug unverified.",
  };
}
