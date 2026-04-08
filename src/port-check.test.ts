import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "net";
import { isPortInUse, checkPortConflicts, getApiPort } from "./port-check.js";

describe("port-check", () => {
  describe("isPortInUse", () => {
    it("returns false for an unused port", async () => {
      const result = await isPortInUse(54322);
      expect(result).toBe(false);
    });

    it("returns true for a port in use", async () => {
      const server = createServer();
      const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as { port: number }).port);
        });
      });

      const result = await isPortInUse(port);
      expect(result).toBe(true);

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });

  describe("checkPortConflicts", () => {
    it("passes when all ports are free", async () => {
      // Skip this test if ports are already in use (e.g., services running)
      const apiPort = await isPortInUse(3235);
      if (apiPort) {
        // Ports are in use - test passes by verifying conflict detection works
        await expect(checkPortConflicts()).rejects.toThrow(/Port conflict/);
        return;
      }
      // In CI with free ports this should pass
      await expect(checkPortConflicts()).resolves.not.toThrow();
    });
  });

  describe("getApiPort", () => {
    const originalPort = process.env.PORT;

    afterEach(() => {
      if (originalPort) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
    });

    it("returns default port 3235 when not set", () => {
      delete process.env.PORT;
      expect(getApiPort()).toBe(3235);
    });

    it("returns configured port from environment", () => {
      process.env.PORT = "3237";
      expect(getApiPort()).toBe(3237);
    });
  });
});
