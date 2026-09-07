---
name: Spain signin HTTP observability
description: Safe comparison of Bookitit signin responses across portals and transient HTTP handling.
---

`getsigninfields/` and `signin/` traces must compare status, redirect, content type, byte length, body fingerprint, parser shape, payload key names, error count, token presence, and cookie fingerprints without logging body or credentials.

**Why:** Kinshasa can fail after all earlier checks pass, and the meaningful difference may be a 200 response with an empty/non-JSONP body, a transient status, or a tiny contract change rather than an obvious application error.

**How to apply:** Keep the same DynamicSession and IP across retries. Retry only transient HTTP statuses (408, 425, 429, 500, 502, 503, 504); treat business 4xx responses as deterministic. Compare sanitized traces with Saopolo/Cuba before changing booking parameters.