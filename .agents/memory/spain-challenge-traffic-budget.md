---
name: Spain challenge traffic budget
description: Rule for avoiding unnecessary Cloudflare challenge and proxy traffic in the Spain watcher
---

## Rule
The Spain watcher must not pre-warm Cloudflare or run proxy probes when there is no active Spain dossier with Bookitit credentials. It should poll configuration and dossiers first, then solve or reuse the persisted CF session only when a real booking candidate exists.

**Why:** A single Cloudflare challenge can consume roughly 1.6 MB of proxy traffic, while later Bookitit probes reuse the same clearance. Solving at service startup with no dossier wastes bandwidth and CapSolver credits.

**How to apply:** Keep the no-dossier guard before `ensureSpainCfSession()` and `runSpainHttpProbe()`. Preserve Redis session reuse and only solve again when the session is missing, expired, or invalidated by a real response.