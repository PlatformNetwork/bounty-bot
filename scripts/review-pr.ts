/**
 * AI-powered PR review script.
 *
 * Fetches the PR diff from GitHub, sends it to an LLM via OpenRouter,
 * and posts a structured review comment with summary, confidence score,
 * file table, issues, and optional Mermaid flowchart.
 *
 * Environment variables:
 *   GITHUB_TOKEN      - GitHub token with pull-requests:write
 *   OPENROUTER_API_KEY - OpenRouter API key
 *   PR_NUMBER         - Pull request number
 *   PR_REPO           - Repository in owner/repo format
 *   PR_HEAD_SHA       - Head commit SHA of the PR
 */

import OpenAI from 'openai';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const PR_NUMBER = parseInt(process.env.PR_NUMBER!, 10);
const PR_REPO = process.env.PR_REPO!;
const PR_HEAD_SHA = process.env.PR_HEAD_SHA ?? 'unknown';
const MODEL = process.env.REVIEW_MODEL || 'moonshotai/kimi-k2.5:nitro';
const COMMENT_MARKER = '<!-- atlas-review -->';
const MAX_DIFF_CHARS = 100_000;

const [owner, repo] = PR_REPO.split('/');

interface ReviewResult {
  summary: string;
  issues: Array<{ description: string; severity: 'critical' | 'warning' | 'info' }>;
  confidence: { score: number; justification: string };
  files: Array<{ filename: string; overview: string }>;
  flowchart: string | null;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function ghFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers as Record<string, string> ?? {}),
    },
  });
}

async function getPRDiff(): Promise<string> {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${PR_NUMBER}`, {
    headers: { Accept: 'application/vnd.github.v3.diff' },
  });
  if (!res.ok) throw new Error(`Failed to fetch PR diff: ${res.status}`);
  const text = await res.text();
  return text.length > MAX_DIFF_CHARS
    ? text.slice(0, MAX_DIFF_CHARS) + '\n... [diff truncated]'
    : text;
}

async function getPRFiles(): Promise<Array<{ filename: string; status: string; additions: number; deletions: number }>> {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${PR_NUMBER}/files?per_page=100`);
  if (!res.ok) throw new Error(`Failed to fetch PR files: ${res.status}`);
  return res.json() as any;
}

async function getPRInfo(): Promise<{ title: string; body: string }> {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${PR_NUMBER}`);
  if (!res.ok) throw new Error(`Failed to fetch PR info: ${res.status}`);
  const data = await res.json() as any;
  return { title: data.title ?? '', body: data.body ?? '' };
}

async function findExistingComment(): Promise<number | null> {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments?per_page=100`);
  if (!res.ok) return null;
  const comments = await res.json() as any[];
  const existing = comments.find((c: any) => c.body?.includes(COMMENT_MARKER));
  return existing?.id ?? null;
}

