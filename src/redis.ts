/**
 * Redis client with distributed lock and idempotency support.
 *
 * Uses ioredis for connection management and Lua scripts for
 * atomic lock release/extend operations.
 */

import { Redis } from "ioredis";
import { logger } from "./logger.js";
import { REDIS_URL } from "./config.js";

let client: Redis | null = null;

/**
 * Lua script: release lock only if the current owner matches.
 * Returns 1 if released, 0 if owner mismatch or key missing.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Lua script: extend lock TTL only if the current owner matches.
 * Returns 1 if extended, 0 if owner mismatch or key missing.
 */
const EXTEND_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Initialize the Redis client and connect.
 *
 * @param url - Redis connection URL (defaults to REDIS_URL config)
 * @returns Connected Redis client
 */
export async function initRedis(url?: string): Promise<Redis> {
  const redisUrl = url || REDIS_URL;

  client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 5000);
      return delay;
    },
    lazyConnect: true,
  });

  client.on("error", (err: Error) => {
    logger.error({ err }, "Redis connection error");
  });

  client.on("connect", () => {
    logger.info("Redis connected");
  });

  await client.connect();
  return client;
}

/**
 * Get the connected Redis client.
 *
 * @throws Error if Redis has not been initialized
 */
export function getRedis(): Redis {
  if (!client) {
    throw new Error("Redis not initialized - call initRedis() first");
  }
  return client;
}

/**
 * Acquire a distributed lock using SET NX EX.
 *
 * @param key - Lock key
 * @param owner - Unique owner identifier for safe release
 * @param ttlSeconds - Lock expiry in seconds (default 300)
 * @returns true if lock acquired, false if already held
 */
export async function acquireLock(
  key: string,
  owner: string,
  ttlSeconds: number = 300,
): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(key, owner, "EX", ttlSeconds, "NX");
  return result === "OK";
}

/**
 * Release a distributed lock only if the caller is the current owner.
 * Uses a Lua script for atomicity.
 *
 * @param key - Lock key
 * @param owner - Owner identifier that must match the lock holder
 * @returns true if released, false if owner mismatch or key missing
 */
export async function releaseLock(
  key: string,
  owner: string,
): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, owner);
  return result === 1;
}

/**
 * Extend a distributed lock TTL only if the caller is the current owner.
 * Uses a Lua script for atomicity.
 *
 * @param key - Lock key
 * @param owner - Owner identifier that must match the lock holder
 * @param ttlSeconds - New TTL in seconds (default 300)
 * @returns true if extended, false if owner mismatch or key missing
 */
export async function extendLock(
  key: string,
  owner: string,
  ttlSeconds: number = 300,
): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.eval(
    EXTEND_LOCK_SCRIPT,
    1,
    key,
    owner,
    ttlSeconds.toString(),
  );
  return result === 1;
}

/**
 * Set an idempotency key with a value and TTL.
 * Only sets if the key does not already exist (NX).
 *
 * @param key - Idempotency key
 * @param value - Value to store
 * @param ttlSeconds - Expiry in seconds (default 3600)
 * @returns true if key was new and set, false if already exists
 */
export async function setIdempotencyKey(
  key: string,
  value: string,
  ttlSeconds: number = 3600,
): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(key, value, "EX", ttlSeconds, "NX");
  return result === "OK";
}

/**
 * Check an idempotency key.
 *
 * @param key - Idempotency key to look up
 * @returns The stored value, or null if not found
 */
export async function checkIdempotencyKey(key: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get(key);
}

/**
 * Gracefully disconnect from Redis.
 */
export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
    logger.info("Redis disconnected");
  }
}
