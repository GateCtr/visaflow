---
name: CEV implementation plan
description: Complete anti-shadow-ban overhaul — key decisions, evidence, and constraints from real HAR captures and Amazon Q analysis.
---

## Key confirmed findings from real captures (2026-06-08/09)

**Critical bugs confirmed in real HAR:**
1. Playwright F5 capture session leaks `"HeadlessChrome"` in `sec-ch-ua` — immediate detection (confidence 0.95 per Amazon Q)
2. sec-ch-ua format wrong: bot uses `"Not:A-Brand"` (colon), real Chrome 148 uses `"Not/A)Brand"` (slash + paren)
3. Missing cookies `ServerId` and `_culture` — both present in every real human request to visaonweb
4. Sec-Fetch-Site is `same-site` for Integration/VOW navigation (cross-subdomain under .diplomatie.be), bot sends `same-origin`
5. Real header order: sec-ch-ua*, sec-ch-ua-mobile, sec-ch-ua-platform go **last and lowercase** in Chrome real requests
6. `POST /Common/LogRenderingClientTime` telemetry sent automatically by OutSystems AngularJS — bot never sends it

**Architecture decision:**
- Full Puppeteer flow (login → IndexByUserId → GetEAppointmentUrl → /Captcha → SetCaptchaToken), then impit for polling only
- **Why:** The Puppeteer→impit session break (different TLS JA4 + zero sub-resources) triggers TGT_ML_CoordinatedActivity and TGT_SessionConsistency rules in F5 BIG-IP behavioral scoring
- **How:** captureFullSessionForAccount() replaces captureF5CookieForAccount(); extracts FullCevSession (all 7 cookies)

**hCaptcha proxy rule:**
- Must use HCaptchaTask (WITH proxy) when SOAX proxy is active — ProxyLess creates IP jump detectable as split-traffic
- CapSolver blacklisted for CEV sitekeys since 2026-04 — use Anti-Captcha only

**Session manager changes:**
- TTL reduced 24h → 4h (session actually expires sooner)
- Shadow ban threshold: 15 consecutive "no slots" → invalidate and re-run Puppeteer flow
- Account-level lock to prevent race condition in multi-dossier round-robin

**SOAX rotation fix:**
- All sticky sessions were rotating simultaneously at 00h/12h UTC → coordinated pattern
- Fix: per-account offset = (accountIndex % 12) * 1h + ±15min jitter

**Plan file location:** `CEV_BOT_IMPLEMENTATION_PLAN.md` (root of workspace, 1259 lines)
