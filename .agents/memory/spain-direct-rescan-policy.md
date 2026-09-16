---
name: Spain direct rescan policy
description: Retry boundaries for active Bookitit session initialization and scan endpoints.
---

The active Spain flow must not replay the same GET/POST with the same PHP session for
session initialization or ordinary Bookitit endpoints. Discard the snapshot and start a
fresh session cycle with a new PHPSESSID on the same proxy when the failure is a portal
or server response. Proxy failures still rotate the IP, captcha solving keeps its own
retry/polling behavior, and datetime/ may retry on the same session.

**Why:** Bookitit initialization endpoints are stateful and one-shot in practice; repeating
the same request can waste the scan window while preserving a broken or stale session.

**How to apply:** Keep generic direct-call retries disabled except signin/ and datetime/.
Make recovery paths recreate the full worker session before re-running PHP initialization,
and preserve proxy/network classification so bad IPs are rotated instead of rescanned.