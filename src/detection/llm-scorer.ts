/**
 * LLM-assisted issue evaluation via OpenRouter.
 *
 * Uses Gemini 3.1 Pro Preview Custom Tools — a variant optimized for
 * reliable function calling that avoids generic bash-tool overuse and
 * correctly selects user-defined tools like `deliver_verdict`.
 *
 * The LLM agent acts as a senior bounty reviewer: it analyzes the issue
 * content, explains its reasoning step by step, then calls
 * `deliver_verdict` with a structured recap and final decision.
 */

import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/index.js";

import { logger } from "../logger.js";
import {
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  LLM_SCORING_MODEL,
} from "../config.js";

/* ------------------------------------------------------------------ */
/*  Client singleton                                                   */
/* ------------------------------------------------------------------ */

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
    });
  }
  return client;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type LLMVerdict = "valid" | "invalid" | "duplicate";

export interface LLMEvaluationResult {
  verdict: LLMVerdict;
  confidence: number;
  recap: string;
  reasoning: string;
  available: boolean;
}

export interface LLMScoreResult {
  score: number;
  reasoning: string;
}

/* ------------------------------------------------------------------ */
/*  Tool definition for function calling                               */
/* ------------------------------------------------------------------ */

const DELIVER_VERDICT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "deliver_verdict",
    description:
      "Deliver the final verdict on a bug bounty issue after analysis. " +
      "You MUST call this function exactly once at the end of your analysis.",
    parameters: {
      type: "object",
      required: ["reasoning", "recap", "verdict", "confidence"],
      properties: {
        reasoning: {
          type: "string",
          description:
            "Step-by-step explanation of WHY you reached this verdict. " +
            "Cover: issue clarity, reproducibility evidence, media quality, " +
            "spam indicators, and similarity to known issues.",
        },
        recap: {
          type: "string",
          description:
            "A short 2-3 sentence summary of the issue and your findings, " +
            "suitable for posting as a public comment.",
        },
        verdict: {
          type: "string",
          enum: ["valid", "invalid", "duplicate"],
          description:
            'Your final decision: "valid" if the issue is a genuine, ' +
            'well-documented bug; "invalid" if it is spam, low-effort, ' +
            'missing evidence, or not a real bug; "duplicate" if it ' +
            "substantially overlaps an existing reported issue.",
        },
        confidence: {
          type: "number",
          description:
            "How confident you are in this verdict, from 0.0 (uncertain) to 1.0 (certain).",
        },
      },
    },
  },
};

/* ------------------------------------------------------------------ */
/*  System prompt — sourced from src/prompts/issue-evaluation.ts       */
/* ------------------------------------------------------------------ */

import { ISSUE_EVALUATION_PROMPT } from "../prompts/issue-evaluation.js";
import { collectStream } from "./llm-stream.js";

/* ------------------------------------------------------------------ */
/*  Full issue evaluation (function calling)                           */
/* ------------------------------------------------------------------ */

/**
 * Run a full LLM evaluation of a bounty issue.
 *
 * Prompt: src/prompts/issue-evaluation.ts
 * Model: Gemini 3.1 Pro Preview Custom Tools (function calling)
 */
