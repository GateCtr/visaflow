# Requirements Document

## Introduction

Extract all proxy-related logic from `artifacts/slot-hunter` into `artifacts/proxy-service` as a pure TypeScript library. The proxy-service currently exists as an Express HTTP server with basic source wrappers (BrightData, iProyal, static). It must be reworked into a zero-server library exposing all proxy functionality (pools, health checks, session guards, IP whitelisting, Decodo pools) via clean TypeScript exports consumable through the `@workspace/proxy-service` pnpm workspace protocol. All consumers in slot-hunter (~12+ files) must be updated to import from the new package, and the singleton `proxyPool` instance in `browser.ts` must be replaced by explicit factory instantiation in the entry point.

## Glossary

- **Proxy_Service**: The `@workspace/proxy-service` pnpm workspace package located at `artifacts/proxy-service`, exposing proxy management as a library.
- **Slot_Hunter**: The `artifacts/slot-hunter` application that consumes proxy functionality.
- **ProxyPool**: The 2captcha gateway-based residential proxy pool with sticky session support (currently `slot-hunter/src/proxyPool.ts`).
- **Decodo_Pool**: A round-robin pool of Decodo ISP/datacenter proxy URLs loaded from CSV files or environment variables (Spain and Germany variants).
- **BrightData_Module**: The BrightData residential proxy module with sticky sessions, keep-alive, country fallback, and session management (currently `slot-hunter/src/usaPortal/brightdata-proxy.ts` and `slot-hunter/src/brightdata-fixed-ip.ts`).
- **IP_Whitelist**: The auto-whitelisting module that registers the server IP with IPRoyal, BrightData, SOAX, and 2Captcha at startup (currently `slot-hunter/src/ip-whitelist.ts`).
- **Proxy_Health_Check**: Pre-flight and mid-session proxy liveness verification (currently `slot-hunter/src/usaPortal/proxy-health-check.ts` and `proxy-session-guard.ts`).
- **Consumer**: Any source file in Slot_Hunter that imports proxy functionality.
- **Subpath_Export**: A package.json `exports` field entry enabling `@workspace/proxy-service/pool`, `@workspace/proxy-service/health`, etc.
- **Singleton_Pattern**: The current pattern in `browser.ts` where `proxyPool` is instantiated at module scope and exported as a module-level constant.

## Requirements

### Requirement 1: Library-Only Architecture

**User Story:** As a developer, I want proxy-service to be a pure TypeScript library with no runtime server, so that it can be consumed by any workspace package without starting a separate process.

#### Acceptance Criteria

1. THE Proxy_Service SHALL export all proxy functionality as TypeScript modules without running an HTTP server.
2. THE Proxy_Service SHALL NOT depend on `express` or any HTTP framework in its production dependencies.
3. THE Proxy_Service SHALL be consumable via the pnpm workspace protocol as `@workspace/proxy-service`.
4. WHEN Slot_Hunter imports from Proxy_Service, THE Proxy_Service SHALL resolve at build time without requiring a running process.

### Requirement 2: Module Extraction from Slot_Hunter

**User Story:** As a developer, I want all proxy logic centralized in proxy-service, so that slot-hunter has zero proxy implementation code.

#### Acceptance Criteria

1. THE Proxy_Service SHALL contain the full implementation of ProxyPool (2captcha gateway mode with sticky sessions, rotation, session IDs).
2. THE Proxy_Service SHALL contain the full implementation of IP_Whitelist (IPRoyal, BrightData, SOAX, 2Captcha auto-whitelisting).
3. THE Proxy_Service SHALL contain the full implementation of Decodo_Pool for Spain (CSV parsing, round-robin rotation, reload, multi-pool detection).
4. THE Proxy_Service SHALL contain the full implementation of Decodo_Pool for Germany (CSV parsing, round-robin rotation, reload).
5. THE Proxy_Service SHALL contain the full implementation of BrightData_Module (sticky URLs, country fallback, keep-alive, session rotation, CapSolver format conversion).
6. THE Proxy_Service SHALL contain the full implementation of Proxy_Health_Check (pre-flight check via Impit with latency thresholds).
7. THE Proxy_Service SHALL contain the full implementation of Proxy_Session_Guard (mid-session liveness, freeze logic, IP mismatch detection).
8. THE Proxy_Service SHALL retain the existing source wrappers (BrightData source, iProyal source, static source) with verify functions.
9. WHEN extraction is complete, THE Slot_Hunter SHALL contain zero proxy implementation files (all extracted files removed from slot-hunter/src/).

### Requirement 3: Package.json Exports Field

**User Story:** As a developer, I want clean subpath imports from proxy-service, so that consumers can import only the modules they need.

#### Acceptance Criteria

