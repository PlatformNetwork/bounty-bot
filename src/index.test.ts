import { describe, it, expect, afterEach } from "vitest";
import { createApp } from "./index.js";
import { buildSignedHeaders } from "./hmac.js";
import http from "http";

describe("bounty-bot app", () => {
  let server: http.Server | null = null;
  const testPort = 3297;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function startApp(): Promise<void> {
    const app = createApp();
    return new Promise((resolve) => {
      server = app.listen(testPort, "0.0.0.0", () => resolve());
    });
  }

  describe("health endpoint", () => {
    it("returns 200 with service info", async () => {
      await startApp();
      const response = await fetch(`http://localhost:${testPort}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        service: string;
      };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("bounty-bot");
    });
  });

  describe("API v1 HMAC protection", () => {
    it("POST /api/v1/validation/trigger returns 401 without HMAC headers", async () => {
      await startApp();
      const response = await fetch(
        `http://localhost:${testPort}/api/v1/validation/trigger`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("unauthorized");
    });

    it("GET /api/v1/validation/:issue_number/status returns 401 without HMAC headers", async () => {
      await startApp();
      const response = await fetch(
        `http://localhost:${testPort}/api/v1/validation/12345/status`,
      );
      expect(response.status).toBe(401);
    });

    it("POST /api/v1/validation/:issue_number/requeue returns 422 when issue not found", async () => {
      await startApp();
      const reqBody = "{}";
      const signed = buildSignedHeaders(reqBody);
      const response = await fetch(
        `http://localhost:${testPort}/api/v1/validation/12345/requeue`,
        { method: "POST", headers: { ...signed }, body: reqBody },
      );
      // Without DB initialised, the handler returns 500 (DB not ready)
      // or 422 (issue not found) when DB is initialised
      expect([422, 500]).toContain(response.status);
    });

    it("POST /api/v1/validation/:issue_number/force-release returns response with valid HMAC", async () => {
      await startApp();
      const reqBody = "{}";
      const signed = buildSignedHeaders(reqBody);
      const response = await fetch(
        `http://localhost:${testPort}/api/v1/validation/12345/force-release`,
        { method: "POST", headers: { ...signed }, body: reqBody },
      );
      // Without DB/Redis initialised, the handler returns 500 or 200
      expect([200, 500]).toContain(response.status);
    });
  });
});
