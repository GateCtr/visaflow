# Implementation Plan: proxy-service-extraction

## Overview

Transform `artifacts/proxy-service` from an Express HTTP server into a pure TypeScript library. Extract 8 proxy-related files from slot-hunter into proxy-service, organized in subdirectories with subpath exports. Invert slot-hunter-specific dependencies (botLog, tokenCache) into callbacks. Update ~15 consumer files in slot-hunter to import from `@workspace/proxy-service`. Remove the proxyPool singleton from browser.ts. Zero behavioral change — identical runtime behavior after migration.

## Tasks

- [ ] 1. Set up proxy-service package structure and configuration
  - [ ] 1.1 Update `artifacts/proxy-service/package.json`: remove `express` and `@types/express`, add `impit` and `ioredis` to dependencies, add subpath `exports` field (`.`, `./pool`, `./health`, `./whitelist`, `./decodo`, `./brightdata`, `./sources`, `./utils`), keep `"type": "module"`
    - Map each export to its `./src/...` entry point (direct TS source imports for workspace protocol)
    - _Requirements: 1.1, 1.2, 3.1–3.8, 7.1–7.6, 9.2_

  - [ ] 1.2 Update `artifacts/proxy-service/tsconfig.json`: ensure strict mode is enabled, ESM module settings, `moduleResolution: "bundler"`, extends base tsconfig
    - _Requirements: 9.1, 9.3, 9.4_

  - [ ] 1.3 Create directory structure: `src/pool/`, `src/health/`, `src/whitelist/`, `src/decodo/`, `src/brightdata/`
    - Create empty `index.ts` barrel files in each directory as placeholders
    - _Requirements: 10.1–10.7_

- [ ] 2. Extract ProxyPool module
  - [ ] 2.1 Create `src/pool/types.ts` with `PoolState`, `StickyProxy` interfaces extracted from slot-hunter's `proxyPool.ts`
    - _Requirements: 2.1, 10.2_

  - [ ] 2.2 Create `src/pool/index.ts` with the full `ProxyPool` class implementation moved from `slot-hunter/src/proxyPool.ts`
    - Move session ID generation (V10 windowed algorithm), sticky session logic, `getProxy`, `getStickyProxy`, `releaseStickyProxy`, `rotateStickyProxy`, `forceWhitelistRefresh`
    - Export `ProxyPool` class and all types
    - Remove any slot-hunter-specific imports (replace with local references)
    - _Requirements: 2.1, 8.1_

  - [ ]* 2.3 Write property test for ProxyPool session ID determinism
    - **Property 1: ProxyPool session ID determinism**
    - For any accountKey and rotation count in the same timestamp window, `generateSessionId` produces the same result
    - **Validates: Requirements 8.1**

  - [ ]* 2.4 Write property test for ProxyPool sticky proxy reuse
    - **Property 8: ProxyPool sticky proxy reuse**
    - For any accountKey, two calls to `getStickyProxy` within the same session lifetime return the same URL
    - **Validates: Requirements 8.1**

- [ ] 3. Extract utilities module
  - [ ] 3.1 Create `src/utils.ts` with `parseHttpProxyUrlForPlaywright` and `detectPublicIp` extracted from slot-hunter's `proxyPool.ts`
    - Handle all formats: standard URL, `host:port:user:pass`, IPv4
    - _Requirements: 3.8, 8.7_

  - [ ]* 3.2 Write property test for proxy URL parsing correctness
    - **Property 6: Proxy URL parsing correctness**
    - For any standard proxy URL, parsing returns correct `{server, username, password}` and round-trip is stable
    - **Validates: Requirements 8.7**

