# Design Document — Spain HTTP-Pure Multi-Portal Scanner

## Overview

This design describes the migration of the Spain (citaconsular.es / Bookitit) slot scanner from a hybrid browser+HTTP architecture to a 100% HTTP-pure multi-portal architecture. The new system eliminates Chromium from the scan path, uses Capsolver for Cloudflare challenge resolution, residential proxies for IP rotation, and supports scanning N Bookitit portals per cycle with a single CF session shared across all portals.

### Design Goals

1. **Zero browser for scanning** — all slot detection via Impit HTTP requests
2. **Multi-portal** — scan all active portals per watcher cycle, not just one
3. **Bandwidth-efficient** — cache session state, only refresh `datetime/` on subsequent scans
4. **Compatible** — return `SpainHttpScanResult` for seamless integration with existing booking/reporting
5. **Resilient** — dynamic month navigation, proxy rotation on ban, graceful portal failures

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| New file `spain-http-multiportal-scanner.ts` | Isolates multi-portal logic without modifying existing `spain-http-scanner.ts` |
| Per-portal `BookititPortalSession` state | Each portal needs its own PHPSESSID, callback, services cache |
| Shared `SpainCfSession` across portals | `cf_clearance` cookie covers `*.citaconsular.es` domain-wide |
| Sequential portal scanning (not concurrent) | Avoids rate-limiting; one proxy IP, one session at a time |
| `datetime/`-only refresh path | Saves ~140KB per scan after initial session setup |

---

## Architecture

### High-Level Data Flow

```mermaid
graph TD
    WL[spain-watcher-loop.ts] -->|mode=capsolver-residential| MPS[spain-http-multiportal-scanner.ts]
    MPS -->|ensureSpainCfSession| SOAX[spain-soax-solver.ts]
    SOAX -->|AntiCloudflareTask| CS[Capsolver API]
    SOAX -->|HTTP via| PROXY[gate.decodo.com residential]
    
    MPS -->|per portal| PS[BookititPortalSession]
    PS -->|init: GET widget + POST token + GET /main/| BKT[citaconsular.es/onlinebookings/]
    PS -->|scan: datetime/ only| BKT
    
    MPS -->|SpainHttpScanResult per portal| WL
    WL -->|slot found| BOOK[spain-http-booking.ts]
    WL -->|reporting| CVX[Convex Backend]
    WL -->|lock| REDIS[Redis]
    
    BOOK -->|signin/ + summary/| BKT
    BOOK -->|fallback reg_type=2| BROWSER[Chromium on-demand]
```

### Component Boundaries

```
┌─────────────────────────────────────────────────────────────────────────┐
│  spain-watcher-loop.ts (orchestrator)                                    │
│    - Mode dispatch: capsolver-residential → runMultiPortalScan()         │
│    - Redis lock acquire/release                                          │
│    - Convex reporting (scan results, heartbeats, alerts)                 │
│    - Booking dispatch per dossier                                        │
└─────────────┬───────────────────────────────────────────────────────────┘
              │ calls
┌─────────────▼───────────────────────────────────────────────────────────┐
│  spain-http-multiportal-scanner.ts (NEW)                                 │
│    - Groups dossiers by portalUrl                                        │
│    - Manages per-portal BookititPortalSession lifecycle                   │
│    - Executes JSONP chain (init or datetime-only)                        │
│    - Returns SpainHttpScanResult[] (one per portal)                      │
│    - Tracks bandwidth, logs with [SPAIN-HTTP-MULTI]                      │
└──────┬──────────────────────────────────┬───────────────────────────────┘
       │ uses                             │ uses
┌──────▼─────────────────┐    ┌──────────▼─────────────────────────────┐
│  spain-soax-solver.ts   │    │  spain-slot-explorer.ts (unchanged)     │
│  (CF session mgmt)      │    │  (detailed slot exploration)            │
│  - ensureSpainCfSession │    └────────────────────────────────────────┘
│  - spainCfFetch         │
│  - getSpainImpit        │
└─────────────────────────┘
```

---

## Components and Interfaces

### 1. `spain-http-multiportal-scanner.ts` (New Module)

This is the core new file. It encapsulates all multi-portal scan logic.

#### Exported Functions

