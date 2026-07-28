---
name: Cuba scanner getservices fix
description: Root cause and fix for Cuba citaconsular scanner returning 0 services from getservices/ JSONP endpoint.
---

# Cuba Scanner getservices/ Fix

## Root Cause (multi-layer)

1. **Backbone templates** — Cuba's /main/ HTML never has rendered `#selectservice/ID` links. Service IDs live inside `<script type="text/template">` as `<%= attributes.id %>`. The fix: test original `html` (not `renderedHtml`) for `/#selectservice\/<%=\s*[\w.]+\s*%>/i`.

2. **HTTP-only session incompatible with JSONP endpoints** — In CapSolver (HTTP-only) mode, `/main/` returns 135KB fine, but `getservices/`, `getwidgetconfigurations/`, `getagendas/` all return HTTP 200 with 0-byte body. This is because the Bookitit server requires the session to have been "warmed up" by the widget JS (`loadermaec.js` execution). CapSolver only gives cf_clearance, not a JS-initialized PHPSESSID. In Playwright mode, the full widget loads and the session is properly initialized.

3. **extractServiceDetails too narrow** — When Playwright mode is used (session is valid), `getservices/` does return data, but `extractServiceDetails` failed if the response used: numeric-keyed objects `{"0":{id,name}}`, Spanish field names (`nombre`, `titulo`), `title` field, or objects where `id` is truthy but `name` is in an unchecked field.

## Fixes Applied (spain-http-scanner.ts)

- `extractServiceDetails`: completely rewritten to handle all Bookitit formats (arrays, numeric-keyed objects, wrapper objects, Spanish field names, id-only fallback name).
- `confirmSlotsViaDatetime` fallback path: added `getwidgetconfigurations/` call before `getservices/` to initialize server-side Bookitit session (with 220ms pause); added `collectIds` fallback if `extractServiceDetails` returns 0 but payload is non-empty.
- Cas 2 regex: `#selectservice\/\d+` → `#selectservice\/[\w-]+` to also match alphanumeric IDs.

## Key Discovery

`diag-cuba-main.ts` consistently gets 0 bytes from /main/ while `test-cuba-dump-main.ts` gets 135KB — difference is `invalidateSpainCfSession()` call at start of the latter. Without it, a stale in-memory session state causes the HTTP flow to produce 0-byte /main/.

## Production Behavior

- Cuba portal URL: `https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/`
- Widget POST response: only 2510 bytes (minimal HTML with `bkt_init_widget`, no JSD oneshot URL)
- /main/ response: 135425 bytes (126978 chars decoded), `noHorasHidden=true`, `hasClientSideTemplates=true`
- getservices/ HTTP-only: 0 bytes; Playwright mode: non-empty (fix validates this path)

**Why:** Cuba scanner must run in Playwright mode (SPAIN_HTTP_MODE=0 or persistent browser session) for JSONP calls to return data.
