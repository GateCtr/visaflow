# Design Document — proxy-service-extraction

## Architecture Overview

The proxy-service extraction transforms `artifacts/proxy-service` from an Express HTTP server into a pure TypeScript library. All proxy-related logic currently scattered across `artifacts/slot-hunter/src/` is consolidated into this single package, consumed via pnpm workspace protocol (`@workspace/proxy-service`) with subpath exports.

```
┌─────────────────────────────────────────────────────────────────┐
│  artifacts/slot-hunter (consumer)                               │
│                                                                 │
│  index.ts ─── creates ProxyPool ─── passes to consumers        │
│     │                                                           │
│     ├── usaPortal/impl.ts     → import from /brightdata, /health│
│     ├── spain-persistent.ts   → import from /decodo             │
│     ├── browser.ts            → NO proxy code (clean)           │
│     └── ...other consumers    → import from /pool, /sources     │
└─────────────────────┬───────────────────────────────────────────┘
                      │ @workspace/proxy-service/*
┌─────────────────────▼───────────────────────────────────────────┐
│  artifacts/proxy-service (library)                              │
│                                                                 │
│  package.json: "type": "module", exports: { subpath entries }   │
│                                                                 │
│  src/                                                           │
│  ├── index.ts            ← barrel re-export                    │
│  ├── utils.ts            ← parseHttpProxyUrlForPlaywright,      │
│  │                         detectPublicIp                       │
│  ├── pool/                                                      │
│  │   ├── index.ts        ← ProxyPool class + types             │
│  │   └── types.ts        ← PoolState, StickyProxy interfaces   │
│  ├── health/                                                    │
│  │   ├── index.ts        ← barrel                              │
│  │   ├── pre-flight.ts   ← preFlightProxyCheck (Impit)         │
│  │   └── session-guard.ts← mid-session liveness + freeze       │
│  ├── whitelist/                                                 │
│  │   └── index.ts        ← autoWhitelistIp, cleanup functions  │
│  ├── decodo/                                                    │
│  │   ├── index.ts        ← barrel                              │
│  │   ├── spain.ts        ← Spain Decodo pool (CSV, round-robin)│
│  │   └── germany.ts      ← Germany Decodo pool                 │
│  ├── brightdata/                                                │
│  │   ├── index.ts        ← barrel                              │
│  │   ├── sticky.ts       ← makeBrightDataStickyUrl, fallback   │
│  │   ├── keep-alive.ts   ← startBrightDataKeepAlive, stop      │
│  │   └── fixed-ip.ts     ← buildBrightDataUrl, parseBrightData,│
│  │                         brightDataToCapSolverFormat          │
│  └── sources/                                                   │
│      ├── index.ts        ← barrel                              │
│      ├── brightdata.ts   ← existing BrightData source wrapper  │
│      ├── iproyal.ts      ← existing iProyal source wrapper     │
│      └── static.ts       ← existing static source wrapper      │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. ProxyPool (`src/pool/`)

The core ProxyPool class managing 2captcha gateway-based residential proxies with sticky sessions.

```typescript
// src/pool/types.ts
export interface PoolState {
  size: number;
  lastRefreshAt: string | null;
  serverIp: string | null;
  whitelistError: boolean;
  whitelistErrorAt: string | null;
  mode: '2captcha-gateway' | 'unconfigured';
  stickyCount: number;
}

export interface StickyProxy {
  proxy: string;
  expiresAt: number;
}
```

```typescript
// src/pool/index.ts
export class ProxyPool {
  constructor(apiKey: string);

  get isConfigured(): boolean;
  get stickyCount(): number;