- [ ] 4. Extract Health Check modules
  - [ ] 4.1 Create `src/health/pre-flight.ts` with `preFlightProxyCheck` extracted from `slot-hunter/src/usaPortal/proxy-health-check.ts`
    - Replace `botLog` import with optional `logger` callback in `PreFlightOptions`
    - Use Impit for TLS fingerprint, 5000ms standard / 8000ms BrightData threshold
    - Export `ProxyHealthResult` interface and `preFlightProxyCheck` function
    - _Requirements: 2.6, 8.5_

  - [ ] 4.2 Create `src/health/session-guard.ts` with proxy session guard extracted from `slot-hunter/src/usaPortal/proxy-session-guard.ts`
    - Replace `botLog` import with optional `onFreeze` callback in `ProxyGuardOptions`
    - Preserve freeze logic (2 consecutive failures, 2-min interval, IP mismatch detection)
    - Export `initProxyGuard`, `releaseProxyGuard`, `isSessionFrozen`, `checkProxyLiveness`
    - _Requirements: 2.7, 8.6_

  - [ ] 4.3 Create `src/health/index.ts` barrel re-exporting everything from `pre-flight.ts` and `session-guard.ts`
    - _Requirements: 3.3_

  - [ ]* 4.4 Write property test for health check threshold selection
    - **Property 4: Health check threshold selection**
    - For any proxy URL, apply 8000ms if URL contains "brd.superproxy" or "brightdata", else 5000ms
    - **Validates: Requirements 8.5**

  - [ ]* 4.5 Write property test for session guard freeze invariant
    - **Property 5: Session guard freeze invariant**
    - For any sequence of pass/fail outcomes, freeze triggers if and only if 2+ consecutive failures, and clears on pass
    - **Validates: Requirements 8.6**

- [ ] 5. Extract IP Whitelist module
  - [ ] 5.1 Create `src/whitelist/index.ts` with `autoWhitelistIp` and `cleanupOldIproyalWhitelistEntries` extracted from `slot-hunter/src/ip-whitelist.ts`
    - Preserve all env var reads (`IPROYAL_API_TOKEN`, `IPROYAL_USER_HASH`, `BRIGHTDATA_API_KEY`, `BRIGHTDATA_ZONE_NAME`, `SOAX_PROXY_URL`, `TWOCAPTCHA_API_KEY`)
    - Export `WhitelistResult` interface
    - _Requirements: 2.2, 6.5, 6.6, 6.7, 6.10_

- [ ] 6. Extract Decodo Pool modules
  - [ ] 6.1 Create `src/decodo/spain.ts` with Spain Decodo pool extracted from `slot-hunter/src/spain-decodo-pool.ts`
    - Preserve CSV parsing, round-robin rotation, reload, multi-pool detection
    - Preserve env var priority: `DECODO_PROXY_FILE` > `DECODO_PROXY_URLS` > `DECODO_PROXY_URL`
    - Export `hasDecodoProxy`, `getCurrentDecodoUrl`, `rotateDecodoUrl`, `reloadDecodoPool`, `isDecodoMultiPool`, `getDecodoPoolSize`
    - _Requirements: 2.3, 6.8, 8.3_

  - [ ] 6.2 Create `src/decodo/germany.ts` with Germany Decodo pool extracted from `slot-hunter/src/germany-decodo-pool.ts`
    - Preserve CSV parsing, round-robin rotation, reload
    - Preserve env var priority: `GERMANY_DECODO_PROXY_FILE` > `GERMANY_DECODO_PROXY_URLS` > `GERMANY_DECODO_PROXY_URL`
    - Export `hasGermanyDecodoProxy`, `getCurrentGermanyDecodoUrl`, `rotateGermanyDecodoUrl`, `reloadGermanyDecodoPool`
    - _Requirements: 2.4, 6.9_

  - [ ] 6.3 Create `src/decodo/index.ts` barrel re-exporting everything from `spain.ts` and `germany.ts`
    - _Requirements: 3.5_

  - [ ]* 6.4 Write property test for Decodo pool source priority
    - **Property 3: Decodo pool source priority**
    - For any combination of CSV/URLS/URL presence, verify correct source is selected according to priority
    - **Validates: Requirements 8.3**

  - [ ]* 6.5 Write property test for Decodo round-robin rotation
    - **Property 7: Decodo round-robin rotation**
    - For a pool of N URLs, N rotations cycle through all URLs exactly once
    - **Validates: Requirements 2.3, 2.4**

