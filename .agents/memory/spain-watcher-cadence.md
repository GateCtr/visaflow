---
name: Spain watcher cadence and diagnostics
description: Cadence configuration and response diagnostics for the Spain HTTP-only watcher
---

## Rule
The Spain HTTP-only watcher uses an explicit `intervalSec` setting stored in Convex. The interval is measured from the start of one probe to the start of the next, not as an additional sleep after the probe completes.

**Why:** A hard-coded 60-second post-probe delay made the admin interval ineffective and produced misleading cycle timing. Empty `/onlinebookings/main/` bodies also need HTTP metadata to distinguish a real empty response from a body-read failure.

**How to apply:** Keep `intervalSec` clamped to a safe range, retain `intervalMin` only as a legacy fallback, and log status, raw/decoded sizes, content type, CF-Ray, redirect URL, preview, and body-read errors for anomalous `/main/` responses.