```typescript
/**
 * Scans all active portals for the current cycle.
 * Called by spain-watcher-loop when SPAIN_SESSION_MODE=capsolver-residential.
 *
 * @param dossiers - Active Spain dossiers from Convex (grouped internally by portalUrl)
 * @param cfSession - Shared CF session (domain-wide cf_clearance)
 * @returns Per-portal scan results compatible with SpainHttpScanResult
 */
export async function runMultiPortalScan(
  dossiers: SpainDossier[],
  cfSession: SpainCfSession,
): Promise<MultiPortalScanResult>;

/**
 * Invalidates the cached portal session for a specific portal.
 * Called when booking fails due to session expiry.
 */
export function invalidatePortalSession(portalUrl: string): void;

/**
 * Returns current bandwidth usage stats for logging/monitoring.
 */
export function getBandwidthStats(): BandwidthStats;
```

#### Internal Classes

```typescript
/**
 * Per-portal Bookitit session state.
 * Each portal gets its own PHPSESSID, jQuery callback, and cached API data.
 * Shared CF session (cf_clearance) is NOT stored here — it's domain-wide.
 */
class BookititPortalSession {
  readonly portalUrl: string;
  readonly publickey: string;
  
  // Session state
  private phpSessionId: string | null;
  private jqueryCallback: string;
  private requestCounter: number;
  private srvsrc: string;
  private version: string;
  private createdAt: number;
  
  // Cached discovery
  private services: BookititService[] | null;
  private agendas: BookititAgenda[] | null;
  private widgetConfig: Record<string, unknown> | null;
  private mainHtml: string | null;
  private getagendasCalled: boolean; // enforce once-per-session
  
  // Lifecycle
  isExpired(): boolean;          // TTL 30 min from createdAt
  needsFullInit(): boolean;      // no PHPSESSID or expired
  needsDatetimeOnly(): boolean;  // has valid cache, only datetime/ needed
  
  // Init sequence (3-step)
  async initialize(cfSession: SpainCfSession): Promise<void>;
  
  // Scan (datetime/ only when cache is valid)
  async scanDatetime(cfSession: SpainCfSession, targetServiceId: string, targetAgendaId: string): Promise<DatetimeScanResult>;
  
  // URL builder (exact parameter ordering per Req 11)
  buildJsonpUrl(endpoint: string, extras?: Record<string, string>): string;
}
```

### 2. Integration Points in `spain-watcher-loop.ts`

The watcher loop gains a new mode branch:

```typescript
// Mode detection (existing pattern extended)
const SPAIN_MULTIPORTAL = process.env.SPAIN_SESSION_MODE === "capsolver-residential";

// In the main scan dispatch:
if (SPAIN_MULTIPORTAL) {
  const cfSession = await ensureSpainCfSession(firstPortalUrl);
  const multiResult = await runMultiPortalScan(activeDossiers, cfSession);
  // Process per-portal results (booking, reporting, etc.)
} else if (SPAIN_PERSISTENT_BROWSER) {
  // existing persistent-browser path
} else if (SPAIN_HTTP_MODE) {
  // existing HTTP-only single-portal path
} else {
  // existing Playwright path
}
```

### 3. Changes to `spain-soax-solver.ts`

Minimal changes — the existing `ensureSpainCfSession()` already supports Capsolver. The key modification:

```typescript
// getSpainProxyUrl() priority update:
function getSpainProxyUrl(): string | undefined {
  // NEW: residential proxy takes priority in capsolver-residential mode
  if (process.env.SPAIN_SESSION_MODE === "capsolver-residential") {
    const residential = process.env.SPAIN_RESIDENTIAL_PROXY_URL;
    if (residential) return residential;
  }
  // Existing fallback chain: Decodo → SOAX → Oxylabs
  const decodo = getCurrentDecodoUrl();
  if (decodo) return decodo;
  // ... rest unchanged
}
```

### 4. `spain-portals.ts` (Unchanged)

The `extractWidgetKey()` and `buildPortalUrlFromWidgetKey()` utilities are reused as-is.

### 5. `spain-http-booking.ts` (Unchanged Interface)

`executeHttpBooking()` continues to receive `SpainCfSession`, `portalUrl`, `mainHtml`, and `SpainBookingConfig` — no interface change needed. The multi-portal scanner provides these from its per-portal cache.

---

## Data Models

### `BookititPortalSession` State

```typescript
interface BookititService {
  id: string;           // e.g. "bkt853215"
  name: string;         // HTML-stripped name
  allowAppointment?: boolean;
}

interface BookititAgenda {
  id: string;           // e.g. "bkt301070"
  name: string;
}

interface DatetimeScanResult {
  /** All slots found across all scanned months */
  allSlots: Array<{
    date: string;       // "2026-09-16"
    time: string;       // "09:10"
    agendaId: string;
    freeSlots: number;
  }>;
  /** Highest maxDays observed */
  maxDaysObserved: string | null;
  /** Number of months scanned */
  monthsScanned: number;
  /** Total bytes received for this datetime scan */
  bytesReceived: number;
}
```