- [ ] 7. Extract BrightData modules
  - [ ] 7.1 Create `src/brightdata/sticky.ts` with `makeBrightDataStickyUrl`, `makeBrightDataStickyUrlWithFallback`, `getBrightDataCountryConfig`, `rotateBrightDataSession` extracted from `slot-hunter/src/usaPortal/brightdata-proxy.ts`
    - Preserve V10 windowed session algorithm, country fallback logic
    - Read `BRIGHTDATA_RESIDENTIAL_PROXY_URL`, `BRIGHTDATA_COUNTRY`, `BRIGHTDATA_FALLBACK_COUNTRIES`
    - _Requirements: 2.5, 6.3, 6.4, 8.2_

  - [ ] 7.2 Create `src/brightdata/keep-alive.ts` with BrightData session keep-alive extracted from `slot-hunter/src/usaPortal/brightdata-proxy.ts`
    - Replace `tokenCache`/`isCachedTokenValid` import with `isTokenValid` callback in `BrightDataKeepAliveOptions`
    - Export `startBrightDataKeepAlive`, `stopBrightDataKeepAlive`, `hasBrightDataSession`, `getBrightDataSessionInfo`, `stopAllBrightDataKeepAlives`
    - _Requirements: 2.5_

  - [ ] 7.3 Create `src/brightdata/fixed-ip.ts` with `buildBrightDataUrl`, `parseBrightDataUrl`, `brightDataToCapSolverFormat`, `hasFixedSession`, `withSession`, `generateSessionId` extracted from `slot-hunter/src/brightdata-fixed-ip.ts`
    - Export `BrightDataProxyConfig` interface
    - _Requirements: 2.5_

  - [ ] 7.4 Create `src/brightdata/index.ts` barrel re-exporting everything from `sticky.ts`, `keep-alive.ts`, `fixed-ip.ts`
    - _Requirements: 3.6_

  - [ ]* 7.5 Write property test for BrightData sticky URL determinism
    - **Property 2: BrightData sticky URL determinism**
    - For any valid base URL, username, country code, same timestamp window → identical URL string
    - **Validates: Requirements 8.2**

- [ ] 8. Update sources barrel and root index
  - [ ] 8.1 Create `src/sources/index.ts` barrel re-exporting from existing `brightdata.ts`, `iproyal.ts`, `static.ts`
    - _Requirements: 3.7, 2.8_

  - [ ] 8.2 Create root `src/index.ts` barrel re-exporting all public APIs from all subdirectories
    - Import and re-export from `./pool/index.js`, `./health/index.js`, `./whitelist/index.js`, `./decodo/index.js`, `./brightdata/index.js`, `./sources/index.js`, `./utils.js`
    - _Requirements: 3.1, 10.9_

- [ ] 9. Checkpoint — Validate proxy-service compiles
  - Ensure `tsc --noEmit` passes on `artifacts/proxy-service`
  - Verify all subpath exports resolve correctly
  - Ask the user if questions arise.

- [ ] 10. Migrate slot-hunter consumers — core entry points
  - [ ] 10.1 Update `slot-hunter/src/index.ts`: import `ProxyPool` from `@workspace/proxy-service/pool`, import `detectPublicIp` from `@workspace/proxy-service/utils`, import `autoWhitelistIp` from `@workspace/proxy-service/whitelist`; instantiate ProxyPool here and pass to consumers
    - _Requirements: 4.2, 5.3_

  - [ ] 10.2 Update `slot-hunter/src/browser.ts`: remove `ProxyPool` import and singleton instantiation, remove `proxyPool` export, keep only browser-related exports (user agents, viewports, Puppeteer helpers), import `parseHttpProxyUrlForPlaywright` from `@workspace/proxy-service/utils` if still needed
    - _Requirements: 4.1, 5.1, 5.2, 5.4_

  - [ ] 10.3 Update `slot-hunter/src/bundle-check.ts`: change proxy imports to `@workspace/proxy-service`
    - _Requirements: 4.3_

  - [ ] 10.4 Update `slot-hunter/src/daily-report.ts`: change proxy state imports to `@workspace/proxy-service`
    - _Requirements: 4.4_

- [ ] 11. Migrate slot-hunter consumers — USA portal
  - [ ] 11.1 Update `slot-hunter/src/usaPortal/impl.ts`: import BrightData from `@workspace/proxy-service/brightdata`, health checks from `@workspace/proxy-service/health`; wire `logger` and `onFreeze` callbacks to `botLog`
    - _Requirements: 4.5_

  - [ ] 11.2 Update `slot-hunter/src/usaPortal/usa-http.ts`: import ProxyPool from `@workspace/proxy-service/pool`; accept ProxyPool instance as parameter or import from entry point
    - _Requirements: 4.6_

  - [ ] 11.3 Update `slot-hunter/src/usaPortal/accounts-keep-alive.ts`: import BrightData keep-alive from `@workspace/proxy-service/brightdata`; pass `isTokenValid` callback wrapping `isCachedTokenValid(tokenCache.get(username))`
    - _Requirements: 4.7_

  - [ ] 11.4 Update `slot-hunter/src/usaPortal/account-restriction.ts`: import proxy rotation from `@workspace/proxy-service/pool` or `@workspace/proxy-service/brightdata`
    - _Requirements: 4.8_

