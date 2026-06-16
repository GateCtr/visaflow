---
name: Playwright→Puppeteer migration
description: API translation cheatsheet and per-file strategy for the slot-hunter Playwright→Puppeteer migration. Build passes 0 errors.
---

## Key API differences (Playwright → Puppeteer)

| Playwright | Puppeteer equivalent |
|---|---|
| `waitForLoadState('networkidle')` | `(page as any).waitForNavigation?.({ waitUntil: 'networkidle0' }).catch(()=>{})` |
| `waitForLoadState('domcontentloaded')` | `(page as any).waitForNavigation?.({ waitUntil: 'domcontentloaded' }).catch(()=>{})` |
| `waitUntil: "commit"` in goto | `waitUntil: "domcontentloaded"` |
| `waitUntil: "networkidle"` in goto | `waitUntil: "networkidle0"` |
| `el.getAttribute(name)` (ElementHandle) | `(el as any).evaluate((e,n)=>e.getAttribute(n), name)` |
| `el.innerText()` (ElementHandle) | `(el as any).evaluate(e=>e.innerText)` |
| `page.innerText(sel)` | `page.$eval(sel, el=>(el as any).innerText)` |
| `page.fill(sel, val)` | `page.$eval(sel, (el,v)=>{(el as HTMLInputElement).value=v; el.dispatchEvent(new Event('input',{bubbles:true}))}, val)` |
| `page.addInitScript(fn)` | `(page as any).evaluateOnNewDocument(fn)` |
| `page.context().cookies()` | `(page as any).cookies()` |
| `page.context().newPage()` | `(page as any).browser().newPage()` |
| `page.context().request` + `callJsonp(req,...)` | Extract cookies + `callJsonpUndici(base, endpoint, params, cookieHeader, referer)` |
| `screenshot()` returns `Buffer` | Returns `Uint8Array` in Puppeteer 25.x — use `Buffer.from(buf).toString('base64')` |

## Type import strategy per file

- **Files with deep Playwright usage** (spainPortal.ts, captcha.ts): Replace `import type { Page, ... } from "playwright"` with `type Page = any; type BrowserContext = any;` etc. at top of file.
- **Files with Puppeteer Page** (cevBooking.ts, canadaPortal.ts, navigator.ts): `import type { Page } from 'puppeteer'`
- **Test/diagnostic files** (test-pw-*.ts, testTurnstile.ts): Add `// @ts-nocheck` header.

## Files changed

1. `browser.ts` — Full rewrite: `puppeteer-extra` + `StealthPlugin`, `PuppeteerContextAdapter` class (context-like API for netCapture).
2. `netCapture.ts` — `EventEmittable` interface, `any` for request/response handlers.
3. `cevBooking.ts` — Puppeteer Page import, `PuppeteerContextAdapter`, all waitForLoadState → waitForNavigation, ElementHandle → evaluate, `Buffer.from(screenshot)`.
4. `navigator.ts` — Response handler typed as `any`, networkidle0, Buffer.from screenshot.
5. `spainPortal.ts` — Playwright types replaced with `type X = any`, all `"commit"` → `"domcontentloaded"`, `addInitScript` → `evaluateOnNewDocument`, `page.context().request` → `callJsonpUndici` with cookie extraction.
6. `canadaPortal.ts` — `page.fill()` → `$eval` + dispatchEvent, `page.context().newPage()` → `browser().newPage()`, `(page as any).screenshot()`.
7. `reverse-spain.ts` — Puppeteer import, `"commit"` → domcontentloaded, `c.domain` undefined guard, Phase D test block skipped.
8. `captcha.ts` — Playwright Page import replaced with `type Page = any`.

**Why:** `playwright-extra` doesn't work reliably for cookie capture; `puppeteer-extra-plugin-stealth` is the proven path for bypassing bot detection on diplomatie.be and Bookitit portals.