1. THE Proxy_Service SHALL expose a root export (`@workspace/proxy-service`) re-exporting all public APIs.
2. THE Proxy_Service SHALL expose a subpath export `@workspace/proxy-service/pool` for ProxyPool and related types.
3. THE Proxy_Service SHALL expose a subpath export `@workspace/proxy-service/health` for pre-flight and mid-session health checks.
4. THE Proxy_Service SHALL expose a subpath export `@workspace/proxy-service/whitelist` for IP_Whitelist functionality.
5. THE Proxy_Service SHALL expose a subpath export `@workspace/proxy-service/decodo` for Spain and Germany Decodo pools.
6. THE Proxy_Service SHALL expose a subpath export `@workspace/proxy-service/brightdata` for all BrightData proxy functionality.
7. THE Proxy_Service SHALL expose a subpath export `@workspace/proxy-service/sources` for basic source wrappers (iProyal, BrightData, static).
8. THE Proxy_Service SHALL expose a subpath export `@workspace/proxy-service/utils` for shared utilities (parseHttpProxyUrlForPlaywright, detectPublicIp).

### Requirement 4: Consumer Migration

**User Story:** As a developer, I want all slot-hunter files that use proxy logic to import from `@workspace/proxy-service`, so that there is a single source of truth.

#### Acceptance Criteria

1. WHEN `src/browser.ts` requires ProxyPool, THE Slot_Hunter SHALL import ProxyPool from `@workspace/proxy-service/pool`.
2. WHEN `src/index.ts` requires proxy initialization, THE Slot_Hunter SHALL import from `@workspace/proxy-service`.
3. WHEN `src/bundle-check.ts` requires proxy functionality, THE Slot_Hunter SHALL import from `@workspace/proxy-service`.
4. WHEN `src/daily-report.ts` requires proxy state, THE Slot_Hunter SHALL import from `@workspace/proxy-service`.
5. WHEN `src/usaPortal/impl.ts` requires BrightData proxy or health checks, THE Slot_Hunter SHALL import from `@workspace/proxy-service/brightdata` or `@workspace/proxy-service/health`.
6. WHEN `src/usaPortal/usa-http.ts` requires proxy pool, THE Slot_Hunter SHALL import from `@workspace/proxy-service/pool`.
7. WHEN `src/usaPortal/accounts-keep-alive.ts` requires BrightData keep-alive, THE Slot_Hunter SHALL import from `@workspace/proxy-service/brightdata`.
8. WHEN `src/usaPortal/account-restriction.ts` requires proxy rotation, THE Slot_Hunter SHALL import from `@workspace/proxy-service/pool` or `@workspace/proxy-service/brightdata`.
9. WHEN `src/spain-persistent-browser.ts` requires Decodo pool, THE Slot_Hunter SHALL import from `@workspace/proxy-service/decodo`.
10. WHEN `src/spain-impit-session.ts` requires Decodo pool, THE Slot_Hunter SHALL import from `@workspace/proxy-service/decodo`.
11. WHEN `src/spain-soax-solver.ts` requires proxy sources, THE Slot_Hunter SHALL import from `@workspace/proxy-service/sources`.
12. WHEN `src/spain-2captcha-browser.ts` requires proxy pool, THE Slot_Hunter SHALL import from `@workspace/proxy-service/pool`.
13. WHEN `src/spain-http-scanner.ts` requires Decodo pool, THE Slot_Hunter SHALL import from `@workspace/proxy-service/decodo`.
14. WHEN `src/cf-challenge-solver.ts` requires proxy functionality, THE Slot_Hunter SHALL import from `@workspace/proxy-service`.
15. WHEN `scripts/usa-portal-capture.ts` requires proxy, THE Slot_Hunter SHALL import from `@workspace/proxy-service`.

### Requirement 5: Singleton Removal from browser.ts

**User Story:** As a developer, I want proxy instantiation to happen explicitly in the entry point, so that browser.ts has no implicit global state.

#### Acceptance Criteria

1. THE Slot_Hunter `src/browser.ts` SHALL NOT instantiate ProxyPool at module scope.
2. THE Slot_Hunter `src/browser.ts` SHALL NOT export a `proxyPool` singleton.
3. WHEN ProxyPool is needed, THE Slot_Hunter `src/index.ts` or an explicit factory SHALL create the instance and pass it to consumers.
4. THE Slot_Hunter `src/browser.ts` SHALL retain only browser-related exports (user agents, viewports, Puppeteer helpers).

### Requirement 6: Environment Variable Compatibility

**User Story:** As a developer, I want the extracted proxy-service to use the same environment variables as before, so that no deployment configuration changes are needed.

#### Acceptance Criteria

