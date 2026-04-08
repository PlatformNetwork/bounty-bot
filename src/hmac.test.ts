import { describe, it, expect, vi, afterEach } from 'vitest';
import { signRequest, verifySignature, buildSignedHeaders } from './hmac.js';

describe('hmac', () => {
  const testSecret = 'test-secret-key-for-hmac';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('signRequest', () => {
    it('produces hex signature and timestamp', () => {
      const { signature, timestamp } = signRequest('hello', testSecret);
      expect(signature).toMatch(/^[a-f0-9]{64}$/);
      expect(Number(timestamp)).toBeGreaterThan(0);
    });

    it('produces different signatures for different bodies', () => {
      const a = signRequest('body-a', testSecret);
      const b = signRequest('body-b', testSecret);
      expect(a.signature).not.toBe(b.signature);
    });

    it('produces different signatures with different secrets', () => {
      const a = signRequest('body', 'secret-1');
      const b = signRequest('body', 'secret-2');
      expect(a.signature).not.toBe(b.signature);
    });
  });

  describe('verifySignature', () => {
    it('valid round-trip (sign then verify)', () => {
      const body = '{"test":true}';
      const { signature, timestamp } = signRequest(body, testSecret);
      expect(verifySignature(body, signature, timestamp, testSecret)).toBe(true);
    });

    it('rejects tampered body', () => {
      const { signature, timestamp } = signRequest('original', testSecret);
      expect(verifySignature('tampered', signature, timestamp, testSecret)).toBe(false);
    });

    it('rejects expired timestamp', async () => {
      const body = 'test';
      // Create a signature with an old timestamp (10 minutes ago)
      const oldTimestamp = (Date.now() - 600_000).toString();
      // Manually create a valid signature for the old timestamp
      const { createHmac } = await import('crypto');
      const oldSig = createHmac('sha256', testSecret)
        .update(oldTimestamp + '.' + body)
        .digest('hex');
      expect(verifySignature(body, oldSig, oldTimestamp, testSecret)).toBe(false);
    });

    it('rejects NaN timestamp', () => {
      const { signature } = signRequest('test', testSecret);
      expect(verifySignature('test', signature, 'not-a-number', testSecret)).toBe(false);
    });

    it('rejects wrong-length signature', () => {
      const { timestamp } = signRequest('test', testSecret);
      expect(verifySignature('test', 'tooshort', timestamp, testSecret)).toBe(false);
    });

    it('rejects empty signature', () => {
      const { timestamp } = signRequest('test', testSecret);
      expect(verifySignature('test', '', timestamp, testSecret)).toBe(false);
    });
  });

  describe('buildSignedHeaders', () => {
    it('returns correct header format with sha256= prefix', () => {
      const headers = buildSignedHeaders('body', testSecret);
      expect(headers['X-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(headers['X-Timestamp']).toBeDefined();
      expect(Number(headers['X-Timestamp'])).toBeGreaterThan(0);
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('signature in header matches signRequest output', () => {
      const body = '{"data":1}';
      const headers = buildSignedHeaders(body, testSecret);
      const rawSig = headers['X-Signature'].replace('sha256=', '');
      // Verify round-trip
      expect(verifySignature(body, rawSig, headers['X-Timestamp'], testSecret)).toBe(true);
    });
  });
});