### `MultiPortalScanResult` (Return Type)

```typescript
interface PortalScanOutcome {
  portalUrl: string;
  publickey: string;
  status: "found" | "not_found" | "closed" | "session_expired" | "error";
  /** Compatible SpainHttpScanResult for booking integration */
  scanResult: SpainHttpScanResult;
  /** Duration of this portal's scan in ms */
  scanDurationMs: number;
  /** Months range scanned (e.g. "2026-08 → 2026-10") */
  monthRange: string;
  /** Bandwidth consumed for this portal in bytes */
  bytesConsumed: number;
}

interface MultiPortalScanResult {
  portals: PortalScanOutcome[];
  /** Total cycle duration across all portals */
  cycleDurationMs: number;
  /** Total bandwidth consumed this cycle */
  totalBytesConsumed: number;
  /** Whether CF session was renewed during this cycle */
  cfSessionRenewed: boolean;
}
```

### `BandwidthStats`

```typescript
interface BandwidthStats {
  /** Bytes consumed since session creation */
  sessionTotalBytes: number;
  /** Bytes consumed today (resets at midnight UTC) */
  dailyTotalBytes: number;
  /** Number of CF solves today */
  dailyCfSolves: number;
  /** Whether bandwidth threshold is exceeded */
  thresholdExceeded: boolean;
  /** Current effective scan interval (may be doubled if threshold exceeded) */
  effectiveIntervalMs: number;
}
```

### Portal Session Cache (In-Memory Map)

```typescript
// Module-level state in spain-http-multiportal-scanner.ts
const portalSessions = new Map<string, BookititPortalSession>();
// key = portalUrl (normalized)

// Lifecycle:
// - Created on first scan of a portal
// - Reused if not expired (30 min TTL)
// - Invalidated on 0B responses, session errors, or explicit invalidation
// - Never persisted to Redis (ephemeral, cheap to recreate)
```

### Consecutive Failure Tracking

```typescript
// Per-portal failure counter for alerting (Req 10.6)
const portalFailureCount = new Map<string, number>();
// key = portalUrl, value = consecutive failed scans
// Reset to 0 on any successful scan
// Alert emitted at threshold (5 consecutive failures)
```

---

## Key Algorithms

### Algorithm 1: Multi-Portal Scan Cycle

```
function runMultiPortalScan(dossiers, cfSession):
  1. Group dossiers by portalUrl → Map<portalUrl, dossier[]>
  2. For each unique portalUrl (sequentially):
     a. Get or create BookititPortalSession from cache
     b. If session.needsFullInit():
        - Execute 3-step init (GET widget → POST token → GET /main/)
        - Execute JSONP chain (getwidgetconfigurations → getservices → getagendas)
        - Cache services, agendas, mainHtml, widgetConfig
     c. Else (session valid, cache fresh):
        - Skip to datetime/ only
     d. Execute dynamic month scan (Algorithm 2)
     e. Build SpainHttpScanResult from datetime results
     f. Apply inter-portal delay (2000ms ± 500ms jitter)
  3. Aggregate results → MultiPortalScanResult
  4. Update bandwidth stats
  5. Return
```

### Algorithm 2: Dynamic Month Navigation

```
function scanMonthsDynamically(session, serviceId, agendaId, cfSession):
  highestMaxDays = null
  allSlots = []
  consecutiveEmpty = 0
  monthOffset = 0
  
  while monthOffset < 12:
    targetDate = addMonths(today(), monthOffset)
    start = firstDayOf(targetDate)  // "YYYY-MM-01"
    end = lastDayOf(targetDate)     // "YYYY-MM-28/29/30/31"
    
    response = callDatetime(session, serviceId, agendaId, start, end)
    slots = extractSlotsFromResponse(response)
    maxDays = extractMaxDays(response)
    
    if maxDays and maxDays > highestMaxDays:
      highestMaxDays = maxDays
    
    allSlots.push(...slots)
    monthOffset++
    
    // Stop conditions (only after minimum 2 months):
    if monthOffset >= 2:
      if highestMaxDays:
        nextMonthStart = firstDayOf(addMonths(today(), monthOffset))
        if nextMonthStart > highestMaxDays:
          break  // server says no data beyond this
      
      if slots.length == 0:
        consecutiveEmpty++
      else:
        consecutiveEmpty = 0
      
      if consecutiveEmpty >= 3 and !highestMaxDays:
        break  // safety: 3 empty months with no guidance
  
  return { allSlots, highestMaxDays, monthOffset }
```

