/**
 * download-usvisascheduling-bundle.ts — Capture le bundle du portail
 * https://www.usvisascheduling.com/ (protégé par Cloudflare Managed Challenge).
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   tsx bundle-analysis/download-usvisascheduling-bundle.ts
 *
 * Stratégie — HTTP PUR, calquée sur la résolution Cloudflare d'Espagne
 * (spain-soax-solver.ts → solveSpainCloudflare), SANS navigateur :
 *   1. impit (client HTTP TLS-fingerprinté Chrome) via un proxy ISP à IP FIXE
 *      fait un GET sur le portail → récupère le HTML du challenge CF.
 *   2. solveSpainCloudflare(url, capsolverKey, proxy, challengeHtml, userAgent)
 *      résout le Managed Challenge via CapSolver AntiCloudflareTask. Comme on
 *      passe le `html` + `userAgent`, le cf_clearance produit est lié à la TLS
 *      de CE impit (donc réutilisable en HTTP direct — pas de 403).
 *   3. On refait des GET impit avec `cf_clearance` pour télécharger le vrai HTML,
 *      puis chaque asset JS/CSS référencé dans la page.
 *   4. Sauvegarde dans un dossier daté + manifest.
 *
 * Pourquoi HTTP pur et pas Playwright : cloudflare-solver.ts (navigateur) est
 * l'ancien chemin bugué (appelle page.context() de Playwright sur une page
 * Puppeteer, et son AntiCloudflareTask n'envoie pas le html requis). Spain a
 * migré vers ce solve HTTP — c'est le chemin fiable aujourd'hui.
 *
 * Outil d'EXPLORATION (one-shot). Non importé par le bot.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as dotenv from "dotenv";
import { Impit } from "impit";

import { solveSpainCloudflare } from "../src/spain-soax-solver.js";
import { getCurrentDecodoUrl } from "../src/spain-decodo-pool.js";

// Charger l'environnement (package + racine)
dotenv.config();
const localEnv = path.join(process.cwd(), ".env");
if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv, override: true });
const rootEnvLocal = path.join(process.cwd(), "..", "..", ".env.local");
if (fs.existsSync(rootEnvLocal)) dotenv.config({ path: rootEnvLocal, override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_URL = "https://www.usvisascheduling.com/";
const FALLBACK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** Un asset téléchargé. */
interface DownloadedAsset {
  url: string;
  status: number;
  filename: string;
  bytes: number;
}

/** Détecte une page de challenge Cloudflare dans un corps HTML. */
function isCfChallenge(status: number, body: string): boolean {
  return status === 403 || /just a moment|_cf_chl_opt|challenge-platform/i.test(body.slice(0, 4000));
}

/** Transforme une URL d'asset en nom de fichier sûr et indexé. */
function urlToFilename(rawUrl: string, index: number): string {
  try {
    const u = new URL(rawUrl, TARGET_URL);
    const base = (u.pathname.split("/").pop() || "index").split("?")[0];
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_") || "asset";
    return `${String(index).padStart(3, "0")}_${safe}`;
  } catch {
    return `${String(index).padStart(3, "0")}_asset`;
  }
}

/** Extrait les URLs de <script src> et <link href> (JS/CSS) d'un HTML. */
function extractAssetUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const scriptRe = /<script[^>]+src=["']([^"']+)["']/gi;
  const linkRe = /<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    try { urls.add(new URL(m[1], baseUrl).href); } catch { /* ignore */ }
  }
  while ((m = linkRe.exec(html)) !== null) {
    try { urls.add(new URL(m[1], baseUrl).href); } catch { /* ignore */ }
  }
  return [...urls];
}