export async function evaluateIssue(issue: {
  title: string;
  body: string;
  mediaUrls: string[];
  similarIssues?: Array<{ number: number; title: string; similarity: number }>;
  issueNumber?: number;
  author?: string;
  mediaAccessible?: boolean;
  spamScore?: number;
}): Promise<LLMEvaluationResult> {
  if (!OPENROUTER_API_KEY) {
    return {
      verdict: "invalid",
      confidence: 0,
      recap: "LLM evaluation unavailable (no API key)",
      reasoning: "Skipped — no OPENROUTER_API_KEY configured",
      available: false,
    };
  }

  const userMessage = ISSUE_EVALUATION_PROMPT.buildUserMessage({
    title: issue.title,
    body: issue.body.slice(0, 6000),
    mediaUrls: issue.mediaUrls,
    mediaAccessible: issue.mediaAccessible,
    similarIssues: issue.similarIssues,
    spamScore: issue.spamScore,
    issueNumber: issue.issueNumber,
    author: issue.author,
  });

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stream = await getClient().chat.completions.create({
        model: LLM_SCORING_MODEL,
        messages: [
          { role: "system", content: ISSUE_EVALUATION_PROMPT.system },
          { role: "user", content: userMessage },
        ],
        tools: [DELIVER_VERDICT_TOOL],
        tool_choice: { type: "function", function: { name: "deliver_verdict" } },
        temperature: 0,
        max_tokens: 1500,
        stream: true,
      });

      const response = await collectStream(stream);
      const toolCall = response.message.tool_calls?.[0];
      if (
        !toolCall ||
        toolCall.function.name !== "deliver_verdict"
      ) {
        logger.warn(
          { attempt },
          "LLM did not call deliver_verdict — retrying",
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, BASE_DELAY_MS * attempt));
          continue;
        }
        return {
          verdict: "invalid",
          confidence: 0,
          recap: "LLM did not produce a structured verdict after retries",
          reasoning: response.message.content ?? "No response",
          available: false,
        };
      }

      const args = JSON.parse(toolCall.function.arguments);
      const verdict = (["valid", "invalid", "duplicate"] as const).includes(
        args.verdict,
      )
        ? (args.verdict as LLMVerdict)
        : "valid";
      const confidence =
        typeof args.confidence === "number"
          ? Math.max(0, Math.min(1, args.confidence))
          : 0.5;

      logger.info(
        {
          verdict,
          confidence: confidence.toFixed(2),
          recap: (args.recap ?? "").slice(0, 100),
          attempt,
        },
        "LLM evaluation complete",
      );

      return {
        verdict,
        confidence,
        recap: typeof args.recap === "string" ? args.recap : "",
        reasoning: typeof args.reasoning === "string" ? args.reasoning : "",
        available: true,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err: msg, attempt, maxRetries: MAX_RETRIES },
        `LLM evaluation failed (attempt ${attempt}/${MAX_RETRIES})`,
      );
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * attempt));
        continue;
      }
      return {
        verdict: "invalid",
        confidence: 0,
        recap: `LLM evaluation failed after ${MAX_RETRIES} attempts: ${msg}`,
        reasoning: `Error after ${MAX_RETRIES} retries: ${msg}`,
        available: false,
      };
    }
  }

  return {
    verdict: "invalid",
    confidence: 0,
    recap: "LLM evaluation exhausted all retries",
    reasoning: "All retry attempts failed",
    available: false,
  };
}

/* ------------------------------------------------------------------ */
/*  Simplified scoring helpers (backwards compat)                      */
/* ------------------------------------------------------------------ */

/**
 * Score how likely an issue is valid (0-1, or -1 if unavailable).
 */
export async function scoreIssueValidity(issue: {
  title: string;
  body: string;
  mediaUrls: string[];
  similarIssues?: Array<{ number: number; title: string; similarity: number }>;
}): Promise<LLMScoreResult> {
  const result = await evaluateIssue(issue);
  if (!result.available) {
    return { score: -1, reasoning: result.reasoning };
  }
  const score =
    result.verdict === "valid" ? result.confidence : 1 - result.confidence;
  return { score, reasoning: result.reasoning };
}

/**
 * Score how likely an issue is spam (0-1, or -1 if unavailable).
 */
export async function scoreSpamLikelihood(
  issue: { title: string; body: string },
  recentIssueTitles: string[],
): Promise<LLMScoreResult> {
  const result = await evaluateIssue({
    ...issue,
    mediaUrls: [],
    similarIssues: recentIssueTitles.map((t, i) => ({
      number: i,
      title: t,
      similarity: 0,
    })),
  });
  if (!result.available) {
    return { score: -1, reasoning: result.reasoning };
  }
  const score = result.verdict === "invalid" ? result.confidence : 0;
  return { score, reasoning: result.reasoning };
}

/* ------------------------------------------------------------------ */
/*  Availability check                                                 */
/* ------------------------------------------------------------------ */

export function isLLMScoringAvailable(): boolean {
  return !!OPENROUTER_API_KEY;
}
