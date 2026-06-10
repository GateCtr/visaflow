---
name: CEV UA pool rules
description: Rules for maintaining the CEV_UA_POOL in cev-shared-impit.ts to avoid bot detection.
---

## Rules

1. **Always use real 4-part build numbers** — `Chrome/149.0.7827.55` not `Chrome/149.0.0.0`. No real user ever has `.0.0.0` suffix. This is the #1 WAF fingerprint trigger.

2. **Always include "Google Chrome" brand for official stable Chrome** — sec-ch-ua must have 3 brands: `"Not/A)Brand";v="99", "Chromium";v="X", "Google Chrome";v="X"`. Chrome 109+ always sends this triple. Only Chromium builds (not installed from google.com) omit it.

3. **No Linux profiles** — Belgian visa portal user base is overwhelmingly Windows/macOS. Linux is a red flag demographic signal.

4. **Edge entries use real Edg/ build number** — `Edg/148.0.2849.68` not `Edg/148.0.0.0`.

5. **Keep profiles to Windows + macOS only** — consistent with real user demographics.

6. **Keep Chrome current** — Chrome releases every ~4 weeks. Verify current stable via `https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=3`. Add the new version as primary entries, keep 1-2 previous versions for realism (not everyone updates immediately). Drop versions older than 3 releases.

7. **Login timing jitter** — `getVowintSession` in `cevHttpSetup.ts` adds a 2-8s random delay between GET login page and POST login (simulates human typing). Do NOT remove this — submitting a login form in <100ms is a WAF trigger.

## Current pool (as of 2026-06-10 after Chrome 149 update)
| UA | Platform | Notes |
|----|----------|-------|
| Chrome/149.0.7827.55 Win | Windows | Primary — current stable |
| Chrome/149.0.7827.55 Mac | macOS | Primary — current stable |
| Chrome/149.0.7827.103 Win | Windows | Patch variant (progressive rollout) |
| Chrome/148.0.7778.96 Win | Windows | Secondary — still widely deployed |
| Chrome/148.0.7778.96 Mac | macOS | Secondary |
| Edge/148.0.2849.68 Win | Windows | Edge coverage |
| Chrome/147.0.7231.96 Win | Windows | Slow-updater tail |

**Why:** F5 BIG-IP ASM and Cloudflare Bot Management both fingerprint UA build number format and sec-ch-ua brand consistency as primary bot signals. These are cheap, deterministic checks that fire before any ML-based analysis.