### Algorithm 3: JSONP URL Construction (Req 11.1)

```
function buildJsonpUrl(endpoint, extras):
  params = []
  params.push(["callback", this.jqueryCallback])
  params.push(["type", "default"])
  params.push(["publickey", this.publickey])
  params.push(["lang", "es"])
  
  // services[] and agendas[] go HERE (before version)
  if extras has "services[]": params.push(["services[]", extras["services[]"]])
  if extras has "agendas[]":  params.push(["agendas[]", extras["agendas[]"]])
  
  params.push(["version", this.version])
  params.push(["src", this.portalUrl])
  
  // srvsrc on ALL endpoints EXCEPT /main/
  if endpoint != "main/":
    params.push(["srvsrc", this.srvsrc])
  
  // Remaining extras (selectedPeople, start, end)
  for [key, value] in extras (excluding services[], agendas[]):
    params.push([key, value])
  
  // Cache buster always last
  this.requestCounter++
  params.push(["_", String(this.requestCounter)])
  
  return `${BASE}/onlinebookings/${endpoint}?${encode(params)}`
```

### Algorithm 4: Bandwidth-Aware Interval Adjustment

```
function getEffectiveScanInterval(baseIntervalMs):
  stats = getBandwidthStats()
  if stats.thresholdExceeded:
    // Double interval, cap at 5 minutes
    return min(baseIntervalMs * 2, 300_000)
  return baseIntervalMs
```

### Algorithm 5: Session Init (3-Step HTTP)

```
async function initialize(cfSession):
  impit = getSpainImpit(cfSession)
  cookies = { cf_clearance: cfSession.cfClearance }
  
  // Step 1: GET widget page
  response1 = impit.fetch(this.portalUrl, { headers: { Cookie: cookies, UA } })
  if response1.body is empty or status != 200: throw SessionInitError
  token = extractToken(response1.body)   // regex: name="token" value="..."
  cookies.PHPSESSID = extractSetCookie(response1, "PHPSESSID")
  
  // Step 2: POST token
  response2 = impit.fetch(this.portalUrl, {
    method: "POST",
    body: `token=${encodeURIComponent(token)}`,
    headers: { Content-Type: "application/x-www-form-urlencoded", Cookie: cookies }
  })
  if response2.body is empty: throw SessionInitError
  this.srvsrc = extractSrvsrc(response2.body)     // regex: srvsrc:\s*'([^']+)'
  this.version = extractVersion(response2.body)   // regex: loadermaec\.js\?v=(\d+)
  cookies update from response2 set-cookie
  
  // Step 3: GET /main/
  url = this.buildJsonpUrl("main/")
  response3 = impit.fetch(url, { headers: jsonpHeaders(cookies) })
  if response3.body.length < 1000: throw SessionInitError
  this.mainHtml = response3.body
  this.phpSessionId = cookies.PHPSESSID
  this.createdAt = Date.now()
```

### Algorithm 6: JSONP Response Parsing

```
function parseJsonp(body: string): unknown | null:
  // Strip callback wrapper: jQuery21109...({...});
  firstParen = body.indexOf("(")
  lastParen = body.lastIndexOf(")")
  if firstParen == -1 or lastParen == -1: return null
  json = body.slice(firstParen + 1, lastParen)
  try: return JSON.parse(json)
  catch: return null
```

### Algorithm 7: 0-Byte Response Classification (Req 12.5)

```
function classifyEmptyResponse(endpoint, portalSession):
  if endpoint is "/main/":
    return "proxy_burned"       // CF/proxy issue → rotate IP
  if endpoint is "getagendas/":
    return "portal_closed"      // Portal disabled → mark closed, skip
  if endpoint is "getservices/" or "datetime/":
    return "session_expired"    // PHPSESSID gone → full reinit
```

---

## Sequence Diagram: Full Scan Cycle

