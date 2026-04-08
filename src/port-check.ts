/**
 * Port conflict detection for bounty-bot service.
 * Fails fast if any port in the bounty-bot allocation (3235-3239) is already in use.
 */

import { createServer } from "net";
import { logger } from "./logger.js";
import {
  PORT_RANGE_START,
  PORT_RANGE_END,
  DEFAULT_API_PORT,
} from "./config.js";

/**
 * Check if a port is already in use.
 */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer()
      .once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          resolve(true);
        } else {
          logger.warn({ err, port }, "Unexpected port check error");
          resolve(false);
        }
      })
      .once("listening", () => {
        tester.close(() => resolve(false));
      })
      .listen(port, "0.0.0.0");
  });
}

/**
 * Check all bounty-bot ports for conflicts.
 * Throws an error if any port in 3235-3239 is already bound.
 */
export async function checkPortConflicts(): Promise<void> {
  const conflicts: number[] = [];

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortInUse(port)) {
      conflicts.push(port);
    }
  }

  if (conflicts.length > 0) {
    const conflictList = conflicts.join(", ");
    logger.fatal(
      { conflicts },
      `Port conflict detected: ports ${conflictList} are already in use. ` +
        `Bounty-bot requires exclusive use of ports ${PORT_RANGE_START}-${PORT_RANGE_END}. ` +
        `Stop conflicting services or adjust port allocation.`,
    );
    throw new Error(
      `Port conflict: ports ${conflictList} are already in use. ` +
        `Bounty-bot requires ports ${PORT_RANGE_START}-${PORT_RANGE_END} to be free.`,
    );
  }

  logger.info("Port conflict check passed - all bounty-bot ports available");
}

/**
 * Get the configured bounty-bot API port from environment.
 */
export function getApiPort(): number {
  const port = parseInt(process.env.PORT || String(DEFAULT_API_PORT), 10);

  if (port < PORT_RANGE_START || port > PORT_RANGE_END) {
    logger.warn(
      { port, range: `${PORT_RANGE_START}-${PORT_RANGE_END}` },
      "Port outside bounty-bot allocation range",
    );
  }

  return port;
}
