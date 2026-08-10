#!/usr/bin/env node
/**
 * test-spain-full-flow.ts — Test du flow HTTP complet citaconsular.es → /main/
 *
 * Chaque étape est testée indépendamment et loguée en détail.
 * Aucune logique de production n'est utilisée — tout est écrit explicitement.
 *
 * Flow :
 *   1. CapSolver AntiCloudflareTask → cf_clearance (+ tous cookies retournés)
 *   2. GET portal citaconsular.es  → PHPSESSID + token CSRF
 *   3. POST token (Continuar)      → page widget Bookitit
 *   4. GET /main/                  → HTML avec créneaux
 *   5. GET JSONP getservices/      → JSON services
 *
 * Usage :
 *   SOAX_PROXY_URL="http://user:pass@proxy:port" \
 *   CAPSOLVER_API_KEY="CAP-xxx" \
 *   node_modules/.bin/tsx scripts/test-spain-full-flow.ts
 */

import { Impit } from "impit";
import { getCurrentDecodoUrl } from "../src/spain-decodo-pool.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const PROXY_URL =
  process.env.SOAX_PROXY_URL ||
  getCurrentDecodoUrl() ||
  undefined;

const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? "";

const PORTAL_URL =
  process.env.SPAIN_WIDGET_URL ||
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const CAPSOLVER_BASE = "https://api.capsolver.com";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CookieJar {
  [name: string]: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskProxy(u: string | undefined) {
  return u ? u.replace(/:([^:@]+)@/, ":***@").slice(0, 80) : "(direct — pas de proxy)";
}

function sep(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`── ${title}`);
  console.log("─".repeat(60));
}

/** Parse tous les Set-Cookie d'une Response impit (header unique concaténé ou multiple) */
function parseSetCookies(res: Response): CookieJar {
  const jar: CookieJar = {};
  // impit peut exposer set-cookie comme une seule chaîne concaténée
  const raw = (res as any).headers?.get?.("set-cookie") ?? "";
  if (!raw) return jar;

  // Split sur les virgules qui précèdent un nom=valeur (heuristique)
  const parts = raw.split(/,\s*(?=[A-Za-z_][^=,]*=)/);
  for (const part of parts) {
    const first = part.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq > 0) {
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name && value) jar[name] = value;
    }
  }
  return jar;
}

