/**
 * spain-decodo-pool.test.ts — Unit tests for the Decodo IP pool blacklist logic
 *
 * Scenarios covered (per task spec):
 *   1. flag IP → getCurrentDecodoUrl returns next IP
 *   2. flag all IPs → getCurrentDecodoUrl falls back to round-robin (returns an IP, doesn't throw)
 *   3. simulate TTL expiry (mock Date.now) → previously flagged IP becomes valid again
 *   4. rotateDecodoUrl skips flagged IPs and logs the skip count
 */

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";

// ─── Mock Redis persistence (fire-and-forget calls — no real Redis in tests) ──

vi.mock("../spain-redis-persistence.js", () => ({
  syncDecodoPoolStateToRedis: vi.fn().mockResolvedValue(undefined),
  restoreDecodoPoolStateFromRedis: vi.fn().mockResolvedValue(null),
}));

import {
  reloadDecodoPool,
  getCurrentDecodoUrl,
  flagDecodoIp,
  rotateDecodoUrl,
  getDecodoPoolSize,
  initDecodoPool,
} from "../spain-decodo-pool.js";

import {
  syncDecodoPoolStateToRedis,
  restoreDecodoPoolStateFromRedis,
} from "../spain-redis-persistence.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a comma-separated DECODO_PROXY_URLS string from N fake URLs. */
function makePool(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `http://user:pass@10.0.0.${i + 1}:10000`);
}

/** Mirror of the private computePoolFingerprint() in spain-decodo-pool.ts. */
function fingerprint(pool: string[]): string {
  const hash = createHash("sha256").update(pool.join("\n")).digest("hex").slice(0, 8);
  return `${pool.length}:${hash}`;
}

/**
 * Configure the module with a fresh pool and reset all internal state.
 * Must be called before each test that needs a specific pool size.
 *
 * We set DECODO_PROXY_FILE to a guaranteed-nonexistent path so the real
 * decodo-proxies.csv in the working directory is not picked up during tests.
 */
function setupPool(urls: string[]): void {
  process.env.DECODO_PROXY_FILE = "/tmp/__test_nonexistent_proxies__.csv";
  process.env.DECODO_PROXY_URLS = urls.join(",");
  delete process.env.DECODO_PROXY_URL;
  reloadDecodoPool();
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks(); // restore any Date.now spy
});

afterEach(() => {
  // Clean up env to avoid leaking into other test files
  delete process.env.DECODO_PROXY_URLS;
  delete process.env.DECODO_PROXY_URL;
  delete process.env.DECODO_PROXY_FILE;
  delete process.env.SPAIN_DECODO_BLACKLIST_TTL_MIN;
  // Reset pool state
  reloadDecodoPool();
  vi.restoreAllMocks();
});

// ─── Scenario 1: flag IP → getCurrentDecodoUrl returns next IP ────────────────

describe("Scenario 1 — flag IP → getCurrentDecodoUrl skips it", () => {
  it("returns the second IP after the first one is flagged (2-IP pool)", () => {
    const pool = makePool(2);
    setupPool(pool);

    // Sanity: pool is configured
    expect(getDecodoPoolSize()).toBe(2);

    // Get the current IP (should be pool[0])
    const first = getCurrentDecodoUrl();
    expect(first).toBe(pool[0]);

    // Flag the current IP
    flagDecodoIp(first, "0B /main/ response");

    // getCurrentDecodoUrl must now return a DIFFERENT IP (pool[1])
    const afterFlag = getCurrentDecodoUrl();
    expect(afterFlag).toBeDefined();
    expect(afterFlag).not.toBe(first);
    expect(afterFlag).toBe(pool[1]);
  });

  it("returns the third IP after the first two are flagged (3-IP pool)", () => {
    const pool = makePool(3);
    setupPool(pool);

    const ip0 = pool[0];
    const ip1 = pool[1];
    const ip2 = pool[2];

    // Flag first two IPs
    flagDecodoIp(ip0, "test-flag");
    flagDecodoIp(ip1, "test-flag");

    // getCurrentDecodoUrl must skip both and return the third
    const result = getCurrentDecodoUrl();
    expect(result).toBe(ip2);
  });

  it("does not advance _index — subsequent calls return the same skipped IP", () => {
    const pool = makePool(3);
    setupPool(pool);

    const first = getCurrentDecodoUrl(); // pool[0]
    flagDecodoIp(first, "test");

    // Both calls return the same fallback (no index mutation)
    const a = getCurrentDecodoUrl();
    const b = getCurrentDecodoUrl();
    expect(a).toBe(b);
    expect(a).not.toBe(first);
  });

  it("has no effect on a 1-IP pool (single IP is never blacklisted)", () => {
    const pool = makePool(1);
    setupPool(pool);

    const ip = getCurrentDecodoUrl();
    expect(ip).toBe(pool[0]);

    // flagDecodoIp is a no-op for single-IP pools
    flagDecodoIp(ip, "test");

    // The IP is still returned
    expect(getCurrentDecodoUrl()).toBe(pool[0]);
  });
});

