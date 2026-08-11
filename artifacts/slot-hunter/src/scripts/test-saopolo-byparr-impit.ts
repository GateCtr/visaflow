/**
 * test-saopolo-byparr-impit.ts — Byparr (Camoufox local) + Impit
 *
 * Byparr résout le challenge CF localement via Camoufox (Firefox anti-détection).
 * Comme c'est sur la même machine, le TLS fingerprint est cohérent pour les
 * requêtes Impit suivantes SI on utilise le même proxy.
 *
 * IMPORTANT: Byparr utilise un TLS Firefox (Camoufox). Impit doit aussi utiliser
 * un fingerprint Firefox pour que CF accepte le cf_clearance sur /onlinebookings/.
 *
 * FLOW :
 *   1. Byparr GET portail → résout CF → retourne cookies + HTML
 *   2. Extraire token du HTML retourné
 *   3. Impit POST token (avec cookies Byparr) → session Bookitit
 *   4. Impit GET /main/ → données
 *
 * PRÉREQUIS : docker run -d --name byparr -p 8191:8191 ghcr.io/thephaseless/byparr:latest
 *
 * USAGE :
 *   npx tsx src/scripts/test-saopolo-byparr-impit.ts
 */

import "dotenv/config";
import { Impit } from "impit";

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings";
const BYPARR_URL = "http://localhost:8191/v1";
const ISP_PROXY_URL = process.env.SPAIN_ISP_PROXY_URL ?? "";

