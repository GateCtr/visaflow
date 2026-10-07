import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real pool/persistence code, but no actual Redis, proxies, portal or captcha.
const redis = vi.hoisted(() => ({
  records: new Map<string, string>(),
  connect: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
}));
vi.mock("redis", () => ({ createClient: () => redis }));

import {
  flagDecodoIp,
  getCurrentDecodoUrl,
  getValidDecodoProxyFromIndex,
  initDecodoPool,
  isDecodoIpBlacklisted,
  reloadDecodoPool,
  rotateDecodoUrl,
} from "./spain-decodo-pool.js";
import {
  initSpainRedis,
  loadWorkerCfClearance,
  saveWorkerCfClearance,
} from "./spain-redis-persistence.js";

const DAY = 24 * 60 * 60_000;
const POOL = ["http://user:pass@host1:10001", "http://user:pass@host2:10002"];

beforeAll(async () => {
  redis.set.mockImplementation(async (key: string, value: string) => {
    redis.records.set(key, value);
    return "OK";
  });
  redis.get.mockImplementation(async (key: string) => redis.records.get(key) ?? null);
  redis.del.mockImplementation(async (key: string) => Number(redis.records.delete(key)));
  vi.stubEnv("REDIS_URL", "redis://example.invalid:6379");
  vi.useFakeTimers();
  expect(await initSpainRedis()).toBe(true);
  vi.clearAllTimers();
  vi.useRealTimers();
});

beforeEach(() => {
  redis.records.clear();
  vi.clearAllMocks();
  vi.stubEnv("DECODO_PROXY_FILE", "/nonexistent-decodo-test-pool.csv");
  vi.stubEnv("DECODO_PROXY_URLS", POOL.join(","));
  vi.stubEnv("SPAIN_DECODO_BLACKLIST_TTL_MIN", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  reloadDecodoPool();
});

afterEach(() => {
  reloadDecodoPool();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => vi.unstubAllEnvs());

describe("Spain seven-day proxy quarantine persistence", () => {
  it("does not expire the pool snapshot before the proxy quarantine", () => {
    flagDecodoIp(POOL[0], "portal-rejected");

    const call = redis.set.mock.calls.at(-1)!;
    expect(call).toHaveLength(2); // No EX 24h or KEEPTTL on this key.
    expect(JSON.parse(call[1]).blacklistedIps["host1:10001"]).toBeTypeOf("number");
  });

  it("keeps a rejected proxy excluded after CF expiry and restart, until exactly seven days", async () => {
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    flagDecodoIp(POOL[0], "portal-rejected");
    saveWorkerCfClearance(POOL[0], "test-clearance", start + 115 * 60_000);

    // The short-lived clearance is gone, but that does not lift the exclusion.
    vi.mocked(Date.now).mockReturnValue(start + 2 * DAY);
    expect(await loadWorkerCfClearance(POOL[0])).toBeNull();
    reloadDecodoPool();
    await initDecodoPool();
    expect(isDecodoIpBlacklisted(POOL[0])).toBe(true);
    expect(getCurrentDecodoUrl()).toBe(POOL[1]);

    vi.mocked(Date.now).mockReturnValue(start + 7 * DAY - 1);
    expect(isDecodoIpBlacklisted(POOL[0])).toBe(true);
    vi.mocked(Date.now).mockReturnValue(start + 7 * DAY);
    expect(isDecodoIpBlacklisted(POOL[0])).toBe(false);
    expect(rotateDecodoUrl()).toBe(POOL[0]);
  });

  it("rewrites a restored snapshot without preserving its legacy 24-hour expiry", async () => {
    flagDecodoIp(POOL[0], "portal-rejected");
    redis.set.mockClear();
    reloadDecodoPool();
    await initDecodoPool();

    expect(redis.set).toHaveBeenCalledOnce();
    expect(redis.set.mock.calls[0]).toHaveLength(2);
    expect(isDecodoIpBlacklisted(POOL[0])).toBe(true);
  });

  it("does not bypass quarantine after restarting with a single rejected proxy", async () => {
    vi.stubEnv("DECODO_PROXY_URLS", POOL[0]);
    reloadDecodoPool();
    flagDecodoIp(POOL[0], "portal-rejected");
    reloadDecodoPool();
    await initDecodoPool();

    expect(getCurrentDecodoUrl()).toBeUndefined();
    expect(rotateDecodoUrl()).toBeUndefined();
    expect(getValidDecodoProxyFromIndex(0)).toBeUndefined();
  });
});
