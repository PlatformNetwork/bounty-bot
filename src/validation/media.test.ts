import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractMediaUrls, validateMedia } from './media.js';

describe('validation/media', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractMediaUrls', () => {
    it('finds markdown images ![alt](url)', () => {
      const body = 'Check this ![screenshot](https://example.com/img.png) out';
      const urls = extractMediaUrls(body);
      expect(urls).toContain('https://example.com/img.png');
    });

    it('finds HTML img tags', () => {
      const body = 'See <img src="https://example.com/photo.jpg"> here';
      const urls = extractMediaUrls(body);
      expect(urls).toContain('https://example.com/photo.jpg');
    });

    it('finds direct .png/.jpg/.mp4 URLs', () => {
      const body = 'Visit https://example.com/video.mp4 and https://example.com/image.png';
      const urls = extractMediaUrls(body);
      expect(urls).toContain('https://example.com/video.mp4');
      expect(urls).toContain('https://example.com/image.png');
    });

    it('finds GitHub asset URLs', () => {
      const body =
        'Evidence: https://user-images.githubusercontent.com/123/abc.png and https://github.com/org/repo/assets/456/def.jpg';
      const urls = extractMediaUrls(body);
      expect(urls.length).toBeGreaterThanOrEqual(2);
    });

    it('returns empty array for empty body', () => {
      expect(extractMediaUrls('')).toEqual([]);
    });

    it('returns empty array for body with no media', () => {
      expect(extractMediaUrls('Just some text without any images')).toEqual([]);
    });

    it('deduplicates URLs', () => {
      const body =
        '![a](https://example.com/img.png) ![b](https://example.com/img.png) https://example.com/img.png';
      const urls = extractMediaUrls(body);
      const unique = new Set(urls);
      expect(urls.length).toBe(unique.size);
    });
  });

  describe('validateMedia', () => {
    it('all accessible -> hasMedia true, accessible true', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const result = await validateMedia(
        'Evidence: ![img](https://example.com/proof.png)',
      );
      expect(result.hasMedia).toBe(true);
      expect(result.accessible).toBe(true);
      expect(result.urls.length).toBeGreaterThan(0);
    });

    it('some inaccessible -> hasMedia true, accessible false', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false });
      vi.stubGlobal('fetch', mockFetch);

      const result = await validateMedia(
        'Evidence: ![img](https://example.com/broken.png)',
      );
      expect(result.hasMedia).toBe(true);
      expect(result.accessible).toBe(false);
    });

    it('no URLs -> hasMedia false, accessible false', async () => {
      const result = await validateMedia('No images here');
      expect(result.hasMedia).toBe(false);
      expect(result.accessible).toBe(false);
    });
  });
});
