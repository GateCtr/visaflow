---
name: Spain Bookitit session cookie rotation
description: PHPSESSID may rotate during the JSONP booking flow and must be propagated between sequential endpoints.
---

Bookitit can return a new `PHPSESSID` through `Set-Cookie` during a stateful flow such as `getsigninfields/`. The next endpoint, especially `signin/`, must use the updated cookie from the same dynamic session; treating the initial PHPSESSID as immutable can produce misleading `0B` responses.

**Why:** The booking flow is server-side stateful, and a valid response from `getsigninfields/` does not guarantee that the original session identifier remains current for `signin/`.

**How to apply:** Any direct JSONP helper must merge response cookies into its jar before parsing/returning, rebuild request headers after a cookie update or retry, and persist the jar back to the owning session when that session will be reused.