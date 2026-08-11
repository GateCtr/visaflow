#!/usr/bin/env node
/**
 * test-html-field-full-flow.ts
 *
 * Validation complète du flow avec le fix "html field" :
 *   1. probe impit → HTML challenge CF
 *   2. CapSolver AntiCloudflareTask WITH html → cf_clearance lié à la TLS impit
 *   3. MÊME impit + cf_clearance → GET portal → PHPSESSID
 *   4. POST Continuar → widget
 *   5. GET /onlinebookings/main/ avec PHPSESSID → données Bookitit
 */

import { Impit } from "impit";

const PROXY_URL  = process.env.SOAX_PROXY_URL ?? process.env.DECODO_PROXY_URL ?? "";
const CAP_KEY    = process.env.CAPSOLVER_API_KEY ?? "";
const CAP_BASE   = "https://api.capsolver.com";

const PORTAL     = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const WID        = "2d01502f12dc08400e22aea87fb00ae34";
const BASE       = "https://www.citaconsular.es/onlinebookings/";
const UA         = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const t0         = Date.now();

function elapsed() { return ((Date.now() - t0) / 1000).toFixed(1) + "s"; }
function sep(t: string) { console.log(`\n${"═".repeat(60)}\n  ${t}\n${"═".repeat(60)}`); }
function mask(u: string) { return u.replace(/:([^:@]+)@/, ":***@").slice(0, 80); }

const HDRS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,fr-FR;q=0.8",
  "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
};

async function capsolver(html: string): Promise<string | null> {
  // Proxy au format CapSolver
  const p = new URL(PROXY_URL);
  const proxy = `http://${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}@${p.hostname}:${p.port || "5000"}`;

  const cr = await (await fetch(`${CAP_BASE}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: CAP_KEY,
      task: {
        type: "AntiCloudflareTask",
        websiteURL: PORTAL,
        proxy,
        userAgent: UA,
        html: html.slice(0, 32_000),
      },
    }),
    signal: AbortSignal.timeout(30_000),
  })).json() as any;

  if (cr.errorId !== 0) { console.error(`  ❌ createTask: ${cr.errorDescription ?? cr.errorCode}`); return null; }
  console.log(`  Task: ${cr.taskId}`);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const pr = await (await fetch(`${CAP_BASE}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAP_KEY, taskId: cr.taskId }),
      signal: AbortSignal.timeout(15_000),
    })).json() as any;
    if (pr.errorId !== 0) { console.error(`  ❌ Poll: ${pr.errorCode}`); return null; }
    if (pr.status === "ready") {
      const cf = pr.solution?.cookies?.["cf_clearance"] ?? pr.solution?.token;
      console.log(`  ✅ Résolu (${(i + 1) * 5}s) — cookies: [${Object.keys(pr.solution?.cookies ?? {}).join(", ")}]`);
      return cf ?? null;
    }
    if (i % 3 === 0) process.stdout.write(".");
  }
  console.error("  ❌ Timeout");
  return null;
}