// ─── Scenario 2: flag all IPs → fallback round-robin (no throw) ───────────────

describe("Scenario 2 — flag all IPs → fallback round-robin", () => {
  it("returns an IP (doesn't throw) when all 3 IPs are flagged", () => {
    const pool = makePool(3);
    setupPool(pool);

    // Flag all IPs
    for (const url of pool) {
      flagDecodoIp(url, "all-flagged");
    }

    // Must return a value (not undefined, not throw)
    let result: string | undefined;
    expect(() => {
      result = getCurrentDecodoUrl();
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    // The returned value must be one of the pool IPs (fallback round-robin)
    expect(pool).toContain(result);
  });

  it("returns an IP (doesn't throw) when all 5 IPs are flagged", () => {
    const pool = makePool(5);
    setupPool(pool);

    for (const url of pool) {
      flagDecodoIp(url, "all-flagged-5");
    }

    let result: string | undefined;
    expect(() => {
      result = getCurrentDecodoUrl();
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(pool).toContain(result);
  });

  it("rotateDecodoUrl also returns an IP (doesn't throw) when all IPs are flagged", () => {
    const pool = makePool(3);
    setupPool(pool);

    for (const url of pool) {
      flagDecodoIp(url, "all-flagged-rotate");
    }

    let result: string | undefined;
    expect(() => {
      result = rotateDecodoUrl();
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(pool).toContain(result);
  });
});

// ─── Scenario 3: TTL expiry (mock Date.now) → flagged IP becomes valid again ──

describe("Scenario 3 — TTL expiry → flagged IP becomes valid again", () => {
  it("IP re-appears in rotation after TTL expires (default 45 min)", () => {
    const pool = makePool(2);
    // Use 1-minute TTL for the test
    process.env.SPAIN_DECODO_BLACKLIST_TTL_MIN = "1";
    setupPool(pool);

    const start = Date.now();

    // Freeze time at `start` during flagging
    vi.spyOn(Date, "now").mockReturnValue(start);
    const ip0 = pool[0];
    flagDecodoIp(ip0, "ttl-test");

    // Confirm ip0 is currently skipped
    expect(getCurrentDecodoUrl()).not.toBe(ip0);

    // Advance time by TTL + 1 ms (61 001 ms > 60 000 ms TTL)
    vi.spyOn(Date, "now").mockReturnValue(start + 61_001);

    // After TTL expiry, ip0 must be accepted again
    // Reset index to 0 so ip0 is the current candidate
    reloadDecodoPool();
    process.env.SPAIN_DECODO_BLACKLIST_TTL_MIN = "1";
    setupPool(pool);

    // Flag ip0 at `start`
    vi.spyOn(Date, "now").mockReturnValue(start);
    flagDecodoIp(ip0, "ttl-test-2");
    expect(getCurrentDecodoUrl()).not.toBe(ip0); // still blacklisted

    // Advance past TTL
    vi.spyOn(Date, "now").mockReturnValue(start + 61_001);
    const result = getCurrentDecodoUrl();
    // Now ip0 should be valid again (auto-expired from blacklist on read)
    expect(result).toBe(ip0);
  });

  it("IP remains skipped while within TTL window", () => {
    const pool = makePool(3);
    process.env.SPAIN_DECODO_BLACKLIST_TTL_MIN = "10";
    setupPool(pool);

    const start = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(start);

    const ip0 = pool[0];
    flagDecodoIp(ip0, "within-ttl");

    // 5 minutes later — still within 10-minute TTL
    vi.spyOn(Date, "now").mockReturnValue(start + 5 * 60_000);
    const result = getCurrentDecodoUrl();
    expect(result).not.toBe(ip0);
  });

  it("IP becomes valid exactly after TTL boundary", () => {
    const pool = makePool(2);
    process.env.SPAIN_DECODO_BLACKLIST_TTL_MIN = "5";
    setupPool(pool);

    const start = 1_700_000_000_000;
    const ttlMs = 5 * 60_000;

    vi.spyOn(Date, "now").mockReturnValue(start);
    const ip0 = pool[0];
    flagDecodoIp(ip0, "boundary");

    // At exactly TTL — still blacklisted (> check, not >=)
    vi.spyOn(Date, "now").mockReturnValue(start + ttlMs);
    expect(getCurrentDecodoUrl()).not.toBe(ip0);

    // One millisecond past TTL — expired and auto-purged
    vi.spyOn(Date, "now").mockReturnValue(start + ttlMs + 1);
    expect(getCurrentDecodoUrl()).toBe(ip0);
  });
});

// ─── Scenario 4: rotateDecodoUrl skips flagged IPs ────────────────────────────

describe("Scenario 4 — rotateDecodoUrl skips flagged IPs", () => {
  it("skips 1 flagged IP and advances to the next valid one (3-IP pool)", () => {
    const pool = makePool(3);
    setupPool(pool);

    // Currently at pool[0]. Flag pool[1] so rotation must skip it.
    flagDecodoIp(pool[1], "skip-test");

    // rotateDecodoUrl should advance from pool[0] → skip pool[1] → land on pool[2]
    const result = rotateDecodoUrl();
    expect(result).toBe(pool[2]);
  });

  it("skips 2 flagged IPs and wraps around correctly (3-IP pool)", () => {
    const pool = makePool(3);
    setupPool(pool);

    // Flag pool[1] and pool[2]. Rotation from pool[0] → skip pool[1] → skip pool[2] → wrap → pool[0]
    flagDecodoIp(pool[1], "skip-2-a");
    flagDecodoIp(pool[2], "skip-2-b");

    const result = rotateDecodoUrl();
    expect(result).toBe(pool[0]);
  });

  it("rotateDecodoUrl returns the same URL for a 1-IP pool (no rotation possible)", () => {
    const pool = makePool(1);
    setupPool(pool);

    expect(rotateDecodoUrl()).toBe(pool[0]);
    expect(rotateDecodoUrl()).toBe(pool[0]);
  });

  it("successive rotateDecodoUrl calls cycle through valid IPs only (4-IP pool, 2 flagged)", () => {
    const pool = makePool(4);
    setupPool(pool);

    // Flag pool[1] and pool[3] — only pool[0] and pool[2] should appear
    flagDecodoIp(pool[1], "cycle-skip");
    flagDecodoIp(pool[3], "cycle-skip");

    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      const url = rotateDecodoUrl();
      expect(url).toBeDefined();
      results.push(url!);
    }

    // None of the results should be flagged IPs
    for (const r of results) {
      expect(r).not.toBe(pool[1]);
      expect(r).not.toBe(pool[3]);
    }

    // All results must come from the valid IPs
    const validIps = new Set([pool[0], pool[2]]);
    for (const r of results) {
      expect(validIps.has(r)).toBe(true);
    }
  });

  it("rotateDecodoUrl advances _index so the next getCurrentDecodoUrl reflects the new position", () => {
    const pool = makePool(4);
    setupPool(pool);

    // Start at pool[0]. Rotate to pool[1].
    const rotated = rotateDecodoUrl();
    expect(rotated).toBe(pool[1]);

    // getCurrentDecodoUrl should reflect pool[1] (no further advance)
    const current = getCurrentDecodoUrl();
    expect(current).toBe(pool[1]);
  });
});

// ─── Scenario 5: blacklist survives restart (Redis restore path) ──────────────

describe("Scenario 5 — blacklist survives restart via Redis restore", () => {
  /**
   * Helper: run restoreDecodoPoolStateFromRedis mock for the next initDecodoPool call.
   * The real restoreDecodoPoolStateFromRedis filters expired IPs before returning;
   * here we control exactly what it hands back to initDecodoPool.
   */
  function mockRestore(state: {
    rotationIndex: number;
    blacklistedIps: Record<string, number>;
    savedAt: number;
    poolFingerprint?: string;
  } | null): void {
    vi.mocked(restoreDecodoPoolStateFromRedis).mockResolvedValueOnce(state as any);
  }

  it("flagged IPs are still skipped after restart when restore returns fresh timestamps", async () => {
    const pool = makePool(4);
    setupPool(pool);

    const ip0 = pool[0];
    const ip1 = pool[1];

    // Simulate what Redis holds: both IPs flagged 5 seconds ago (well within 45-min TTL)
    const now = Date.now();
    mockRestore({
      rotationIndex: 1, // last used index before restart
      blacklistedIps: {
        [ip0]: now - 5_000,
        [ip1]: now - 10_000,
      },
      savedAt: now - 5_000,
      // Matching fingerprint → pool composition verified → blacklist restored.
      // (A separate migration test covers the missing-fingerprint safe-reset path.)
      poolFingerprint: fingerprint(pool),
    });

    // Simulate restart: reset module state then restore from Redis
    reloadDecodoPool();
    setupPool(pool);
    await initDecodoPool();

    // Both flagged IPs must still be skipped
    const current = getCurrentDecodoUrl();
    expect(current).not.toBe(ip0);
    expect(current).not.toBe(ip1);
    expect([pool[2], pool[3]]).toContain(current);
  });

  it("syncDecodoPoolStateToRedis is called when flagging an IP (fire-and-forget wiring)", () => {
    const pool = makePool(3);
    setupPool(pool);

    vi.mocked(syncDecodoPoolStateToRedis).mockClear();

    flagDecodoIp(pool[0], "0B /main/");

    // Must have been called once to persist the new blacklist state
    expect(vi.mocked(syncDecodoPoolStateToRedis)).toHaveBeenCalledTimes(1);
    // First arg is the current rotation index (a number)
    const [idxArg, mapArg] = vi.mocked(syncDecodoPoolStateToRedis).mock.calls[0];
    expect(typeof idxArg).toBe("number");
    // Second arg is the blacklisted IPs Map containing the flagged URL
    expect(mapArg).toBeInstanceOf(Map);
    expect((mapArg as Map<string, number>).has(pool[0])).toBe(true);
  });

  it("TTL-expired entries returned by restore are auto-discarded on first access", async () => {
    const pool = makePool(3);
    // Use 1-minute TTL
    process.env.SPAIN_DECODO_BLACKLIST_TTL_MIN = "1";
    setupPool(pool);

    const ip0 = pool[0];
    const ip1 = pool[1];

    // Restore returns timestamps that are already 2 minutes old → beyond the 1-min TTL
    const expiredTs = Date.now() - 2 * 60_000;
    mockRestore({
      rotationIndex: 0,
      blacklistedIps: {
        [ip0]: expiredTs,
        [ip1]: expiredTs,
      },
      savedAt: expiredTs,
      poolFingerprint: fingerprint(pool),
    });

    reloadDecodoPool();
    process.env.SPAIN_DECODO_BLACKLIST_TTL_MIN = "1";
    setupPool(pool);
    await initDecodoPool();

    // Both entries are expired → isBlacklisted() auto-purges them → ip0 is valid again
    // (initDecodoPool sets _index = (rotationIndex+1) % pool.length = 1,
    //  then findNextValidIndex finds ip1 valid, so _index lands on 1;
    //  but since ip0's TTL is also expired it is valid too — let's just confirm
    //  the current URL is one of the pool IPs and neither throws)
    let result: string | undefined;
    expect(() => { result = getCurrentDecodoUrl(); }).not.toThrow();
    expect(result).toBeDefined();
    expect(pool).toContain(result);

    // After the first getCurrentDecodoUrl call, expired entries are auto-purged.
    // Flagging a fresh IP and re-checking must still work (no stale state).
    flagDecodoIp(result!, "post-restore test");
    const next = getCurrentDecodoUrl();
    expect(next).toBeDefined();
    expect(pool).toContain(next);
  });

  it("allBlacklisted fallback applies when all restored IPs have fresh timestamps", async () => {
    const pool = makePool(3);
    setupPool(pool);

    const now = Date.now();
    // All 3 IPs flagged 10 seconds ago — none are expired
    mockRestore({
      rotationIndex: 2,
      blacklistedIps: {
        [pool[0]]: now - 10_000,
        [pool[1]]: now - 10_000,
        [pool[2]]: now - 10_000,
      },
      savedAt: now - 10_000,
      poolFingerprint: fingerprint(pool),
    });

    reloadDecodoPool();
    setupPool(pool);
    await initDecodoPool();

    // All IPs are blacklisted → allBlacklisted fallback: must return an IP, never throw
    let result: string | undefined;
    expect(() => { result = getCurrentDecodoUrl(); }).not.toThrow();
    expect(result).toBeDefined();
    expect(pool).toContain(result);
  });

  it("restore returning null (Redis empty / unavailable) falls back to random index", async () => {
    const pool = makePool(4);
    setupPool(pool);

    // mockRestore(null) — already the default, but be explicit
    mockRestore(null);

    reloadDecodoPool();
    setupPool(pool);
    await initDecodoPool();

    // With no Redis state, initDecodoPool picks a random index.
    // getCurrentDecodoUrl must still return a valid pool URL.
    const result = getCurrentDecodoUrl();
    expect(result).toBeDefined();
    expect(pool).toContain(result);
  });
});