  initialize(ip: string): Promise<void>;
  getState(): PoolState;
  getProxy(): Promise<{ proxy: string; expiresAt: string } | null>;
  getStickyProxy(accountKey: string): Promise<string | null>;
  getStickyProxyInfo(accountKey: string): StickyProxy | null;
  releaseStickyProxy(accountKey: string): void;
  rotateStickyProxy(accountKey: string): Promise<string | null>;
  forceWhitelistRefresh(): Promise<{ ok: boolean; message: string; serverIp: string | null }>;
}
```

Key design decisions:
- Session ID generation uses the existing V10 windowed algorithm (per-account offset via hash, 12h windows) — unchanged.
- `TWOCAPTCHA_PROXY_USER` env var read at module scope (gateway mode auth).
- The class is NOT a singleton — callers instantiate via factory in `index.ts`.

### 2. Health Checks (`src/health/`)

Two complementary modules:

**Pre-flight (`pre-flight.ts`):**
- Uses `Impit` (chrome fingerprint TLS) to test proxy reachability before login.
- Threshold: 5000ms standard, 8000ms for BrightData (African residential IPs are slower).
- Returns `ProxyHealthResult { healthy, latencyMs, exitIp, error? }`.
- External dependency on `botLog` from slot-hunter is removed — replaced by an optional `logger` callback parameter.

**Session Guard (`session-guard.ts`):**
- Mid-session liveness monitoring.
- Check interval: 2 minutes.
- Freeze after 2 consecutive failures.
- IP mismatch detection (exit IP changed → session invalid).
- Uses `undici.ProxyAgent` for check requests.
- External dependency on `botLog` from slot-hunter is removed — replaced by an optional `onFreeze` callback.

```typescript
// src/health/pre-flight.ts
export interface ProxyHealthResult {
  healthy: boolean;
  latencyMs: number;
  exitIp: string | null;
  error?: string;
}

export interface PreFlightOptions {
  /** Optional logging callback for external telemetry */
  logger?: (result: ProxyHealthResult, proxyUrl: string) => void;
}

export function preFlightProxyCheck(
  proxyUrl: string | undefined,
  options?: PreFlightOptions,
): Promise<ProxyHealthResult>;
```

```typescript
// src/health/session-guard.ts
export interface ProxyGuardOptions {
  onFreeze?: (username: string, proxyUrl: string) => void;
}

export function initProxyGuard(username: string, proxyUrl: string, exitIp?: string): void;
export function releaseProxyGuard(username: string): void;
export function isSessionFrozen(username?: string): boolean;
export function checkProxyLiveness(username?: string): Promise<boolean>;
```

### 3. IP Whitelist (`src/whitelist/`)

Orchestrates auto-whitelisting the server IP with IPRoyal, BrightData, SOAX, and 2Captcha at startup.

```typescript
// src/whitelist/index.ts
export interface WhitelistResult {
  ip: string;
  iproyal: { ok: boolean; message: string };
  brightdata: { ok: boolean; message: string };
  soax: { ok: boolean; message: string };
  twocaptcha: { ok: boolean; message: string };
}

export function autoWhitelistIp(serverIp: string): Promise<WhitelistResult>;
export function cleanupOldIproyalWhitelistEntries(currentIp: string): Promise<{ removed: number; kept: number }>;
```

Design: All env vars (`IPROYAL_API_TOKEN`, `IPROYAL_USER_HASH`, `BRIGHTDATA_API_KEY`, etc.) read at call-time via `process.env` — same as current implementation.

### 4. Decodo Pools (`src/decodo/`)

Two parallel implementations sharing the same pattern (CSV > URLS > URL priority, round-robin rotation):

```typescript
// src/decodo/spain.ts
export function hasDecodoProxy(): boolean;
export function getCurrentDecodoUrl(): string | undefined;
export function rotateDecodoUrl(): string | undefined;
export function reloadDecodoPool(): void;
export function isDecodoMultiPool(): boolean;
export function getDecodoPoolSize(): number;
```

```typescript
// src/decodo/germany.ts
export function hasGermanyDecodoProxy(): boolean;
export function getCurrentGermanyDecodoUrl(): string | undefined;
export function rotateGermanyDecodoUrl(): string | undefined;
export function reloadGermanyDecodoPool(): void;
```

Module-level state (index + cached pool) is preserved as-is. These are inherently singletons managed via module scope.

### 5. BrightData Module (`src/brightdata/`)

Three sub-modules:

**`sticky.ts`** — Sticky URL generation with V10 windowed session IDs and country fallback:
```typescript
export function makeBrightDataStickyUrl(baseUrl: string, username?: string, country?: string): string;
export function makeBrightDataStickyUrlWithFallback(
  baseUrl: string,
  username: string,
  preFlightCheck: (proxyUrl: string, jobId?: string) => Promise<ProxyHealthResult>,
  jobId?: string,
): Promise<{ url: string; country: string; latencyMs: number } | null>;
export function getBrightDataCountryConfig(): { primary: string; fallbacks: string[] };
export function rotateBrightDataSession(username: string): void;
```

**`keep-alive.ts`** — BrightData session keep-alive (prevents idle timeout):
```typescript
export interface BrightDataKeepAliveOptions {
  /** Check if the account token is still valid before pinging. Return false to stop. */
  isTokenValid?: (username: string) => boolean;
}

