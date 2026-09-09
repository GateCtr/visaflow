---
name: Spain signin HTTP observability
description: Safe comparison of Bookitit signin responses across portals and transient HTTP handling.
---

`getsigninfields/` and `signin/` traces must compare status, redirect, content type, byte length, body fingerprint, parser shape, payload key names, error count, token presence, and cookie fingerprints without logging body or credentials.

`getsigninfields/` also needs two fingerprints: a content fingerprint with dynamic nonce/token-like fields normalized, and a schema fingerprint over keys, types, and array lengths. This distinguishes a changed form contract from a changing session value.

**Why:** Kinshasa can fail after all earlier checks pass, and the meaningful difference may be a 200 response with an empty/non-JSONP body, a transient status, or a tiny contract change rather than an obvious application error.

**How to apply:** Keep the same DynamicSession and IP across retries. Retry only transient HTTP statuses (408, 425, 429, 500, 502, 503, 504); treat business 4xx responses as deterministic. Compare sanitized traces with Saopolo/Cuba before changing booking parameters.

For captcha-protected booking, never log `gct` or any other token-bearing query parameter. A `signin/` HTTP 504 with an HTML gateway body and `Retry-After` is a server/proxy timeout, not proof of an empty response or a captcha rejection; the worker must preserve that distinction from the legacy `0B` label.

**Why:** A publication race produced simultaneous 504 HTML responses for several workers while `getsigninfields/` and cookies remained stable. Replaying the same one-use token during retries can add a token failure, but cannot be inferred from the 504 alone.

**How to apply:** Record status, body shape, fingerprints, retry hints, and token age without token values. Treat the first fresh-token attempt separately from later retries, and do not classify a final HTTP overload sentinel as a literal empty body.