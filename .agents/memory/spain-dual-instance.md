---
name: Spain dual-instance collision fix
description: Why running Railway + Replit simultaneously causes empty /main/ responses, and how it was fixed.
---

# Spain dual-instance collision

## The rule
Set `SPAIN_SCAN_DISABLED=1` on Replit when Railway is the active Spain scanner. Remove it only if Railway goes down and Replit must take over.

**Why:** Railway and Replit each have their own Redis (Replit=localhost:6379, Railway=external). The distributed lock (`visaflow:spain-scanner:lock`) only works when both instances share the **same** Redis. With separate Redis instances, both acquire the lock independently → two Chromium persistent-browser sessions scan citaconsular.es with the same dossier account simultaneously → the portal invalidates one session → `/main/` returns empty body.

**How to apply:** 
- Replit env var `SPAIN_SCAN_DISABLED=1` → watcher returns immediately at startup, no scan.
- Remove `SPAIN_SCAN_DISABLED` and restart slot-hunter on Replit to activate it as backup.
- Chrome is installed at `/home/runner/.cache/puppeteer` (version 149.0.7827.22) so Replit is ready as backup without extra setup.
- Long-term fix: point both instances to the same Redis (Upstash or Railway Redis URL) so the distributed lock actually coordinates them.