1. THE Proxy_Service SHALL read `IPROYAL_PROXY_URL` for IPRoyal proxy source configuration.
2. THE Proxy_Service SHALL read `BRIGHTDATA_PROXY_URL` for BrightData proxy source configuration.
3. THE Proxy_Service SHALL read `BRIGHTDATA_RESIDENTIAL_PROXY_URL` for BrightData residential proxy with zone info.
4. THE Proxy_Service SHALL read `BRIGHTDATA_COUNTRY` and `BRIGHTDATA_FALLBACK_COUNTRIES` for BrightData country targeting.
5. THE Proxy_Service SHALL read `BRIGHTDATA_API_KEY` and `BRIGHTDATA_ZONE_NAME` for BrightData API whitelist.
6. THE Proxy_Service SHALL read `TWOCAPTCHA_API_KEY` and `TWOCAPTCHA_PROXY_USER` for 2captcha gateway proxy pool.
7. THE Proxy_Service SHALL read `IPROYAL_API_TOKEN`, `IPROYAL_USER_HASH`, `IPROYAL_WHITELIST_PORT`, `IPROYAL_WHITELIST_PROTO`, `IPROYAL_WHITELIST_CONFIG` for IPRoyal whitelisting.
8. THE Proxy_Service SHALL read `DECODO_PROXY_FILE`, `DECODO_PROXY_URLS`, `DECODO_PROXY_URL` for Spain Decodo pool.
9. THE Proxy_Service SHALL read `GERMANY_DECODO_PROXY_FILE`, `GERMANY_DECODO_PROXY_URLS`, `GERMANY_DECODO_PROXY_URL` for Germany Decodo pool.
10. THE Proxy_Service SHALL read `SOAX_PROXY_URL` for SOAX proxy configuration.
11. THE Proxy_Service SHALL read `PROXY_URL` for static proxy fallback.

### Requirement 7: Dependencies

**User Story:** As a developer, I want proxy-service to declare its own dependencies, so that it is self-contained.

#### Acceptance Criteria

1. THE Proxy_Service SHALL declare `impit` as a production dependency.
2. THE Proxy_Service SHALL declare `undici` as a production dependency.
3. THE Proxy_Service SHALL declare `ioredis` as a production dependency.
4. THE Proxy_Service SHALL NOT declare `express` or any HTTP framework as a dependency.
5. THE Proxy_Service SHALL declare `typescript` and `@types/node` as dev dependencies.
6. THE Proxy_Service SHALL declare `tsx` as a dev dependency for development scripts.

### Requirement 8: Zero Behavioral Change

**User Story:** As a developer, I want the extraction to be a pure refactoring with no behavioral changes, so that all existing proxy logic works identically after extraction.

#### Acceptance Criteria

1. THE Proxy_Service ProxyPool SHALL generate identical sticky session IDs for the same inputs (deterministic session generation preserved).
2. THE Proxy_Service BrightData_Module SHALL produce identical sticky URLs with the same V10 windowed session logic.
3. THE Proxy_Service Decodo_Pool SHALL parse CSV files and environment variables with identical priority order (CSV > URLS > URL).
4. THE Proxy_Service IP_Whitelist SHALL call IPRoyal and BrightData APIs with identical request format and error handling.
5. THE Proxy_Service Proxy_Health_Check SHALL use the same latency thresholds (5000ms standard, 8000ms BrightData).
6. THE Proxy_Service Proxy_Session_Guard SHALL use the same freeze logic (2 consecutive failures, 2-minute check interval).
7. THE Proxy_Service `parseHttpProxyUrlForPlaywright` utility SHALL handle all proxy URL formats identically (standard URL, host:port:user:pass, IPv4).
8. WHEN all consumers are migrated, THE Slot_Hunter SHALL produce identical runtime behavior (same logs, same API calls, same timing).

### Requirement 9: TypeScript Configuration

**User Story:** As a developer, I want proxy-service to have proper TypeScript strict mode and ESM configuration, so that it integrates cleanly with the monorepo.

#### Acceptance Criteria

1. THE Proxy_Service SHALL use TypeScript strict mode.
2. THE Proxy_Service SHALL use ESM module format (`"type": "module"` in package.json).
3. THE Proxy_Service SHALL use `.js` extensions in import paths for ESM compatibility.
4. THE Proxy_Service tsconfig SHALL extend the monorepo base tsconfig if one exists, or match the Slot_Hunter tsconfig settings.
5. THE Proxy_Service SHALL compile without errors (`tsc --noEmit` passes).

### Requirement 10: Internal Module Structure

**User Story:** As a developer, I want proxy-service to have a clean internal file organization, so that it is maintainable and navigable.

#### Acceptance Criteria

1. THE Proxy_Service SHALL organize source files under `src/` with logical subdirectories.
2. THE Proxy_Service SHALL have a `src/pool/` directory containing ProxyPool implementation and types.
3. THE Proxy_Service SHALL have a `src/health/` directory containing pre-flight and session guard modules.
4. THE Proxy_Service SHALL have a `src/whitelist/` directory containing IP_Whitelist logic.
5. THE Proxy_Service SHALL have a `src/decodo/` directory containing Spain and Germany Decodo pool implementations.
6. THE Proxy_Service SHALL have a `src/brightdata/` directory containing BrightData sticky session, keep-alive, and fixed-IP modules.
7. THE Proxy_Service SHALL have a `src/sources/` directory containing basic source wrappers (iProyal, BrightData, static) — existing files preserved.
8. THE Proxy_Service SHALL have a `src/utils.ts` file containing shared utilities (parseHttpProxyUrlForPlaywright, detectPublicIp).
9. THE Proxy_Service SHALL have a `src/index.ts` barrel file re-exporting all public APIs.
