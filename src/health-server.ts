/**
 * Health and readiness HTTP server for bounty-bot service.
 * Provides /health (liveness) and /ready (readiness) endpoints.
 *
 * Uses Express for consistency with the API layer (both share the same
 * framework). Health/readiness are mounted on the main Express app in
 * production, but this module can also run standalone for testing.
 */

import express, { type Express, type Request, type Response } from 'express';
import http from 'http';
import { logger } from './logger.js';
import { SERVICE_NAME } from './config.js';

let server: http.Server | null = null;
let readinessState = false;
let readinessChecks: Array<() => boolean | Promise<boolean>> = [];

/**
 * Register a readiness check function.
 * All registered checks must pass for /ready to return 200.
 */
export function registerReadinessCheck(
  check: () => boolean | Promise<boolean>,
): void {
  readinessChecks.push(check);
}

/**
 * Clear all registered readiness checks.
 * Used for testing to reset state between tests.
 */
export function clearReadinessChecks(): void {
  readinessChecks = [];
}

/**
 * Update readiness state directly (for simple cases).
 */
export function setReady(ready: boolean): void {
  readinessState = ready;
  logger.info({ ready }, 'Readiness state updated');
}

/**
 * Mount health and readiness routes on an Express app.
 */
export function mountHealthRoutes(app: Express): void {
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: SERVICE_NAME,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      let ready = readinessState;
      for (const check of readinessChecks) {
        if (!(await check())) {
          ready = false;
          break;
        }
      }

      if (ready) {
        res.json({
          status: 'ready',
          service: SERVICE_NAME,
          timestamp: new Date().toISOString(),
        });
      } else {
        res.status(503).json({
          status: 'not_ready',
          service: SERVICE_NAME,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.error({ err }, 'Readiness check failed');
      res.status(503).json({
        status: 'error',
        service: SERVICE_NAME,
        timestamp: new Date().toISOString(),
      });
    }
  });
}

/**
 * Start a standalone health HTTP server on the specified port.
 * Used for testing; in production, routes are mounted on the main Express app.
 */
export async function startHealthServer(port: number): Promise<void> {
  if (server) {
    logger.warn('Health server already running');
    return;
  }

  const app = express();
  mountHealthRoutes(app);

  return new Promise((resolve, reject) => {
    server = app.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Health server started');
      resolve();
    });

    server.on('error', (err) => {
      logger.error({ err, port }, 'Health server error');
      reject(err);
    });
  });
}

/**
 * Stop the standalone health HTTP server.
 */
export async function stopHealthServer(): Promise<void> {
  if (!server) return;

  return new Promise((resolve, reject) => {
    server!.close((err) => {
      if (err) {
        logger.error({ err }, 'Error stopping health server');
        reject(err);
      } else {
        server = null;
        logger.info('Health server stopped');
        resolve();
      }
    });
  });
}
