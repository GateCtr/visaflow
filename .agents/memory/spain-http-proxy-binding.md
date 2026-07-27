---
name: Spain HTTP proxy binding
description: Proxy and Cloudflare session constraints for the Spain HTTP-only watcher
---

In Spain HTTP-only mode, `cf_clearance` and the Bookitit session must be created and reused through the same configured proxy IP. `DECODO_PROXY_URL` is the preferred fixed proxy; SOAX remains the fallback.

**Why:** Cloudflare can bind the clearance cookie to the source IP. The local cookie pool does not record the cookie's source IP, so reusing an old pool cookie can silently pair it with the wrong proxy after a provider change or redeploy.

**How to apply:** In `SPAIN_HTTP_MODE=1`, ignore local pool cookies, reject sessions without a compatible proxy, and verify startup logs show the provider before allowing HTTP scans.

When production logs show `Cookie valide trouvé dans le pool` followed by `impit ... direct / sans proxy`, the running deployment predates this guard or is using a different build/configuration. The `IP serveur (Railway)` marker also means Replit secrets/workflows are not the process being diagnosed.

**Why:** A valid HTTP status with an empty `/onlinebookings/main/` body is a likely symptom of an old deployment pairing a stale Cloudflare cookie with the wrong source IP, not evidence that Bookitit intentionally changed its API.

**How to apply:** Compare the deployed startup/build logs with the current source before debugging the response body. Redeploy the same revision and configure the proxy secret in the actual runtime that performs the scan; do not infer Railway behavior from Replit secret presence.

## Local Playwright bootstrap

The HTTP watcher’s browser bootstrap requires both the Playwright Chromium binary and the system Cairo library. Installing the Node package alone is insufficient in a fresh Replit environment.

**Why:** Without the browser binary, Playwright reports a missing executable; after downloading it, Chromium can still exit immediately if `libcairo.so.2` is unavailable.

**How to apply:** Keep the browser install step and the Cairo system dependency in the Replit environment before diagnosing proxy or Cloudflare behavior.