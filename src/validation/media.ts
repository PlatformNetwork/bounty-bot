/**
 * Media-gated validation.
 *
 * Uses GitHub's rendered body_html to extract real image URLs,
 * then verifies accessibility. Trusts GitHub-hosted attachments.
 */

import { logger } from "../logger.js";
import { TARGET_REPO, GITHUB_TOKEN } from "../config.js";

/* ------------------------------------------------------------------ */
/*  URL extraction — multiple strategies                               */
/* ------------------------------------------------------------------ */

/** Extract media URLs from GitHub's rendered HTML (most reliable). */
export function extractFromHtml(html: string): string[] {
  const urls = new Set<string>();
  let m: RegExpExecArray | null;

  // <img> tags
  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((m = imgRe.exec(html)) !== null) {
    if (m[1] && m[1].startsWith("http")) urls.add(m[1]);
  }

  // <a> wrapping images (GitHub wraps <img> in <a>)
  const aImgRe = /<a[^>]+href=["']([^"']+)["'][^>]*>\s*<img/gi;
  while ((m = aImgRe.exec(html)) !== null) {
    if (m[1] && m[1].startsWith("http")) urls.add(m[1]);
  }

  // <video> tags
  const videoRe = /<video[^>]+src=["']([^"']+)["']/gi;
  while ((m = videoRe.exec(html)) !== null) {
    if (m[1] && m[1].startsWith("http")) urls.add(m[1]);
  }

  // <source> inside <video>
  const sourceRe = /<source[^>]+src=["']([^"']+)["']/gi;
  while ((m = sourceRe.exec(html)) !== null) {
    if (m[1] && m[1].startsWith("http")) urls.add(m[1]);
  }

  return [...urls];
}

/** Fallback: extract from raw markdown body. */
export function extractFromMarkdown(body: string): string[] {
  const urls = new Set<string>();
  let m: RegExpExecArray | null;

  // Markdown images: ![alt](url)
  const mdImgRe = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/gi;
  while ((m = mdImgRe.exec(body)) !== null) {
    if (m[1]) urls.add(m[1]);
  }

  // HTML img tags in markdown
  const htmlImgRe = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
  while ((m = htmlImgRe.exec(body)) !== null) {
    if (m[1]) urls.add(m[1]);
  }

  // GitHub user-attachments (no file extension, UUID format)
  const ghAttachRe =
    /https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/gi;
  while ((m = ghAttachRe.exec(body)) !== null) {
    urls.add(m[0]);
  }

  // GitHub user-images (both public and private)
  const ghUserImgRe =
    /https:\/\/(?:private-)?user-images\.githubusercontent\.com\/[^\s)>"']+/gi;
  while ((m = ghUserImgRe.exec(body)) !== null) {
    urls.add(m[0]);
  }

  // GitHub repo assets: github.com/owner/repo/assets/...
  const ghRepoAssetsRe =
    /https:\/\/github\.com\/[^/]+\/[^/]+\/assets\/[^\s)>"']+/gi;
  while ((m = ghRepoAssetsRe.exec(body)) !== null) {
    urls.add(m[0]);
  }

  // Raw githubusercontent
  const rawGhRe =
    /https:\/\/raw\.githubusercontent\.com\/[^\s)>"']+/gi;
  while ((m = rawGhRe.exec(body)) !== null) {
    urls.add(m[0]);
  }

  // Direct media file URLs (with extension)
  const directRe =
    /https?:\/\/[^\s)>"']+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|mov|webm)/gi;
  while ((m = directRe.exec(body)) !== null) {
    urls.add(m[0]);
  }

  // Video platforms (YouTube, Vimeo)
  const videoRe =
    /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|vimeo\.com\/)\S+/gi;
  while ((m = videoRe.exec(body)) !== null) {
    urls.add(m[0]);
  }

  return [...urls];
}

/* ------------------------------------------------------------------ */
/*  Fetch body_html from GitHub API                                    */
/* ------------------------------------------------------------------ */