function cookieStr(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function logCookies(label: string, jar: CookieJar) {
  const keys = Object.keys(jar);
  if (keys.length === 0) {
    console.log(`   🍪 ${label}: (aucun cookie)`);
    return;
  }
  for (const k of keys) {
    const v = jar[k];
    const preview = v.length > 50 ? v.slice(0, 50) + "…" : v;
    console.log(`   🍪 ${label} → ${k}=${preview}`);
  }
}

function logBody(label: string, body: string) {
  const size = body.length;
  if (size === 0) {
    console.error(`   ❌ ${label} : 0B — réponse vide`);
    return;
  }
  const preview = body.slice(0, 200).replace(/\s+/g, " ").trim();
  console.log(`   📄 ${label} : ${size} chars → "${preview}"`);
}

// ─── Étape 1 : CapSolver AntiCloudflareTask ───────────────────────────────────

async function stepCapSolver(): Promise<{
  cfClearance: string;
  userAgent: string;
  allCookies: CookieJar;
} | null> {
  sep("Étape 1 : CapSolver AntiCloudflareTask");

  if (!CAPSOLVER_KEY) {
    console.error("❌ CAPSOLVER_API_KEY manquante");
    return null;
  }
  if (!PROXY_URL) {
    console.error("❌ SOAX_PROXY_URL manquante");
    return null;
  }

  // Format proxy CapSolver
  const parsed = new URL(PROXY_URL);
  const proxyForCap = `http://${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}@${parsed.hostname}:${parsed.port || "5000"}`;
  console.log(`   Proxy pour CapSolver: ${maskProxy(proxyForCap)}`);
  console.log(`   Target: ${PORTAL_URL}`);

  // Vérifier balance
  try {
    const balRes = await fetch(`${CAPSOLVER_BASE}/getBalance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY }),
      signal: AbortSignal.timeout(10_000),
    });
    const bal = (await balRes.json()) as any;
    if (bal.errorId !== 0) {
      console.error(`❌ Balance check failed: ${bal.errorCode} — ${bal.errorDescription}`);
      return null;
    }
    console.log(`   💰 Balance CapSolver: $${bal.balance?.toFixed(3)}`);
  } catch (e) {
    console.error(`❌ Balance check error: ${e}`);
    return null;
  }

  // Créer la tâche — SANS champ html (cause ERROR_INVALID_TASK_DATA)
  let taskId: string;
  try {
    const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: CAPSOLVER_KEY,
        task: {
          type: "AntiCloudflareTask",
          websiteURL: PORTAL_URL,
          proxy: proxyForCap,
          // ⚠️  Pas de champ `html` : retourne ERROR_INVALID_TASK_DATA
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await createRes.json()) as any;
    if (data.errorId !== 0 || !data.taskId) {
      console.error(`❌ createTask failed: ${data.errorDescription || data.errorCode}`);
      return null;
    }
    taskId = data.taskId;
    console.log(`   ✅ Task créée: ${taskId}`);
  } catch (e) {
    console.error(`❌ createTask network error: ${e}`);
    return null;
  }

  // Poller
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    try {
      const pollRes = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await pollRes.json()) as any;

      if (data.errorId !== 0) {
        const code = data.errorCode || `errorId=${data.errorId}`;
        console.error(`❌ Poll erreur fatale: ${code} — ${data.errorDescription ?? ""}`);
        return null;
      }
      if (data.status === "ready") {
        const sol = data.solution ?? {};
        console.log(`   ✅ Résolu en ${(i + 1) * 5}s`);
        console.log(`   solution keys: ${Object.keys(sol).join(", ")}`);

        // Logger TOUS les cookies retournés
        const allCookies: CookieJar = {};
        if (sol.cookies && typeof sol.cookies === "object") {
          Object.assign(allCookies, sol.cookies);
        }
        console.log(`   Cookies CapSolver (${Object.keys(allCookies).length}) :`);
        logCookies("CapSolver", allCookies);

        const ua = sol.userAgent || CHROME_UA;
        console.log(`   UA: ${ua.slice(0, 80)}`);

        const cfClearance = allCookies["cf_clearance"] || sol.token || "";
        if (!cfClearance) {
          console.error("❌ cf_clearance absent dans la solution");
          return null;
        }

        return { cfClearance, userAgent: ua, allCookies };
      }
      if (i % 3 === 0) console.log(`   ⏳ Poll #${i + 1} — processing…`);
    } catch (e) {
      console.warn(`   ⚠️  Poll #${i + 1} erreur réseau: ${e}`);
    }
  }

  console.error("❌ Timeout CapSolver");
  return null;
}

// ─── Étape 2 : GET portal → PHPSESSID + token CSRF ────────────────────────────

async function stepGetPortal(impit: InstanceType<typeof Impit>, jar: CookieJar): Promise<{
  token: string;
  postUrl: string;
  newCookies: CookieJar;
} | null> {
  sep("Étape 2 : GET portal citaconsular.es → PHPSESSID + token");

  console.log(`   Cookie envoyé: ${cookieStr(jar).slice(0, 120)}…`);

  try {
    const res = await (impit.fetch(PORTAL_URL, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        "Cookie": cookieStr(jar),
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
    } as any) as unknown as Response);

    const body = await res.text();
    const newCookies = parseSetCookies(res);
    console.log(`   HTTP ${(res as any).status} | ${body.length} chars`);
    logCookies("Set-Cookie", newCookies);
    logBody("HTML preview", body);

    // Vérifier CF challenge
    if (/just a moment|jetzt einen moment|_cf_chl_opt/i.test(body.slice(0, 2000))) {
      console.error("   ❌ CF challenge sur portal page — cf_clearance invalide ou IP rejetée");
      return null;
    }

    // Extraire token CSRF
    const tokenM =
      body.match(/<input[^>]+name=["']token["'][^>]+value=["']([^"']+)["']/i) ??
      body.match(/name="token"\s+value="([^"]+)"/i);
    const formM =
      body.match(/<form[^>]+action=["']([^"']+)["'][^>]+method=["']POST["']/i) ??
      body.match(/action="([^"]+)"\s+method="POST"/i);

    if (!tokenM) {
      console.warn("   ⚠️  Pas de token CSRF — peut-être pas de bouton Continue (direct widget ?)");
      // Chercher bkt_init_widget ou API URL directement
      const apiM = body.match(/(https?:\/\/[^\s"']*bookitit\.com[^\s"']*onlinebookings\/)/i);
      if (apiM) console.log(`   📍 API Bookitit trouvée directement: ${apiM[1]}`);
      return { token: "", postUrl: "", newCookies };
    }

    const token = tokenM[1];
    const rawAction = formM ? formM[1] : PORTAL_URL + "/";
    const postUrl = rawAction.startsWith("http")
      ? rawAction
      : `https://www.citaconsular.es${rawAction}`;

    console.log(`   ✅ Token CSRF: ${token.slice(0, 30)}…`);
    console.log(`   POST URL: ${postUrl}`);

    return { token, postUrl, newCookies };
  } catch (e) {
    console.error(`   ❌ GET portal échoué: ${e}`);
    return null;
  }
}

// ─── Étape 3 : POST token (Continuar) → page widget ──────────────────────────

async function stepPostToken(
  impit: InstanceType<typeof Impit>,
  jar: CookieJar,
  token: string,
  postUrl: string,
): Promise<{ html: string; bookititBase: string; newCookies: CookieJar } | null> {
  sep("Étape 3 : POST token (Continuar) → widget Bookitit");

  console.log(`   POST → ${postUrl}`);
  console.log(`   Cookie: ${cookieStr(jar).slice(0, 120)}…`);

  try {
    const res = await (impit.fetch(postUrl, {
      method: "POST",
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookieStr(jar),
        "Origin": "https://www.citaconsular.es",
        "Referer": PORTAL_URL,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      body: `token=${encodeURIComponent(token)}`,
    } as any) as unknown as Response);

    const body = await res.text();
    const newCookies = parseSetCookies(res);
    console.log(`   HTTP ${(res as any).status} | ${body.length} chars`);
    logCookies("Set-Cookie", newCookies);
    logBody("HTML preview", body);

    // Trouver la base URL Bookitit
    const patterns = [
      body.match(/bkt_init_widget\.srvsrc\s*=\s*["']([^"']+)["']/),
      body.match(/"baseUrl"\s*:\s*"([^"]*bookitit\.com[^"]*onlinebookings\/[^"]*)"/),
      body.match(/(https?:\/\/[^\s"']*bookitit\.com[^\s"']*onlinebookings\/)/i),
    ];
    const bookititBase =
      patterns.find(Boolean)?.[1]?.replace(/(?:getwidget|getservice|datetime|getagenda).*$/, "") ?? "";

    if (bookititBase) {
      console.log(`   📍 Base Bookitit: ${bookititBase}`);
    } else {
      console.warn("   ⚠️  Base Bookitit introuvable dans le HTML du widget");
    }

    return { html: body, bookititBase, newCookies };
  } catch (e) {
    console.error(`   ❌ POST Continuar échoué: ${e}`);
    return null;
  }
}

// ─── Étape 4 : GET /main/ ─────────────────────────────────────────────────────

async function stepGetMain(
  impit: InstanceType<typeof Impit>,
  jar: CookieJar,
  bookititBase: string,
  phpSessId: string,
): Promise<void> {
  sep("Étape 4 : GET /main/");

  const wid = "2d01502f12dc08400e22aea87fb00ae34"; // Kinshasa widget ID
  const mainUrl = `${bookititBase}main/?wid=${wid}&lang=fr&v=2`;

  console.log(`   GET ${mainUrl}`);
  console.log(`   Cookie: ${cookieStr(jar).slice(0, 120)}…`);

  try {
    const res = await (impit.fetch(mainUrl, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,*/*;q=0.9",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Cookie": cookieStr(jar),
        "Referer": PORTAL_URL,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      },
    } as any) as unknown as Response);

    const body = await res.text();
    const size = body.length;
    console.log(`   HTTP ${(res as any).status} | ${size} chars`);
    logCookies("Set-Cookie", parseSetCookies(res));

    if (size === 0) {
      console.error("   ❌ /main/ → 0B");
    } else {
      const preview = body.slice(0, 300).replace(/\s+/g, " ").trim();
      console.log(`   📄 /main/ preview: "${preview}"`);

      // Chercher des données utiles
      if (/bkt_init_widget|datetime|service/i.test(body)) {
        console.log("   ✅ /main/ contient des données Bookitit (bkt_init_widget détecté)");
      } else if (/<!DOCTYPE|<html/i.test(body)) {
        console.log("   ⚠️  /main/ retourne du HTML (pas de données JSON/Bookitit)");
      } else {
        console.log("   ℹ️  /main/ retourne un contenu non-HTML");
      }
    }
  } catch (e) {
    console.error(`   ❌ GET /main/ échoué: ${e}`);
  }
}

// ─── Étape 5 : GET JSONP getservices/ ────────────────────────────────────────

async function stepGetServices(
  impit: InstanceType<typeof Impit>,
  jar: CookieJar,
  bookititBase: string,
): Promise<void> {
  sep("Étape 5 : GET JSONP getservices/");

  const wid = "2d01502f12dc08400e22aea87fb00ae34";
  const svcUrl = `${bookititBase}getservices/?wid=${wid}&lang=fr&callback=cb`;

  console.log(`   GET ${svcUrl}`);

  try {
    const res = await (impit.fetch(svcUrl, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/javascript, */*; q=0.01",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Cookie": cookieStr(jar),
        "Referer": PORTAL_URL,
        "Sec-Fetch-Dest": "script",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      },
    } as any) as unknown as Response);

    const body = await res.text();
    const size = body.length;
    console.log(`   HTTP ${(res as any).status} | ${size} chars`);

    if (size === 0) {
      console.error("   ❌ getservices/ → 0B");
    } else {
      const preview = body.slice(0, 200).replace(/\s+/g, " ").trim();
      console.log(`   📄 preview: "${preview}"`);

      if (/cb\(|jQuery\d+\(|\{"services/i.test(body)) {
        console.log("   ✅ getservices/ retourne du JSONP valide");
      } else if (/<!DOCTYPE/i.test(body)) {
        console.log("   ⚠️  getservices/ retourne du HTML (PHPSESSID probablement manquant/invalide)");
      }
    }
  } catch (e) {
    console.error(`   ❌ getservices/ échoué: ${e}`);
  }
}

// ─── Étape 0 : probe impit avant CapSolver (pattern identique à la prod) ──────

async function stepProbeImpit(): Promise<{
  impit: InstanceType<typeof Impit>;
  isCfChallenge: boolean;
  html: string;
}> {
  sep("Étape 0 : Probe impit → établit session TLS AVANT CapSolver");

  const impit = new Impit({
    browser: "chrome",
    ...(PROXY_URL ? { proxyUrl: PROXY_URL } : {}),
  } as any);

  console.log(`   GET ${PORTAL_URL}`);
  try {
    const res = await (impit.fetch(PORTAL_URL, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
        "Priority": "u=0, i",
      },
    } as any) as unknown as Response);

    const html = await res.text();
    const status = (res as any).status;
    const isCf = /just a moment|jetzt einen moment|verifying|_cf_chl_opt|challenge-platform/i.test(html.slice(0, 4000));

    console.log(`   HTTP ${status} | ${html.length} chars | CF challenge: ${isCf ? "✅ OUI (solve nécessaire)" : "❌ NON (direct!)"}`);

    if (!isCf && status === 200) {
      const setCookie = (res as any).headers?.get?.("set-cookie") ?? "";
      const phpSessId = setCookie.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
      console.log(`   ✅ Accès DIRECT (pas de challenge) — PHPSESSID: ${phpSessId ? phpSessId.slice(0, 12) + "…" : "❌ absent"}`);
    }
    if (isCf) {
      // Log le type de challenge
      const cTypeM = html.match(/"cType"\s*:\s*"([^"]+)"/);
      const sitekeyM = html.match(/challenges\.cloudflare\.com\/turnstile\/v[\d]+\/[a-z]\/([a-f0-9]{8,32})\/api\.js/);
      console.log(`   Challenge cType: ${cTypeM?.[1] ?? "inconnu"} | Turnstile sitekey: ${sitekeyM?.[1] ?? "absent"}`);
    }

    return { impit, isCfChallenge: isCf, html };
  } catch (e) {
    console.error(`   ❌ Probe échoué: ${e}`);
    // Retourner quand même l'instance impit — on tente CapSolver
    return { impit, isCfChallenge: true, html: "" };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("  TEST FLOW COMPLET — citaconsular.es → /main/");
  console.log("  Pattern identique à spain-soax-solver.ts (probe → solve → scan)");
  console.log("=".repeat(60));
  console.log(`  Proxy  : ${maskProxy(PROXY_URL)}`);
  console.log(`  Portal : ${PORTAL_URL}`);
  console.log("=".repeat(60));

  // ── 0. Probe impit AVANT CapSolver (établit session TLS) ──────────────────
  const { impit, isCfChallenge } = await stepProbeImpit();
  // impit est réutilisé pour toutes les étapes suivantes (même instance = même session TLS)

  // Cookie jar cumulatif
  const jar: CookieJar = {};

  if (!isCfChallenge) {
    console.log("\n✅ Pas de CF challenge → accès direct. Test du flow GET portal avec cette instance.");
  }

  // ── 1. CapSolver (seulement si CF challenge détecté) ──────────────────────
  if (isCfChallenge) {
    const capResult = await stepCapSolver();
    if (!capResult) {
      console.error("\n💥 Arrêt : CapSolver échoué");
      process.exit(1);
    }
    Object.assign(jar, capResult.allCookies);
    console.log(`\n   ✅ jar après CapSolver: ${Object.keys(jar).join(", ")}`);
  }

  // ── 2. GET portal (MÊME instance impit que le probe) ──────────────────────
  // C'est ici que ça différait dans le test précédent : on utilisait une
  // NOUVELLE instance impit créée après CapSolver → nouvelle session TLS.
  // Maintenant : MÊME instance que le probe → session TLS déjà établie.
  const portalResult = await stepGetPortal(impit, jar);
  if (!portalResult) {
    console.error("\n💥 Arrêt : GET portal échoué");
    process.exit(1);
  }
  Object.assign(jar, portalResult.newCookies);
  console.log(`\n   🍪 Jar accumulé après portal: ${Object.keys(jar).join(", ")}`);

  // ── 3. POST token (si token présent) ──────────────────────────────────────
  let bookititBase = "https://webapp.bookitit.com/onlinebookings/";
  if (portalResult.token) {
    const postResult = await stepPostToken(impit, jar, portalResult.token, portalResult.postUrl);
    if (postResult) {
      Object.assign(jar, postResult.newCookies);
      if (postResult.bookititBase) bookititBase = postResult.bookititBase;
    }
  } else {
    sep("Étape 3 : POST token");
    console.log("   ⏭️  Skippée — pas de token (widget déjà accessible directement)");
  }
  console.log(`\n   🍪 Jar accumulé après POST: ${Object.keys(jar).join(", ")}`);
  console.log(`   📍 Base Bookitit: ${bookititBase}`);

  const phpSessId = jar["PHPSESSID"] ?? "";

  // ── 4. GET /main/ ─────────────────────────────────────────────────────────
  await stepGetMain(impit, jar, bookititBase, phpSessId);

  // ── 5. GET getservices/ ───────────────────────────────────────────────────
  await stepGetServices(impit, jar, bookititBase);

  // ── Résumé ────────────────────────────────────────────────────────────────
  sep("Résumé");
  console.log(`  cf_clearance  : ${jar["cf_clearance"] ? "✅" : "❌"}`);
  console.log(`  PHPSESSID     : ${jar["PHPSESSID"] ? "✅ " + jar["PHPSESSID"].slice(0, 12) + "…" : "❌ absent"}`);
  console.log(`  Base Bookitit : ${bookititBase}`);
  console.log("\n  Différence clé vs test précédent: MÊME instance impit pour probe + portal GET");
  console.log("  Si /main/ = 0B mais getservices/ ≥100 chars → PHPSESSID manquant pour /main/");
  console.log("  Si les deux OK → flow complet validé ✅");
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