```mermaid
sequenceDiagram
    participant WL as Watcher Loop
    participant MPS as MultiPortalScanner
    participant SOAX as spain-soax-solver
    participant CS as Capsolver
    participant BKT as citaconsular.es
    participant CVX as Convex

    WL->>WL: getActiveSpainDossiers()
    WL->>WL: Group by portalUrl → [Portal A, Portal B]
    WL->>SOAX: ensureSpainCfSession(portalA_url)
    
    alt CF session expired
        SOAX->>BKT: GET widget (detect challenge)
        BKT-->>SOAX: 403 + "Just a moment"
        SOAX->>CS: createTask(AntiCloudflareTask)
        CS-->>SOAX: taskId
        loop Poll every 5s (max 120s)
            SOAX->>CS: getTaskResult
            CS-->>SOAX: status=ready, cf_clearance
        end
    end
    
    SOAX-->>WL: SpainCfSession (cf_clearance + proxy)
    WL->>MPS: runMultiPortalScan(dossiers, cfSession)
    
    rect rgb(240, 248, 255)
        Note over MPS,BKT: Portal A — Full Init (first time or cache expired)
        MPS->>BKT: GET widget URL (with cf_clearance)
        BKT-->>MPS: HTML + token + PHPSESSID
        MPS->>BKT: POST token
        BKT-->>MPS: HTML (srvsrc, version)
        MPS->>BKT: GET /main/ (JSONP)
        BKT-->>MPS: 128KB widget HTML
        MPS->>BKT: GET /getwidgetconfigurations/
        MPS->>BKT: GET /getservices/
        MPS->>BKT: GET /getagendas/ (once!)
        MPS->>BKT: GET /datetime/ (month M)
        MPS->>BKT: GET /datetime/ (month M+1)
        Note over MPS: Dynamic stop based on maxDays
    end
    
    MPS->>MPS: sleep(2000 ± 500ms)
    
    rect rgb(255, 248, 240)
        Note over MPS,BKT: Portal B — datetime/ only (cache valid)
        MPS->>BKT: GET /datetime/ (month M)
        MPS->>BKT: GET /datetime/ (month M+1)
    end
    
    MPS-->>WL: MultiPortalScanResult
    WL->>CVX: reportSpainWatcherScan (per portal)
    
    alt Slot found for Portal A
        WL->>WL: executeHttpBooking(cfSession, portalA, mainHtml, config)
    end
```

---

## Bandwidth Optimization Strategy

### Cost Model

| Operation | Size | Frequency |
|-----------|------|-----------|
| CF Solve roundtrip | ~50 KB | 1x / 2h |
| Session init (GET widget + POST token + GET /main/) | ~140 KB | 1x / 30 min per portal |
| getwidgetconfigurations/ | ~0.4 KB | 1x / 30 min per portal |
| getservices/ | ~1 KB | 1x / 30 min per portal |
| getagendas/ | ~0.2 KB | 1x / 30 min per portal |
| datetime/ (per month) | ~10 KB | Every scan cycle |

### Steady-State Scan (cache valid)

With 2 portals, scanning every 30s, 3 months average:
- Per scan: `2 portals × 3 months × 10 KB = 60 KB`
- Per hour: `120 scans × 60 KB = 7.2 MB`
- Per day: `173 MB`
- Per month: `5.2 GB` (exceeds 3 GB budget)

### Optimization Levers

1. **Increase scan interval to 60s** → halves bandwidth to ~2.6 GB/month
2. **Compress responses** (`Accept-Encoding: gzip`) → ~60% reduction → ~1 GB/month
3. **Skip months with no `maxDays` progression** → reduces months scanned
4. **Adaptive interval** when threshold exceeded → auto-doubles to 120s

### Implementation

The scanner tracks bytes per session and per day. When `dailyTotalBytes > SPAIN_BANDWIDTH_LIMIT_MB * 1024 * 1024`, the effective interval doubles. The `BandwidthStats` struct is logged every 10 cycles for monitoring.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Prework: Acceptance Criteria Testing Analysis

**4.1** THE Scanner SHALL always scan at minimum 2 months regardless of maxDays
- Thoughts: This is a universal rule about all scans — for any portal and any maxDays value, the scanner must produce results for at least 2 months. We can generate random maxDays values (including "today") and verify the scanner always scans ≥ 2 months.
- Classification: PROPERTY
- Test Strategy: Generate random maxDays dates (past, today, future), run the month navigation algorithm, verify monthsScanned ≥ 2.

**4.2** THE Scanner SHALL parse maxDays and stop when next month exceeds highest observed
- Thoughts: For any sequence of datetime/ responses with varying maxDays, the algorithm should correctly determine when to stop. We can generate random sequences of (slots, maxDays) tuples and verify the stop condition.
- Classification: PROPERTY
- Test Strategy: Generate sequences of monthly responses with random maxDays values, verify the algorithm stops at the correct month.