export function startBrightDataKeepAlive(proxyUrl: string, username: string, options?: BrightDataKeepAliveOptions): void;
export function stopBrightDataKeepAlive(username: string): void;
export function hasBrightDataSession(username: string): boolean;
export function getBrightDataSessionInfo(username: string): { sessionId: string; createdAt: number; lastKeepAliveAt: number; durationMin: number } | null;
export function stopAllBrightDataKeepAlives(): void;
```

Key change: The current `keep-alive.ts` imports `tokenCache` and `isCachedTokenValid` from `usa-http.ts` (slot-hunter internal). This creates a circular dependency. Solution: inject `isTokenValid` as an optional callback via `BrightDataKeepAliveOptions`. The slot-hunter consumer passes `(username) => isCachedTokenValid(tokenCache.get(username))`.

**`fixed-ip.ts`** — URL building, parsing, CapSolver format conversion:
```typescript
export interface BrightDataProxyConfig {
  accountId: string;
  proxyType: string;
  password: string;
  sessionId?: string;
  country?: string;
  city?: string;
}

export function buildBrightDataUrl(config: BrightDataProxyConfig): string;
export function parseBrightDataUrl(proxyUrl: string): BrightDataProxyConfig | null;
export function brightDataToCapSolverFormat(proxyUrl: string): string;
export function hasFixedSession(proxyUrl: string): boolean;
export function withSession(proxyUrl: string, sessionId?: string): string;
export function generateSessionId(): string;
```

### 6. Source Wrappers (`src/sources/`)

Existing files (brightdata.ts, iproyal.ts, static.ts) preserved unchanged. Already in the correct location.

### 7. Utilities (`src/utils.ts`)

```typescript
export function parseHttpProxyUrlForPlaywright(
  raw: string,
): { server: string; username?: string; password?: string } | undefined;

export function detectPublicIp(): Promise<string | null>;
```

## Interfaces & Data Models

### Package.json Exports Map

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./pool": "./src/pool/index.ts",
    "./health": "./src/health/index.ts",
    "./whitelist": "./src/whitelist/index.ts",
    "./decodo": "./src/decodo/index.ts",
    "./brightdata": "./src/brightdata/index.ts",
    "./sources": "./src/sources/index.ts",
    "./utils": "./src/utils.ts"
  }
}
```

Using direct `.ts` source imports (standard for pnpm workspace protocol with `"moduleResolution": "bundler"` in the monorepo tsconfig). No compilation step required for consumers — `tsx` resolves TypeScript sources directly.

### Consumer Migration Pattern

Before (slot-hunter/src/index.ts):
```typescript
import { ProxyPool, detectPublicIp } from "./proxyPool.js";
const proxyPool = new ProxyPool(process.env.TWOCAPTCHA_API_KEY ?? "");
```

After (slot-hunter/src/index.ts):
```typescript
import { ProxyPool, detectPublicIp } from "@workspace/proxy-service/pool";
const proxyPool = new ProxyPool(process.env.TWOCAPTCHA_API_KEY ?? "");
// Pass to consumers that need it
```

Before (slot-hunter/src/browser.ts):
```typescript
import { ProxyPool, detectPublicIp, parseHttpProxyUrlForPlaywright } from "./proxyPool.js";
export const proxyPool = new ProxyPool(process.env.TWOCAPTCHA_API_KEY ?? "");
```

After (slot-hunter/src/browser.ts):
```typescript
// browser.ts exports ONLY browser-related utilities
// ProxyPool instantiation moved to index.ts
import { parseHttpProxyUrlForPlaywright } from "@workspace/proxy-service/utils";
export { parseHttpProxyUrlForPlaywright };
```

### Dependency Injection for Cross-Package Boundaries

The health check and keep-alive modules currently import `botLog` from slot-hunter's `convexClient.ts`. Since proxy-service cannot depend on slot-hunter, these dependencies are inverted:

