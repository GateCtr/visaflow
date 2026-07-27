---
name: Spain watcher cadence and diagnostics
description: Cadence configuration and response diagnostics for the Spain HTTP-only watcher
---

## Rule
The Spain HTTP-only watcher uses an explicit `intervalSec` setting stored in Convex. The interval is measured from the start of one probe to the start of the next, not as an additional sleep after the probe completes.

**Why:** A hard-coded 60-second post-probe delay made the admin interval ineffective and produced misleading cycle timing. Empty `/onlinebookings/main/` bodies also need HTTP metadata to distinguish a real empty response from a body-read failure.

**How to apply:** Keep `intervalSec` clamped to a safe range, retain `intervalMin` only as a legacy fallback, and log status, raw/decoded sizes, content type, CF-Ray, redirect URL, preview, and body-read errors for anomalous `/main/` responses.

An empty `200` from `/onlinebookings/main/` is not a normal “no appointment” result: the expected no-slot response is still non-empty HTML. A curl/Burp request dump without response headers and body cannot establish a shadow ban.

**Why:** The real browser sends executable Cloudflare/Bookitit state and telemetry, while HTTP-only can only approximate it; a WAF/edge response, session mismatch, or transport issue can look like an empty business response.

**How to apply:** Treat `status=200 + empty body` as an upstream/session/protocol anomaly. Compare the same proxy and fresh session in a real browser and HTTP client, and capture the response body for every preceding portal POST before attributing it to appointment-level filtering.