async function main(): Promise<void> {
  const capsolverApiKey = process.env.CAPSOLVER_API_KEY?.trim() ?? "";
  // Proxy ISP à IP fixe (CapSolver lie le token à l'IP de résolution).
  // Source EXACTEMENT identique à Spain : pool CSV decodo-proxies.csv via
  // getCurrentDecodoUrl() (gère les ports virtuels Decodo > 65535 que new URL() rejette),
  // avec fallback env si le CSV est absent.
  const ispProxy =
    getCurrentDecodoUrl() ||
    process.env.DECODO_PROXY_URL?.trim() ||
    process.env.SPAIN_ISP_PROXY_URL?.trim() ||
    process.env.IPROYAL_PROXY_URL?.trim() ||
    "";

  if (!capsolverApiKey) {
    console.error("[usvs-capture] ❌ CAPSOLVER_API_KEY absent — impossible de résoudre.");
    process.exit(1);
  }
  if (!ispProxy) {
    console.error("[usvs-capture] ❌ Aucun proxy ISP (decodo-proxies.csv / DECODO_PROXY_URL / SPAIN_ISP / IPROYAL) — CapSolver nécessite une IP fixe.");
    process.exit(1);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, "usvisascheduling", dateStr);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[usvs-capture] 📁 Sortie : ${outDir}`);
  console.log(`[usvs-capture] 🌐 Proxy ISP : ${ispProxy.replace(/:([^:@]+)@/, ":***@").slice(0, 70)}…`);

  // ── Étape 1 : probe impit → HTML du challenge ───────────────────────────────
  const impit = new Impit({ browser: "chrome", proxyUrl: ispProxy, timeout: 60_000 } as unknown as ConstructorParameters<typeof Impit>[0]);

  console.log(`[usvs-capture] 🔍 Probe GET ${TARGET_URL} …`);
  let challengeHtml: string | undefined;
  try {
    const r = (await impit.fetch(TARGET_URL, {
      headers: { "User-Agent": FALLBACK_UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    } as RequestInit)) as Response;
    const body = await r.text();
    console.log(`[usvs-capture]   Probe → HTTP ${r.status} (${body.length}B)`);
    if (isCfChallenge(r.status, body)) {
      challengeHtml = body;
      console.log("[usvs-capture]   ⚠️ Challenge Cloudflare détecté → CapSolver");
      fs.writeFileSync(path.join(outDir, "challenge.html"), body);
    } else {
      console.log("[usvs-capture]   ✅ Pas de challenge — accès direct");
      fs.writeFileSync(path.join(outDir, "index.html"), body);
    }
  } catch (err) {
    console.error("[usvs-capture] ❌ Probe échoué :", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // ── Étape 2 : résolution CapSolver (si challenge) ───────────────────────────
  let cfClearance = "";
  let solvedUa = FALLBACK_UA;
  let cookieHeader = "";
  if (challengeHtml !== undefined) {
    console.log("[usvs-capture] 🛡️ solveSpainCloudflare (AntiCloudflareTask + html + userAgent)…");
    const result = await solveSpainCloudflare(TARGET_URL, capsolverApiKey, ispProxy, challengeHtml, FALLBACK_UA);
    if (!result.success || !result.session?.cfClearance) {
      console.error(`[usvs-capture] ❌ CapSolver échoué : ${result.error} (${result.durationMs}ms)`);
      process.exit(1);
    }
    cfClearance = result.session.cfClearance;
    solvedUa = result.session.userAgent || FALLBACK_UA;
    const allCookies = result.session.allCookies ?? [{ name: "cf_clearance", value: cfClearance }];
    cookieHeader = allCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    console.log(`[usvs-capture] ✅ cf_clearance obtenu (len=${cfClearance.length}, ${result.durationMs}ms)`);
    console.log(`[usvs-capture]    UA résolu : ${solvedUa.slice(0, 60)}…`);
    fs.writeFileSync(
      path.join(outDir, "cf-session.json"),
      JSON.stringify({ cfClearance, userAgent: solvedUa, cookies: allCookies, proxy: ispProxy.replace(/:([^:@]+)@/, ":***@") }, null, 2),
    );
  }

  // ── Étape 3 : GET du HTML réel avec cf_clearance ────────────────────────────
  const authHeaders: Record<string, string> = {
    "User-Agent": solvedUa,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (cookieHeader) authHeaders["Cookie"] = cookieHeader;

  console.log("[usvs-capture] 📄 GET du HTML applicatif (post-clearance)…");
  let appHtml = "";
  try {
    const r = (await impit.fetch(TARGET_URL, { headers: authHeaders } as RequestInit)) as Response;
    appHtml = await r.text();
    console.log(`[usvs-capture]   HTML → HTTP ${r.status} (${appHtml.length}B)`);
    if (isCfChallenge(r.status, appHtml)) {
      console.warn("[usvs-capture]   ⚠️ Toujours un challenge — cf_clearance rejeté (TLS/IP mismatch ?).");
    }
    fs.writeFileSync(path.join(outDir, "index.html"), appHtml);
  } catch (err) {
    console.error("[usvs-capture] ❌ GET HTML échoué :", err instanceof Error ? err.message : err);
  }

  // ── Étape 4 : télécharger tous les assets JS/CSS référencés ─────────────────
  const assetUrls = extractAssetUrls(appHtml, TARGET_URL);
  console.log(`[usvs-capture] 📦 ${assetUrls.length} asset(s) référencé(s) dans le HTML`);
  const downloaded: DownloadedAsset[] = [];
  let idx = 0;
  for (const assetUrl of assetUrls) {
    idx += 1;
    try {
      const r = (await impit.fetch(assetUrl, { headers: authHeaders } as RequestInit)) as Response;
      const body = await r.text();
      const filename = urlToFilename(assetUrl, idx);
      fs.writeFileSync(path.join(outDir, filename), body);
      downloaded.push({ url: assetUrl, status: r.status, filename, bytes: body.length });
      console.log(`[usvs-capture]   📥 ${r.status} ${filename} (${(body.length / 1024).toFixed(1)} KB) ${assetUrl.slice(0, 80)}`);
    } catch (err) {
      console.warn(`[usvs-capture]   ⚠️ Échec ${assetUrl.slice(0, 80)} : ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Manifest ────────────────────────────────────────────────────────────────
  const manifest = {
    capturedAt: new Date().toISOString(),
    target: TARGET_URL,
    method: "http-impit + capsolver AntiCloudflareTask",
    cfClearancePresent: Boolean(cfClearance),
    userAgent: solvedUa,
    htmlBytes: appHtml.length,
    assetCount: downloaded.length,
    assets: downloaded.sort((a, b) => b.bytes - a.bytes),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log("");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log(`║  Capture terminée — ${String(downloaded.length).padStart(2)} asset(s) + HTML            ║`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`[usvs-capture] cf_clearance : ${cfClearance ? "présent" : "ABSENT"}`);
  console.log(`[usvs-capture] 📁 ${outDir}`);
  if (!appHtml || isCfChallenge(200, appHtml)) {
    console.warn("[usvs-capture] ⚠️ HTML applicatif non récupéré (challenge persistant) — vérifier proxy/IP.");
  }
}

main().catch((err) => {
  console.error("[usvs-capture] FATAL :", err);
  process.exit(1);
});