const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(level: string, msg: string): void {
  const icons: Record<string, string> = { INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶️ " };
  console.log(`[${ts()}] ${icons[level] ?? "  "} ${msg}`);
}
function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}
function buildCookieString(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main(): Promise<void> {
  section("SAOPOLO — Byparr (Camoufox local) + Impit");

  log("INFO", `Byparr    : ${BYPARR_URL}`);
  log("INFO", `Proxy ISP : ${ISP_PROXY_URL ? ISP_PROXY_URL.replace(/:([^@:]+)@/, ":***@") : "(aucun — direct)"}`);
  log("INFO", `Cible     : ${SAOPOLO_URL.slice(0, 60)}…`);

  // ═══ ÉTAPE 1 : Byparr résout le challenge CF ═════════════════════════════
  section("1 — Byparr solve CF (Camoufox)");
  log("STEP", "POST Byparr /v1 → request.get");

  const byparrPayload: Record<string, unknown> = {
    cmd: "request.get",
    url: SAOPOLO_URL,
    maxTimeout: 60000,
  };

  // Si proxy ISP disponible, le passer à Byparr
  if (ISP_PROXY_URL) {
    const u = new URL(ISP_PROXY_URL);
    byparrPayload.proxy = {
      url: `${u.protocol}//${u.hostname}:${u.port || "80"}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
    log("INFO", `Proxy passé à Byparr : ${u.hostname}:${u.port}`);
  }

  const byparrRes = await fetch(BYPARR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(byparrPayload),
  });

  if (!byparrRes.ok) {
    log("ERR", `Byparr HTTP ${byparrRes.status} — est-il lancé ? (docker run -d --name byparr -p 8191:8191 ghcr.io/thephaseless/byparr:latest)`);
    process.exit(1);
  }

  const byparrData = await byparrRes.json() as any;
  const solution = byparrData.solution;

  if (!solution || byparrData.status !== "ok") {
    log("ERR", `Byparr échec : ${JSON.stringify(byparrData).slice(0, 300)}`);
    process.exit(1);
  }

  const cookies: Array<{ name: string; value: string; domain?: string }> = solution.cookies ?? [];
  const userAgent: string = solution.userAgent ?? "";
  const responseHtml: string = solution.response ?? "";
  const cfClearance = cookies.find((c) => c.name === "cf_clearance")?.value ?? "";

  log("OK", `Byparr résolu ! (${responseHtml.length}B HTML)`);
  log("INFO", `UA        : ${userAgent.slice(0, 80)}`);
  log("INFO", `Cookies   : ${cookies.map((c) => c.name).join(", ")}`);
  log("INFO", `cf_clearance : ${cfClearance.slice(0, 30)}…`);

  if (!cfClearance) {
    log("ERR", "cf_clearance absent — Byparr n'a pas résolu le challenge");
    log("INFO", `HTML[0:500] : ${responseHtml.slice(0, 500)}`);
    process.exit(1);
  }

  // ═══ ÉTAPE 2 : Extraire token du HTML retourné par Byparr ════════════════
  section("2 — Extraire token du HTML Byparr");

  const tokenMatch = responseHtml.match(/name="token"\s+value="([^"]+)"/i);
  if (!tokenMatch) {
    log("WARN", "Token non trouvé dans la réponse Byparr (peut-être la page challenge)");
    log("INFO", `HTML[0:500] : ${responseHtml.slice(0, 500)}`);
    // Byparr a peut-être retourné le widget directement — cherchons le bouton Continuar
    if (responseHtml.includes("idCaptchaButton") || responseHtml.includes("loadermaec")) {
      log("INFO", "Widget Bookitit détecté dans la réponse Byparr ✓");
    }
    // On peut essayer un GET supplémentaire avec les cookies
  }

  const token = tokenMatch?.[1] ?? "";
  if (token) {
    log("OK", `Token : ${token.slice(0, 30)}…`);
  }

  // ═══ ÉTAPE 3 : Impit POST+/main/ avec les cookies de Byparr ═══════════════
  section("3 — Impit POST + /main/ (cookies Byparr, retry)");

  // Utiliser le browser "firefox" dans Impit pour matcher Camoufox TLS
  const impit = new Impit({
    browser: "firefox",
    proxyUrl: ISP_PROXY_URL || undefined,
  } as any);

  const cookieStr = buildCookieString(cookies);
  let body4 = "";
  const MAX = 3;

  for (let attempt = 1; attempt <= MAX; attempt++) {
    log("STEP", `── Tentative ${attempt}/${MAX} ──`);

    // Si on n'a pas le token, faire un GET d'abord
    let currentToken = token;
    if (!currentToken) {
      const rGet = await impit.fetch(SAOPOLO_URL, {
        headers: { "User-Agent": userAgent, "Accept": "text/html,*/*;q=0.8", "Cookie": cookieStr },
      } as any) as unknown as Response;
      const bodyGet = await rGet.text();
      currentToken = bodyGet.match(/name="token"\s+value="([^"]+)"/i)?.[1] ?? "";
      log("INFO", `GET → ${rGet.status} | ${bodyGet.length}B | token=${currentToken ? currentToken.slice(0, 15) + "…" : "❌"}`);
      if (!currentToken) continue;
    }

    // POST token
    const rPost = await impit.fetch(SAOPOLO_URL, {
      method: "POST",
      headers: {
        "User-Agent": userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookieStr,
        "Referer": SAOPOLO_URL,
        "Origin": "https://www.citaconsular.es",
      },
      body: `token=${encodeURIComponent(currentToken)}`,
    } as any) as unknown as Response;
    const bodyPost = await rPost.text();
    log("INFO", `POST → ${rPost.status} | ${bodyPost.length}B`);

    // GET /main/
    const cb = `jQuery${Math.random().toString().slice(2, 18)}_${Date.now()}`;
    const qs = new URLSearchParams({ callback: cb, type: "default", publickey: "2d01502f12dc08400e22aea87fb00ae34", lang: "es", version: "4", src: SAOPOLO_URL, _: String(Date.now()) });
    const mainUrl = `${BOOKITIT_BASE}/main/?${qs}`;

    const rMain = await impit.fetch(mainUrl, {
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/javascript, application/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
        "Referer": SAOPOLO_URL,
        "Cookie": cookieStr,
      },
    } as any) as unknown as Response;
    body4 = await rMain.text();
    log("INFO", `/main/ → ${rMain.status} | ${body4.length}B`);

    if (body4.length > 100) { log("OK", `🎉 /main/ a répondu ! (${body4.length}B)`); break; }
    if (attempt < MAX) { log("WARN", "0B — retry 3s…"); await new Promise<void>((r) => setTimeout(r, 3000)); currentToken = ""; }
  }

  // ═══ RÉSULTAT ═════════════════════════════════════════════════════════════
  section("RÉSULTAT");
  if (body4.length > 1000) {
    log("OK", `🎉🎉🎉 /main/ → ${body4.length}B — BOOKITIT FONCTIONNE !`);
    log("INFO", `Aperçu: ${body4.slice(0, 120)}`);
    console.log("\n  ┌──────────────────────────────────────────────────────────────────┐");
    console.log("  │  SUCCÈS : Byparr (Camoufox) + Impit = /main/ passe !           │");
    console.log("  │  Même machine, même TLS, même IP. CF accepte.                  │");
    console.log("  └──────────────────────────────────────────────────────────────────┘");
  } else if (body4.length > 0) {
    log("WARN", `/main/ → ${body4.length}B: ${body4.slice(0, 200)}`);
  } else {
    log("ERR", "/main/ → 0B — TLS mismatch Firefox(Byparr) vs Impit persiste");
    log("INFO", "→ Piste suivante: utiliser Byparr aussi pour POST+/main/ (tout via Camoufox)");
  }

  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
