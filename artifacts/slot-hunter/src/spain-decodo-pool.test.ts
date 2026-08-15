/**
 * spain-decodo-pool.test.ts
 *
 * Tests for pool-fingerprint mismatch detection in initDecodoPool().
 * Verifies that a changed pool composition (shrink, reorder, expand)
 * invalidates the saved Redis index and blacklist rather than applying
 * them to the wrong IPs.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Redis persistence ────────────────────────────────────────────────────
// Must be declared before any import of the module under test (vitest hoists vi.mock).

vi.mock("./spain-redis-persistence.js", () => ({
  restoreDecodoPoolStateFromRedis: vi.fn(),
  syncDecodoPoolStateToRedis: vi.fn(),
}));

import {
  reloadDecodoPool,
  initDecodoPool,
  getCurrentDecodoUrl,
} from "./spain-decodo-pool.js";
import {
  restoreDecodoPoolStateFromRedis,
  syncDecodoPoolStateToRedis,
} from "./spain-redis-persistence.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

const POOL = [
  "http://user:pass@host1:10001",
  "http://user:pass@host2:10002",
  "http://user:pass@host3:10003",
];

/** Mirror of the private computePoolFingerprint() in spain-decodo-pool.ts. */
function fingerprint(pool: string[]): string {
  const hash = createHash("sha256").update(pool.join("\n")).digest("hex").slice(0, 8);
  return `${pool.length}:${hash}`;
}

/** Reset the pool module state and set env so DECODO_PROXY_URLS drives the pool. */
function resetPool(urls: string[]): void {
  // Point DECODO_PROXY_FILE at a path that cannot exist so the CSV branch is skipped
  // and DECODO_PROXY_URLS drives the pool instead.
  process.env.DECODO_PROXY_FILE = "/nonexistent-test-proxy-file.csv";
  process.env.DECODO_PROXY_URLS = urls.join(",");
  reloadDecodoPool();
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("initDecodoPool — pool fingerprint mismatch detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores saved index when fingerprints match", async () => {
    resetPool(POOL);

    // Saved state: index 1 (0-based), no blacklisted IPs, matching fingerprint
    vi.mocked(restoreDecodoPoolStateFromRedis).mockResolvedValue({
      rotationIndex: 1,
      blacklistedIps: {},
      savedAt: Date.now() - 5_000,
      poolFingerprint: fingerprint(POOL),
    });

    await initDecodoPool();

    // initDecodoPool restores at rotationIndex+1 to avoid re-hitting the same IP
    // rotationIndex=1 → restored at index 2 → host3:10003
    expect(getCurrentDecodoUrl()).toBe(POOL[2]);

    // syncDecodoPoolStateToRedis must NOT be called during a clean restore
    // (no mismatch triggered, no immediate sync needed here)
    expect(vi.mocked(syncDecodoPoolStateToRedis)).not.toHaveBeenCalled();
  });

  it("resets index to 0 and clears blacklist when pool fingerprint changes", async () => {
    resetPool(POOL);

    const staleFingerprint = fingerprint(["http://user:pass@old-host:10001"]);

    vi.mocked(restoreDecodoPoolStateFromRedis).mockResolvedValue({
      rotationIndex: 2,
      blacklistedIps: {
        "http://user:pass@host1:10001": Date.now() - 1_000, // recently blacklisted
      },
      savedAt: Date.now() - 5_000,
      poolFingerprint: staleFingerprint, // saved with a different pool
    });

    await initDecodoPool();

    // Index must be reset to 0 (first IP of the new pool)
    expect(getCurrentDecodoUrl()).toBe(POOL[0]);

    // syncDecodoPoolStateToRedis must have been called with the NEW fingerprint
    // to overwrite the stale Redis entry
    expect(vi.mocked(syncDecodoPoolStateToRedis)).toHaveBeenCalledOnce();
    const [calledIdx, calledBlacklist, calledFingerprint] =
      vi.mocked(syncDecodoPoolStateToRedis).mock.calls[0];
    expect(calledIdx).toBe(0);
    expect(calledBlacklist.size).toBe(0); // blacklist cleared
    expect(calledFingerprint).toBe(fingerprint(POOL)); // new fingerprint stored
  });

  it("resets to index 0 and persists new fingerprint when no fingerprint is present (safe migration)", async () => {
    resetPool(POOL);

    // Old Redis entry without poolFingerprint — pool composition is unverifiable
    vi.mocked(restoreDecodoPoolStateFromRedis).mockResolvedValue({
      rotationIndex: 2,
      blacklistedIps: {
        "http://user:pass@host2:10002": Date.now() - 1_000, // stale blacklist entry
      },
      savedAt: Date.now() - 5_000,
      // poolFingerprint intentionally absent — simulates a pre-fix Redis entry
    });

    await initDecodoPool();

    // Unverifiable state must be discarded → reset to index 0
    expect(getCurrentDecodoUrl()).toBe(POOL[0]);

    // Must immediately persist the current fingerprint so the next restart is safe
    expect(vi.mocked(syncDecodoPoolStateToRedis)).toHaveBeenCalledOnce();
    const [calledIdx, calledBlacklist, calledFingerprint] =
      vi.mocked(syncDecodoPoolStateToRedis).mock.calls[0];
    expect(calledIdx).toBe(0);
    expect(calledBlacklist.size).toBe(0); // stale blacklist cleared
    expect(calledFingerprint).toBe(fingerprint(POOL));
  });

  it("falls back to random index when Redis has no saved state", async () => {
    resetPool(POOL);

    vi.mocked(restoreDecodoPoolStateFromRedis).mockResolvedValue(null);

    await initDecodoPool();

    // With no Redis state, a random index is chosen — just verify we get a valid URL
    const url = getCurrentDecodoUrl();
    expect(POOL).toContain(url);
  });
});