**4.3** THE Scanner SHALL stop after 12 months
- Thoughts: Safety bound — for any input, never scan more than 12 months. Edge case of the dynamic navigation.
- Classification: EDGE_CASE (subsumed by property on 4.1/4.2 — generator includes pathological maxDays)

**4.4** IF 3 consecutive empty months with no maxDays → stop
- Thoughts: This is a specific stop condition. We can test it as part of the month navigation property by generating sequences with 3+ empty months.
- Classification: PROPERTY (combined with 4.2)

**5.4** THE Scanner SHALL generate a single jQuery callback per session, reused for all requests
- Thoughts: This is an invariant on session state. For any sequence of buildJsonpUrl calls within a session, the callback parameter must be identical. We can generate random sequences of endpoint calls and verify.
- Classification: PROPERTY
- Test Strategy: Generate random endpoint sequences, call buildJsonpUrl for each, verify all URLs contain the same callback value.

**5.5** THE Scanner SHALL increment `_` on every request
- Thoughts: Monotonically increasing counter. For any sequence of N requests, the `_` values should be strictly increasing.
- Classification: PROPERTY
- Test Strategy: Generate random endpoint sequences, extract `_` values, verify strict monotonic increase.

**11.1** Parameter ordering in JSONP URLs
- Thoughts: For any combination of endpoint + extras, the parameter order must match the spec. We can generate random extras and verify ordering.
- Classification: PROPERTY
- Test Strategy: Generate random endpoint/extras combinations, parse the resulting URL params, verify positional ordering.

**11.2** srvsrc present on all endpoints except /main/
- Thoughts: For any endpoint name, srvsrc inclusion is deterministic. Universal rule.
- Classification: PROPERTY (combined with 11.1 — URL construction property)

**12.1** JSONP parsing: strip callback wrapper before JSON.parse
- Thoughts: Round-trip property — for any valid JSON object wrapped in a callback, parsing should recover the original object.
- Classification: PROPERTY
- Test Strategy: Generate random JSON objects, wrap in callback format, verify parseJsonp recovers the original.

**12.5** 0-byte classification by endpoint
- Thoughts: For any endpoint name, the classification is deterministic (pure function). We can generate random endpoint names and verify correct classification.
- Classification: PROPERTY
- Test Strategy: Generate random endpoint strings, verify classification matches spec rules.

**3.1** Group dossiers by portalUrl
- Thoughts: For any list of dossiers with varying portalUrls, grouping should produce correct partitions (no dossier lost, all in correct group).
- Classification: PROPERTY
- Test Strategy: Generate random dossier lists, verify grouping preserves all dossiers and groups correctly.

**1.5** Reuse CF session if age < 105 minutes
- Thoughts: For any session age, the reuse decision is a pure function of timestamp comparison. We can generate random ages and verify.
- Classification: PROPERTY
- Test Strategy: Generate random session ages, verify reuse decision matches threshold.

**7.4** Bandwidth threshold doubles interval
- Thoughts: For any bandwidth value, the effective interval is deterministic. Pure function.
- Classification: PROPERTY (trivial — combined with interval test)

**Remaining criteria** (1.1–1.4, 1.6, 2.1–2.5, 3.2–3.7, 5.1–5.3, 5.6, 6.1–6.6, 7.1–7.3, 7.5–7.6, 8.1–8.7, 9.1–9.5, 10.1–10.6, 11.3–11.10):
- Classification: INTEGRATION or EXAMPLE
- These test external service behavior (Capsolver API, Bookitit responses, Redis, Convex), configuration checks, or specific error handling paths that don't vary meaningfully with input.

### Reflection on Identified Properties

Reviewing identified properties for redundancy:
- Properties on 4.1, 4.2, 4.3, 4.4 all relate to the **month navigation algorithm**. They can be combined into a single comprehensive property: "For any sequence of monthly responses, the navigation algorithm respects minimum 2 months, stops correctly based on maxDays, never exceeds 12, and stops after 3 consecutive empties."
- Properties on 5.4 and 5.5 both test **session URL consistency**. Combined with 11.1 and 11.2 into a single URL construction property.
- Property 12.1 (JSONP parsing round-trip) is independent and valuable.
- Property 12.5 (endpoint classification) is independent.
- Property 3.1 (dossier grouping) is independent.
- Property 1.5 (session reuse threshold) is trivial and subsumed by integration tests.

**Final properties after deduplication:**

