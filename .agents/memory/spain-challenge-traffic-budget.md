---
name: Spain challenge traffic budget
description: Rule for avoiding unnecessary Cloudflare challenge and proxy traffic in the Spain watcher
---

## Rule
The Spain watcher must not pre-warm Cloudflare or run proxy probes when there is no active Spain dossier with Bookitit credentials. It should poll configuration and dossiers first, then solve or reuse the persisted CF session only when a real booking candidate exists.

**Why:** A single Cloudflare challenge can consume roughly 1.6 MB of proxy traffic, while later Bookitit probes reuse the same clearance. Solving at service startup with no dossier wastes bandwidth and CapSolver credits.

**How to apply:** Keep the no-dossier guard before `ensureSpainCfSession()` and `runSpainHttpProbe()`. Preserve Redis session reuse and only solve again when the session is missing, expired, or invalidated by a real response.

## Important interpretation
Traffic reports count the internal requests made by one Cloudflare challenge, not the number of challenge resolutions. Five requests to `challenges.cloudflare.com` can therefore represent one solve, not five solves.

**Why:** A single solve loads several challenge/iframe/API resources. The Spain watcher logs distinguish `Session CF établie` from `Session CF réutilisée`; those are the reliable indicators for counting solves.