/**
 * Complete validation pipeline.
 *
 * Orchestrates all validation checks (media, spam, duplicate, edit history)
 * and produces a unified VerdictResult for an issue.
 */

import { logger } from '../logger.js';
import { TARGET_REPO } from '../config.js';
import { getIssue, GitHubApiError } from '../github/client.js';
import { validateMedia } from './media.js';
import { analyzeSpam, isSpam, type SpamIssueInput } from '../detection/spam.js';
import { findDuplicates } from '../detection/duplicate.js';
import { analyzeEditHistory } from '../detection/edit-history.js';
import { scoreSpamLikelihood, scoreIssueValidity } from '../detection/llm-scorer.js';
import { evaluateRules, formatRulesForPrompt } from '../rules/index.js';
import type { RuleContext } from '../rules/types.js';
import type { VerdictResult } from './verdict.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Edit fraud score above which an issue is flagged as suspicious. */
const EDIT_FRAUD_THRESHOLD = 0.5;

/* ------------------------------------------------------------------ */
/*  Repo helpers                                                       */
/* ------------------------------------------------------------------ */

function parseRepo(): { owner: string; repo: string } {
  const parts = TARGET_REPO.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid TARGET_REPO format: "${TARGET_REPO}"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run the full validation pipeline for a bounty issue.
 *
 * Steps:
 * 1. Fetch issue from GitHub
 * 2. Media check (presence and accessibility)
 * 3. Spam detection (template, burst, parity scoring)
 * 4. Duplicate detection (lexical fingerprinting + Jaccard similarity)
 * 5. Edit history analysis (fraud detection)
 * 6. Combine into verdict
 *
 * @param issueNumber - GitHub issue number to validate
 * @param workspaceId - Workspace identifier for tracking
 * @returns VerdictResult with full rationale
 */
export async function runValidationPipeline(
  issueNumber: number,
  workspaceId: string,
): Promise<VerdictResult> {
  const { owner, repo } = parseRepo();

  logger.info({ issueNumber, workspaceId }, 'Pipeline: starting validation');

  // 1. Fetch issue from GitHub
  let ghIssue;
  try {
    ghIssue = await getIssue(owner, repo, issueNumber);
  } catch (err: unknown) {
    const is404 =
      (err instanceof GitHubApiError && err.statusCode === 404) ||
      (err instanceof Error &&
        (err.message.includes('404') || err.message.includes('Not Found')));

    if (is404) {
      logger.warn({ issueNumber }, 'Pipeline: GitHub 404 — issue deleted or inaccessible');
      return {
        verdict: 'invalid',
        rationale: 'Issue deleted or inaccessible from GitHub API (HTTP 404). Cannot validate.',
        evidence: { error: 'github_404' },
        checklist: ['Issue not found on GitHub'],
      };
    }
    throw err;
  }

  const body = ghIssue.body ?? '';
  const title = ghIssue.title;
  const author = ghIssue.user?.login ?? 'unknown';
  const createdAt = ghIssue.created_at;

  // 2. Media check
  logger.info({ issueNumber }, 'Pipeline: running media check');
  const mediaResult = await validateMedia(body);

  // 3. Spam detection
  logger.info({ issueNumber }, 'Pipeline: running spam detection');
  const spamInput: SpamIssueInput = {
    issueNumber,
    title,
    body,
    author,
    createdAt,
  };
  let spamResult = await analyzeSpam(spamInput);

  // 3b. LLM-assisted spam scoring for borderline cases
  if (spamResult.overallScore >= 0.3 && spamResult.overallScore <= 0.7) {
    logger.info({ issueNumber }, 'Pipeline: borderline spam score — consulting LLM');
    const llmSpam = await scoreSpamLikelihood(
      { title, body },
      [], // Recent issue titles not readily available here; LLM uses issue content
    );
    if (llmSpam.score >= 0) {
      const blended = 0.5 * spamResult.overallScore + 0.5 * llmSpam.score;
      logger.info(
        { issueNumber, original: spamResult.overallScore.toFixed(2), llm: llmSpam.score.toFixed(2), blended: blended.toFixed(2) },
        'Pipeline: blended spam score',
      );
      spamResult = {
        ...spamResult,
        overallScore: blended,
        details: `${spamResult.details}; llm_spam=${llmSpam.score.toFixed(2)} (${llmSpam.reasoning})`,
      };
    }
  }

  // 4. Duplicate detection
  logger.info({ issueNumber }, 'Pipeline: running duplicate detection');
  const dupResult = await findDuplicates({ issueNumber, title, body });

  // 5. Edit history analysis
  logger.info({ issueNumber }, 'Pipeline: running edit history analysis');
  const editResult = await analyzeEditHistory(owner, repo, issueNumber);

  // 6. Combine results into verdict
  const checklist: string[] = [];
  const evidenceParts: Record<string, unknown> = {
    media: mediaResult,
    spam: {
      overallScore: spamResult.overallScore,
      details: spamResult.details,
    },
    duplicate: dupResult,
    editHistory: {
      fraudScore: editResult.fraudScore,
      editCount: editResult.edits.length,
      details: editResult.details,
    },
  };

  // Decision logic — first failing check determines verdict
  // Priority: media → spam → duplicate → edit fraud → valid

  // Media failure
  if (!mediaResult.hasMedia || !mediaResult.accessible) {
    const reasons: string[] = [];
    if (!mediaResult.hasMedia) {
      reasons.push('No media/evidence URLs found in issue body');
      checklist.push('Attach screenshot or video evidence');
    }
    if (mediaResult.hasMedia && !mediaResult.accessible) {
      reasons.push('Media URLs are not accessible');
      checklist.push('Ensure all attached media URLs are publicly accessible');
    }

    logger.info({ issueNumber, verdict: 'invalid' }, 'Pipeline: media failure');

    return {
      verdict: 'invalid',
      rationale: `Media validation failed: ${reasons.join('; ')}`,
      checklist: [...checklist, ...mediaResult.evidence],
      evidence: evidenceParts,
      spamScore: spamResult.overallScore,
      mediaCheck: {
        hasMedia: mediaResult.hasMedia,
        accessible: mediaResult.accessible,
      },
    };
  }

  // Spam detection
  if (isSpam(spamResult)) {
    logger.info({ issueNumber, verdict: 'invalid', score: spamResult.overallScore }, 'Pipeline: spam detected');

    return {
      verdict: 'invalid',
      rationale: `Issue flagged as spam (score: ${spamResult.overallScore.toFixed(2)}). ${spamResult.details}`,
      checklist: [
        'Ensure submission is original and not template-generated',
        'Avoid submitting multiple similar issues in rapid succession',
      ],
      evidence: evidenceParts,
      spamScore: spamResult.overallScore,
      mediaCheck: {
        hasMedia: mediaResult.hasMedia,
        accessible: mediaResult.accessible,
      },
    };
  }

  // Duplicate detection
  if (dupResult.isDuplicate && dupResult.originalIssue !== undefined) {
    logger.info(
      { issueNumber, verdict: 'duplicate', originalIssue: dupResult.originalIssue },
      'Pipeline: duplicate found',
    );

    return {
      verdict: 'duplicate',
      rationale: `Issue is a duplicate of #${dupResult.originalIssue} (similarity: ${dupResult.similarity.toFixed(2)})`,
      duplicateOf: dupResult.originalIssue,
      evidence: evidenceParts,
      spamScore: spamResult.overallScore,
      mediaCheck: {
        hasMedia: mediaResult.hasMedia,
        accessible: mediaResult.accessible,
      },
    };
  }

  // Edit history fraud
  if (editResult.suspicious && editResult.fraudScore > EDIT_FRAUD_THRESHOLD) {
    logger.info(
      { issueNumber, verdict: 'invalid', fraudScore: editResult.fraudScore },
      'Pipeline: suspicious edits detected',
    );

    return {
      verdict: 'invalid',
      rationale: `Suspicious edit history detected (fraud score: ${editResult.fraudScore.toFixed(2)}). ${editResult.details}`,
      checklist: [
        'Avoid excessive editing of evidence after submission',
        'Submit complete evidence at the time of issue creation',
      ],
      evidence: evidenceParts,
      spamScore: spamResult.overallScore,
      mediaCheck: {
        hasMedia: mediaResult.hasMedia,
        accessible: mediaResult.accessible,
      },
    };
  }

  // 6b. Rule evaluation — apply all loaded rules from rules/*.ts
  logger.info({ issueNumber }, 'Pipeline: evaluating rules');
  const ruleCtx: RuleContext = {
    issueNumber,
    title,
    body,
    author,
    createdAt,
    mediaUrls: mediaResult.urls,
    mediaAccessible: mediaResult.accessible,
    spamScore: spamResult.overallScore,
    duplicateScore: dupResult.similarity,
    editFraudScore: editResult.fraudScore,
    labels: [],
  };
  const ruleReport = await evaluateRules(ruleCtx);

  // If any REJECT code rule failed, immediately invalidate
  if (ruleReport.hasReject) {
    const rejectRules = ruleReport.codeResults.failed.filter((r) => r.severity === 'reject');
    logger.info(
      { issueNumber, verdict: 'invalid', rejectRules: rejectRules.map((r) => r.ruleId) },
      'Pipeline: REJECT rule(s) triggered',
    );

    return {
      verdict: 'invalid',
      rationale: `Rule violation: ${rejectRules.map((r) => r.message).join('; ')}`,
      checklist: rejectRules.map((r) => r.message),
      evidence: { ...evidenceParts, rules: ruleReport },
      spamScore: spamResult.overallScore,
      mediaCheck: {
        hasMedia: mediaResult.hasMedia,
        accessible: mediaResult.accessible,
      },
    };
  }

  // If REQUIRE rules failed, invalidate
  const requireFailures = ruleReport.codeResults.failed.filter((r) => r.severity === 'require');
  if (requireFailures.length > 0) {
    logger.info(
      { issueNumber, verdict: 'invalid', requireRules: requireFailures.map((r) => r.ruleId) },
      'Pipeline: REQUIRE rule(s) not met',
    );

    return {
      verdict: 'invalid',
      rationale: `Missing requirement: ${requireFailures.map((r) => r.message).join('; ')}`,
      checklist: requireFailures.map((r) => r.message),
      evidence: { ...evidenceParts, rules: ruleReport },
      spamScore: spamResult.overallScore,
      mediaCheck: {
        hasMedia: mediaResult.hasMedia,
        accessible: mediaResult.accessible,
      },
    };
  }

  // LLM validity gate — includes code rule results + LLM instructions in prompt
  logger.info({ issueNumber }, 'Pipeline: running LLM validity check');
  const rulesPromptContext = formatRulesForPrompt(ruleReport);
  const llmValidity = await scoreIssueValidity({
    title,
    body: rulesPromptContext ? `${body}\n\n${rulesPromptContext}` : body,
    mediaUrls: mediaResult.urls,
  });

  if (llmValidity.score >= 0 && llmValidity.score < 0.3) {
    logger.info(
      { issueNumber, verdict: 'invalid', llmScore: llmValidity.score.toFixed(2) },
      'Pipeline: LLM flagged as likely invalid',
    );

    return {
      verdict: 'invalid',
      rationale: `LLM validity check failed (score: ${llmValidity.score.toFixed(2)}). ${llmValidity.reasoning}`,
      checklist: [
        'Ensure the issue describes a genuine, reproducible bug',
        'Provide clear steps to reproduce and evidence',
        ...ruleReport.codeResults.failed.map((r) => r.message),
      ],
      evidence: { ...evidenceParts, llmValidity, rules: ruleReport },
      spamScore: spamResult.overallScore,
      mediaCheck: {
        hasMedia: mediaResult.hasMedia,
        accessible: mediaResult.accessible,
      },
    };
  }

  // All checks passed — valid
  logger.info(
    { issueNumber, verdict: 'valid', rulesReport: ruleReport.summary },
    'Pipeline: all checks passed',
  );

  return {
    verdict: 'valid',
    rationale: `All validation checks passed. ${ruleReport.summary}`,
    evidence: { ...evidenceParts, rules: ruleReport },
    spamScore: spamResult.overallScore,
    mediaCheck: {
      hasMedia: mediaResult.hasMedia,
      accessible: mediaResult.accessible,
    },
  };
}
