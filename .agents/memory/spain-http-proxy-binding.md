---
name: Spain HTTP proxy binding
description: Rules for Decodo ISP proxy usage in Spain HTTP scanner and CapSolver integration
---

# Spain HTTP proxy binding

## Rule
HTTP-only sessions (impit) and CapSolver `AntiCloudflareTask` must both use the same Decodo ISP proxy URL so that the resulting `cf_clearance` is bound to the same exit IP that subsequent requests use.

**Why:** `cf_clearance` is IP-bound. If CapSolver solves using a different IP than the one used for `/main/`, CF silently serves an empty body or Managed Challenge at HTTP 200 instead of the real page.

**How to apply:** Pass `proxyUrl` to both `new Impit({ proxy })` and to CapSolver's `proxy` field. Never reuse `cf_clearance` from a pool cookie whose origin IP is unknown.

## Pre-fetched HTML optimisation
Passing `html` to CapSolver's `AntiCloudflareTask` saves ~240KB of Decodo bandwidth per solve (the challenge page is ~6KB pre-fetched via impit, so CapSolver doesn't re-fetch). This is safe as long as the probe fetches the HTML **through the same Decodo proxy** — the solve result is still IP-bound to Decodo.

When the probe fails (e.g. ProxyAuthRequired), `html` is not passed and CapSolver fetches the challenge page itself through the proxy.

## `cf-challenge` log false positive (fixed 2026-07-27)
The GET portail diagnostic previously used `/challenge/` in its regex, which matched the JSD oneshot URL path `/cdn-cgi/challenge-platform/...` embedded in the real (non-challenged) page. Fixed to use `un instant|just a moment|verifying you are human|_cf_chl_opt` only — these never appear on the real page.

## Decodo ISP session expiry
The DECODO_PROXY_URL embeds a specific exit IP via `-ip-X.X.X.X` in the username. This IP session has a limited duration. When it expires:
- impit probe fails with `ProxyAuthRequired` (HTTP 407)
- CapSolver also fails with `custom proxy connect failed`
- Fix: renew the URL from the Decodo dashboard and update the `DECODO_PROXY_URL` secret + restart the workflow

## JSD Oneshot absence
When CF trusts the Decodo ISP exit IP, the POST widget response does NOT embed the JSD oneshot URL. This is expected — CF skips the second challenge step. `/main/` still returns the full page (116KB+). Do not treat JSD oneshot absence as an error.