1. Month navigation correctness (combines 4.1, 4.2, 4.3, 4.4)
2. JSONP URL construction correctness (combines 5.4, 5.5, 11.1, 11.2)
3. JSONP response parsing round-trip (12.1)
4. Empty response endpoint classification (12.5)
5. Dossier grouping preserves all entries (3.1)

### Property 1: Month Navigation Correctness

*For any* sequence of monthly datetime/ responses (each containing zero or more slots and an optional `maxDays` date), the dynamic month navigation algorithm SHALL:
- Always produce `monthsScanned >= 2`
- Never produce `monthsScanned > 12`
- Stop when the first day of the next candidate month exceeds the highest `maxDays` observed (if any)
- Stop when 3 consecutive months return zero slots and no `maxDays` is present in any of those responses

**Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.6**

### Property 2: JSONP URL Construction Correctness

*For any* combination of endpoint name and extra parameters, the `buildJsonpUrl` function SHALL:
- Place query parameters in the exact order: `callback` → `type` → `publickey` → `lang` → `services[]` → `agendas[]` → `version` → `src` → `srvsrc` → remaining extras → `_`
- Include `srvsrc` on all endpoints except `main/`
- Use the same `callback` value for all calls within a session
- Produce a strictly increasing `_` value on each successive call

**Validates: Requirements 5.4, 5.5, 11.1, 11.2**

### Property 3: JSONP Parsing Round-Trip

*For any* valid JSON value (object, array, number, string, boolean, null), wrapping it in a JSONP callback string of format `callbackName(JSON);` and then parsing with `parseJsonp` SHALL recover a value deeply equal to the original.

**Validates: Requirements 12.1**

### Property 4: Empty Response Endpoint Classification

*For any* Bookitit endpoint path, the `classifyEmptyResponse` function SHALL return:
- `"proxy_burned"` if the endpoint contains `main/`
- `"portal_closed"` if the endpoint contains `getagendas/`
- `"session_expired"` if the endpoint contains `getservices/` or `datetime/`

**Validates: Requirements 12.5**

### Property 5: Dossier Grouping Preserves All Entries

*For any* list of dossiers with arbitrary `portalUrl` values, grouping by `portalUrl` SHALL:
- Produce groups where the sum of all group sizes equals the original list length (no dossier lost)
- Place each dossier in the group matching its `portalUrl` (correct partitioning)
- Produce exactly one group per distinct `portalUrl` value

**Validates: Requirements 3.1, 3.2**

---

## Error Handling

### Error Categories

| Category | Example | Recovery |
|----------|---------|----------|
| **CF Challenge** | 403 + "Just a moment" | Submit to Capsolver, 60s backoff on failure, max 3 retries |
| **Proxy Burned** | 0B on `/main/` | Rotate proxy IP, invalidate CF session, fresh solve |
| **Portal Closed** | 0B on `getagendas/` | Mark portal closed for cycle, continue other portals |
| **Session Expired** | 0B on `getservices/` or `datetime/` | Invalidate portal session, full reinit next cycle |
| **Capsolver Timeout** | 120s polling exceeded | Log error, backoff 60s, retry (max 3) |
| **Bookitit Error** | Malformed JSONP or unexpected structure | Log body sample, mark portal error, continue |
| **Bandwidth Exceeded** | Daily threshold hit | Double scan interval, log warning |
| **Redis Lock** | Lock held by other instance | Skip cycle, wait interval |

### Error Propagation Rules

1. **A single portal failure MUST NOT fail the entire cycle** — other portals continue
2. **CF session failure affects ALL portals** — the entire cycle is skipped
3. **Booking failures are independent** — reported to Convex, don't affect next scan
4. **5 consecutive failures per portal** → Convex alert, portal continues being scanned

### Timeout Configuration

```typescript
const TIMEOUTS = {
  CAPSOLVER_POLL_INTERVAL_MS: 5_000,
  CAPSOLVER_MAX_TIMEOUT_MS: 120_000,
  CF_SOLVE_RETRY_BACKOFF_MS: 60_000,
  CF_SOLVE_MAX_RETRIES: 3,
  BOOKITIT_REQUEST_TIMEOUT_MS: 30_000,
  SESSION_INIT_TIMEOUT_MS: 45_000,  // full 3-step init
  PORTAL_FAILURE_ALERT_THRESHOLD: 5,
} as const;
```

---

## Testing Strategy

### Property-Based Tests (fast-check)

Library: **fast-check** (standard PBT library for TypeScript/Node.js)

