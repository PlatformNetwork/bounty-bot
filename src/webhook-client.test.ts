import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import {
  buildWebhookPayload,
  sendWebhookCallback,
  type WebhookPayload,
} from './webhook-client.js';

describe('webhook-client', () => {
  describe('buildWebhookPayload', () => {
    it('creates payload with event type and data', () => {
      const payload = buildWebhookPayload('validation.completed', {
        issue_number: 42001,
        verdict: 'valid',
      });

      expect(payload.event).toBe('validation.completed');
      expect(payload.data.issue_number).toBe(42001);
      expect(payload.data.verdict).toBe('valid');
      expect(payload.timestamp).toBeDefined();
    });

    it('includes ISO timestamp', () => {
      const before = new Date().toISOString();
      const payload = buildWebhookPayload('validation.failed', { reason: 'timeout' });
      const after = new Date().toISOString();

      expect(payload.timestamp >= before).toBe(true);
      expect(payload.timestamp <= after).toBe(true);
    });

    it('creates payload for each event type', () => {
      const completed = buildWebhookPayload('validation.completed', {});
      expect(completed.event).toBe('validation.completed');

      const failed = buildWebhookPayload('validation.failed', {});
      expect(failed.event).toBe('validation.failed');

      const deployed = buildWebhookPayload('autonomy.deployed', {});
      expect(deployed.event).toBe('autonomy.deployed');
    });
  });

  describe('sendWebhookCallback', () => {
    let mockServer: http.Server;
    let serverPort: number;
    let requestLog: Array<{
      method: string;
      url: string;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>;
    let responseCode: number;

    beforeEach(async () => {
      requestLog = [];
      responseCode = 200;

      mockServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          requestLog.push({
            method: req.method || '',
            url: req.url || '',
            headers: req.headers,
            body,
          });
          res.writeHead(responseCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        });
      });

      serverPort = await new Promise<number>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          resolve((mockServer.address() as { port: number }).port);
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it('sends POST request with JSON payload', async () => {
      const payload = buildWebhookPayload('validation.completed', {
        issue_number: 42001,
      });

      const result = await sendWebhookCallback(
        payload,
        `http://127.0.0.1:${serverPort}/webhooks`,
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(requestLog).toHaveLength(1);
      expect(requestLog[0].method).toBe('POST');
      expect(requestLog[0].headers['content-type']).toBe('application/json');
      expect(requestLog[0].headers['x-webhook-event']).toBe('validation.completed');

      const receivedBody = JSON.parse(requestLog[0].body) as WebhookPayload;
      expect(receivedBody.event).toBe('validation.completed');
      expect(receivedBody.data.issue_number).toBe(42001);
    });

    it('returns success with status code on 2xx', async () => {
      responseCode = 201;
      const payload = buildWebhookPayload('validation.completed', {});
      const result = await sendWebhookCallback(
        payload,
        `http://127.0.0.1:${serverPort}/webhooks`,
      );

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(201);
    });

    it('does not retry on 4xx client errors', async () => {
      responseCode = 400;
      const payload = buildWebhookPayload('validation.failed', {});
      const result = await sendWebhookCallback(
        payload,
        `http://127.0.0.1:${serverPort}/webhooks`,
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.statusCode).toBe(400);
      expect(requestLog).toHaveLength(1);
    });

    it('retries on 5xx server errors', async () => {
      responseCode = 500;
      const payload = buildWebhookPayload('validation.failed', {});

      // Use fast retry for testing
      vi.stubEnv('WEBHOOK_RETRY_DELAY_MS', '10');

      const result = await sendWebhookCallback(
        payload,
        `http://127.0.0.1:${serverPort}/webhooks`,
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBeGreaterThan(1);
      expect(requestLog.length).toBeGreaterThan(1);

      vi.unstubAllEnvs();
    });

    it('handles connection errors with retry', async () => {
      const payload = buildWebhookPayload('validation.completed', {});

      // Point to a port where nothing is listening
      const result = await sendWebhookCallback(
        payload,
        'http://127.0.0.1:19999/webhooks',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('includes X-Webhook-Event header', async () => {
      const payload = buildWebhookPayload('autonomy.deployed', { pr: 123 });
      await sendWebhookCallback(
        payload,
        `http://127.0.0.1:${serverPort}/webhooks`,
      );

      expect(requestLog[0].headers['x-webhook-event']).toBe('autonomy.deployed');
    });
  });
});
