/**
 * Media-gated validation.
 *
 * Extracts media URLs from issue body text, checks their accessibility
 * via HEAD requests, and returns a structured validation result.
 */

import { logger } from "../logger.js";

/* ------------------------------------------------------------------ */
/*  URL extraction patterns                                            */
/* ------------------------------------------------------------------ */

/** Markdown image syntax: ![alt](url) */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/gi;

/** HTML img tag: <img src="url"> */
const HTML_IMG_RE = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;

/** Direct media file URLs (image extensions) */
const DIRECT_MEDIA_RE =
  /https?:\/\/[^\s)>"']+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|mov|webm)/gi;

/** GitHub user content / asset URLs */
const GITHUB_MEDIA_RE =
  /https:\/\/(?:user-images\.githubusercontent\.com|github\.com\/[^/]+\/[^/]+\/assets)\/[^\s)>"']+/gi;

/** Video platform URLs */
const VIDEO_PLATFORM_RE =
  /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|vimeo\.com\/)[^\s)>"']+/gi;

/* ------------------------------------------------------------------ */
/*  Extraction                                                         */
/* ------------------------------------------------------------------ */

/**
 * Extract all media URLs from an issue body string.
 *
 * Finds image URLs (markdown and HTML), video URLs (YouTube, Vimeo,
 * direct .mp4/.webm), and GitHub user-content/asset URLs.
 */
export function extractMediaUrls(body: string): string[] {
  const urls = new Set<string>();

  const patterns: RegExp[] = [
    MARKDOWN_IMAGE_RE,
    HTML_IMG_RE,
    DIRECT_MEDIA_RE,
    GITHUB_MEDIA_RE,
    VIDEO_PLATFORM_RE,
  ];

  for (const pattern of patterns) {
    // Reset lastIndex for global regex reuse
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(body)) !== null) {
      // Use capture group 1 if present (markdown/html), otherwise group 0
      const url = match[1] ?? match[0];
      urls.add(url);
    }
  }

  return [...urls];
}

/* ------------------------------------------------------------------ */
/*  Accessibility check                                                */
/* ------------------------------------------------------------------ */

const HEAD_TIMEOUT_MS = 5000;

/**
 * Check accessibility of a list of URLs via HEAD requests.
 *
 * @param urls - URLs to check
 * @returns Categorized results: accessible and inaccessible URL lists
 */
export async function checkMediaAccessibility(
  urls: string[],
): Promise<{ accessible: string[]; inaccessible: string[] }> {
  const accessible: string[] = [];
  const inaccessible: string[] = [];

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const response = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
          redirect: "follow",
        });
        return { url, ok: response.ok };
      } catch {
        return { url, ok: false };
      }
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
      // Promise rejected — treat as inaccessible
      inaccessible.push("unknown");
    }
  }

  return { accessible, inaccessible };
}

/* ------------------------------------------------------------------ */
/*  Public validation API                                              */
/* ------------------------------------------------------------------ */

export interface MediaValidationResult {
  hasMedia: boolean;
  accessible: boolean;
  urls: string[];
  evidence: string[];
}

/**
 * Run full media validation on an issue body.
 *
 * 1. Extract all media URLs from the body
 * 2. Check each URL for accessibility (HEAD request, 5s timeout)
 * 3. Build evidence checklist items
 *
 * @param body - The issue body text
 * @returns Structured media validation result
 */
export async function validateMedia(
  body: string,
): Promise<MediaValidationResult> {
  const urls = extractMediaUrls(body);
  const evidence: string[] = [];

  if (urls.length === 0) {
    evidence.push("No media URLs found in issue body");
    return { hasMedia: false, accessible: false, urls, evidence };
  }

  evidence.push(`Found ${urls.length} media URL(s)`);

  const { accessible, inaccessible } = await checkMediaAccessibility(urls);

  if (accessible.length > 0) {
    evidence.push(`${accessible.length} URL(s) accessible`);
  }
  if (inaccessible.length > 0) {
    evidence.push(`${inaccessible.length} URL(s) inaccessible`);
  }

  const allAccessible = inaccessible.length === 0;

  logger.info(
    {
      totalUrls: urls.length,
      accessible: accessible.length,
      inaccessible: inaccessible.length,
    },
    "Media validation complete",
  );

  return {
    hasMedia: true,
    accessible: allAccessible,
    urls,
    evidence,
  };
}