| Current coupling | Solution |
|-----------------|----------|
| `proxy-health-check.ts` → `botLog` | Optional `logger` callback in `PreFlightOptions` |
| `proxy-session-guard.ts` → `botLog` | Optional `onFreeze` callback in `ProxyGuardOptions` |
| `brightdata-proxy.ts` → `tokenCache` / `isCachedTokenValid` | Optional `isTokenValid` callback in `BrightDataKeepAliveOptions` |

Slot-hunter wires these callbacks at instantiation time, preserving identical behavior.

## Error Handling

### Network Errors (Proxy Refresh / Health Check)

All network calls use `AbortSignal.timeout()` or `AbortController` with explicit timeouts:
- ProxyPool gateway: no network call needed (URL-based auth)
- IP Whitelist API calls: 15s timeout
- Pre-flight health check: 5s/8s (provider-dependent)
- Session guard health check: 5s timeout
- BrightData keep-alive: 10s timeout

Errors are caught, logged with `[module]` prefix, and propagated as result objects (never thrown to consumers for non-critical paths).

### Proxy Pool Degradation

ProxyPool handles degradation gracefully:
- If `TWOCAPTCHA_PROXY_USER` is empty → `isConfigured` returns false → consumers fall back to direct connection.
- If gateway connectivity fails → `getProxy()` returns null → consumer handles fallback.
- Whitelist errors → 30-minute retry backoff (preserved from existing logic).

### Decodo Pool Fallbacks

Priority chain: CSV file → `DECODO_PROXY_URLS` env → `DECODO_PROXY_URL` env → returns undefined (no proxy available). Consumers must handle `undefined` return.

### Session Guard Freeze

When 2 consecutive mid-session health checks fail:
1. `frozen` flag set → `isSessionFrozen()` returns true
2. All API requests for that account are blocked
3. Next cycle in slot-hunter detects frozen state → triggers re-login with new proxy
4. Re-login calls `initProxyGuard()` → resets state

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Acceptance Criteria Testing Prework

1.1. THE Proxy_Service SHALL export all proxy functionality as TypeScript modules without running an HTTP server.
  Thoughts: This is a structural/architectural requirement. We can verify it by checking that the package has no `express` import and no `app.listen()` call. It's a smoke test.
  Classification: SMOKE
  Test Strategy: Single check that no HTTP server is started on import.

1.2. THE Proxy_Service SHALL NOT depend on `express` or any HTTP framework in its production dependencies.
  Thoughts: This is a configuration check — verify package.json. Smoke test.
  Classification: SMOKE
  Test Strategy: Parse package.json and assert no express/fastify/koa in dependencies.

1.3. THE Proxy_Service SHALL be consumable via the pnpm workspace protocol as `@workspace/proxy-service`.
  Thoughts: Integration check — does the import resolve? Smoke test.
  Classification: SMOKE
  Test Strategy: Attempt import from workspace and verify it resolves.

1.4. WHEN Slot_Hunter imports from Proxy_Service, THE Proxy_Service SHALL resolve at build time without requiring a running process.
  Thoughts: Same as 1.3 — build-time resolution check.
  Classification: SMOKE
  Test Strategy: Run `tsc --noEmit` on slot-hunter after migration.

2.1-2.9: Module extraction — these are structural requirements (files exist in the right place).
  Classification: SMOKE
  Test Strategy: Verify files exist and export expected symbols.

3.1-3.8: Subpath exports — structural verification.
  Classification: SMOKE
  Test Strategy: Attempt import from each subpath and verify symbols resolve.

4.1-4.15: Consumer migration — structural verification.
  Classification: SMOKE
  Test Strategy: `tsc --noEmit` on slot-hunter after all imports changed.

5.1. THE Slot_Hunter `src/browser.ts` SHALL NOT instantiate ProxyPool at module scope.
  Thoughts: Code-level structural check.
  Classification: SMOKE
  Test Strategy: Grep browser.ts for `new ProxyPool` — must not exist.

5.2. THE Slot_Hunter `src/browser.ts` SHALL NOT export a `proxyPool` singleton.
  Classification: SMOKE
  Test Strategy: Grep for `export.*proxyPool`.

5.3. WHEN ProxyPool is needed, THE Slot_Hunter `src/index.ts` or an explicit factory SHALL create the instance and pass it to consumers.
  Classification: EXAMPLE
  Test Strategy: Verify index.ts creates ProxyPool and passes to consumers.

