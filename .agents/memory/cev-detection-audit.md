---
name: CEV bot detection audit
description: Complete analysis of real Chrome 148 traffic dumps (2026-06-08) vs. bot implementation — what's safe, what was fixed, what remains.
---

## Dumps analysed
- `2026-06-08T12-01-52` (session 1) and `2026-06-08T12-53-31` (session 2)
- Both captured via Chrome extension inside a Playwright-controlled Chrome with UA override

## Confirmed SAFE (matches real traffic exactly)
- Header order for document GET: Accept → Accept-Encoding → Accept-Language → Sec-Fetch-Dest → Sec-Fetch-Mode → Sec-Fetch-Site → Sec-Fetch-User → Upgrade-Insecure-Requests → User-Agent → sec-ch-ua → sec-ch-ua-mobile → sec-ch-ua-platform → [Cookie]
- Header order for AJAX/XHR (cors): Accept → AE → AL → [Cookie] → [Referer] → sec-ch-ua → sec-ch-ua-mobile → sec-ch-ua-platform → Sec-Fetch-Dest → Sec-Fetch-Mode → Sec-Fetch-Site → [Sec-Fetch-Storage-Access] → User-Agent
- `Sec-Fetch-Storage-Access: active` present only on cross-site sub-resources ✓
- `Sec-Fetch-Site: cross-site` on VOWINT → CEV integration URL hop (line 611 cevHttpSetup.ts) ✓
- Cookie domain isolation: `fullCevCookie` contains only CEV cookies, not VOWINT cookies ✓
- `TS0110ceb4` F5 WAF cookie captured via redirect:"manual" loop ✓
- `isFormPost=true` on login POST (FIX #2) ✓
- `"Google Chrome";v="148"` brand present in Chrome 148 entries (FIX #6) ✓
- No `Connection` header sent (impit uses HTTP/2 properly) ✓

## Fixes applied
- **FIX #2**: isFormPost flag for login POST headers
- **FIX #3**: Redis version:2 scheme invalidates old sessions
- **FIX #4**: explicit captchaSolved===false check
- **FIX #5**: redirect:"manual" loop for resolveFirstAppIdFromMyList
- **FIX #6**: "Google Chrome";v="148" third brand + parseUserAgentForSecCh updated
- **FIX #7**: Chrome 147 entries updated to real build `147.0.7231.96` + added "Google Chrome";v="147" brand; Linux entry replaced by macOS Chrome 147 profile
- **FIX #8**: Edge UA updated to real build `Edg/148.0.2849.68`

## Remaining observations
- The dump captures show `sec-ch-ua` with only 2 brands (`"Not/A)Brand";v="99", "Chromium";v="148"`) because the capture tool used a UA-overridden Playwright Chrome where sec-ch-ua wasn't updated. Real deployed bot uses 3-brand string which is MORE accurate.
- `Not/A)Brand v="99"` in the captures is from the capture tool, not necessarily what Chrome 148 sends in the wild. The bot currently uses `v="99"` which matches the captures.
- OSOnline cookie (F5 BIG-IP) appears on visaonweb.diplomatie.be — captured by mergeCookies and sent back correctly.
- ServerId cookie (F5 load balancer affinity) — also captured by mergeCookies.

**Why:** Real Chrome always has a full 4-part build number (e.g., 148.0.7778.96). `.0.0.0` is an exclusively automated/headless pattern that F5 BIG-IP and Cloudflare WAFs can trivially fingerprint. "Google Chrome" brand absence is a Chromium-vs-official-Chrome distinguisher added in Chrome 109+.