Each property test runs **minimum 100 iterations** with random inputs.

```typescript
// Example: Property 1 — Month Navigation
// Feature: spain-http-pure-multiportal, Property 1: Month navigation correctness
fc.assert(fc.property(
  fc.array(fc.record({
    slots: fc.nat({ max: 50 }),
    maxDays: fc.option(fc.date({ min: today, max: addMonths(today, 18) })),
  }), { minLength: 1, maxLength: 15 }),
  (monthlyResponses) => {
    const result = runMonthNavigation(monthlyResponses);
    expect(result.monthsScanned).toBeGreaterThanOrEqual(2);
    expect(result.monthsScanned).toBeLessThanOrEqual(12);
    // ... stop conditions verified
  }
), { numRuns: 100 });
```

| Property | Generator | Assertion |
|----------|-----------|-----------|
| 1: Month Navigation | Array of {slots: nat, maxDays: option(date)} | ≥2, ≤12, stop conditions |
| 2: URL Construction | {endpoint: oneof(endpoints), extras: dict(string)} | Param order, srvsrc rule, callback/counter invariants |
| 3: JSONP Parsing | Arbitrary JSON values | `parseJsonp(wrap(json)) ≡ json` |
| 4: Endpoint Classification | Random endpoint strings | Classification matches rules |
| 5: Dossier Grouping | Array of {portalUrl: oneof(urls), ...dossierFields} | Partition correctness |

### Unit Tests (vitest)

- Session init: mock HTTP responses, verify token extraction, srvsrc/version parsing
- CF session reuse: verify 105-minute threshold logic
- Bandwidth tracking: verify daily reset, threshold detection
- Error classification: specific 0B scenarios with mock responses
- Inter-portal delay: verify jitter range (1500–2500ms)

### Integration Tests

- Full JSONP chain against recorded fixtures (captured from test-bookitit-dynamic.ts)
- Watcher loop mode dispatch: verify `capsolver-residential` routes to `runMultiPortalScan`
- Redis lock: verify mutual exclusion between two concurrent scan attempts
- Convex reporting: verify event payloads match expected schema

### Test File Location

```
artifacts/slot-hunter/src/__tests__/
├── spain-multiportal-scanner.test.ts     # Unit + property tests
├── spain-multiportal-scanner.int.test.ts # Integration with fixtures
└── fixtures/
    ├── bookitit-getservices.jsonp
    ├── bookitit-getagendas.jsonp
    ├── bookitit-datetime-with-slots.jsonp
    └── bookitit-datetime-empty.jsonp
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SPAIN_SESSION_MODE` | Yes | — | Must be `capsolver-residential` to activate this feature |
| `SPAIN_RESIDENTIAL_PROXY_URL` | Recommended | — | Primary residential proxy (format: `http://user:pass@gate.decodo.com:port`) |
| `DECODO_PROXY_URL` | Fallback | — | Secondary proxy (ISP or residential) |
| `SOAX_PROXY_URL` | Fallback | — | Tertiary proxy |
| `CAPSOLVER_API_KEY` | Yes | — | Capsolver API key for AntiCloudflareTask |
| `SPAIN_HTTP_SCAN_INTERVAL_SEC` | No | `30` | Base scan interval in seconds (min 10) |
| `SPAIN_INTER_PORTAL_DELAY_MS` | No | `2000` | Delay between portal scans in ms |
| `SPAIN_BANDWIDTH_LIMIT_MB` | No | `500` | Daily bandwidth threshold before interval doubling |

---

## Migration Path

### Phase 1: Add new module (non-breaking)
- Create `spain-http-multiportal-scanner.ts` with `BookititPortalSession` and `runMultiPortalScan()`
- Add `capsolver-residential` mode branch in `spain-watcher-loop.ts`
- No changes to existing modes — all existing code paths remain untouched

### Phase 2: Update proxy priority
- Add `SPAIN_RESIDENTIAL_PROXY_URL` to `getSpainProxyUrl()` in `spain-soax-solver.ts`
- Deploy with new env var pointing to `gate.decodo.com`

### Phase 3: Enable in production
- Set `SPAIN_SESSION_MODE=capsolver-residential` on Railway
- Monitor via `[SPAIN-HTTP-MULTI]` log prefix
- Existing modes remain available as instant rollback

### Rollback Strategy
- Set `SPAIN_SESSION_MODE=persistent-browser` (or remove the var) → immediate revert to existing behavior
- No database migrations, no schema changes, no breaking API changes
