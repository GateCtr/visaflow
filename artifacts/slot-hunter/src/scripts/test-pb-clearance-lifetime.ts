/**
 * test-pb-clearance-lifetime.ts — VOIE D : mesurer la durée de vie du cf_clearance navigateur.
 *
 * Question décisive : un cf_clearance obtenu par le navigateur persistant reste-t-il accepté
 * par des GET HTTP purs (impit) sur São Paulo, et pendant COMBIEN DE TEMPS ?
 *   - Si ~30 min  → voie D viable (navigateur amorti, scan HTTP < 40s respecté).
 *   - Si quelques secondes → voie D morte.
 *
 * Flux :
 *   1. ensureSpainPersistentBrowserSession(SAOPOLO) → le navigateur franchit CF.
 *   2. On extrait cf_clearance + tous les cookies + l'IP proxy utilisée.
 *   3. GET HTTP purs (impit, MÊME IP) espacés : T+0, 10s, 30s, 60s, 120s, 300s, 600s, 900s.
 *      À chaque GET : statut, taille, token présent ? encore CF ?
 *   4. On note l'instant où le 403 revient (= expiration réelle du clearance pour HTTP pur).
 */
import "dotenv/config";
import { Impit } from "impit";
import {
  ensureSpainPersistentBrowserSession,
  getActiveSpainPersistentBrowserSession,
} from "../_legacy_spain-persistent-browser.js";
import { SAOPOLO_PORTAL_URL } from "../spain-portals.js";

const URL = SAOPOLO_PORTAL_URL.split("#")[0];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

// Échéances de sonde (secondes depuis l'obtention du clearance).
const PROBES_SEC = (process.env.PROBES ?? "0,10,30,60,120,300,600,900")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasToken = (b: string) => /name="token"\s+value="([^"]+)"/i.test(b) || /bkt_init_widget/i.test(b);
const isCf = (b: string, s: number) => s === 403 || /just a moment|_cf_chl_opt|cf-mitigated/i.test(b.slice(0, 3000));

async function main() {
  console.log(`[lifetime] 🚀 Franchissement CF via navigateur persistant… (${URL})`);
  const t0 = Date.now();
  const session = await ensureSpainPersistentBrowserSession(URL)
    ?? getActiveSpainPersistentBrowserSession();

  if (!session || !session.cfClearance) {
    console.error("[lifetime] ❌ Le navigateur n'a pas obtenu de cf_clearance. Voie D non testable ici.");
    process.exit(1);
  }
  console.log(`[lifetime] ✅ CF franchi en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[lifetime]    cf_clearance len=${session.cfClearance.length}`);
  console.log(`[lifetime]    cookies: ${(session.allCookies ?? []).map((c) => c.name).join(",") || "(aucun)"}`);
  console.log(`[lifetime]    proxy (IP du clearance): ${(session.soaxProxyUrl ?? "").replace(/:([^:@/]+)@/, ":***@").slice(0, 60)}`);

  const proxyUrl = session.soaxProxyUrl;
  if (!proxyUrl) {
    console.error("[lifetime] ❌ Pas d'IP proxy dans la session — impossible de rejouer sur la même IP.");
    process.exit(1);
  }

  // Jar complet depuis la session navigateur.
  const jar: Record<string, string> = {};
  for (const c of session.allCookies ?? []) jar[c.name] = c.value;
  if (!jar.cf_clearance) jar.cf_clearance = session.cfClearance;
  const cookieStr = Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");

  const impit = new Impit({ browser: "chrome", proxyUrl, timeout: 60_000 } as any);
  const clearanceAt = Date.now();
  let firstFailSec: number | null = null;

  for (const target of PROBES_SEC) {
    const elapsed = (Date.now() - clearanceAt) / 1000;
    const wait = target - elapsed;
    if (wait > 0) await sleep(wait * 1000);
    const atSec = Math.round((Date.now() - clearanceAt) / 1000);
    try {
      const r = await (impit.fetch(URL, { headers: { "User-Agent": UA, "Cookie": cookieStr } } as any) as unknown as Promise<Response>);
      const b = await r.text();
      const ok = r.status === 200 && !isCf(b, r.status) && hasToken(b);
      const stillCf = isCf(b, r.status);
      console.log(`[lifetime] T+${String(atSec).padStart(4)}s → HTTP ${r.status} ${b.length}B | token=${hasToken(b) ? "✅" : "✗"} | encoreCF=${stillCf ? "OUI" : "non"} → ${ok ? "✅ VALIDE" : "❌ REJETÉ"}`);
      if (!ok && firstFailSec === null) firstFailSec = atSec;
    } catch (e) {
      console.log(`[lifetime] T+${String(atSec).padStart(4)}s → ERREUR: ${e instanceof Error ? e.message.slice(0, 70) : e}`);
      if (firstFailSec === null) firstFailSec = atSec;
    }
  }

  console.log("\n╔══════════════ VERDICT VOIE D ══════════════╗");
  if (firstFailSec === null) {
    console.log(`  cf_clearance navigateur VALIDE en HTTP pur sur TOUTE la fenêtre testée (jusqu'à ${PROBES_SEC[PROBES_SEC.length - 1]}s).`);
    console.log(`  → Voie D VIABLE : scan HTTP < 40s respecté, navigateur amorti.`);
  } else if (firstFailSec === 0) {
    console.log(`  cf_clearance navigateur REJETÉ dès T+0 en HTTP pur.`);
    console.log(`  → Même le clearance navigateur n'est pas rejouable par impit : voie D (hand-off HTTP) NON viable.`);
  } else {
    console.log(`  cf_clearance navigateur valide jusqu'à ~T+${firstFailSec}s puis rejeté.`);
    console.log(`  → Voie D viable SI on renouvelle avant ${firstFailSec}s (pré-chauffage).`);
  }
  console.log("╚═════════════════════════════════════════════╝");
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