async function fetchBodyHtml(issueNumber: number): Promise<string | null> {
  const parts = TARGET_REPO.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [owner, repo] = parts;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.full+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return (data.body_html as string) ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Accessibility check                                                */
/* ------------------------------------------------------------------ */

const CHECK_TIMEOUT_MS = 10_000;

/** GitHub-hosted URLs that are always accessible if the issue exists. */
function isTrustedGitHubUrl(url: string): boolean {
  return (
    /^https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/.test(url) ||
    url.includes("private-user-images.githubusercontent.com") ||
    url.includes("user-images.githubusercontent.com") ||
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/assets\//.test(url)
  );
}

/**
 * Check if a URL is accessible. Uses HEAD first, then GET with Range
 * as fallback (GitHub S3 signed URLs reject HEAD with 403).
 */
export async function isUrlAccessible(url: string): Promise<boolean> {
  try {
    const headRes = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      redirect: "follow",
    });
    if (headRes.ok) return true;

    // HEAD failed — try GET with Range (handles S3 signed URLs)
    const getRes = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      redirect: "follow",
    });
    return getRes.ok || getRes.status === 206;
  } catch {
    return false;
  }
}

async function checkMediaAccessibility(
  urls: string[],
): Promise<{ accessible: string[]; inaccessible: string[] }> {
  const accessible: string[] = [];
  const inaccessible: string[] = [];

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      // Trust GitHub-hosted attachment URLs
      if (isTrustedGitHubUrl(url)) {
        return { url, ok: true };
      }
      const ok = await isUrlAccessible(url);
      return { url, ok };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      if (result.value.ok) {
        accessible.push(result.value.url);
      } else {
        inaccessible.push(result.value.url);
      }
    } else {
      inaccessible.push("unknown");
    }
  }

  return { accessible, inaccessible };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export interface MediaValidationResult {
  hasMedia: boolean;
  accessible: boolean;
  urls: string[];
  evidence: string[];
}

/**
 * Run full media validation on an issue.
 *
 * 1. Fetch body_html from GitHub API (contains resolved image URLs)
 * 2. Extract media URLs from HTML
 * 3. Fallback: extract from markdown body
 * 4. Check accessibility (trust GitHub attachments, HEAD/GET others)
 * 5. Accessible = at least one URL works
 */
export async function validateMedia(
  body: string,
  issueNumber?: number,
): Promise<MediaValidationResult> {
  const evidence: string[] = [];
  let urls: string[] = [];

  // Strategy 1: Use GitHub's rendered HTML (most reliable)
  if (issueNumber) {
    const html = await fetchBodyHtml(issueNumber);
    if (html) {
      urls = extractFromHtml(html);
      if (urls.length > 0) {
        evidence.push(
          `Found ${urls.length} media URL(s) via GitHub rendered HTML`,
        );
      }
    }
  }

  // Strategy 2: Fallback to markdown parsing
  if (urls.length === 0) {
    urls = extractFromMarkdown(body);
    if (urls.length > 0) {
      evidence.push(`Found ${urls.length} media URL(s) via markdown parsing`);
    }
  }

  if (urls.length === 0) {
    evidence.push("No media URLs found in issue body");
    return { hasMedia: false, accessible: false, urls, evidence };
  }

  // Deduplicate
  urls = [...new Set(urls)];

  const { accessible, inaccessible } = await checkMediaAccessibility(urls);

  if (accessible.length > 0) {
    evidence.push(`${accessible.length} URL(s) accessible`);
  }
  if (inaccessible.length > 0) {
    evidence.push(
      `${inaccessible.length} URL(s) inaccessible`,
    );
  }

  // Accessible if at least one URL works
  const isAccessible = accessible.length > 0;

  logger.info(
    {
      issueNumber,
      totalUrls: urls.length,
      accessible: accessible.length,
      inaccessible: inaccessible.length,
    },
    "Media validation complete",
  );

  return {
    hasMedia: true,
    accessible: isAccessible,
    urls,
    evidence,
  };
}