- [ ] 12. Migrate slot-hunter consumers — Spain portal
  - [ ] 12.1 Update `slot-hunter/src/spain-persistent-browser.ts`: import Decodo pool from `@workspace/proxy-service/decodo`
    - _Requirements: 4.9_

  - [ ] 12.2 Update `slot-hunter/src/spain-impit-session.ts`: import Decodo pool from `@workspace/proxy-service/decodo`
    - _Requirements: 4.10_

  - [ ] 12.3 Update `slot-hunter/src/spain-soax-solver.ts`: import proxy sources from `@workspace/proxy-service/sources`
    - _Requirements: 4.11_

  - [ ] 12.4 Update `slot-hunter/src/spain-2captcha-browser.ts`: import ProxyPool from `@workspace/proxy-service/pool`
    - _Requirements: 4.12_

  - [ ] 12.5 Update `slot-hunter/src/spain-http-scanner.ts`: import Decodo pool from `@workspace/proxy-service/decodo`
    - _Requirements: 4.13_

- [ ] 13. Migrate slot-hunter consumers — remaining files
  - [ ] 13.1 Update `slot-hunter/src/cf-challenge-solver.ts`: import proxy from `@workspace/proxy-service`
    - _Requirements: 4.14_

  - [ ] 13.2 Update `slot-hunter/scripts/usa-portal-capture.ts`: import proxy from `@workspace/proxy-service`
    - _Requirements: 4.15_

  - [ ] 13.3 Remove extracted files from slot-hunter: delete `src/proxyPool.ts`, `src/ip-whitelist.ts`, `src/spain-decodo-pool.ts`, `src/germany-decodo-pool.ts`, `src/brightdata-fixed-ip.ts`, `src/usaPortal/proxy-health-check.ts`, `src/usaPortal/proxy-session-guard.ts`, `src/usaPortal/brightdata-proxy.ts`
    - _Requirements: 2.9_

- [ ] 14. Checkpoint — Full compilation validation
  - Run `tsc --noEmit` on both `artifacts/proxy-service` and `artifacts/slot-hunter`
  - Fix any remaining import errors or type mismatches
  - Verify no proxy implementation files remain in slot-hunter (all extracted)
  - Ensure all tests pass, ask the user if questions arise.

- [ ]* 15. Write property test for environment variable coverage
  - **Property 9: Environment variable coverage**
  - For all env var names in Requirement 6, verify they are referenced in proxy-service source
  - **Validates: Requirements 6.1–6.11**

- [ ] 16. Final checkpoint — Full validation
  - Run `tsc --noEmit` on both packages one final time
  - Verify `browser.ts` exports no proxy symbols
  - Verify slot-hunter `package.json` has `@workspace/proxy-service` as workspace dependency
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The design uses TypeScript — no language selection needed
- Key dependency inversions: `botLog` → `logger` callback, `tokenCache` → `isTokenValid` callback
- Existing `src/sources/` files in proxy-service (brightdata.ts, iproyal.ts, static.ts) are preserved as-is
- Module-level state in Decodo pools is preserved (inherently singleton via module scope)
- ProxyPool becomes explicitly instantiated in `index.ts` — no more implicit singleton

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "3.1", "5.1", "6.1", "6.2", "7.3"] },
    { "id": 2, "tasks": ["2.2", "4.1", "4.2", "6.3", "7.1", "7.2", "8.1"] },
    { "id": 3, "tasks": ["2.3", "2.4", "3.2", "4.3", "4.4", "4.5", "6.4", "6.5", "7.4", "7.5", "8.2"] },
    { "id": 4, "tasks": ["10.1", "10.2", "10.3", "10.4"] },
    { "id": 5, "tasks": ["11.1", "11.2", "11.3", "11.4", "12.1", "12.2", "12.3", "12.4", "12.5"] },
    { "id": 6, "tasks": ["13.1", "13.2", "13.3"] },
    { "id": 7, "tasks": ["15"] }
  ]
}
```