5.4. THE Slot_Hunter `src/browser.ts` SHALL retain only browser-related exports.
  Classification: SMOKE
  Test Strategy: Verify exports of browser.ts contain no proxy symbols.

6.1-6.11: Environment variable compatibility.
  Thoughts: These test that specific env vars are READ by the code. We can verify this across all env var names: for any env var X in the list, the proxy-service source must reference `process.env.X` or `process.env["X"]`.
  Classification: PROPERTY
  Test Strategy: For all env var names in the spec, verify they are referenced in proxy-service source.

7.1-7.6: Dependency declarations — structural.
  Classification: SMOKE
  Test Strategy: Parse package.json and verify declared deps.

8.1. THE Proxy_Service ProxyPool SHALL generate identical sticky session IDs for the same inputs.
  Thoughts: This is a deterministic function. For any (accountKey, rotationCount, timestamp window), the generated session ID should be the same before and after extraction. This is a round-trip / idempotence property — same inputs → same outputs.
  Classification: PROPERTY
  Test Strategy: Generate random accountKeys + rotation counts + fixed timestamps, verify session ID is deterministic and matches the known algorithm.

8.2. THE Proxy_Service BrightData_Module SHALL produce identical sticky URLs with the same V10 windowed session logic.
  Thoughts: Same as 8.1 — deterministic function for URL generation. For any (baseUrl, username, country, rotationCount, timestamp window), the output URL should be predictable.
  Classification: PROPERTY
  Test Strategy: Generate random baseUrl + username + country combinations, verify output URL structure is correct and deterministic.

8.3. THE Proxy_Service Decodo_Pool SHALL parse CSV files and environment variables with identical priority order.
  Thoughts: For any combination of CSV file presence, DECODO_PROXY_URLS, and DECODO_PROXY_URL, the pool should select according to priority: CSV > URLS > URL. This is a property about priority ordering.
  Classification: PROPERTY
  Test Strategy: Generate combinations of sources (CSV exists/not, URLS set/not, URL set/not), verify correct source is selected.

8.4. THE Proxy_Service IP_Whitelist SHALL call IPRoyal and BrightData APIs with identical request format.
  Thoughts: Integration test — verifying external API call format. Not amenable to PBT since it tests external interaction shape.
  Classification: INTEGRATION
  Test Strategy: Mock fetch, call autoWhitelistIp, verify request URL/headers/body.

8.5. THE Proxy_Service Proxy_Health_Check SHALL use the same latency thresholds (5000ms standard, 8000ms BrightData).
  Thoughts: For any proxy URL, the threshold used should be 8000ms if the URL contains "brd.superproxy" or "brightdata", and 5000ms otherwise. This is a property.
  Classification: PROPERTY
  Test Strategy: Generate random proxy URLs (some with brightdata domain, some without), verify correct threshold is applied.

8.6. THE Proxy_Service Proxy_Session_Guard SHALL use the same freeze logic (2 consecutive failures, 2-minute check interval).
  Thoughts: For any sequence of health check results, the freeze should trigger if and only if there are 2+ consecutive failures. This is a state machine property.
  Classification: PROPERTY
  Test Strategy: Generate random sequences of pass/fail health checks, verify freeze triggers exactly at the 2nd consecutive failure.

8.7. THE Proxy_Service `parseHttpProxyUrlForPlaywright` utility SHALL handle all proxy URL formats identically.
  Thoughts: This is a parsing function. For any valid proxy URL in any supported format, parsing should produce a correct {server, username?, password?} object. Round-trip property: for standard URLs, build → parse → build should be stable.
  Classification: PROPERTY
  Test Strategy: Generate random proxy URLs in different formats (standard URL, host:port:user:pass, IPv4), verify parse output is correct.

8.8. WHEN all consumers are migrated, THE Slot_Hunter SHALL produce identical runtime behavior.
  Thoughts: This is an integration/acceptance test — run the full system and verify behavior matches.
  Classification: INTEGRATION
  Test Strategy: End-to-end verification that slot-hunter runs identically after migration.

9.1-9.5: TypeScript configuration — structural.
  Classification: SMOKE
  Test Strategy: `tsc --noEmit` passes, verify tsconfig settings.

