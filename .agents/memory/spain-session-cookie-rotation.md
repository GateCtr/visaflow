---
name: Spain Bookitit session cookie rotation
description: Booking keeps the same PHPSESSID through signin; only summary may rotate the session cookie.
---

The booking flow deliberately keeps the same PHPSESSID and session jar from `getsigninfields/` through `signin/`. Do not merge or rotate cookies between those calls. A cookie change is allowed only after `summary/`, according to the established portal behavior.

**Why:** The live booking behavior and project convention require one continuous PHP session through authentication. Introducing a mid-flow cookie change can break the nonce/session relationship that `signin/` relies on.

**How to apply:** Keep the request cookie header stable for `getsigninfields/` and `signin/`. If `summary/` emits a new cookie, handle it only in the post-signin summary path.