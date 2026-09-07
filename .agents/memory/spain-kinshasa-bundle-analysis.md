---
name: Kinshasa Bookitit bundle analysis
description: The Kinshasa widget's static JavaScript is only a loader; portal-specific form behavior arrives from a dynamic onlinebookings response.
---

The Kinshasa frontend loads `loadermaec.js?v=4`, then the small shared `mainv1.js?v=4` core. The core requests `/onlinebookings/main/?callback=?` and loads RequireJS modules; the static bundle does not define `signin`, `logintype`, or `CustomFields`.

**Why:** A CapSolver-resolved session successfully downloaded the public loader/core, but the static files contained no portal-specific login contract. Searching only JavaScript would therefore miss the fields that can explain a Kinshasa `signin/` empty response.

**How to apply:** When a Kinshasa slot is available, capture and compare the dynamic `onlinebookings/main` response plus the browser's `getsigninfields/` and `signin/` request bodies. Keep the same sticky proxy/TLS session while solving Cloudflare; a cached clearance can be invalid for a newly generated sticky session and return 403.

The booking fallback order is `document`, then `passport`, then `email` by default. A later type is attempted only for an empty/unusable signin response with no business errors; explicit credential or validation errors stop the sequence.

**Why:** Retrying another login type after Bookitit has explicitly rejected credentials would create unnecessary authentication attempts and could hide the real failure.

**How to apply:** Keep `document` first for Kinshasa. Use `SPAIN_LOGIN_TYPES` only when a portal's dynamic form proves a different order or supported value.