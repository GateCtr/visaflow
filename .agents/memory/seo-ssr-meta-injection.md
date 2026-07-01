---
name: Joventy SSR meta-injection solution
description: How we fixed the SPA SEO problem — correct title/meta/schemas for destination and guide pages visible to Googlebot
---

## The problem
Joventy is a React Vite SPA. Googlebot received the generic homepage `<title>` and `<meta description>` for ALL pages including `/visa-espagne-kinshasa` and `/guides/*`. react-helmet-async injects meta dynamically via JS — invisible to crawlers. Result: 537 weekly RDC impressions, 0% CTR, position 8-9.

## The fix (two-layer)

### Layer 1: Dev server — Vite `configureServer` middleware intercept
**File:** `artifacts/joventy/vite-plugin-seo.ts`  
**Plugin:** `seoMetaInjectPlugin()` registered in `vite.config.ts`

The plugin wraps `res.write` and `res.end` for routes matching `/visa-*` or `/guides/*`. It buffers the response, checks if it's HTML (contains `</head>`), then calls `injectSeoMeta(html, pathname)` before sending.

**Why `configureServer` not `transformIndexHtml`:** In Vite 7 SPA mode, `transformIndexHtml` is NOT reliably called with the actual URL path for sub-routes — the path context gets lost in the SPA fallback. The middleware approach is reliable.

### Layer 2: Build-time prerender — static HTML files for Vercel
**File:** `artifacts/joventy/scripts/prerender.ts`  
**Run:** `pnpm run build:prerender` (after `build:vite`)

Reads `dist/public/index.html`, calls `injectSeoMeta()` for each destination and guide slug, writes:
- `dist/public/${slug}.html` (Vercel clean URLs)
- `dist/public/${slug}/index.html` (directory fallback)
- `dist/public/guides/${slug}.html`
- `dist/public/guides/${slug}/index.html`

26 pages total (12 destinations + 14 guides).

**Vercel config:** `cleanUrls: true`, `trailingSlash: false` added to `vercel.json`. Static files always take precedence over the catch-all rewrite `/(.*) → /index.html`.

## The `injectSeoMeta(html, pathname)` function
Shared between dev plugin and build script. Uses `.replace()` with specific regex patterns for each tag. Injects:
- `<title>` — from `dest.title` or `guide.metaTitle`
- `<meta name="description">` — from `metaDescription`
- `<link rel="canonical">` — page-specific URL (no www)
- `<meta property="og:title|description|url|type">`
- `<meta name="twitter:title|description">`
- Appends page-specific schemas before `</head>`:
  - Destination: FAQPage + BreadcrumbList + Service (3 schemas)
  - Guide: Article + BreadcrumbList + FAQPage (3 schemas)

## Homepage unchanged
Routes not matching `/visa-*` or `/guides/*` patterns pass through untouched — homepage keeps its generic meta.

## Expected SEO impact
Before: 537 RDC impressions/week, 0 clicks (0% CTR) — Google shows generic "Assistance Visa Kinshasa | USA, Canada, Europe, Dubaï | Joventy" title.  
After next deploy + Googlebot crawl (2-4 weeks): correct title "Rendez-vous Visa Espagne Kinshasa 2026 | Ambassade Directe | Joventy" should increase CTR from 0% to 5-15%.

## Deploy procedure
1. Push to GitHub → Vercel auto-deploys
2. The build command in vercel.json runs `pnpm --filter @workspace/joventy run build` which runs `build:vite` + `build:prerender`
3. Pre-rendered HTML files in dist/public take precedence over SPA rewrite
4. Request Google Search Console URL inspection + re-crawl for key pages after deploy
