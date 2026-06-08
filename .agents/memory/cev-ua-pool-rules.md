---
name: CEV UA pool rules
description: Rules for maintaining the CEV_UA_POOL in cev-shared-impit.ts to avoid bot detection.
---

## Rules

1. **Always use real 4-part build numbers** — `Chrome/148.0.7778.96` not `Chrome/148.0.0.0`. No real user ever has `.0.0.0` suffix. This is the #1 WAF fingerprint trigger.

2. **Always include "Google Chrome" brand for official stable Chrome** — sec-ch-ua must have 3 brands: `"Not/A)Brand";v="99", "Chromium";v="X", "Google Chrome";v="X"`. Chrome 109+ always sends this triple. Only Chromium builds (not installed from google.com) omit it.

3. **No Linux profiles** — Belgian visa portal user base is overwhelmingly Windows/macOS. Linux is a red flag demographic signal.

4. **Edge entries use real Edg/ build number** — `Edg/148.0.2849.68` not `Edg/148.0.0.0`.

5. **Keep profiles to Windows + macOS only** — consistent with real user demographics.

## Current pool (as of 2026-06-08 after FIX #7/#8)
| UA | Platform | Notes |
|----|----------|-------|
| Chrome/148.0.7778.96 Win | Windows | Primary (FIX #6) |
| Chrome/147.0.7231.96 Win | Windows | Secondary (FIX #7) |
| Chrome/148.0.7778.96 Mac | macOS | Diversity |
| Edge/148.0.2849.68 Win | Windows | Edge coverage (FIX #8) |
| Chrome/147.0.7231.96 Mac | macOS | FIX #7 (replaces Linux) |

**Why:** F5 BIG-IP ASM and Cloudflare Bot Management both fingerprint UA build number format and sec-ch-ua brand consistency as primary bot signals. These are cheap, deterministic checks that fire before any ML-based analysis.
