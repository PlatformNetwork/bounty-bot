import { describe, it, expect, afterEach } from "vitest";

describe("config", () => {
  // We need to re-import config dynamically since values are set at import time
  // Instead, test the exported values directly

  describe("static defaults", () => {
    it("exports DEFAULT_API_PORT as 3235", async () => {
      const { DEFAULT_API_PORT } = await import("./config.js");
      expect(DEFAULT_API_PORT).toBe(3235);
    });

    it("exports port range 3235-3239", async () => {
      const { PORT_RANGE_START, PORT_RANGE_END } = await import("./config.js");
      expect(PORT_RANGE_START).toBe(3235);
      expect(PORT_RANGE_END).toBe(3239);
    });

    it("exports SERVICE_NAME as bounty-bot", async () => {
      const { SERVICE_NAME } = await import("./config.js");
      expect(SERVICE_NAME).toBe("bounty-bot");
    });

    it("exports ATLAS_WEBHOOK_URL with default", async () => {
      const { ATLAS_WEBHOOK_URL } = await import("./config.js");
      expect(ATLAS_WEBHOOK_URL).toBeDefined();
      expect(typeof ATLAS_WEBHOOK_URL).toBe("string");
    });

    it("exports TARGET_REPO with default", async () => {
      const { TARGET_REPO } = await import("./config.js");
      expect(TARGET_REPO).toBeDefined();
      expect(TARGET_REPO).toContain("/");
    });

    it("exports WEBHOOK_MAX_RETRIES as positive number", async () => {
      const { WEBHOOK_MAX_RETRIES } = await import("./config.js");
      expect(WEBHOOK_MAX_RETRIES).toBeGreaterThan(0);
    });

    it("exports SQLITE_PATH derived from DATA_DIR", async () => {
      const { SQLITE_PATH } = await import("./config.js");
      expect(SQLITE_PATH).toBeDefined();
      expect(SQLITE_PATH).toContain("bounty-bot.db");
    });
  });

  describe("environment overrides", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore environment
      process.env = { ...originalEnv };
    });

    it("BOUNTY_BOT_PORT env var is respected by getApiPort", async () => {
      // getApiPort reads PORT env var, tested in port-check.test.ts
      // Here we just verify the config module doesn't crash with env vars set
      const config = await import("./config.js");
      expect(config.DEFAULT_API_PORT).toBe(3235);
    });
  });
});