10.1-10.9: Internal structure — structural.
  Classification: SMOKE
  Test Strategy: Verify directory structure and barrel exports exist.

### Property Reflection

Reviewing properties for redundancy:
- 8.1 (ProxyPool session ID determinism) and 8.2 (BrightData sticky URL determinism) are distinct — different algorithms, different inputs, both needed.
- 8.3 (Decodo priority order) is unique.
- 8.5 (health check thresholds) and 8.6 (freeze logic) test different aspects of health module.
- 8.7 (parseHttpProxyUrlForPlaywright) is a standalone parsing function.
- 6.x (env var compatibility) can be consolidated into one property about env var references.

No redundancies identified — all properties test distinct behaviors.

### Property 1: ProxyPool session ID determinism

*For any* accountKey string and rotation count, given the same timestamp window (same 12h period after per-account offset), the `generateSessionId` function SHALL produce the same 8-character alphanumeric session ID.

**Validates: Requirements 8.1**

### Property 2: BrightData sticky URL determinism

*For any* valid base URL, username string, country code, and rotation count, given the same timestamp window, `makeBrightDataStickyUrl` SHALL produce an identical URL string containing the same session ID and country parameter.

**Validates: Requirements 8.2**

### Property 3: Decodo pool source priority

*For any* combination of (CSV file exists with N>0 lines, DECODO_PROXY_URLS is set with M>0 entries, DECODO_PROXY_URL is set), the pool SHALL load from CSV if available, else from URLS if set, else from URL — never mixing sources and never preferring a lower-priority source over a higher-priority one.

**Validates: Requirements 8.3**

### Property 4: Health check threshold selection

*For any* proxy URL string, the pre-flight health check SHALL apply a latency threshold of 8000ms if the URL contains "brd.superproxy" or "brightdata", and 5000ms otherwise.

**Validates: Requirements 8.5**

### Property 5: Session guard freeze invariant

*For any* sequence of health check outcomes (pass/fail) delivered to the session guard for a given username, the session SHALL be frozen if and only if the most recent N consecutive results are all failures where N >= 2, and SHALL NOT be frozen if the most recent result was a pass.

**Validates: Requirements 8.6**

### Property 6: Proxy URL parsing correctness

*For any* proxy URL in standard format (`http://user:pass@host:port`), `parseHttpProxyUrlForPlaywright` SHALL return `{ server: "http://host:port", username: "user", password: "pass" }`, and for any URL in non-standard format (`host:port:user:pass`), it SHALL return the equivalent parsed components. For any output with username/password, round-tripping through URL construction and re-parsing SHALL yield the same components.

**Validates: Requirements 8.7**

### Property 7: Decodo round-robin rotation

*For any* Decodo pool with N > 1 URLs, calling `rotateDecodoUrl()` N times SHALL cycle through all N URLs exactly once before repeating, and `getCurrentDecodoUrl()` between rotations SHALL return the most recently rotated URL.

**Validates: Requirements 2.3, 2.4**

### Property 8: ProxyPool sticky proxy reuse

*For any* accountKey, if `getStickyProxy(accountKey)` is called twice within the same session lifetime (before expiration), both calls SHALL return the same proxy URL string.

**Validates: Requirements 8.1**

### Property 9: Environment variable coverage

*For all* environment variable names specified in Requirement 6 (IPROYAL_PROXY_URL, BRIGHTDATA_PROXY_URL, BRIGHTDATA_RESIDENTIAL_PROXY_URL, BRIGHTDATA_COUNTRY, BRIGHTDATA_FALLBACK_COUNTRIES, BRIGHTDATA_API_KEY, BRIGHTDATA_ZONE_NAME, TWOCAPTCHA_API_KEY, TWOCAPTCHA_PROXY_USER, IPROYAL_API_TOKEN, IPROYAL_USER_HASH, IPROYAL_WHITELIST_PORT, IPROYAL_WHITELIST_PROTO, IPROYAL_WHITELIST_CONFIG, DECODO_PROXY_FILE, DECODO_PROXY_URLS, DECODO_PROXY_URL, GERMANY_DECODO_PROXY_FILE, GERMANY_DECODO_PROXY_URLS, GERMANY_DECODO_PROXY_URL, SOAX_PROXY_URL, PROXY_URL), the proxy-service source code SHALL contain a reference to that variable name.

**Validates: Requirements 6.1–6.11**
