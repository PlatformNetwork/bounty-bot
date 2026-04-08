import { describe, it, expect, vi, afterEach } from "vitest";
import {
  extractFromMarkdown,
  extractFromHtml,
  validateMedia,
} from "./media.js";

describe("validation/media", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("extractFromMarkdown", () => {
    it("finds markdown images ![alt](url)", () => {
      const body = "Check this ![screenshot](https://example.com/img.png) out";
      const urls = extractFromMarkdown(body);
      expect(urls).toContain("https://example.com/img.png");
    });

    it("finds HTML img tags", () => {
      const body = 'See <img src="https://example.com/photo.jpg"> here';
      const urls = extractFromMarkdown(body);
      expect(urls).toContain("https://example.com/photo.jpg");
    });

    it("finds direct .png/.jpg/.mp4 URLs", () => {
      const body =
        "Visit https://example.com/video.mp4 and https://example.com/image.png";
      const urls = extractFromMarkdown(body);
      expect(urls).toContain("https://example.com/video.mp4");
      expect(urls).toContain("https://example.com/image.png");
    });

    it("finds GitHub user-attachments URLs (no extension)", () => {
      const body =
        '<img src="https://github.com/user-attachments/assets/f08f37d4-e6f7-46f1-8e76-49e5a33072fa" />';
      const urls = extractFromMarkdown(body);
      expect(urls).toContain(
        "https://github.com/user-attachments/assets/f08f37d4-e6f7-46f1-8e76-49e5a33072fa",
      );
    });

    it("finds GitHub user-images URLs", () => {
      const body =
        "Evidence: https://user-images.githubusercontent.com/123/abc.png";
      const urls = extractFromMarkdown(body);
      expect(urls.length).toBeGreaterThanOrEqual(1);
    });

    it("finds raw.githubusercontent.com URLs", () => {
      const body =
        "![img](https://raw.githubusercontent.com/user/repo/main/screenshot.png)";
      const urls = extractFromMarkdown(body);
      expect(urls.length).toBeGreaterThanOrEqual(1);
    });

    it("returns empty array for empty body", () => {
      expect(extractFromMarkdown("")).toEqual([]);
    });

    it("returns empty array for body with no media", () => {
      expect(
        extractFromMarkdown("Just some text without any images"),
      ).toEqual([]);
    });
  });

  describe("extractFromHtml", () => {
    it("finds img tags", () => {
      const html =
        '<img src="https://private-user-images.githubusercontent.com/123/img.png?jwt=xxx" />';
      const urls = extractFromHtml(html);
      expect(urls.length).toBe(1);
      expect(urls[0]).toContain("private-user-images");
    });

    it("finds video tags", () => {
      const html =
        '<video src="https://github.com/user-attachments/assets/abc-123"></video>';
      const urls = extractFromHtml(html);
      expect(urls.length).toBe(1);
    });

    it("finds a tags wrapping images", () => {
      const html =
        '<a href="https://example.com/full.png"><img src="https://example.com/thumb.png" /></a>';
      const urls = extractFromHtml(html);
      expect(urls).toContain("https://example.com/full.png");
      expect(urls).toContain("https://example.com/thumb.png");
    });

    it("returns empty for html with no media", () => {
      expect(extractFromHtml("<p>No images</p>")).toEqual([]);
    });
  });

  describe("validateMedia", () => {
    it("no URLs -> hasMedia false, accessible false", async () => {
      const result = await validateMedia("No images here");
      expect(result.hasMedia).toBe(false);
      expect(result.accessible).toBe(false);
    });

    it("GitHub attachment URL -> trusted, accessible true", async () => {
      // Mock fetch to fail (simulating S3 rejection) — should still pass because trusted
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
      vi.stubGlobal("fetch", mockFetch);

      const body =
        '<img src="https://github.com/user-attachments/assets/f08f37d4-e6f7-46f1-8e76-49e5a33072fa" />';
      const result = await validateMedia(body);
      expect(result.hasMedia).toBe(true);
      expect(result.accessible).toBe(true);
    });

    it("accessible URL -> hasMedia true, accessible true", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      const result = await validateMedia(
        "Evidence: ![img](https://example.com/proof.png)",
      );
      expect(result.hasMedia).toBe(true);
      expect(result.accessible).toBe(true);
    });

    it("inaccessible non-GitHub URL -> accessible false", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await validateMedia(
        "Evidence: ![img](https://broken-host.example/proof.png)",
      );
      expect(result.hasMedia).toBe(true);
      expect(result.accessible).toBe(false);
    });

    it("mixed: one accessible + one not -> accessible true (at least one)", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ ok: callCount === 1, status: callCount === 1 ? 200 : 404 });
      });
      vi.stubGlobal("fetch", mockFetch);

      const body =
        "![a](https://example.com/good.png) ![b](https://broken.example/bad.png)";
      const result = await validateMedia(body);
      expect(result.hasMedia).toBe(true);
      expect(result.accessible).toBe(true);
    });
  });
});