async function postOrUpdateComment(body: string): Promise<void> {
  const existingId = await findExistingComment();
  if (existingId) {
    await ghFetch(`/repos/${owner}/${repo}/issues/comments/${existingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    console.log(`Updated existing comment ${existingId}`);
  } else {
    await ghFetch(`/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    console.log('Posted new review comment');
  }
}

// ---------------------------------------------------------------------------
// LLM review
// ---------------------------------------------------------------------------

async function runLLMReview(diff: string, files: any[], prInfo: { title: string; body: string }): Promise<ReviewResult> {
  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: OPENROUTER_API_KEY,
  });

  const fileList = files.map(f => `- ${f.filename} (+${f.additions}/-${f.deletions}) [${f.status}]`).join('\n');

  const systemPrompt = `You are a senior code reviewer. You review pull requests and produce structured analysis.

Your review must be:
- Focused on bugs, security issues, correctness problems, and real risks
- Concise and actionable — no nitpicking style/formatting
- Honest about confidence — if the diff is small/trivial, say so

You MUST respond with a valid JSON object matching this schema:
{
  "summary": "2-4 sentence natural language summary of what the PR does and why",
  "issues": [{"description": "what's wrong and where", "severity": "critical|warning|info"}],
  "confidence": {"score": 1-5, "justification": "1-2 sentences explaining the score"},
  "files": [{"filename": "path/to/file.ts", "overview": "1 sentence about what changed and any concerns"}],
  "flowchart": "mermaid flowchart code (NO backticks/fences) showing architecture/data flow, or null if not needed"
}

Rules for the flowchart:
- Only include if the PR changes architecture, data flow, or multi-component interactions
- Use short node names (under 20 chars)
- Start with "flowchart TD" or "flowchart LR"
- Do NOT wrap in backticks — just the raw mermaid code
- Set to null for simple/small PRs

Rules for issues:
- "critical" = bugs, security holes, data loss risks, broken functionality
- "warning" = inconsistencies, missing error handling, incomplete migration
- "info" = suggestions, minor improvements
- Empty array if no issues found

Rules for confidence score:
- 5 = trivial/safe change, no risks
- 4 = safe to merge with minor notes
- 3 = likely safe but needs verification
- 2 = has real concerns that should be addressed
- 1 = has critical issues, do not merge`;

  const userPrompt = `## PR: ${prInfo.title}

### Description
${prInfo.body || 'No description provided.'}

### Changed Files
${fileList}

### Diff
\`\`\`diff
${diff}
\`\`\`

Review this PR and respond with the JSON object.`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 4000,
  });

  const content = response.choices[0]?.message?.content ?? '';

  // Extract JSON from response (handle markdown fences)
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? content.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) throw new Error(`LLM did not return valid JSON:\n${content.slice(0, 500)}`);

  return JSON.parse(jsonMatch[1].trim()) as ReviewResult;
}

// ---------------------------------------------------------------------------
// Render comment
// ---------------------------------------------------------------------------

function renderComment(review: ReviewResult, filesCount: number): string {
  const severityIcon = (s: string) => s === 'critical' ? '🔴' : s === 'warning' ? '🟡' : '🟢';
  const repoName = repo.charAt(0).toUpperCase() + repo.slice(1);

  let md = `${COMMENT_MARKER}\n`;
  md += `<h3>${repoName} Review Summary</h3>\n\n`;
  md += `${review.summary}\n\n`;

  if (review.issues.length > 0) {
    md += `Issues found:\n`;
    for (const issue of review.issues) {
      md += `- ${severityIcon(issue.severity)} ${issue.description}\n`;
    }
    md += '\n';
  }

  md += `<h3>Confidence Score: ${review.confidence.score}/5</h3>\n\n`;
  md += `- ${review.confidence.justification}\n\n`;

  if (review.files.length > 0) {
    md += `<h3>Important Files Changed</h3>\n\n`;
    md += `| Filename | Overview |\n|----------|----------|\n`;
    for (const f of review.files) {
      md += `| \`${f.filename}\` | ${f.overview} |\n`;
    }
    md += '\n';
  }

  if (review.flowchart) {
    md += `<details open><summary><h3>Flowchart</h3></summary>\n\n`;
    md += '```mermaid\n';
    md += review.flowchart.trim();
    md += '\n```\n</details>\n\n';
  }

  md += `<sub>Last reviewed commit: ${PR_HEAD_SHA.slice(0, 7)}</sub>\n`;

  return md;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Reviewing PR #${PR_NUMBER} on ${PR_REPO} (${PR_HEAD_SHA.slice(0, 7)})`);

  const [diff, files, prInfo] = await Promise.all([
    getPRDiff(),
    getPRFiles(),
    getPRInfo(),
  ]);

  console.log(`Diff: ${diff.length} chars, ${files.length} files changed`);

  const review = await runLLMReview(diff, files, prInfo);
  console.log(`Review: confidence=${review.confidence.score}/5, issues=${review.issues.length}`);

  const comment = renderComment(review, files.length);
  await postOrUpdateComment(comment);

  console.log('Review posted successfully');
}

main().catch((err) => {
  console.error('Review failed:', err);
  process.exit(1);
});
