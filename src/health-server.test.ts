import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startHealthServer,
  stopHealthServer,
  setReady,
  registerReadinessCheck,
  clearReadinessChecks,
} from './health-server.js';

describe('health-server', () => {
  const testPort = 3298; // Use port outside mission allocation for tests

  beforeEach(() => {
    setReady(false);
    clearReadinessChecks();
  });

  afterEach(async () => {
    await stopHealthServer();
  });

  describe('/health endpoint', () => {
    it('returns 200 OK when server is running', async () => {
      await startHealthServer(testPort);
      const response = await fetch(`http://localhost:${testPort}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        service: string;
        timestamp: string;
      };
      expect(body.status).toBe('ok');
      expect(body.service).toBe('bounty-bot');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('/ready endpoint', () => {
    it('returns 503 when not ready', async () => {
      await startHealthServer(testPort);
      setReady(false);
      const response = await fetch(`http://localhost:${testPort}/ready`);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe('not_ready');
    });

    it('returns 200 when ready', async () => {
      await startHealthServer(testPort);
      setReady(true);
      const response = await fetch(`http://localhost:${testPort}/ready`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        service: string;
        timestamp: string;
      };
      expect(body.status).toBe('ready');
      expect(body.service).toBe('bounty-bot');
    });

    it('returns 503 when readiness check fails', async () => {
      await startHealthServer(testPort);
      setReady(true);
      registerReadinessCheck(() => false);
      const response = await fetch(`http://localhost:${testPort}/ready`);
      expect(response.status).toBe(503);
    });

    it('returns 200 when all readiness checks pass', async () => {
      await startHealthServer(testPort);
      setReady(true);
      registerReadinessCheck(() => true);
      registerReadinessCheck(() => true);
      const response = await fetch(`http://localhost:${testPort}/ready`);
      expect(response.status).toBe(200);
    });

    it('supports async readiness checks', async () => {
      await startHealthServer(testPort);
      setReady(true);
      registerReadinessCheck(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return true;
      });
      const response = await fetch(`http://localhost:${testPort}/ready`);
      expect(response.status).toBe(200);
    });
  });

  describe('unknown paths', () => {
    it('returns 404 for unknown routes', async () => {
      await startHealthServer(testPort);
      const response = await fetch(`http://localhost:${testPort}/unknown`);
      expect(response.status).toBe(404);
    });
  });
});