async function main() {
  console.log("=".repeat(60));
  console.log("  VALIDATION FLOW COMPLET — html field fix");
  console.log("=".repeat(60));
  console.log(`  Proxy  : ${mask(PROXY_URL)}`);
  console.log(`  WID    : ${WID}`);

  if (!PROXY_URL || !CAP_KEY) {
    console.error("❌ SOAX_PROXY_URL ou CAPSOLVER_API_KEY manquant"); process.exit(1);
  }

  // ── Étape 1 : Probe impit → HTML challenge CF ─────────────────────────────
  sep("Étape 1 — Probe impit → CF challenge HTML");
  const imp = new Impit({ browser: "chrome", proxyUrl: PROXY_URL } as any);
  let cfHtml = "";
  {
    const r = await (imp.fetch(PORTAL, { headers: HDRS } as any) as unknown as Promise<Response>);
    cfHtml = await (r as any).text() as string;
    const st = (r as any).status as number;
    const isCf = /just a moment|_cf_chl_opt/i.test(cfHtml.slice(0, 3000));
    const cType = cfHtml.match(/["']cType["']\s*:\s*["']([^"']+)["']/)?.[1] ?? "inconnu";
    console.log(`  HTTP ${st} | ${cfHtml.length}B | CF: ${isCf ? `🔴 (cType: ${cType})` : "✅ accès direct"}`);
    if (!isCf) {
      // Accès direct déjà — chercher PHPSESSID
      const php = ((r as any).headers?.get?.("set-cookie") ?? "").match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
      console.log(`  PHPSESSID direct: ${php ? "✅ " + php.slice(0, 12) : "absent"}`);
    }
    if (!isCf) { console.log("\n✅ Accès direct — pas besoin de CapSolver pour ce test"); }
  }

  // ── Étape 2 : CapSolver WITH html → cf_clearance ─────────────────────────
  sep("Étape 2 — CapSolver AntiCloudflareTask WITH html");
  const cfClearance = await capsolver(cfHtml);
  if (!cfClearance) { console.error("\n❌ CapSolver échoué"); process.exit(1); }
  console.log(`  cf_clearance: ${cfClearance.slice(0, 30)}… (${elapsed()})`);

  // ── Étape 3 : MÊME impit + cf_clearance → GET portal → PHPSESSID ──────────
  sep("Étape 3 — MÊME impit + cf_clearance → GET portal → PHPSESSID");
  let phpSessId = "";
  let csrfToken = "";
  let postUrl   = PORTAL;
  {
    const r = await (imp.fetch(PORTAL, {
      headers: { ...HDRS, "Cookie": `cf_clearance=${cfClearance}` },
    } as any) as unknown as Promise<Response>);
    const body = await (r as any).text() as string;
    const st = (r as any).status as number;
    const setCk = (r as any).headers?.get?.("set-cookie") ?? "";
    phpSessId = setCk.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
    csrfToken = body.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i)?.[1] ?? "";
    const isCf = /just a moment|_cf_chl_opt/i.test(body.slice(0, 2000));
    const formAction = body.match(/<form[^>]+action=["']([^"']+)["'][^>]+method=["']POST["']/i)?.[1] ?? "";
    if (formAction) postUrl = formAction.startsWith("http") ? formAction : `https://www.citaconsular.es${formAction}`;

    console.log(`  HTTP ${st} | ${body.length}B | CF: ${isCf ? "🔴 ENCORE bloqué ❌" : "✅ PASSÉ!"}`);
    console.log(`  PHPSESSID  : ${phpSessId ? "✅ " + phpSessId.slice(0, 12) + "…" : "❌ absent"}`);
    console.log(`  Token CSRF : ${csrfToken ? "✅ " + csrfToken.slice(0, 20) + "…" : "absent"}`);
    console.log(`  Form POST  : ${postUrl.slice(0, 80)}`);
    if (isCf) { console.error("\n❌ CF challenge encore actif après solve — fix non fonctionnel"); process.exit(1); }
    if (!phpSessId) { console.error("\n❌ Pas de PHPSESSID — impossible de continuer"); process.exit(1); }
  }

  // ── Étape 4 : POST Continuar ───────────────────────────────────────────────
  sep("Étape 4 — POST Continuar (token CSRF)");
  {
    const r = await (imp.fetch(postUrl, {
      method: "POST",
      headers: {
        "User-Agent": UA, "Cookie": `cf_clearance=${cfClearance}; PHPSESSID=${phpSessId}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": PORTAL, "Origin": "https://www.citaconsular.es",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1",
      },
      body: `token=${encodeURIComponent(csrfToken)}`,
    } as any) as unknown as Promise<Response>);
    const body = await (r as any).text() as string;
    const st = (r as any).status as number;
    const setCk = (r as any).headers?.get?.("set-cookie") ?? "";
    const newPhp = setCk.match(/PHPSESSID=([^;]+)/)?.[1];
    if (newPhp) phpSessId = newPhp;
    const hasWidget = /bookitit|bkt-widget|appointment/i.test(body);
    console.log(`  HTTP ${st} | ${body.length}B | widget: ${hasWidget ? "✅" : "—"}`);
    console.log(`  Preview: "${body.slice(0, 200).replace(/\s+/g, " ").trim()}"`);
  }

  // ── Étape 5 : GET /main/ avec PHPSESSID ───────────────────────────────────
  sep("Étape 5 — GET /onlinebookings/main/ avec PHPSESSID");
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({
      callback: cb, type: "default", publickey: WID,
      lang: "es", version: "4", src: PORTAL, _: String(Date.now()),
    });
    const url = `${BASE}main/?${q}`;
    console.log(`  URL: ${url.slice(0, 90)}…`);

    const r = await (imp.fetch(url, {
      headers: {
        "User-Agent": UA,
        "Cookie": `cf_clearance=${cfClearance}; PHPSESSID=${phpSessId}`,
        "Accept": "*/*", "Referer": PORTAL,
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Ch-Ua": '"Not/A)Brand";v="8", "Chromium";v="136", "Google Chrome";v="136"',
        "Sec-Ch-Ua-Mobile": "?0", "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
    } as any) as unknown as Promise<Response>);

    const body = await (r as any).text() as string;
    const st = (r as any).status as number;
    const isCf   = /just a moment|_cf_chl_opt/i.test(body.slice(0, 2000));
    const isErr  = /no callback found|Exception|error/i.test(body.slice(0, 200));
    const isBkt  = /bkt_init_widget|bkt_widget_init|srvsrc|services/i.test(body);
    const isJsonp = body.startsWith(cb) || new RegExp(`^${cb}\\s*\\(`).test(body.slice(0, 50));

    console.log(`  HTTP ${st} | ${body.length}B`);
    console.log(`  CF:${isCf ? "🔴" : "✅"}  JSONP:${isJsonp ? "✅" : "—"}  bkt:${isBkt ? "✅" : "—"}  err:${isErr ? "⚠️ " + body.slice(0, 80) : "—"}`);
    if (body.length > 0) console.log(`  Preview: "${body.slice(0, 300).replace(/\s+/g, " ").trim()}"`);

    // ── Résultat final ──────────────────────────────────────────────────────
    sep("Résultat final");
    const ok = body.length > 100 && !isCf && !isErr && (isJsonp || isBkt);
    if (ok) {
      console.log(`✅ SUCCÈS COMPLET (${elapsed()}) — Flow html-field → PHPSESSID → /main/ opérationnel!`);
      console.log(`   cf_clearance : via CapSolver (html field)`);
      console.log(`   PHPSESSID    : ✅ (même instance impit)`);
      console.log(`   /main/       : ${body.length}B de données Bookitit`);
    } else {
      console.log(`⚠️  Flow partiellement validé (${elapsed()})`);
      console.log(`   PHPSESSID    : ✅`);
      console.log(`   /main/       : HTTP ${st} | ${body.length}B | CF:${isCf} err:${isErr}`);
      if (!isJsonp && !isBkt && !isErr && !isCf) {
        console.log("   → Réponse 0B ou inattendue — vérifier PHPSESSID POST Continuar");
      }
    }
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
