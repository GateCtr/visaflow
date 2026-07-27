---
name: Spain HTTP proxy binding
description: Proxy and Cloudflare session constraints for the Spain HTTP-only watcher
---

In Spain HTTP-only mode, `cf_clearance` and the Bookitit session must be created and reused through the same configured proxy IP. `DECODO_PROXY_URL` is the preferred fixed proxy; SOAX remains the fallback.

**Why:** Cloudflare can bind the clearance cookie to the source IP. The local cookie pool does not record the cookie's source IP, so reusing an old pool cookie can silently pair it with the wrong proxy after a provider change or redeploy.

**How to apply:** In `SPAIN_HTTP_MODE=1`, ignore local pool cookies, reject sessions without a compatible proxy, and verify startup logs show the provider before allowing HTTP scans.